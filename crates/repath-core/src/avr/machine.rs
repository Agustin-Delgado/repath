//! The chip: register file, memory, I/O, interrupts, and the loop that runs
//! them to a limit.
//!
//! Time here is a cycle count from power-on and nothing else. The instruction
//! set is in `cpu.rs`; the timers in `timer.rs`. What a cycle is in seconds,
//! and what a pin is on a net, is the device's business (`mod.rs`).
//!
//! Two conventions hold everywhere, and the tests are written against them:
//!
//! - An instruction reads the inputs as they are at the cycle it starts on,
//!   and what it writes reaches the pins at the cycle it ends on.
//! - A peripheral event (a timer clock that sets a flag, a serial bit) at or
//!   before an instruction boundary is seen at that boundary, so an interrupt
//!   whose flag rises there is taken before the next instruction.

use std::sync::Arc;

use super::adc::{self, Adc, AnalogLevels};
use super::eeprom::Eeprom;
use super::receiver::{self, Format, Receiver};
use super::timer::{ICF, OCFA, OCFB, TOV, Timer};
use super::twi::{TWEN, Twi};

pub const FLASH_WORDS: usize = 16 * 1024;
pub const FLASH_BYTES: usize = FLASH_WORDS * 2;
pub(super) const PC_MASK: u16 = (FLASH_WORDS - 1) as u16;
/// Registers, I/O and extended I/O, then 2 KB of SRAM.
const DATA_SIZE: usize = 0x900;
pub const RAMEND: u16 = 0x08FF;

// SREG bits.
pub(super) const C: u8 = 0;
pub(super) const Z: u8 = 1;
pub(super) const N: u8 = 2;
pub(super) const V: u8 = 3;
pub(super) const S: u8 = 4;
pub(super) const H: u8 = 5;
pub(super) const T: u8 = 6;
pub(super) const I: u8 = 7;

// Data-space addresses of the registers with behaviour.
const PINB: u8 = 0x23;
const PORTD: u8 = 0x2B;
const TIFR0: u8 = 0x35;
const TIFR2: u8 = 0x37;
const PCIFR: u8 = 0x3B;
const EIFR: u8 = 0x3C;
const EIMSK: u8 = 0x3D;
const EECR: u8 = 0x3F;
const EEDR: u8 = 0x40;
const EEARL: u8 = 0x41;
const EEARH: u8 = 0x42;
const TCCR0A: u8 = 0x44;
const TCCR0B: u8 = 0x45;
const TCNT0: u8 = 0x46;
const OCR0A: u8 = 0x47;
const OCR0B: u8 = 0x48;
const SPCR: u8 = 0x4C;
const SPSR: u8 = 0x4D;
const SPDR: u8 = 0x4E;
const ACSR: u8 = 0x50;
pub(super) const SMCR: u8 = 0x53;
const MCUSR: u8 = 0x54;
const MCUCR: u8 = 0x55;
const SPL: u8 = 0x5D;
const SPH: u8 = 0x5E;
const SREG: u8 = 0x5F;
const WDTCSR: u8 = 0x60;
const PCICR: u8 = 0x68;
const EICRA: u8 = 0x69;
const PCMSK0: u8 = 0x6B;
const PCMSK2: u8 = 0x6D;
const TIMSK0: u8 = 0x6E;
const TIMSK2: u8 = 0x70;
const TCCR1A: u8 = 0x80;
const TCCR1B: u8 = 0x81;
const TCCR1C: u8 = 0x82;
const TCNT1L: u8 = 0x84;
const TCNT1H: u8 = 0x85;
const ICR1L: u8 = 0x86;
const ICR1H: u8 = 0x87;
const OCR1AL: u8 = 0x88;
const OCR1BH: u8 = 0x8B;
const TCCR2A: u8 = 0xB0;
const TCCR2B: u8 = 0xB1;
const TCNT2: u8 = 0xB2;
const OCR2A: u8 = 0xB3;
const OCR2B: u8 = 0xB4;
const TWBR: u8 = 0xB8;
const TWSR: u8 = 0xB9;
const TWDR: u8 = 0xBB;
const TWCR: u8 = 0xBC;
const UCSR0A: u8 = 0xC0;
const UCSR0B: u8 = 0xC1;
const UCSR0C: u8 = 0xC2;
const UBRR0L: u8 = 0xC4;
const UBRR0H: u8 = 0xC5;
const UDR0: u8 = 0xC6;

/// Pins are numbered `port * 8 + bit`, ports B, C, D as 0, 1, 2.
pub const PD0: u32 = 16;
pub const PD1: u32 = 17;
pub const PD2: u32 = 18;

/// Bits that exist in each port. PC6 is RESET and there is no PC7.
const PORT_MASK: [u8; 3] = [0xFF, 0x7F, 0xFF];

/// Which compare output drives which pin: (timer, channel, pin).
const COMPARE_PINS: [(usize, usize, u32); 6] =
    [(0, 0, 22), (0, 1, 21), (1, 0, 1), (1, 1, 2), (2, 0, 3), (2, 1, 19)];

/// The levels outside the chip, pin by pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinLevels {
    pub high: u32,
    /// Pins nothing drives, or that have no net at all: these read what the
    /// chip itself puts on them — its own output, or its pull-up.
    pub floating: u32,
}

impl Default for PinLevels {
    fn default() -> Self {
        Self { high: 0, floating: !0 }
    }
}

/// What the chip puts on its pins.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PinOutputs {
    /// Pins it drives.
    pub driven: u32,
    /// Their levels; zero wherever `driven` is.
    pub level: u32,
    /// Pins with the internal pull-up on.
    pub pullup: u32,
}

impl PinOutputs {
    /// Whether anything in `watch` differs between the two.
    pub fn differs(&self, other: &Self, watch: &Watch) -> bool {
        let drive = (self.driven ^ other.driven) | (self.level ^ other.level);
        drive & watch.drive != 0 || (self.pullup ^ other.pullup) & watch.pullup != 0
    }
}

/// The pins whose drive, and whose pull-up, somebody is listening to. A change
/// on a pin with nothing connected is not worth stopping a run for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Watch {
    pub drive: u32,
    pub pullup: u32,
}

/// The CPU met an instruction it does not have, and stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fault {
    pub cycle: u64,
    /// Word address of the instruction.
    pub pc: u16,
    pub opcode: u16,
}

impl std::fmt::Display for Fault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let at = u32::from(self.pc) * 2;
        if self.opcode == 0xFFFF {
            write!(f, "the program ran into erased flash at 0x{at:04X}")
        } else {
            write!(f, "unknown instruction 0x{:04X} at 0x{at:04X}", self.opcode)
        }
    }
}

/// A part of the chip that is not simulated, or not fully, which a program
/// has started to use. Using it is not an error and the program runs on, but
/// what it gets back is not what the silicon would give, and the person
/// reading the results ought to know.
///
/// The set is what a sketch can be caught using cheaply and without crying
/// wolf. Not here: the timers' external clock pins, which count as stopped
/// and show as a timer that never moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Peripheral {
    /// A conversion of the temperature sensor was started, which reads 0 V.
    Thermometer,
    /// The converter set to be auto triggered by something other than its own
    /// completion: a timer, the comparator, an external interrupt. No such
    /// conversion ever starts.
    AdcTrigger,
    /// SPE set in SPCR.
    Spi,
    /// TWEN set in TWCR. The bus is simulated, as one with nothing on it, so
    /// this is less "not simulated" than "nothing to talk to".
    I2c,
    /// ACSR read, or its interrupt enabled, while the comparator is on.
    Comparator,
    /// WDE or WDIE left set by a write: the watchdog armed, not just touched
    /// on the way to switching it off.
    Watchdog,
}

impl Peripheral {
    pub fn id(self) -> &'static str {
        match self {
            Self::Thermometer => "temperature",
            Self::AdcTrigger => "adc-trigger",
            Self::Spi => "spi",
            Self::I2c => "i2c",
            Self::Comparator => "comparator",
            Self::Watchdog => "watchdog",
        }
    }
}

/// Why [`Machine::run`] stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// A watched output changed, a byte finished going out, or the program
    /// first used a peripheral that is not simulated, at this cycle.
    Changed(u64),
    /// A conversion is due to complete at this cycle and nobody has said what
    /// it sampled: [`Machine::adc_sample_needed`] says when that was, and
    /// [`Machine::give_adc_levels`] lets the run go on. Nothing due at the
    /// cycle has been done.
    Sample(u64),
    /// The CPU faulted at this cycle.
    Fault(u64),
    /// The limit was reached.
    Limit,
    /// Asleep or stopped with nothing that could ever wake it: no timer
    /// running, no byte going out. Only an input can change anything now.
    Idle,
}

/// USART0's registers and transmitter; the receiver is in `receiver.rs`.
#[derive(Debug, Clone)]
struct Usart {
    /// UCSR0A's own bits: TXC0, U2X0, MPCM0. UDRE0 is derived.
    status: u8,
    control_b: u8,
    control_c: u8,
    baud: u16,
    frame: Option<Frame>,
    /// UDR0's transmit buffer, holding the byte after the one going out.
    buffer: Option<u8>,
    /// The level on TXD.
    line: bool,
}

#[derive(Debug, Clone, Copy)]
struct Frame {
    byte: u8,
    /// Start, data, parity and stop bits, least significant first.
    bits: u16,
    count: u8,
    index: u8,
    bit_cycles: u64,
    next_at: u64,
}

const TXC: u8 = 1 << 6;
const UDRE: u8 = 1 << 5;
const TXEN: u8 = 1 << 3;
const RXEN: u8 = 1 << 4;
const RXCIE: u8 = 1 << 7;

impl Usart {
    fn new() -> Self {
        Self {
            status: 0,
            control_b: 0,
            control_c: 0x06,
            baud: 0,
            frame: None,
            buffer: None,
            line: true,
        }
    }

    fn status(&self) -> u8 {
        self.status | if self.buffer.is_none() { UDRE } else { 0 }
    }

    fn enabled(&self) -> bool {
        self.control_b & TXEN != 0
    }

    fn receiving(&self) -> bool {
        self.control_b & RXEN != 0
    }

    /// The frame the registers describe, as the receiver takes it.
    fn format(&self) -> Format {
        let size = ((self.control_c >> 1) & 3) | (self.control_b & 4);
        let parity = (self.control_c >> 4) & 3;
        Format {
            period: u64::from(self.baud) + 1,
            samples: if self.status & 0x02 != 0 { 8 } else { 16 },
            data: match size {
                0 => 5,
                1 => 6,
                2 => 7,
                7 => 9,
                _ => 8,
            },
            parity: (parity >= 2).then_some(parity == 3),
            addresses_only: self.status & 0x01 != 0,
        }
    }

    fn next_event(&self) -> u64 {
        self.frame.map_or(u64::MAX, |f| f.next_at)
    }

    fn write(&mut self, byte: u8, cycle: u64) {
        if !self.enabled() {
            return;
        }
        if self.frame.is_none() {
            self.start(byte, cycle);
        } else if self.buffer.is_none() {
            self.buffer = Some(byte);
        }
        // With the buffer full the datasheet has the write ignored.
    }

    fn start(&mut self, byte: u8, cycle: u64) {
        let size = ((self.control_c >> 1) & 3) | (self.control_b & 4);
        let data: u16 = match size {
            0 => 5,
            1 => 6,
            2 => 7,
            7 => 9,
            _ => 8,
        };
        let ninth = u16::from(self.control_b & 1);
        let word = u16::from(byte) | ninth << 8;
        let word = word & ((1 << data) - 1);
        let mut bits = word << 1;
        let mut count: u16 = 1 + data;
        let parity = (self.control_c >> 4) & 3;
        if parity >= 2 {
            let odd = word.count_ones() % 2 == 1;
            bits |= u16::from(odd ^ (parity == 3)) << count;
            count += 1;
        }
        let stops: u16 = if self.control_c & 0x08 != 0 { 2 } else { 1 };
        bits |= ((1 << stops) - 1) << count;
        count += stops;
        let per_bit = if self.status & 0x02 != 0 { 8 } else { 16 };
        let bit_cycles = per_bit * (u64::from(self.baud) + 1);
        self.line = false;
        self.frame = Some(Frame {
            byte,
            bits,
            count: count as u8,
            index: 0,
            bit_cycles,
            next_at: cycle + bit_cycles,
        });
    }

    /// The bit boundary at `at`; a finished byte goes into `log`.
    fn event(&mut self, at: u64, log: &mut Vec<(u64, u8)>) {
        let Some(mut frame) = self.frame else { return };
        frame.index += 1;
        if frame.index < frame.count {
            self.line = frame.bits >> frame.index & 1 != 0;
            frame.next_at += frame.bit_cycles;
            self.frame = Some(frame);
            return;
        }
        log.push((at, frame.byte));
        self.line = true;
        self.frame = None;
        match self.buffer.take() {
            Some(next) => self.start(next, at),
            None => self.status |= TXC,
        }
    }
}

/// An ATmega328P, from its flash to its pins.
#[derive(Clone)]
pub struct Machine {
    flash: Arc<[u16]>,
    pub(super) data: [u8; DATA_SIZE],
    /// Word address of the next instruction.
    pub(super) pc: u16,
    pub(super) sp: u16,
    pub(super) sreg: u8,
    /// Cycles since power-on.
    pub cycle: u64,
    /// Instructions, interrupts and peripheral events so far: whether a run did
    /// anything at all.
    progress: u64,
    pub(super) sleeping: bool,
    pub(super) fault: Option<Fault>,
    /// Set by SEI and RETI: one more instruction runs before an interrupt.
    pub(super) inhibit: bool,
    ddr: [u8; 3],
    port: [u8; 3],
    inputs: PinLevels,
    timers: [Timer; 3],
    /// The TEMP register Timer1's 16-bit registers are reached through.
    temp: u8,
    usart: Usart,
    receiver: Receiver,
    twi: Twi,
    pub(super) eeprom: Eeprom,
    adc: Adc,
    /// Cycles the CPU is halted for after the instruction under way, as an
    /// EEPROM access halts it.
    stall: u64,
    eicra: u8,
    eimsk: u8,
    eifr: u8,
    pcicr: u8,
    pcifr: u8,
    pcmsk: [u8; 3],
    /// The earliest cycle at which a peripheral has something to do.
    next_event: u64,
    outputs_dirty: bool,
    /// Start cycle of the latest instruction that read a PINx register.
    last_input_read: Option<u64>,
    /// Whether an external or pin-change interrupt was enabled at any time
    /// since [`Self::begin_speculation`]: then any input change matters.
    irq_armed_seen: bool,
    /// Whether the receiver was on at any time since then: it reads RXD
    /// whether or not the program ever looks at what it got.
    rx_seen: bool,
    /// Bytes sent, with the cycle each one's stop bit ended.
    pub(super) serial: Vec<(u64, u8)>,
    /// Peripherals noticed so far, one bit each: a program converting in a
    /// loop is noticed once, not on every conversion.
    noticed: u8,
    /// Peripherals first used, with the cycle of the instruction that did it.
    /// Taken away like `serial`, so a notice leaves the chip once.
    pub(super) notices: Vec<(u64, Peripheral)>,
}

impl std::fmt::Debug for Machine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Machine")
            .field("cycle", &self.cycle)
            .field("pc", &self.pc)
            .field("sp", &self.sp)
            .field("sreg", &self.sreg)
            .field("sleeping", &self.sleeping)
            .field("fault", &self.fault)
            .finish_non_exhaustive()
    }
}

/// Flash words from a byte image, little-endian, padded with erased flash.
pub fn flash_words(image: &[u8]) -> Arc<[u16]> {
    let mut words = vec![0xFFFF; FLASH_WORDS];
    for (word, pair) in words.iter_mut().zip(image.chunks(2)) {
        *word = u16::from_le_bytes([pair[0], pair.get(1).copied().unwrap_or(0xFF)]);
    }
    words.into()
}

impl Machine {
    /// The chip at power-on, `cycle` cycles into the run, clocked at
    /// `frequency` — which only the EEPROM's programming time, set in
    /// milliseconds, needs to know. Its EEPROM is erased: a reset that is
    /// not a power-on keeps the old one's.
    pub fn new(flash: Arc<[u16]>, cycle: u64, frequency: f64) -> Self {
        let mut data = [0u8; DATA_SIZE];
        // Power-on reset is the reason for the last reset.
        data[MCUSR as usize] = 0x01;
        Self {
            flash,
            data,
            pc: 0,
            sp: RAMEND,
            sreg: 0,
            cycle,
            progress: 0,
            sleeping: false,
            fault: None,
            inhibit: false,
            ddr: [0; 3],
            port: [0; 3],
            inputs: PinLevels::default(),
            timers: [
                Timer::timer0().starting_at(cycle),
                Timer::timer1().starting_at(cycle),
                Timer::timer2().starting_at(cycle),
            ],
            temp: 0,
            usart: Usart::new(),
            receiver: Receiver::default(),
            twi: Twi::new(),
            eeprom: Eeprom::new(frequency),
            adc: Adc::default(),
            stall: 0,
            eicra: 0,
            eimsk: 0,
            eifr: 0,
            pcicr: 0,
            pcifr: 0,
            pcmsk: [0; 3],
            next_event: u64::MAX,
            outputs_dirty: false,
            last_input_read: None,
            irq_armed_seen: false,
            rx_seen: false,
            serial: Vec::new(),
            noticed: 0,
            notices: Vec::new(),
        }
    }

    pub fn fault(&self) -> Option<Fault> {
        self.fault
    }

    pub fn progress(&self) -> u64 {
        self.progress
    }

    pub(super) fn fetch(&self, pc: u16) -> u16 {
        self.flash[usize::from(pc & PC_MASK)]
    }

    pub(super) fn flash_byte(&self, address: u16) -> u8 {
        let word = self.fetch(address >> 1);
        if address & 1 == 0 { word as u8 } else { (word >> 8) as u8 }
    }

    // -----------------------------------------------------------------------
    // Pins
    // -----------------------------------------------------------------------

    /// What the chip puts on its pins right now.
    pub fn outputs(&self) -> PinOutputs {
        let pull_ups_off = self.data[MCUCR as usize] & 0x10 != 0;
        let mut out = PinOutputs::default();
        for p in 0..3 {
            let shift = 8 * p;
            let ddr = u32::from(self.ddr[p]);
            let port = u32::from(self.port[p]);
            out.driven |= ddr << shift;
            out.level |= (ddr & port) << shift;
            if !pull_ups_off {
                out.pullup |= (!ddr & port & 0xFF) << shift;
            }
        }
        // A connected compare output takes the pin over from PORTx, but only
        // while DDRx makes it an output: the datasheet's "the OC0A pin must be
        // set as output".
        for &(t, ch, pin) in &COMPARE_PINS {
            let bit = 1 << pin;
            if let Some(level) = self.timers[t].pin(ch)
                && out.driven & bit != 0
            {
                out.level = (out.level & !bit) | if level { bit } else { 0 };
            }
        }
        // The receiver makes RXD an input whatever DDRD says, its pull-up
        // still PORTD0's.
        if self.usart.receiving() {
            let bit = 1 << PD0;
            out.driven &= !bit;
            out.level &= !bit;
            if !pull_ups_off && self.port[2] & 1 != 0 {
                out.pullup |= bit;
            }
        }
        // The transmitter overrides TXD whatever DDRD says.
        if self.usart.enabled() {
            let bit = 1 << PD1;
            out.driven |= bit;
            out.pullup &= !bit;
            out.level = (out.level & !bit) | if self.usart.line { bit } else { 0 };
        }
        out
    }

    /// The level each pin reads as, all three ports.
    fn pin_bits(&self) -> u32 {
        let out = self.outputs();
        let own = out.level | out.pullup;
        (self.inputs.high & !self.inputs.floating) | (own & self.inputs.floating)
    }

    /// Apply new levels from outside, as they are from cycle `at` on,
    /// catching the edges the external and pin-change interrupts and the
    /// receiver look for. Flags are raised only for an enabled interrupt.
    ///
    /// `at` matters only to the receiver, which times a frame from its start
    /// edge. The machine can stand a few cycles past `at`, an instruction
    /// being atomic, but the receiver never samples past the limit of a run,
    /// so no sample it took after `at` was of the old level.
    pub fn set_inputs(&mut self, levels: PinLevels, at: u64) {
        let before = self.pin_bits();
        self.inputs = levels;
        let after = self.pin_bits();
        let changed = before ^ after;
        if changed == 0 {
            return;
        }
        let rxd = 1 << PD0;
        if self.usart.receiving() && changed & rxd != 0 && after & rxd == 0 {
            self.receiver.falling_edge(at, self.usart.format());
        }
        for n in 0..2 {
            let bit = 1 << (PD2 + n);
            if self.eimsk & (1 << n) == 0 || changed & bit == 0 {
                continue;
            }
            let high = after & bit != 0;
            let hit = match (self.eicra >> (2 * n)) & 3 {
                1 => true,
                2 => !high,
                3 => high,
                // Low level: no flag, it is pending for as long as it is low.
                _ => false,
            };
            if hit {
                self.eifr |= 1 << n;
            }
        }
        for p in 0..3 {
            if self.pcicr & (1 << p) != 0 && (changed >> (8 * p)) as u8 & self.pcmsk[p] != 0 {
                self.pcifr |= 1 << p;
            }
        }
    }

    fn pin_irqs_armed(&self) -> bool {
        self.eimsk & 3 != 0 || self.pcicr & 7 != 0
    }

    /// Forget what was read so far: the start of a run whose inputs might be
    /// changed under it.
    pub fn begin_speculation(&mut self) {
        self.last_input_read = None;
        self.irq_armed_seen = self.pin_irqs_armed();
        self.rx_seen = self.usart.receiving();
    }

    /// Whether this run would have gone differently had the pins in
    /// `changed` changed at `cycle`: it read a pin at or after it, a pin
    /// could have interrupted, or the receiver was listening to RXD.
    pub fn depends_on_inputs_from(&self, cycle: u64, changed: u32) -> bool {
        self.irq_armed_seen
            || self.last_input_read.is_some_and(|at| at >= cycle)
            || self.rx_seen && changed & (1 << PD0) != 0
    }

    /// CPU cycles a bit lasts at the rate the receiver is set to, while it is
    /// on.
    pub fn receive_bit_cycles(&self) -> Option<u64> {
        self.usart.receiving().then(|| self.usart.format().bit_cycles())
    }

    // -----------------------------------------------------------------------
    // Data space
    // -----------------------------------------------------------------------

    pub(super) fn read(&mut self, address: u16) -> u8 {
        match address {
            0x00..=0x1F => self.data[usize::from(address)],
            0x20..=0xFF => self.read_io(address as u8),
            _ => self.data.get(usize::from(address)).copied().unwrap_or(0),
        }
    }

    pub(super) fn write(&mut self, address: u16, value: u8) {
        match address {
            0x00..=0x1F => self.data[usize::from(address)] = value,
            0x20..=0xFF => {
                self.write_io(address as u8, value);
                self.outputs_dirty = true;
            }
            _ => {
                if let Some(cell) = self.data.get_mut(usize::from(address)) {
                    *cell = value;
                }
            }
        }
    }

    /// SBI and CBI. On this part they touch only their own bit, so on a
    /// register where writing a one does something — PINx toggles, a flag
    /// clears — the other bits are not written back as they were read.
    pub(super) fn write_bit(&mut self, address: u16, bit: u8, set: bool) {
        let mask = 1 << bit;
        let strobe = matches!(address as u8, 0x23 | 0x26 | 0x29 | TIFR0..=TIFR2 | PCIFR | EIFR);
        let value = if strobe {
            if set { mask } else { 0 }
        } else {
            // `sbi ACSR, ACD` switches the comparator off; the read it does on
            // the way is not the program looking at the comparator's output.
            let old = if address == u16::from(ACSR) {
                self.data[ACSR as usize]
            } else {
                self.read(address)
            };
            if set { old | mask } else { old & !mask }
        };
        self.write(address, value);
    }

    fn timer(&mut self, t: usize) -> &mut Timer {
        let cycle = self.cycle;
        let timer = &mut self.timers[t];
        timer.sync(cycle);
        timer
    }

    fn read_io(&mut self, a: u8) -> u8 {
        match a {
            0x23 | 0x26 | 0x29 => {
                let p = usize::from((a - PINB) / 3);
                self.last_input_read = Some(self.cycle);
                let bits = (self.pin_bits() >> (8 * p)) as u8 & PORT_MASK[p];
                // A pin whose digital input DIDR0 disables reads zero.
                if p == 1 { bits & !self.adc.didr0 } else { bits }
            }
            0x24 | 0x27 | 0x2A => self.ddr[usize::from((a - 0x24) / 3)],
            0x25 | 0x28 | PORTD => self.port[usize::from((a - 0x25) / 3)],
            TIFR0..=TIFR2 => self.timer(usize::from(a - TIFR0)).flags(),
            PCIFR => self.pcifr,
            EIFR => self.eifr,
            EIMSK => self.eimsk,
            EECR => self.eeprom.control(self.cycle),
            EEDR => self.eeprom.data,
            EEARL => self.eeprom.address_byte(false),
            EEARH => self.eeprom.address_byte(true),
            TCCR0A => self.timers[0].control_a(),
            TCCR0B => self.timers[0].control_b(),
            TCNT0 => self.timer(0).count() as u8,
            OCR0A => self.timers[0].compare_value(0) as u8,
            OCR0B => self.timers[0].compare_value(1) as u8,
            SPDR => {
                // Reading the data clears the transfer-complete flag, as the
                // datasheet's "SPSR then SPDR" sequence does.
                self.data[SPSR as usize] &= 0x7F;
                self.data[SPDR as usize]
            }
            ACSR => {
                if self.data[ACSR as usize] & 0x80 == 0 {
                    self.note(Peripheral::Comparator);
                }
                self.data[ACSR as usize]
            }
            SPL => self.sp as u8,
            SPH => (self.sp >> 8) as u8,
            SREG => self.sreg,
            PCICR => self.pcicr,
            EICRA => self.eicra,
            PCMSK0..=PCMSK2 => self.pcmsk[usize::from(a - PCMSK0)],
            TIMSK0..=TIMSK2 => self.timers[usize::from(a - TIMSK0)].mask(),
            TCCR1A => self.timers[1].control_a(),
            TCCR1B => self.timers[1].control_b(),
            TCCR1C => 0,
            // Reading the low byte of TCNT1 or ICR1 latches the high byte into
            // TEMP, so the pair reads as one value even as it counts.
            TCNT1L => {
                let v = self.timer(1).count();
                self.temp = (v >> 8) as u8;
                v as u8
            }
            ICR1L => {
                let v = self.timers[1].capture();
                self.temp = (v >> 8) as u8;
                v as u8
            }
            TCNT1H | ICR1H => self.temp,
            // The compare registers read directly, without TEMP.
            OCR1AL..=OCR1BH => {
                let v = self.timers[1].compare_value(usize::from((a - OCR1AL) / 2));
                if a & 1 == 0 { v as u8 } else { (v >> 8) as u8 }
            }
            adc::ADCL => self.adc.read_low(),
            adc::ADCH => self.adc.read_high(),
            adc::ADCSRA => self.adc.status(),
            adc::ADCSRB => self.adc.adcsrb,
            adc::ADMUX => self.adc.admux,
            adc::DIDR0 => self.adc.didr0,
            TCCR2A => self.timers[2].control_a(),
            TCCR2B => self.timers[2].control_b(),
            TCNT2 => self.timer(2).count() as u8,
            OCR2A => self.timers[2].compare_value(0) as u8,
            OCR2B => self.timers[2].compare_value(1) as u8,
            UCSR0A => self.usart.status() | self.receiver.status(),
            UCSR0B => self.usart.control_b | self.receiver.ninth_bit(),
            UCSR0C => self.usart.control_c,
            UBRR0L => self.usart.baud as u8,
            UBRR0H => (self.usart.baud >> 8) as u8,
            UDR0 => self.receiver.read(),
            TWBR => self.twi.bit_rate,
            TWSR => self.twi.status(),
            TWDR => self.twi.data,
            TWCR => self.twi.control(),
            _ => self.data[usize::from(a)],
        }
    }

    fn write_io(&mut self, a: u8, v: u8) {
        match a {
            0x23 | 0x26 | 0x29 => {
                let p = usize::from((a - PINB) / 3);
                self.port[p] ^= v & PORT_MASK[p];
            }
            0x24 | 0x27 | 0x2A => {
                let p = usize::from((a - 0x24) / 3);
                self.ddr[p] = v & PORT_MASK[p];
            }
            0x25 | 0x28 | PORTD => {
                let p = usize::from((a - 0x25) / 3);
                self.port[p] = v & PORT_MASK[p];
            }
            TIFR0..=TIFR2 => self.timer(usize::from(a - TIFR0)).clear_flags(v),
            PCIFR => self.pcifr &= !v,
            EIFR => self.eifr &= !v,
            EIMSK => self.eimsk = v & 3,
            // An EEPROM read or write completes at once; see BACKLOG.md.
            EECR => {
                let cycle = self.cycle;
                self.stall = self.eeprom.write_control(v, cycle);
            }
            EEDR => self.eeprom.data = v,
            EEARL => self.eeprom.set_address_byte(false, v),
            EEARH => self.eeprom.set_address_byte(true, v),
            TCCR0A => self.timer(0).set_control_a(v),
            TCCR0B => {
                let timer = self.timer(0);
                timer.set_control_b(v & 0x3F);
                Self::force(timer, v);
            }
            TCNT0 => self.timer(0).set_count(u16::from(v)),
            OCR0A => self.timer(0).set_compare_value(0, u16::from(v)),
            OCR0B => self.timer(0).set_compare_value(1, u16::from(v)),
            SPCR => {
                if v & 0x40 != 0 {
                    self.note(Peripheral::Spi);
                }
                self.data[SPCR as usize] = v;
            }
            SPDR => {
                // A transfer completes at once and shifts in nothing, so that a
                // sketch waiting on SPIF goes on rather than hanging.
                self.data[SPDR as usize] = v;
                self.data[SPSR as usize] |= 0x80;
            }
            ACSR => {
                // ACD is bit 7, ACIE bit 3. The comparator is on from reset,
                // so being on says nothing; an interrupt asked of it does.
                if v & 0x88 == 0x08 {
                    self.note(Peripheral::Comparator);
                }
                self.data[ACSR as usize] = v;
            }
            SPL => self.sp = (self.sp & 0xFF00) | u16::from(v),
            SPH => self.sp = (self.sp & 0x00FF) | u16::from(v) << 8,
            SREG => self.sreg = v,
            WDTCSR => {
                // WDCE | WDE is the first half of the timed sequence that
                // changes the watchdog, and `wdt_disable()` writes it too; what
                // arms it is WDIE, or WDE written without WDCE.
                if v & 0x40 != 0 || v & 0x18 == 0x08 {
                    self.note(Peripheral::Watchdog);
                }
                self.data[WDTCSR as usize] = v;
            }
            PCICR => self.pcicr = v & 7,
            EICRA => self.eicra = v & 0x0F,
            PCMSK0..=PCMSK2 => self.pcmsk[usize::from(a - PCMSK0)] = v,
            TIMSK0..=TIMSK2 => self.timers[usize::from(a - TIMSK0)].set_mask(v),
            // Extended I/O, like UDR0: the write lands as the store ends, and
            // the converter's clock edges are counted from there.
            adc::ADCSRA => {
                let started = self.adc.write_status(v, self.cycle + 2);
                if started && self.adc.admux & 0x0F == adc::TEMPERATURE_CHANNEL {
                    self.note(Peripheral::Thermometer);
                }
                if self.adc.foreign_trigger() {
                    self.note(Peripheral::AdcTrigger);
                }
            }
            adc::ADCSRB => {
                self.adc.adcsrb = v & 0x47;
                if self.adc.foreign_trigger() {
                    self.note(Peripheral::AdcTrigger);
                }
            }
            // Bit 4 is reserved and reads zero.
            adc::ADMUX => self.adc.write_mux(v & 0xEF, self.cycle + 2),
            adc::DIDR0 => self.adc.didr0 = v & 0x3F,
            // The result registers are read-only.
            adc::ADCL | adc::ADCH => {}
            TCCR1A => self.timer(1).set_control_a(v),
            TCCR1B => self.timer(1).set_control_b(v),
            TCCR1C => Self::force(self.timer(1), v),
            TCNT1L => {
                let value = u16::from(self.temp) << 8 | u16::from(v);
                self.timer(1).set_count(value);
            }
            ICR1L => {
                let value = u16::from(self.temp) << 8 | u16::from(v);
                self.timer(1).set_capture(value);
            }
            OCR1AL | 0x8A => {
                let value = u16::from(self.temp) << 8 | u16::from(v);
                self.timer(1).set_compare_value(usize::from((a - OCR1AL) / 2), value);
            }
            // Writing a high byte only fills TEMP; the low byte writes both.
            TCNT1H | ICR1H | 0x89 | OCR1BH => self.temp = v,
            TCCR2A => self.timer(2).set_control_a(v),
            TCCR2B => {
                let timer = self.timer(2);
                timer.set_control_b(v & 0x3F);
                Self::force(timer, v);
            }
            TCNT2 => self.timer(2).set_count(u16::from(v)),
            OCR2A => self.timer(2).set_compare_value(0, u16::from(v)),
            OCR2B => self.timer(2).set_compare_value(1, u16::from(v)),
            UCSR0A => {
                let kept = self.usart.status & TXC & !v;
                self.usart.status = kept | (v & 0x03);
            }
            UCSR0B => {
                if v & RXEN == 0 {
                    self.receiver.disable();
                }
                // RXB80 is the receiver's to set.
                self.usart.control_b = v & !0x02;
            }
            UCSR0C => self.usart.control_c = v,
            UBRR0L => self.usart.baud = (self.usart.baud & 0x0F00) | u16::from(v),
            UBRR0H => self.usart.baud = (self.usart.baud & 0x00FF) | u16::from(v & 0x0F) << 8,
            UDR0 => {
                // Extended I/O is reached only by the two-cycle stores, and a
                // write lands as the instruction ends.
                let cycle = self.cycle + 2;
                self.usart.write(v, cycle);
            }
            TWBR => self.twi.bit_rate = v,
            TWSR => self.twi.set_status(v),
            TWDR => self.twi.write_data(v),
            TWCR => {
                if v & TWEN != 0 {
                    self.note(Peripheral::I2c);
                }
                // Extended I/O again: the bus starts as the store ends.
                self.twi.write_control(v, self.cycle + 2);
            }
            _ => self.data[usize::from(a)] = v,
        }
        if self.pin_irqs_armed() {
            self.irq_armed_seen = true;
        }
        if self.usart.receiving() {
            self.rx_seen = true;
        }
        self.refresh_next_event();
    }

    /// Record the first use of a peripheral that is not simulated.
    fn note(&mut self, peripheral: Peripheral) {
        let bit = 1 << peripheral as u8;
        if self.noticed & bit == 0 {
            self.noticed |= bit;
            self.notices.push((self.cycle, peripheral));
        }
    }

    /// The FOCnA and FOCnB strobes, bits 7 and 6 of whichever register has them.
    fn force(timer: &mut Timer, v: u8) {
        if v & 0x80 != 0 {
            timer.force(0);
        }
        if v & 0x40 != 0 {
            timer.force(1);
        }
    }

    fn refresh_next_event(&mut self) {
        self.next_event = self
            .timers
            .iter()
            .map(Timer::next_event)
            .chain([
                self.usart.next_event(),
                self.twi.next_event(),
                self.eeprom.next_event(),
                self.adc.next_event(),
            ])
            .min()
            .unwrap_or(u64::MAX);
    }

    /// Do whatever the peripherals have to do at `at`.
    fn process_events(&mut self, at: u64) {
        for timer in &mut self.timers {
            if timer.next_event() <= at {
                timer.sync(at);
            }
        }
        if self.usart.next_event() <= at {
            self.usart.event(at, &mut self.serial);
        }
        if self.twi.next_event() <= at {
            self.twi.event();
        }
        if self.eeprom.next_event() <= at {
            self.eeprom.event();
        }
        if self.adc.next_event() <= at {
            self.adc.complete();
        }
        self.progress += 1;
        self.refresh_next_event();
    }

    // -----------------------------------------------------------------------
    // Stack and interrupts
    // -----------------------------------------------------------------------

    pub(super) fn push(&mut self, value: u8) {
        self.write(self.sp, value);
        self.sp = self.sp.wrapping_sub(1);
    }

    pub(super) fn pop(&mut self) -> u8 {
        self.sp = self.sp.wrapping_add(1);
        self.read(self.sp)
    }

    /// A return address, as the hardware stacks it: low byte at the higher
    /// address, pushed first.
    pub(super) fn push_pc(&mut self, pc: u16) {
        self.push(pc as u8);
        self.push((pc >> 8) as u8);
    }

    pub(super) fn pop_pc(&mut self) -> u16 {
        let high = self.pop();
        let low = self.pop();
        u16::from_be_bytes([high, low]) & PC_MASK
    }

    /// The vector of the highest-priority interrupt asking to be served —
    /// whatever the I flag says.
    fn pending_interrupt(&self) -> Option<u8> {
        let mut external = self.eifr & self.eimsk;
        for n in 0..2 {
            let low_level = (self.eicra >> (2 * n)) & 3 == 0;
            if low_level && self.eimsk & (1 << n) != 0 && self.pin_bits() & (1 << (PD2 + n)) == 0 {
                external |= 1 << n;
            }
        }
        if external & 1 != 0 {
            return Some(1);
        }
        if external & 2 != 0 {
            return Some(2);
        }
        let changed = self.pcifr & self.pcicr & 7;
        if changed != 0 {
            return Some(3 + changed.trailing_zeros() as u8);
        }
        // Timer2, Timer1, Timer0: each with its own order of flags.
        let order: [(usize, [(u8, u8); 4]); 3] = [
            (2, [(OCFA, 7), (OCFB, 8), (TOV, 9), (0, 0)]),
            (1, [(ICF, 10), (OCFA, 11), (OCFB, 12), (TOV, 13)]),
            (0, [(OCFA, 14), (OCFB, 15), (TOV, 16), (0, 0)]),
        ];
        for (t, flags) in order {
            let pending = self.timers[t].pending();
            if let Some(&(_, vector)) = flags.iter().find(|(f, _)| pending & f != 0) {
                return Some(vector);
            }
        }
        if self.receiver.status() & receiver::RXC != 0 && self.usart.control_b & RXCIE != 0 {
            return Some(18);
        }
        let status = self.usart.status();
        if status & UDRE != 0 && self.usart.control_b & 0x20 != 0 {
            return Some(19);
        }
        if status & TXC != 0 && self.usart.control_b & 0x40 != 0 {
            return Some(20);
        }
        if self.adc.interrupt() {
            return Some(21);
        }
        if self.eeprom.interrupt() {
            return Some(22);
        }
        if self.twi.interrupt() {
            return Some(24);
        }
        None
    }

    /// The flag the hardware clears when it runs a vector. UDRE stays: it is a
    /// state, not an event, and the handler has to fill the buffer to end it.
    /// So does the TWI's TWINT, which holds the bus until the handler writes it.
    fn acknowledge(&mut self, vector: u8) {
        let clear = |m: &mut Self, t: usize, flag: u8| m.timers[t].clear_flags(flag);
        match vector {
            1 | 2 => self.eifr &= !(1 << (vector - 1)),
            3..=5 => self.pcifr &= !(1 << (vector - 3)),
            7 => clear(self, 2, OCFA),
            8 => clear(self, 2, OCFB),
            9 => clear(self, 2, TOV),
            10 => clear(self, 1, ICF),
            11 => clear(self, 1, OCFA),
            12 => clear(self, 1, OCFB),
            13 => clear(self, 1, TOV),
            14 => clear(self, 0, OCFA),
            15 => clear(self, 0, OCFB),
            16 => clear(self, 0, TOV),
            20 => self.usart.status &= !TXC,
            21 => self.adc.acknowledge(),
            _ => {}
        }
    }

    /// Four cycles to stack the return address, clear I and jump to the vector;
    /// four more when the interrupt is also what woke the CPU.
    fn interrupt(&mut self, vector: u8, waking: bool) {
        self.acknowledge(vector);
        self.push_pc(self.pc);
        self.sreg &= !(1 << I);
        self.pc = u16::from(vector) * 2;
        self.cycle += if waking { 8 } else { 4 };
        self.progress += 1;
    }

    // -----------------------------------------------------------------------
    // Running
    // -----------------------------------------------------------------------

    /// Run until a watched output changes, the CPU faults, `limit` is reached,
    /// or nothing could ever happen again.
    ///
    /// Instructions are atomic, so the run can end up to a few cycles past
    /// `limit`: one that starts before it is finished.
    pub fn run(&mut self, limit: u64, watch: &Watch) -> Stop {
        let mut seen = self.outputs();
        loop {
            while self.next_event <= self.cycle {
                let at = self.next_event;
                // A conversion cannot finish without what it sampled, and only
                // the analog side knows that.
                if self.adc.waiting(at) {
                    return Stop::Sample(at);
                }
                let sent = self.serial.len();
                self.process_events(at);
                let now = self.outputs();
                // A byte is worth stopping for too: it is the one thing a
                // serial monitor shows, and otherwise it would be seen only
                // when the run next stopped for something else.
                if now.differs(&seen, watch) || self.serial.len() > sent {
                    return Stop::Changed(at);
                }
                seen = now;
            }
            // The receiver reads a pin, and what the pin does from `limit` on
            // is not known yet: it is the one peripheral held to the limit
            // rather than to the end of the instruction that crossed it.
            self.receive_until(self.cycle.min(limit.saturating_sub(1)));
            if self.cycle >= limit {
                return Stop::Limit;
            }
            if self.fault.is_some() || self.sleeping {
                if self.fault.is_none()
                    && let Some(vector) = self.pending_interrupt()
                {
                    self.sleeping = false;
                    if self.sreg & (1 << I) != 0 {
                        self.interrupt(vector, true);
                    }
                    continue;
                }
                let next = self.next_event.min(self.receiver.next_at());
                if next == u64::MAX {
                    return Stop::Idle;
                }
                self.cycle = next.min(limit);
                continue;
            }
            let enabled = self.sreg & (1 << I) != 0 && !self.inhibit;
            match enabled.then(|| self.pending_interrupt()).flatten() {
                Some(vector) => self.interrupt(vector, false),
                None => {
                    self.inhibit = false;
                    let noticed = self.notices.len();
                    let cycles = self.execute();
                    self.progress += 1;
                    if self.fault.is_some() {
                        return Stop::Fault(self.cycle);
                    }
                    self.cycle += cycles + std::mem::take(&mut self.stall);
                    // Worth stopping for, as a byte is: otherwise the notice
                    // would wait for whatever next ends the run, up to a
                    // horizon, before anyone outside saw it.
                    if self.notices.len() > noticed {
                        return Stop::Changed(self.cycle);
                    }
                }
            }
            if std::mem::take(&mut self.outputs_dirty) {
                let now = self.outputs();
                if now.differs(&seen, watch) {
                    return Stop::Changed(self.cycle);
                }
                seen = now;
            }
        }
    }

    /// Take every receiver sample due at or before `cycle`.
    fn receive_until(&mut self, cycle: u64) {
        while self.receiver.next_at() <= cycle {
            let at = self.receiver.next_at();
            let high = self.pin_bits() & (1 << PD0) != 0;
            if self.receiver.sample(high) {
                self.receiver.falling_edge(at + self.usart.format().period, self.usart.format());
            }
            self.progress += 1;
        }
    }

    #[cfg(test)]
    pub(super) fn raise_timer_flags(&mut self, t: usize, flags: u8) {
        self.timers[t].raise(flags);
    }

    /// The sample-and-hold cycle of the conversion under way, if it has not
    /// been given what it sampled.
    pub fn adc_sample_needed(&self) -> Option<u64> {
        self.adc.sample_needed()
    }

    /// What the conversion under way sampled, for a run stopped with
    /// [`Stop::Sample`] to go on.
    pub fn give_adc_levels(&mut self, levels: AnalogLevels) {
        self.adc.give(levels);
    }

    /// Stand idle up to `cycle`: what an [`Stop::Idle`] machine does while
    /// time passes outside it.
    pub fn idle_until(&mut self, cycle: u64) {
        self.cycle = self.cycle.max(cycle);
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::asm::*;
    use super::*;

    pub fn machine(words: &[u16]) -> Machine {
        let image: Vec<u8> = words.iter().flat_map(|w| w.to_le_bytes()).collect();
        Machine::new(flash_words(&image), 0, 16e6)
    }

    /// Run until the program counter reaches word `pc`, returning the cycle.
    pub fn run_to(m: &mut Machine, pc: u16, limit: u64) -> u64 {
        let all = Watch { drive: !0, pullup: !0 };
        while m.pc != pc || m.sleeping {
            assert!(m.cycle < limit, "never reached {pc:#x}: {m:?}");
            let _ = m.run(m.cycle + 1, &all);
            assert!(m.fault.is_none(), "{m:?}");
        }
        m.cycle
    }

    #[test]
    fn the_avr_gcc_startup_sets_the_stack_and_clears_sreg() {
        // The opening of every avr-gcc program, as the bytes appear in any
        // ATmega328P disassembly:
        //   eor r1, r1 / out 0x3f, r1 / ldi r28, 0xFF / ldi r29, 0x08
        //   out 0x3e, r29 / out 0x3d, r28
        let mut m = machine(&[0x2411, 0xBE1F, 0xEFCF, 0xE0D8, 0xBFDE, 0xBFCD, 0xCFFF]);
        m.data[1] = 0x55;
        m.sreg = 0xFF;
        m.sp = 0;
        assert_eq!(run_to(&mut m, 6, 100), 6, "six one-cycle instructions");
        assert_eq!(m.data[1], 0);
        assert_eq!(m.sreg, 0);
        assert_eq!(m.sp, RAMEND);
    }

    #[test]
    fn writing_a_one_to_pin_toggles_only_that_bit() {
        // ldi r16, 0x21 / out DDRB, r16 / out PORTB, r16 / sbi PINB, 5
        let mut m = machine(&[ldi(16, 0x21), out(0x04, 16), out(0x05, 16), sbi(0x03, 5), idle()]);
        run_to(&mut m, 4, 100);
        assert_eq!(m.port[0], 0x01, "PB5 toggled off, PB0 left alone");
    }

    #[test]
    fn a_floating_input_reads_its_pull_up() {
        // Port B all inputs; PORTB bit 3 turns PB3's pull-up on.
        // ldi r16, 0x08 / out PORTB, r16 / in r17, PINB
        let mut m = machine(&[ldi(16, 0x08), out(0x05, 16), in_(17, 0x03), idle()]);
        m.set_inputs(PinLevels { high: 0x01, floating: !0x03 }, 0);
        run_to(&mut m, 3, 100);
        // PB0 is driven high outside, PB1 low; PB3 floats onto its pull-up and
        // the rest float with nothing to pull them.
        assert_eq!(m.data[17], 0x09);
        assert_eq!(m.outputs().pullup, 0x08);
    }

    #[test]
    fn a_compare_output_overrides_the_port_only_when_an_output() {
        // Timer0 in CTC, toggling OC0A (PD6) every compare.
        let mut m = machine(&[idle()]);
        m.write(0x44, 0x42);
        assert_eq!(m.outputs().driven & 1 << 22, 0, "PD6 still an input");
        m.write(0x2A, 0x40);
        assert_ne!(m.outputs().driven & 1 << 22, 0);
        m.timers[0].force(0);
        assert_ne!(m.outputs().level & 1 << 22, 0, "the latch, not PORTD, drives it");
    }

    /// What micros() does: read TCNT0, and TOV0 with interrupts off, and
    /// work out the time from them. Both have to be current at the cycle the
    /// `in` runs, however long the timer was left alone.
    #[test]
    fn timer0_reads_as_counted_whenever_it_is_read() {
        let program = [
            ldi(16, 3),    // ldi r16, 3            ; 0..1
            out(0x25, 16), // out TCCR0B, r16       ; 1..2  clk/64
            ldi(24, 250),  // ldi r24, 250          ; 2..3
            dec(24),       // dec r24               ; 3 * 250 - 1
            brne(-2),      // brne .-4              ;   = 749, to 752
            in_(17, 0x26), // in r17, TCNT0         ; at 752
            in_(20, 0x15), // in r20, TIFR0         ; at 753
            ldi(24, 0x04), // ldi r24, lo(4100)     ; 754..755
            ldi(25, 0x10), // ldi r25, hi(4100)     ; 755..756
            sbiw(24, 1),   // sbiw r24, 1           ; 4 * 4100 - 1
            brne(-2),      // brne .-4              ;   = 16 399, to 17 155
            in_(18, 0x26), // in r18, TCNT0         ; at 17 155
            in_(19, 0x15), // in r19, TIFR0         ; at 17 156
            idle(),
        ];
        let mut m = machine(&program);
        run_to(&mut m, 13, 20_000);
        // Counts at every multiple of 64: 752 / 64 = 11.75, so 11, and no
        // overflow yet; 17 155 / 64 = 268.05, so 268 counts, 12 past the
        // overflow at 256 counts — which TOV0 says happened.
        assert_eq!(m.data[17], 11);
        assert_eq!(m.data[20] & 1, 0);
        assert_eq!(m.data[18], 12);
        assert_eq!(m.data[19] & 1, 1);
    }

    #[test]
    fn timer1_sixteen_bit_registers_go_through_temp() {
        let mut m = machine(&[idle()]);
        // High byte first on a write: it waits in TEMP until the low byte.
        m.write(0x89, 0x12);
        assert_eq!(m.read(0x88), 0x00, "nothing written yet");
        m.write(0x88, 0x34);
        assert_eq!((m.read(0x89), m.read(0x88)), (0x12, 0x34));
        // TCNT1 = 0x00FE, then running at clk/1 from cycle 0.
        m.write(0x85, 0x00);
        m.write(0x84, 0xFE);
        m.write(0x81, 0x01);
        // Low byte first on a read: it latches the high byte, so the pair is
        // one value even when the counter carries between the two reads.
        m.cycle = 1;
        assert_eq!(m.read(0x84), 0xFF);
        m.cycle = 10;
        assert_eq!(m.read(0x85), 0x00, "the latched high byte, not 0x01");
        assert_eq!(m.read(0x84), 0x08);
        assert_eq!(m.read(0x85), 0x01);
    }

    #[test]
    fn a_pin_change_raises_its_port_flag_only_when_enabled() {
        let mut m = machine(&[idle()]);
        let levels = |high: u32| PinLevels { high, floating: 0 };
        m.set_inputs(levels(0), 0);
        m.set_inputs(levels(1), 0);
        assert_eq!(m.pcifr, 0, "nothing enabled");
        m.write(0x6B, 0x01); // PCMSK0: PB0
        m.write(0x68, 0x01); // PCICR: PCIE0
        m.set_inputs(levels(1 << 1), 0);
        assert_eq!(m.pcifr, 0x01, "PB0 fell");
        assert_eq!(m.pending_interrupt(), Some(3));
        m.write(0x3B, 0x01);
        m.set_inputs(levels((1 << 1) | (1 << 8)), 0);
        assert_eq!(m.pcifr, 0, "PB1 and PC0 are not in the masks");
    }

    #[test]
    fn the_transmitter_shifts_a_frame_out_lsb_first() {
        // 8N1 with UBRR0 = 0: sixteen cycles a bit, ten bits a frame.
        let mut m = machine(&[idle()]);
        m.write(u16::from(UCSR0B), TXEN);
        m.write(u16::from(UDR0), 0x48);
        let mut line = Vec::new();
        while m.next_event != u64::MAX {
            let at = m.next_event;
            m.cycle = at;
            m.process_events(at);
            line.push((at, m.usart.line));
        }
        // 'H' is 0x48, 0b0100_1000: after the start bit, 0 0 0 1 0 0 1 0,
        // then the stop bit.
        let bits: Vec<bool> = line.iter().map(|b| b.1).collect();
        assert_eq!(bits, [false, false, false, true, false, false, true, false, true, true]);
        // The write is taken as landing when the two-cycle store doing it
        // ends, so the frame starts at 2.
        assert!(line.iter().enumerate().all(|(i, (at, _))| *at == 2 + 16 * (i as u64 + 1)));
        assert_eq!(m.serial, vec![(162, 0x48)]);
        assert_ne!(m.usart.status() & TXC, 0);
    }

    #[test]
    fn a_second_byte_waits_in_the_buffer() {
        let mut m = machine(&[idle()]);
        m.write(u16::from(UCSR0B), TXEN);
        m.write(u16::from(UDR0), b'a');
        assert_ne!(m.read(u16::from(UCSR0A)) & UDRE, 0, "the first goes straight out");
        m.write(u16::from(UDR0), b'b');
        assert_eq!(m.read(u16::from(UCSR0A)) & UDRE, 0, "the second fills the buffer");
        let none = Watch::default();
        while m.run(10_000, &none) != Stop::Limit {}
        assert_eq!(m.serial, vec![(162, b'a'), (322, b'b')]);
        assert_eq!(m.read(u16::from(UCSR0A)) & (UDRE | TXC), UDRE | TXC);
    }

    /// What the Arduino `Wire` library does, cut down: an interrupt handler
    /// that answers a START with an address, and anything else with a STOP.
    /// With nobody on the bus, the address is NACKed and the handler is
    /// entered twice, when each action's bit times say.
    #[test]
    fn the_twi_interrupt_walks_an_empty_bus_through_start_address_and_stop() {
        let mut program = vec![nop(); 76];
        program[0] = rjmp(49); // reset -> main, word 50
        program[48] = rjmp(11); // TWI, vector 24 -> isr, word 60
        let main = [
            ldi(30, 0x00), // ldi r30, lo(0x100)    ; 2..3   Z: where statuses go
            ldi(31, 0x01), // ldi r31, hi(0x100)    ; 3..4
            ldi(16, 72),   // ldi r16, 72           ; 4..5   160 cycles a bit
            sts(0xB8, 16)[0],
            0x00B8,        // sts TWBR, r16         ; 5..7
            ldi(16, 0xA5), // ldi r16, TWINT | TWSTA | TWEN | TWIE
            sts(0xBC, 16)[0],
            0x00BC, // sts TWCR, r16         ; 8..10  START from 10
            sei(),  // sei                   ; 10..11
            idle(), // rjmp .                ; from 11, every 2
            // isr:
            lds(20, 0xB9)[0],
            0x00B9,        // lds r20, TWSR
            st_z_inc(20),  // st Z+, r20
            sbrs(20, 3),   // sbrs r20, 3          ; a START is 0x08
            rjmp(7),       // rjmp stop
            ldi(16, 0x4E), // ldi r16, 0x27 << 1   ; SLA+W
            sts(0xBB, 16)[0],
            0x00BB,        // sts TWDR, r16
            ldi(16, 0x85), // ldi r16, TWINT | TWEN | TWIE
            sts(0xBC, 16)[0],
            0x00BC,        // sts TWCR, r16
            reti(),        // reti
            ldi(16, 0x95), // stop: ldi r16, TWINT | TWSTO | TWEN | TWIE
            sts(0xBC, 16)[0],
            0x00BC, // sts TWCR, r16
            reti(), // reti
        ];
        program[50..76].copy_from_slice(&main);
        let mut m = machine(&program);
        // SCL = 16 MHz / (16 + 2 · 72) = 100 kHz: 160 cycles a bit.
        //
        // The START goes from 10 and is done a bit later, at 170; the idle
        // loop's boundaries are odd, so it is served at 171: 4 cycles of
        // response and `rjmp isr` 2.
        assert_eq!(run_to(&mut m, 60, 10_000), 170 + 1 + 4 + 2);
        // lds 2, st 2, sbrs skipping 2, ldi 1, sts 2, ldi 1, sts 2: the
        // address goes from 177 + 12 = 189, nine bits to the NACK at 1629 —
        // a boundary of the idle loop again after `reti` — and the handler
        // starts 4 + 2 later.
        let _ = m.run(m.cycle + 1, &Watch::default());
        assert_eq!(run_to(&mut m, 60, 10_000), 189 + 9 * 160 + 4 + 2);
        // lds 2, st 2, sbrs 1, rjmp 2, ldi 1, sts 2: the STOP from 1645.
        run_to(&mut m, 75, 10_000);
        assert_eq!(m.cycle, 1635 + 10);
        assert_eq!(m.twi.next_event(), 1645 + 160);
        assert_ne!(m.read(u16::from(TWCR)) & 0x10, 0, "TWSTO stays until the STOP is out");
        while m.run(5_000, &Watch::default()) != Stop::Limit {}
        assert_eq!(m.read(u16::from(TWCR)) & 0x90, 0, "TWSTO cleared, and TWINT never set");
        assert_eq!(m.read(u16::from(TWSR)) & 0xF8, 0xF8);
        assert_eq!(&m.data[0x100..0x103], &[0x08, 0x20, 0x00], "a START, an SLA+W NACK, no more");
        assert_eq!(m.notices, vec![(8, Peripheral::I2c)]);
    }

    /// avr-libc's way: read a byte, write one and poll EEPE until the write
    /// is done, read it back. A read halts the CPU four cycles and a write
    /// two, and the write takes 3.4 ms: 54 400 cycles at 16 MHz.
    #[test]
    fn an_eeprom_write_holds_eepe_for_the_programming_time() {
        let program = [
            ldi(16, 5),    // ldi r16, 5            ; 0..1
            out(0x21, 16), // out EEARL, r16        ; 1..2
            sbi(0x1F, 0),  // sbi EECR, EERE        ; 2..4, halted to 8
            in_(17, 0x20), // in r17, EEDR          ; 8..9
            ldi(16, 42),   // ldi r16, 42           ; 9..10
            out(0x20, 16), // out EEDR, r16         ; 10..11
            sbi(0x1F, 2),  // sbi EECR, EEMPE       ; 11..13
            sbi(0x1F, 1),  // sbi EECR, EEPE        ; 13..15, halted to 17
            sbic(0x1F, 1), // wait: sbic EECR, EEPE ; 1, or 2 skipping
            rjmp(-2),      // rjmp wait             ; 2
            sbi(0x1F, 0),  // sbi EECR, EERE
            in_(18, 0x20), // in r18, EEDR
            idle(),
        ];
        let mut m = machine(&program);
        assert_eq!(run_to(&mut m, 3, 100), 8, "the `in` waits out the halt");
        run_to(&mut m, 4, 100);
        assert_eq!(m.data[17], 0xFF, "erased");
        assert_eq!(run_to(&mut m, 8, 100), 17);
        // The write began at 13 and is done at 13 + 54 400 = 54 413. The poll
        // loop is 3 cycles from 17, so an `sbic` starts on 54 413 exactly,
        // sees EEPE clear and skips.
        assert_eq!(run_to(&mut m, 10, 100_000), 54_413 + 2);
        run_to(&mut m, 12, 100_000);
        assert_eq!(m.data[18], 42);
    }

    #[test]
    fn ee_ready_interrupts_when_the_write_is_done() {
        let mut program = vec![nop(); 55];
        program[0] = rjmp(45); // reset -> main, word 46
        program[44] = rjmp(8); // EE_READY, vector 22 -> isr, word 53
        let main = [
            ldi(16, 42),   // ldi r16, 42           ; 2..3
            out(0x20, 16), // out EEDR, r16         ; 3..4
            sbi(0x1F, 2),  // sbi EECR, EEMPE       ; 4..6
            sbi(0x1F, 1),  // sbi EECR, EEPE        ; 6..8, halted to 10
            sbi(0x1F, 3),  // sbi EECR, EERIE       ; 10..12
            sei(),         // sei                   ; 12..13
            idle(),        // rjmp .                ; from 13, every 2
            cbi(0x1F, 3),  // isr: cbi EECR, EERIE
            reti(),
        ];
        program[46..55].copy_from_slice(&main);
        let mut m = machine(&program);
        // Done at 6 + 54 400 = 54 406, served at the idle loop's next
        // boundary, 54 407: 4 cycles of response, `rjmp isr` 2.
        assert_eq!(run_to(&mut m, 53, 100_000), 54_407 + 4 + 2);
        // The handler turned it off, so it does not come round again.
        while m.run(60_000, &Watch::default()) != Stop::Limit {}
        assert_eq!(m.pc, 52);
    }

    #[test]
    fn a_peripheral_is_noticed_once_at_the_instruction_that_first_used_it() {
        let mut m = machine(&[idle()]);
        let at = |m: &mut Machine, cycle: u64, address: u8, value: u8| {
            m.cycle = cycle;
            m.write(u16::from(address), value);
        };
        // A conversion of ADC0 is simulated; one of the temperature sensor is
        // not, and is noticed when it starts — twice is not news.
        at(&mut m, 10, adc::ADMUX, 0x40);
        at(&mut m, 11, adc::ADCSRA, 0xC7);
        at(&mut m, 12, adc::ADCSRA, 0x00);
        at(&mut m, 19, adc::ADMUX, 0xC8);
        at(&mut m, 20, adc::ADCSRA, 0xC7);
        at(&mut m, 30, adc::ADCSRA, 0x00);
        at(&mut m, 31, adc::ADCSRA, 0xC7);
        // `wdt_disable()`: WDCE | WDE, then nothing.
        at(&mut m, 40, WDTCSR, 0x18);
        at(&mut m, 41, WDTCSR, 0x00);
        // `sbi ACSR, ACD` switches the comparator off, and reading it off is
        // not using it.
        m.cycle = 50;
        m.write_bit(u16::from(ACSR), 7, true);
        let _ = m.read(u16::from(ACSR));
        assert_eq!(m.notices, vec![(20, Peripheral::Thermometer)]);
        // `wdt_enable(WDTO_1S)`: WDCE | WDE, then WDE and the prescaler.
        at(&mut m, 60, WDTCSR, 0x18);
        at(&mut m, 61, WDTCSR, 0x0E);
        at(&mut m, 70, SPCR, 0x50);
        at(&mut m, 80, TWCR, 0x45);
        // On again, the comparator's output is read.
        at(&mut m, 90, ACSR, 0x00);
        m.cycle = 91;
        let _ = m.read(u16::from(ACSR));
        let _ = m.read(u16::from(ACSR));
        // Free running is simulated; a timer as the trigger is not.
        at(&mut m, 100, adc::ADCSRA, 0xA7);
        at(&mut m, 101, adc::ADCSRB, 0x05);
        assert_eq!(
            m.notices,
            vec![
                (20, Peripheral::Thermometer),
                (61, Peripheral::Watchdog),
                (70, Peripheral::Spi),
                (80, Peripheral::I2c),
                (91, Peripheral::Comparator),
                (101, Peripheral::AdcTrigger),
            ]
        );
    }

    #[test]
    fn a_notice_ends_a_run_like_a_byte_does() {
        // ldi r16, SPE / out SPCR, r16 / idle.
        let mut m = machine(&[ldi(16, 0x40), out(0x2C, 16), idle()]);
        assert_eq!(m.run(1_000, &Watch::default()), Stop::Changed(2));
        assert_eq!(m.notices, vec![(1, Peripheral::Spi)]);
    }

    /// Levels with ADC0 at `volts` and AVCC at 5 V.
    fn on_adc0(volts: f64) -> AnalogLevels {
        AnalogLevels { channels: [volts, 0.0, 0.0, 0.0, 0.0, 0.0], avcc: 5.0, ..Default::default() }
    }

    /// `analogRead()` as the Arduino core has it, cut down: ADMUX, ADSC, wait
    /// for ADSC to clear, ADCL then ADCH. The run stops where the conversion
    /// is to complete, having said when it sampled, and goes on once told.
    #[test]
    fn a_conversion_waits_at_its_end_for_what_it_sampled() {
        let program = [
            ldi(16, 0x87), // ldi r16, ADEN | 128         ; 0..1
            sts(0x7A, 16)[0],
            0x007A,        // sts ADCSRA, r16             ; 1..3   prescaler from 3
            ldi(16, 0x40), // ldi r16, REFS0              ; 3..4
            sts(0x7C, 16)[0],
            0x007C,        // sts ADMUX, r16              ; 4..6
            ldi(16, 0xC7), // ldi r16, ADEN | ADSC | 128  ; 6..7
            sts(0x7A, 16)[0],
            0x007A, //        sts ADCSRA, r16             ; 7..9
            lds(17, 0x7A)[0],
            0x007A,      //   wait: lds r17, ADCSRA       ; 2
            sbrc(17, 6), //   sbrc r17, ADSC              ; 1, or 2 skipping
            rjmp(-4),    //   rjmp wait                   ; 2
            lds(18, 0x78)[0],
            0x0078, //        lds r18, ADCL
            lds(19, 0x79)[0],
            0x0079, //        lds r19, ADCH
            idle(),
        ];
        let mut m = machine(&program);
        let all = Watch { drive: !0, pullup: !0 };
        // ADEN lands at 3 and ADSC at 9: the conversion starts on the ADC
        // clock edge after 9, at 3 + 128 = 131. It is the first since the
        // converter was switched on, so it samples 13.5 ADC clocks in and is
        // done 25 in.
        let done = 131 + 25 * 128;
        assert_eq!(m.run(100_000, &all), Stop::Sample(done));
        assert_eq!(m.adc_sample_needed(), Some(131 + 27 * 64));
        assert_eq!(m.data[18], 0, "nothing read yet");
        m.give_adc_levels(on_adc0(3.0));
        // 3 · 1024 / 5 = 614.4: 0x266.
        run_to(&mut m, 17, 100_000);
        assert_eq!((m.data[18], m.data[19]), (0x66, 0x02));
        // The wait loop is 5 cycles a pass from 9, and the `lds` of the first
        // pass to start at or after `done` sees ADSC clear: it, the skipping
        // `sbrc`, and the two reads.
        let last = 9 + 5 * (done - 9).div_ceil(5);
        assert_eq!(m.cycle, last + 2 + 2 + 2 + 2);
    }

    #[test]
    fn the_adc_interrupt_is_vector_21() {
        let mut program = vec![nop(); 52];
        program[0] = rjmp(43); // reset -> main, word 44
        program[42] = rjmp(6); // ADC, vector 21 -> isr, word 49
        let main = [
            sei(),         // sei                               ; 2..3
            ldi(16, 0xCC), // ldi r16, ADEN | ADSC | ADIE | 16  ; 3..4
            sts(0x7A, 16)[0],
            0x007A, //        sts ADCSRA, r16                   ; 4..6
            idle(), //        rjmp .
            lds(20, 0x79)[0],
            0x0079, //        isr: lds r20, ADCH
            idle(),
        ];
        program[44..52].copy_from_slice(&main);
        let mut m = machine(&program);
        // ADSC lands at 6, the prescaler released at 6 too, and the first
        // edge 16 later: done 25 ADC clocks after 22.
        let done = 22 + 25 * 16;
        assert_eq!(m.run(100_000, &Watch::default()), Stop::Sample(done));
        m.give_adc_levels(on_adc0(5.0));
        run_to(&mut m, 51, 100_000);
        // 5 V against AVCC at 5 V reads all ones, and running the vector
        // cleared ADIF.
        assert_eq!(m.data[20], 0x03);
        assert!(!m.adc.interrupt());
        assert_eq!(m.read(u16::from(adc::ADCSRA)) & 0x50, 0);
    }

    #[test]
    fn didr0_makes_a_port_c_pin_read_zero() {
        let mut m = machine(&[idle()]);
        m.set_inputs(PinLevels { high: 0x3F << 8, floating: 0 });
        assert_eq!(m.read(0x26), 0x3F);
        m.write(u16::from(adc::DIDR0), 0x05);
        assert_eq!(m.read(0x26), 0x3A);
    }

    // -----------------------------------------------------------------------
    // The receiver
    // -----------------------------------------------------------------------

    /// RXD high or low, every other pin left to the chip.
    fn rxd(high: bool) -> PinLevels {
        PinLevels { high: if high { 1 << PD0 } else { 0 }, floating: !(1 << PD0) }
    }

    /// Run to `cycle`, however little there is to do on the way.
    fn run_until(m: &mut Machine, cycle: u64) {
        loop {
            match m.run(cycle, &Watch::default()) {
                Stop::Limit => return,
                Stop::Idle => return m.idle_until(cycle),
                _ => {}
            }
        }
    }

    /// Put levels on RXD at the cycles given the way the device does: the
    /// machine run up to each change, then told of it.
    fn drive_rxd(m: &mut Machine, levels: &[(u64, bool)]) {
        for &(at, high) in levels {
            run_until(m, at);
            m.set_inputs(rxd(high), at);
        }
    }

    /// A frame from `start`, `bit` cycles a bit: the start bit, `width` bits
    /// of `data` least significant first, then `tail` — parity, stop.
    fn frame(start: u64, bit: u64, data: u16, width: u16, tail: &[bool]) -> Vec<(u64, bool)> {
        std::iter::once(false)
            .chain((0..width).map(|i| data >> i & 1 != 0))
            .chain(tail.iter().copied())
            .enumerate()
            .map(|(i, level)| (start + i as u64 * bit, level))
            .collect()
    }

    /// A chip listening on an idle line, its USART set up as given.
    fn listening(a: u8, b: u8, c: u8, ubrr: u8) -> Machine {
        let mut m = machine(&[idle()]);
        m.set_inputs(rxd(true), 0);
        m.write(u16::from(UCSR0A), a);
        m.write(u16::from(UCSR0C), c);
        m.write(u16::from(UBRR0L), ubrr);
        m.write(u16::from(UCSR0B), RXEN | b);
        m
    }

    const RXC0: u8 = 0x80;
    const FE0: u8 = 0x10;
    const DOR0: u8 = 0x08;
    const UPE0: u8 = 0x04;

    #[test]
    fn a_byte_is_complete_at_the_stop_bits_last_vote() {
        // UBRR0 = 0 at normal speed: a sample every cycle, sixteen a bit, and
        // samples 8, 9 and 10 vote — 7, 8 and 9 cycles into each bit. The stop
        // bit is the tenth, from 100 + 9 · 16 = 244: its last vote at 253.
        let mut m = listening(0, 0, 0x06, 0);
        drive_rxd(&mut m, &frame(100, 16, 0xA5, 8, &[true]));
        run_until(&mut m, 253);
        assert_eq!(m.read(u16::from(UCSR0A)) & RXC0, 0, "an instruction at 252 does not see it");
        run_until(&mut m, 254);
        assert_eq!(m.read(u16::from(UCSR0A)) & (RXC0 | FE0 | DOR0 | UPE0), RXC0);
        assert_eq!(m.read(u16::from(UDR0)), 0xA5);
        assert_eq!(m.read(u16::from(UCSR0A)) & RXC0, 0, "reading UDR0 empties it");

        // U2X0 with UBRR0 = 1: a sample every two cycles, eight a bit — the
        // same sixteen cycles — and samples 4, 5 and 6 vote, at 6, 8 and 10.
        let mut m = listening(0x02, 0, 0x06, 1);
        drive_rxd(&mut m, &frame(100, 16, 0x3C, 8, &[true]));
        run_until(&mut m, 254);
        assert_eq!(m.read(u16::from(UCSR0A)) & RXC0, 0);
        run_until(&mut m, 255);
        assert_eq!(m.read(u16::from(UDR0)), 0x3C);
    }

    #[test]
    fn two_of_three_samples_in_the_middle_of_a_bit_decide_it() {
        // A byte of zeros with high glitches inside some of its bits, placed
        // against the three voting samples 7, 8 and 9 cycles into each bit:
        // before them, on one, on two, on the last two, on the last one.
        let mut m = listening(0, 0, 0x06, 0);
        let bit = |i: u64| 100 + 16 * (i + 1);
        let mut levels = vec![(100, false)];
        for (i, from, to) in [(0, 0, 7), (1, 8, 9), (2, 7, 9), (5, 8, 16), (7, 9, 15)] {
            levels.push((bit(i) + from, true));
            levels.push((bit(i) + to, false));
        }
        levels.push((244, true));
        drive_rxd(&mut m, &levels);
        run_until(&mut m, 300);
        // Bits 2 and 5 had two votes high.
        assert_eq!(m.read(u16::from(UCSR0A)) & (RXC0 | FE0), RXC0);
        assert_eq!(m.read(u16::from(UDR0)), 0x24);
    }

    #[test]
    fn a_start_bit_that_does_not_last_to_its_middle_is_noise() {
        // Low for eight cycles: the first vote, at 107, reads low and the
        // other two high, so it is not a start bit; a real frame after it is
        // received as if it had not happened.
        let mut m = listening(0, 0, 0x06, 0);
        drive_rxd(&mut m, &[(100, false), (108, true)]);
        drive_rxd(&mut m, &frame(200, 16, 0x5A, 8, &[true]));
        run_until(&mut m, 400);
        assert_eq!(m.read(u16::from(UDR0)), 0x5A);
        assert_eq!(m.read(u16::from(UCSR0A)) & RXC0, 0, "one byte, not two");
    }

    #[test]
    fn a_low_stop_bit_is_a_framing_error() {
        let mut m = listening(0, 0, 0x06, 0);
        // The stop bit low, and the line back up a bit later.
        drive_rxd(&mut m, &frame(100, 16, 0x41, 8, &[false, true]));
        drive_rxd(&mut m, &frame(400, 16, 0x42, 8, &[true]));
        run_until(&mut m, 600);
        assert_eq!(m.read(u16::from(UCSR0A)) & (RXC0 | FE0), RXC0 | FE0);
        assert_eq!(m.read(u16::from(UDR0)), 0x41, "the data is kept all the same");
        assert_eq!(m.read(u16::from(UCSR0A)) & (RXC0 | FE0), RXC0, "the flag goes with its byte");
        assert_eq!(m.read(u16::from(UDR0)), 0x42);
    }

    #[test]
    fn a_fourth_byte_unread_loses_the_third() {
        // Two bytes fit in UDR0's buffer and a third waits in the shift
        // register; the fourth's start bit finds nowhere for it and it is
        // lost. The fourth goes in when there is room, marked with DOR0.
        let mut m = listening(0, 0, 0x06, 0);
        for (k, byte) in b"abcd".iter().copied().enumerate() {
            drive_rxd(&mut m, &frame(100 + 160 * k as u64, 16, byte.into(), 8, &[true]));
        }
        run_until(&mut m, 1_000);
        let mut read = Vec::new();
        while m.read(u16::from(UCSR0A)) & RXC0 != 0 {
            let dor = m.read(u16::from(UCSR0A)) & DOR0 != 0;
            read.push((m.read(u16::from(UDR0)), dor));
        }
        assert_eq!(read, vec![(b'a', false), (b'b', false), (b'd', true)]);
    }

    #[test]
    fn parity_is_checked_against_the_data() {
        // 8E1: the parity bit makes the number of ones even. 0x03 has two,
        // so its parity bit is 0; 0x07 has three, so a 0 is wrong.
        let mut m = listening(0, 0, 0x26, 0);
        drive_rxd(&mut m, &frame(100, 16, 0x03, 8, &[false, true]));
        drive_rxd(&mut m, &frame(300, 16, 0x07, 8, &[false, true]));
        run_until(&mut m, 500);
        assert_eq!(m.read(u16::from(UCSR0A)) & UPE0, 0);
        assert_eq!(m.read(u16::from(UDR0)), 0x03);
        assert_eq!(m.read(u16::from(UCSR0A)) & UPE0, UPE0);
        assert_eq!(m.read(u16::from(UDR0)), 0x07);
        // 8O1: odd, so for 0x07 a parity bit of 0 is right.
        let mut m = listening(0, 0, 0x36, 0);
        drive_rxd(&mut m, &frame(100, 16, 0x07, 8, &[false, true]));
        run_until(&mut m, 300);
        assert_eq!(m.read(u16::from(UCSR0A)) & (RXC0 | UPE0), RXC0);
    }

    #[test]
    fn a_ninth_bit_lands_in_rxb8() {
        // UCSZ0 = 7: nine data bits, the ninth read from UCSR0B.
        let mut m = listening(0, 0x04, 0x06, 0);
        drive_rxd(&mut m, &frame(100, 16, 0x1A5, 9, &[true]));
        run_until(&mut m, 300);
        assert_eq!(m.read(u16::from(UCSR0B)) & 0x02, 0x02);
        assert_eq!(m.read(u16::from(UDR0)), 0xA5);
        assert_eq!(m.read(u16::from(UCSR0B)) & 0x02, 0, "with the buffer empty");
    }

    #[test]
    fn switching_the_receiver_off_flushes_it_and_stops_it_listening() {
        let mut m = listening(0, 0, 0x06, 0);
        drive_rxd(&mut m, &frame(100, 16, 0x11, 8, &[true]));
        run_until(&mut m, 300);
        m.write(u16::from(UCSR0B), 0);
        assert_eq!(m.read(u16::from(UCSR0A)) & RXC0, 0, "flushed");
        drive_rxd(&mut m, &frame(300, 16, 0x22, 8, &[true]));
        run_until(&mut m, 500);
        m.write(u16::from(UCSR0B), RXEN);
        assert_eq!(m.read(u16::from(UCSR0A)) & RXC0, 0, "nothing was received while off");
    }

    #[test]
    fn the_receiver_makes_rxd_an_input_whatever_ddrd_says() {
        // DDRD0 and PORTD0 set: a high output, until RXEN0 makes it an input
        // with its pull-up on.
        let mut m = machine(&[idle()]);
        m.write(0x2A, 0x01);
        m.write(0x2B, 0x01);
        assert_ne!(m.outputs().driven & 1 << PD0, 0);
        m.write(u16::from(UCSR0B), RXEN);
        let out = m.outputs();
        assert_eq!(out.driven & 1 << PD0, 0);
        assert_ne!(out.pullup & 1 << PD0, 0);
    }
}
