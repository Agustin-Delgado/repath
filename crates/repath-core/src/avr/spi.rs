//! The SPI as a master, on its pins: SCK and MOSI driven edge by edge, MISO
//! read from its net at every sampling edge.
//!
//! Unlike the TWI, which hands whole bytes to devices it carries inside it
//! (`i2c`), this one puts the transfer on the wires. Nothing on an SPI bus
//! answers back in the way I2C's acknowledge does — a slave only shifts — so
//! a device need not live inside the chip to be timed right, and what is most
//! often hung on these pins is not a device the simulator has a model for but
//! plain logic: a 74HC595 whose flip-flops take MOSI on SCK's rising edge, or
//! a scope. Those only work if the edges are really there. The cost is an edge
//! the chip's run stops at every half SCK period, but only on a pin something
//! is wired to, and SPI's writes do not come back as inputs the chip has to
//! wait for, so a speculation is not thrown away for them.
//!
//! Timed from the datasheet's description of the master: writing SPDR starts
//! the clock generator, the first SCK edge comes half a period later, and the
//! sixteenth ends the byte and sets SPIF. With CPHA = 0 the first bit is on
//! MOSI from the write, each leading edge samples MISO and each trailing edge
//! shifts the next bit out; CPHA = 1 shifts on the leading edge and samples
//! on the trailing one. SCK idles at CPOL.
//!
//! Not modelled: slave mode (nothing here could clock the chip), and with it
//! what a slave-mode SS does. A master whose SS is an input taken low drops to
//! slave mode with SPIF set — the mode fault — as the datasheet has it, and
//! from there it does nothing until the program sets MSTR again.

/// SPCR's bits.
const SPIE: u8 = 1 << 7;
pub const SPE: u8 = 1 << 6;
const DORD: u8 = 1 << 5;
pub const MSTR: u8 = 1 << 4;
const CPOL: u8 = 1 << 3;
const CPHA: u8 = 1 << 2;

/// SPSR's bits.
pub const SPIF: u8 = 1 << 7;
const WCOL: u8 = 1 << 6;
const SPI2X: u8 = 1 << 0;

/// A byte on its way out and in.
#[derive(Debug, Clone, Copy)]
struct Transfer {
    /// Edges so far, out of sixteen.
    edges: u8,
    /// Cycles from one edge to the next: half an SCK period.
    half: u64,
    next_at: u64,
}

#[derive(Debug, Clone)]
pub struct Spi {
    /// SPCR.
    control: u8,
    /// SPSR's SPIF and WCOL; SPI2X is kept with them.
    status: u8,
    /// The byte being shifted out, as written to SPDR.
    out: u8,
    /// The bits sampled from MISO so far, in the order they came.
    incoming: u8,
    /// SPDR as read: the last byte received. The receiver is double
    /// buffered, so this holds while the next transfer runs.
    received: u8,
    /// SPSR was read with SPIF set, so the next SPDR access clears it — the
    /// datasheet's way of clearing the flag without the interrupt.
    seen_flag: bool,
    transfer: Option<Transfer>,
    sck: bool,
    mosi: bool,
}

impl Default for Spi {
    fn default() -> Self {
        Self::new()
    }
}

impl Spi {
    pub fn new() -> Self {
        Self {
            control: 0,
            status: 0,
            out: 0,
            incoming: 0,
            received: 0,
            seen_flag: false,
            transfer: None,
            sck: false,
            mosi: false,
        }
    }

    pub fn control(&self) -> u8 {
        self.control
    }

    /// Enabled as a master: the unit that drives SCK and MOSI and reads MISO.
    pub fn master(&self) -> bool {
        self.control & (SPE | MSTR) == SPE | MSTR
    }

    /// Enabled as a slave, which is not simulated.
    pub fn slave(&self) -> bool {
        self.control & (SPE | MSTR) == SPE
    }

    /// The levels it puts on SCK and MOSI, while it is a master. The port
    /// still decides whether the pins are outputs at all: the datasheet has
    /// the program set DDRB for them.
    pub fn pins(&self) -> Option<(bool, bool)> {
        self.master().then_some((self.sck, self.mosi))
    }

    /// Whether a byte is going out.
    #[cfg(test)]
    pub fn busy(&self) -> bool {
        self.transfer.is_some()
    }

    pub fn write_control(&mut self, v: u8) {
        self.control = v;
        if !self.master() {
            // Switched off, or to slave: the byte under way is abandoned.
            self.transfer = None;
        }
        if self.transfer.is_none() {
            self.sck = v & CPOL != 0;
        }
    }

    pub fn status(&mut self) -> u8 {
        if self.status & SPIF != 0 {
            self.seen_flag = true;
        }
        self.status
    }

    /// Only SPI2X can be written; the flags are the hardware's.
    pub fn write_status(&mut self, v: u8) {
        self.status = (self.status & !SPI2X) | (v & SPI2X);
    }

    /// An SPDR access after SPSR was read with SPIF set clears SPIF and WCOL.
    fn access(&mut self) {
        if std::mem::take(&mut self.seen_flag) {
            self.status &= !(SPIF | WCOL);
        }
    }

    pub fn read_data(&mut self) -> u8 {
        self.access();
        self.received
    }

    /// A write to SPDR landing at `at`. As a master, it starts a transfer;
    /// during one, it is lost and WCOL says so. As a slave, or switched off,
    /// it only loads the shift register, which nothing here will ever clock.
    pub fn write_data(&mut self, v: u8, at: u64) {
        self.access();
        if self.transfer.is_some() {
            self.status |= WCOL;
            return;
        }
        self.out = v;
        if !self.master() {
            return;
        }
        self.incoming = 0;
        if self.control & CPHA == 0 {
            self.mosi = self.bit(0);
        }
        let half = self.divider() / 2;
        self.transfer = Some(Transfer { edges: 0, half, next_at: at + half });
    }

    /// CPU cycles to one SCK period, from SPR1:0 and SPI2X.
    fn divider(&self) -> u64 {
        let base = [4, 16, 64, 128][usize::from(self.control & 3)];
        if self.status & SPI2X != 0 { base / 2 } else { base }
    }

    /// The `n`th bit to go out, in the order DORD says.
    fn bit(&self, n: u8) -> bool {
        let shift = if self.control & DORD != 0 { n } else { 7 - n };
        self.out >> shift & 1 != 0
    }

    pub fn next_event(&self) -> u64 {
        self.transfer.map_or(u64::MAX, |t| t.next_at)
    }

    /// Whether the edge due now samples MISO, so the caller knows to read it.
    pub fn samples_next(&self) -> bool {
        self.transfer.is_some_and(|t| {
            let leading = t.edges % 2 == 0;
            leading == (self.control & CPHA == 0)
        })
    }

    /// The edge due now, with MISO at `miso`. Whether it set SPIF.
    pub fn event(&mut self, miso: bool) -> bool {
        let Some(mut t) = self.transfer else { return false };
        let sampling = self.samples_next();
        let leading = t.edges % 2 == 0;
        let bit = t.edges / 2;
        self.sck = !self.sck;
        if sampling {
            let shift = if self.control & DORD != 0 { bit } else { 7 - bit };
            self.incoming |= u8::from(miso) << shift;
        } else if leading {
            // CPHA = 1: each bit goes out on its own leading edge.
            self.mosi = self.bit(bit);
        } else if bit < 7 {
            // CPHA = 0: the trailing edge puts the next bit out. After the
            // last one MOSI is left where it is.
            self.mosi = self.bit(bit + 1);
        }
        t.edges += 1;
        if t.edges < 16 {
            t.next_at += t.half;
            self.transfer = Some(t);
            return false;
        }
        self.transfer = None;
        self.received = self.incoming;
        self.status |= SPIF;
        true
    }

    /// SS, an input, was taken low while a master: the unit drops to slave
    /// mode and says so with SPIF, and a byte under way is abandoned.
    pub fn mode_fault(&mut self) {
        self.write_control(self.control & !MSTR);
        self.status |= SPIF;
    }

    pub fn interrupt(&self) -> bool {
        self.control & (SPIE | SPE) == SPIE | SPE && self.status & SPIF != 0
    }

    /// The vector running clears SPIF.
    pub fn acknowledge(&mut self) {
        self.status &= !SPIF;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run a whole transfer of `byte` from `at`, with MISO given by `miso` for
    /// the n-th sample. The cycle and levels after every edge.
    fn shift(
        spi: &mut Spi,
        byte: u8,
        at: u64,
        miso: impl Fn(u8) -> bool,
    ) -> Vec<(u64, bool, bool)> {
        spi.write_data(byte, at);
        let mut seen = Vec::new();
        let mut samples = 0;
        while spi.busy() {
            let when = spi.next_event();
            let level = if spi.samples_next() {
                samples += 1;
                miso(samples - 1)
            } else {
                false
            };
            spi.event(level);
            let (sck, mosi) = spi.pins().unwrap();
            seen.push((when, sck, mosi));
        }
        seen
    }

    #[test]
    fn mode_0_shifts_msb_first_on_the_trailing_edge_at_a_quarter_of_the_clock() {
        // SPI.begin() and the defaults: master, mode 0, MSB first, fosc/4.
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR);
        assert_eq!(spi.pins(), Some((false, false)), "SCK idles low");
        let edges = shift(&mut spi, 0b1010_0110, 100, |n| n == 0 || n == 7);
        // Sixteen edges two cycles apart, starting two after the write.
        let times: Vec<u64> = edges.iter().map(|e| e.0).collect();
        assert_eq!(times, (1..=16).map(|k| 100 + 2 * k).collect::<Vec<_>>());
        // After each rising edge SCK is high and MOSI still holds the bit it
        // sampled; the falling edge brings the next.
        let sent: Vec<bool> = edges.iter().step_by(2).map(|e| e.2).collect();
        assert_eq!(sent, [true, false, true, false, false, true, true, false]);
        assert!(edges.iter().step_by(2).all(|e| e.1), "rising edges");
        assert_eq!(spi.status() & SPIF, SPIF);
        assert_eq!(spi.read_data(), 0b1000_0001, "MISO high on the first and last bit");
        assert_eq!(spi.status() & SPIF, 0, "SPSR then SPDR cleared it");
    }

    #[test]
    fn the_first_bit_is_on_mosi_from_the_write_in_mode_0_and_from_the_first_edge_in_mode_1() {
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR);
        spi.write_data(0x80, 0);
        assert_eq!(spi.pins(), Some((false, true)));

        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR | CPHA);
        spi.write_data(0x80, 0);
        assert_eq!(spi.pins(), Some((false, false)), "not until the leading edge");
        spi.event(false);
        assert_eq!(spi.pins(), Some((true, true)));
    }

    #[test]
    fn mode_3_lsb_first_idles_high_and_samples_on_the_rising_edge() {
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR | CPOL | CPHA | DORD);
        assert_eq!(spi.pins(), Some((true, false)), "SCK idles high");
        // In mode 3 the leading edge falls and shifts out, the trailing one
        // rises and samples.
        let edges = shift(&mut spi, 0b0000_0011, 0, |n| n == 1);
        let falls: Vec<(bool, bool)> = edges.iter().step_by(2).map(|e| (e.1, e.2)).collect();
        assert_eq!(falls[..3], [(false, true), (false, true), (false, false)]);
        assert!(edges.last().unwrap().1, "back at idle");
        assert_eq!(spi.read_data(), 0b0000_0010, "the second sample, LSB first, is bit 1");
    }

    #[test]
    fn the_rate_follows_spr_and_spi2x() {
        for (spr, double, period) in [
            (0, false, 4),
            (1, false, 16),
            (2, false, 64),
            (3, false, 128),
            (0, true, 2),
            (3, true, 64),
        ] {
            let mut spi = Spi::new();
            spi.write_control(SPE | MSTR | spr);
            spi.write_status(if double { SPI2X } else { 0 });
            let edges = shift(&mut spi, 0, 0, |_| false);
            assert_eq!(edges.last().unwrap().0, 8 * period, "SPR {spr}, SPI2X {double}");
        }
    }

    #[test]
    fn a_write_during_a_transfer_is_lost_and_sets_wcol() {
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR);
        spi.write_data(0x55, 0);
        spi.write_data(0xAA, 1);
        assert_eq!(spi.status() & WCOL, WCOL);
        let mut sent = 0u8;
        while spi.busy() {
            let rising = spi.samples_next();
            spi.event(false);
            if rising {
                sent = sent << 1 | u8::from(spi.pins().unwrap().1);
            }
        }
        assert_eq!(sent, 0x55);
        // SPSR read with SPIF set, then SPDR: both flags go.
        assert_eq!(spi.status() & (SPIF | WCOL), SPIF | WCOL);
        spi.read_data();
        assert_eq!(spi.status() & (SPIF | WCOL), 0);
    }

    #[test]
    fn spif_is_not_cleared_by_spdr_alone() {
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR | SPIE);
        shift(&mut spi, 0x12, 0, |_| false);
        assert!(spi.interrupt());
        spi.read_data();
        assert!(spi.interrupt(), "SPSR was never read");
        spi.acknowledge();
        assert!(!spi.interrupt());
    }

    #[test]
    fn a_mode_fault_drops_to_slave_and_sets_spif() {
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR);
        spi.write_data(0xFF, 0);
        spi.event(false);
        spi.mode_fault();
        assert!(spi.slave() && !spi.busy());
        assert_eq!(spi.status() & SPIF, SPIF);
        assert_eq!(spi.pins(), None, "the pins are the port's again");
        // As a slave a write starts nothing.
        spi.read_data();
        spi.write_data(0x01, 10);
        assert_eq!(spi.next_event(), u64::MAX);
    }

    #[test]
    fn switching_off_abandons_the_byte() {
        let mut spi = Spi::new();
        spi.write_control(SPE | MSTR);
        spi.write_data(0xFF, 0);
        spi.write_control(0);
        assert_eq!(spi.next_event(), u64::MAX);
        assert_eq!(spi.status() & SPIF, 0);
    }
}
