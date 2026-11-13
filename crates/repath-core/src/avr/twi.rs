//! The TWI — the AVR's I2C — as a master on a bus with nothing else on it.
//!
//! repath has no I2C devices, so whatever the program addresses, nobody
//! answers. That is a perfectly well-defined bus: with the pull-ups holding
//! SDA high, every address and every data byte is NACKed, and a byte clocked
//! in reads as all ones. The master's state machine is modelled just far
//! enough to give those answers in the status codes of the datasheet's tables,
//! at roughly the time they would come, so that the Arduino `Wire` library —
//! interrupt-driven, waiting on TWINT — returns "address not acknowledged"
//! instead of waiting for ever.
//!
//! Not modelled: the slave modes (nothing could address this chip either),
//! arbitration, and the bus on the pins. SDA and SCL stay whatever the port
//! makes them, which after `Wire.begin()` is two pull-ups: the idle bus, not
//! the transfer's waveform.

/// TWCR's bits.
pub const TWINT: u8 = 1 << 7;
const TWEA: u8 = 1 << 6;
const TWSTA: u8 = 1 << 5;
const TWSTO: u8 = 1 << 4;
const TWWC: u8 = 1 << 3;
pub const TWEN: u8 = 1 << 2;
const TWIE: u8 = 1 << 0;

// Status codes, TWSR's top five bits, from the master tables of the datasheet.
const START: u8 = 0x08;
const REPEATED_START: u8 = 0x10;
const SLA_W_NACK: u8 = 0x20;
const DATA_NACK: u8 = 0x30;
const SLA_R_NACK: u8 = 0x48;
const DATA_IN_ACK: u8 = 0x50;
const DATA_IN_NACK: u8 = 0x58;
const NO_INFO: u8 = 0xF8;

/// Where the master stands on the bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Not holding the bus.
    Idle,
    /// Holding it after a START: the next byte is an address.
    Address,
    /// After SLA+W: bytes go out.
    Transmit,
    /// After SLA+R: bytes come in.
    Receive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Start { repeated: bool },
    Stop,
    Byte,
}

#[derive(Debug, Clone)]
pub struct Twi {
    /// TWBR.
    pub bit_rate: u8,
    /// TWSR's TWPS bits.
    prescaler: u8,
    /// TWSR's status bits.
    status: u8,
    /// TWDR.
    pub data: u8,
    /// TWCR, every bit as it reads.
    control: u8,
    phase: Phase,
    /// What the bus is doing, and the cycle it is done.
    action: Option<(Action, u64)>,
}

impl Twi {
    pub fn new() -> Self {
        Self {
            bit_rate: 0,
            prescaler: 0,
            status: NO_INFO,
            data: 0xFF,
            control: 0,
            phase: Phase::Idle,
            action: None,
        }
    }

    pub fn status(&self) -> u8 {
        self.status | self.prescaler
    }

    /// Only the prescaler bits are written; the status is the hardware's.
    pub fn set_status(&mut self, v: u8) {
        self.prescaler = v & 3;
    }

    pub fn control(&self) -> u8 {
        self.control
    }

    /// Whether the TWI interrupt is asking to be served. Running the vector
    /// does not clear TWINT: the handler has to, by writing a one to it.
    pub fn interrupt(&self) -> bool {
        self.control & (TWINT | TWIE) == TWINT | TWIE
    }

    pub fn next_event(&self) -> u64 {
        self.action.map_or(u64::MAX, |(_, at)| at)
    }

    /// TWDR can be written only while TWINT is set, between two actions;
    /// at any other time the write is lost and TWWC says so.
    pub fn write_data(&mut self, v: u8) {
        if self.control & TWINT != 0 {
            self.data = v;
            self.control &= !TWWC;
        } else {
            self.control |= TWWC;
        }
    }

    /// One SCL period in CPU cycles: the datasheet's
    /// SCL = F_CPU / (16 + 2 · TWBR · 4^TWPS).
    fn bit_cycles(&self) -> u64 {
        16 + 2 * u64::from(self.bit_rate) * 4u64.pow(u32::from(self.prescaler))
    }

    /// A write to TWCR landing at `at`. Writing a one to TWINT clears it and
    /// sets the bus going on whatever TWSTA, TWSTO and TWDR ask for; a write
    /// with TWINT zero only changes the enables.
    pub fn write_control(&mut self, v: u8, at: u64) {
        let mut flags = self.control & (TWINT | TWWC);
        if v & TWINT != 0 {
            flags &= !TWINT;
        }
        self.control = (v & !(TWINT | TWWC | 0x02)) | flags;
        if v & TWEN == 0 {
            // Switched off: whatever was going on is abandoned, bus and all.
            self.control &= !TWSTO;
            self.phase = Phase::Idle;
            self.action = None;
            return;
        }
        if v & TWINT == 0 {
            return;
        }
        let held = self.phase != Phase::Idle;
        if !held {
            // With no bus to let go of, TWSTO only puts the unit back to
            // unaddressed and clears itself.
            self.control &= !TWSTO;
        }
        // Timed as whole SCL periods: a START or a STOP as one, a byte as its
        // eight bits and the acknowledge. The real conditions take a fraction
        // of a period more or less, set by the setup and hold times; a few
        // microseconds either way in a 100 kHz transfer.
        let (action, bits) = match (v & TWSTA != 0, self.control & TWSTO != 0) {
            // STOP then START is a fresh START, not a repeated one.
            (true, stop) => (Action::Start { repeated: held && !stop }, if stop { 2 } else { 1 }),
            (false, true) => (Action::Stop, 1),
            (false, false) if held => (Action::Byte, 9),
            // Not holding the bus and not asked to take it: nothing to do.
            (false, false) => {
                self.action = None;
                return;
            }
        };
        self.action = Some((action, at + bits * self.bit_cycles()));
    }

    /// The action under way finishes: now is its [`Self::next_event`].
    pub fn event(&mut self) {
        let Some((action, _)) = self.action.take() else { return };
        self.status = match action {
            Action::Start { repeated } => {
                self.control &= !TWSTO;
                self.phase = Phase::Address;
                if repeated { REPEATED_START } else { START }
            }
            // The one action that does not set TWINT: TWSTO clearing is how
            // the program knows the STOP is out.
            Action::Stop => {
                self.control &= !TWSTO;
                self.phase = Phase::Idle;
                NO_INFO
            }
            Action::Byte => match self.phase {
                // The read/write bit decides which half of the master the
                // NACK leaves it in.
                Phase::Address if self.data & 1 == 0 => {
                    self.phase = Phase::Transmit;
                    SLA_W_NACK
                }
                Phase::Address => {
                    self.phase = Phase::Receive;
                    SLA_R_NACK
                }
                Phase::Transmit => DATA_NACK,
                // Nobody drives SDA, so the pull-ups make every bit a one.
                Phase::Receive => {
                    self.data = 0xFF;
                    if self.control & TWEA != 0 { DATA_IN_ACK } else { DATA_IN_NACK }
                }
                Phase::Idle => return,
            },
        };
        if action != Action::Stop {
            self.control |= TWINT;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write TWCR at `at`, then let the bus finish: the cycle it finished, and
    /// TWSR and TWCR then.
    fn step(twi: &mut Twi, control: u8, at: u64) -> (u64, u8, u8) {
        twi.write_control(control, at);
        let done = twi.next_event();
        assert_ne!(done, u64::MAX, "nothing started");
        twi.event();
        (done, twi.status() & 0xF8, twi.control())
    }

    /// What `Wire.endTransmission()` and then `Wire.requestFrom()` put the
    /// unit through with nobody on the bus, at the 100 kHz `Wire` sets up:
    /// TWBR = (16 MHz / 100 kHz - 16) / 2 = 72, so 160 cycles a bit.
    #[test]
    fn every_address_goes_unanswered_on_an_empty_bus() {
        let mut twi = Twi::new();
        twi.bit_rate = 72;
        twi.write_control(TWEN | TWIE | TWEA, 0);
        assert_eq!(twi.next_event(), u64::MAX, "enabling it does nothing on the bus");
        assert_eq!(twi.status(), NO_INFO);

        let go = TWINT | TWEA | TWEN | TWIE;
        // START: one bit time, then TWINT.
        let (at, status, control) = step(&mut twi, go | TWSTA, 100);
        assert_eq!((at, status), (100 + 160, START));
        assert_ne!(control & TWINT, 0);
        assert!(twi.interrupt());
        // SLA+W for 0x27: eight bits and the acknowledge nobody gives.
        twi.write_data(0x27 << 1);
        assert_eq!(twi.control() & TWWC, 0);
        let (at, status, _) = step(&mut twi, go, 300);
        assert_eq!((at, status), (300 + 9 * 160, SLA_W_NACK));
        // A data byte after that is not acknowledged either.
        let (at, status, _) = step(&mut twi, go, 2000);
        assert_eq!((at, status), (2000 + 9 * 160, DATA_NACK));
        // A repeated START, then SLA+R: NACK again.
        let (_, status, _) = step(&mut twi, go | TWSTA, 4000);
        assert_eq!(status, REPEATED_START);
        twi.write_data(0x27 << 1 | 1);
        let (_, status, _) = step(&mut twi, go, 5000);
        assert_eq!(status, SLA_R_NACK);
        // STOP: TWSTO clears after a bit time, and TWINT stays down.
        twi.write_control(TWEN | TWIE | TWEA | TWINT | TWSTO, 7000);
        assert_eq!(twi.control() & (TWINT | TWSTO), TWSTO);
        assert!(!twi.interrupt());
        assert_eq!(twi.next_event(), 7000 + 160);
        twi.event();
        assert_eq!(twi.control() & (TWINT | TWSTO), 0);
        assert_eq!(twi.status(), NO_INFO);
        // And the next START is a first one again.
        let (_, status, _) = step(&mut twi, go | TWSTA, 8000);
        assert_eq!(status, START);
    }

    #[test]
    fn a_byte_clocked_in_reads_the_pull_ups() {
        let mut twi = Twi::new();
        twi.bit_rate = 72;
        let go = TWINT | TWEN;
        step(&mut twi, go | TWSTA, 0);
        twi.write_data(0x50 << 1 | 1);
        step(&mut twi, go, 1000);
        let (_, status, _) = step(&mut twi, go | TWEA, 3000);
        assert_eq!((status, twi.data), (DATA_IN_ACK, 0xFF));
        let (_, status, _) = step(&mut twi, go, 5000);
        assert_eq!((status, twi.data), (DATA_IN_NACK, 0xFF));
    }

    #[test]
    fn the_bit_time_follows_twbr_and_the_prescaler() {
        // 16 + 2 · 2 · 4² = 80 cycles: 200 kHz at 16 MHz.
        let mut twi = Twi::new();
        twi.bit_rate = 2;
        twi.set_status(2);
        assert_eq!(twi.status(), NO_INFO | 2);
        let (at, _, _) = step(&mut twi, TWINT | TWEN | TWSTA, 10);
        assert_eq!(at, 10 + 80);
        // STOP and START together: a STOP, then a START that is not repeated.
        twi.write_data(0x10);
        step(&mut twi, TWINT | TWEN, 100);
        let (at, status, control) = step(&mut twi, TWINT | TWEN | TWSTA | TWSTO, 1000);
        assert_eq!((at, status), (1000 + 2 * 80, START));
        assert_eq!(control & TWSTO, 0);
    }

    #[test]
    fn twdr_is_written_only_between_actions() {
        let mut twi = Twi::new();
        twi.bit_rate = 72;
        twi.write_control(TWINT | TWEN | TWSTA, 0);
        twi.write_data(0x42);
        assert_ne!(twi.control() & TWWC, 0, "a START is under way");
        assert_eq!(twi.data, 0xFF);
        twi.event();
        twi.write_data(0x42);
        assert_eq!((twi.data, twi.control() & TWWC), (0x42, 0));
    }

    #[test]
    fn switching_it_off_abandons_the_bus() {
        let mut twi = Twi::new();
        twi.bit_rate = 72;
        twi.write_control(TWINT | TWEN | TWSTA, 0);
        twi.write_control(0, 50);
        assert_eq!(twi.next_event(), u64::MAX);
        // Back on, a START is a first one: the bus was let go.
        let (_, status, _) = step(&mut twi, TWINT | TWEN | TWSTA, 100);
        assert_eq!(status, START);
    }
}
