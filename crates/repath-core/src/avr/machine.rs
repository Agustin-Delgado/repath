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

use super::timer::{ICF, OCFA, OCFB, TOV, Timer};

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
const TCCR0A: u8 = 0x44;
const TCCR0B: u8 = 0x45;
const TCNT0: u8 = 0x46;
const OCR0A: u8 = 0x47;
const OCR0B: u8 = 0x48;
const SPSR: u8 = 0x4D;
const SPDR: u8 = 0x4E;
pub(super) const SMCR: u8 = 0x53;
const MCUSR: u8 = 0x54;
const MCUCR: u8 = 0x55;
const SPL: u8 = 0x5D;
const SPH: u8 = 0x5E;
const SREG: u8 = 0x5F;
const PCICR: u8 = 0x68;
const EICRA: u8 = 0x69;
const PCMSK0: u8 = 0x6B;
const PCMSK2: u8 = 0x6D;
const TIMSK0: u8 = 0x6E;
const TIMSK2: u8 = 0x70;
const ADCSRA: u8 = 0x7A;
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
const UCSR0A: u8 = 0xC0;
const UCSR0B: u8 = 0xC1;
const UCSR0C: u8 = 0xC2;
const UBRR0L: u8 = 0xC4;
const UBRR0H: u8 = 0xC5;
const UDR0: u8 = 0xC6;

/// Pins are numbered `port * 8 + bit`, ports B, C, D as 0, 1, 2.
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

/// Why [`Machine::run`] stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// A watched output changed, or a byte finished going out, at this cycle.
    Changed(u64),
    /// The CPU faulted at this cycle.
    Fault(u64),
    /// The limit was reached.
    Limit,
    /// Asleep or stopped with nothing that could ever wake it: no timer
    /// running, no byte going out. Only an input can change anything now.
    Idle,
}

/// USART0's transmitter. The receiver is not modelled.
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
    /// Bytes sent, with the cycle each one's stop bit ended.
    pub(super) serial: Vec<(u64, u8)>,
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
    /// The chip at power-on, `cycle` cycles into the run: what a reset is.
    pub fn new(flash: Arc<[u16]>, cycle: u64) -> Self {
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
            serial: Vec::new(),
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

    /// Apply new levels from outside, catching the edges the external and
    /// pin-change interrupts look for. Flags are raised only for an enabled
    /// interrupt.
    pub fn set_inputs(&mut self, levels: PinLevels) {
        let before = self.pin_bits();
        self.inputs = levels;
        let after = self.pin_bits();
        let changed = before ^ after;
        if changed == 0 {
            return;
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
    }

    /// Whether this run would have gone differently had the inputs changed at
    /// `cycle`: it read a pin at or after it, or a pin could have interrupted.
    pub fn depends_on_inputs_from(&self, cycle: u64) -> bool {
        self.irq_armed_seen || self.last_input_read.is_some_and(|at| at >= cycle)
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
            let old = self.read(address);
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
                (self.pin_bits() >> (8 * p)) as u8 & PORT_MASK[p]
            }
            0x24 | 0x27 | 0x2A => self.ddr[usize::from((a - 0x24) / 3)],
            0x25 | 0x28 | PORTD => self.port[usize::from((a - 0x25) / 3)],
            TIFR0..=TIFR2 => self.timer(usize::from(a - TIFR0)).flags(),
            PCIFR => self.pcifr,
            EIFR => self.eifr,
            EIMSK => self.eimsk,
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
            TCCR2A => self.timers[2].control_a(),
            TCCR2B => self.timers[2].control_b(),
            TCNT2 => self.timer(2).count() as u8,
            OCR2A => self.timers[2].compare_value(0) as u8,
            OCR2B => self.timers[2].compare_value(1) as u8,
            UCSR0A => self.usart.status(),
            UCSR0B => self.usart.control_b,
            UCSR0C => self.usart.control_c,
            UBRR0L => self.usart.baud as u8,
            UBRR0H => (self.usart.baud >> 8) as u8,
            // Nothing is ever received.
            UDR0 => 0,
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
            EECR => self.data[EECR as usize] = v & !0x03,
            TCCR0A => self.timer(0).set_control_a(v),
            TCCR0B => {
                let timer = self.timer(0);
                timer.set_control_b(v & 0x3F);
                Self::force(timer, v);
            }
            TCNT0 => self.timer(0).set_count(u16::from(v)),
            OCR0A => self.timer(0).set_compare_value(0, u16::from(v)),
            OCR0B => self.timer(0).set_compare_value(1, u16::from(v)),
            SPDR => {
                // A transfer completes at once and shifts in nothing, so that a
                // sketch waiting on SPIF goes on rather than hanging.
                self.data[SPDR as usize] = v;
                self.data[SPSR as usize] |= 0x80;
            }
            SPL => self.sp = (self.sp & 0xFF00) | u16::from(v),
            SPH => self.sp = (self.sp & 0x00FF) | u16::from(v) << 8,
            SREG => self.sreg = v,
            PCICR => self.pcicr = v & 7,
            EICRA => self.eicra = v & 0x0F,
            PCMSK0..=PCMSK2 => self.pcmsk[usize::from(a - PCMSK0)] = v,
            TIMSK0..=TIMSK2 => self.timers[usize::from(a - TIMSK0)].set_mask(v),
            // A conversion completes at once and reads zero, so analogRead()
            // returns rather than waiting on ADSC for ever.
            ADCSRA => {
                let mut v = v;
                if v & 0x40 != 0 {
                    v = (v & !0x40) | 0x10;
                    self.data[0x78] = 0;
                    self.data[0x79] = 0;
                }
                self.data[ADCSRA as usize] = v;
            }
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
            UCSR0B => self.usart.control_b = v,
            UCSR0C => self.usart.control_c = v,
            UBRR0L => self.usart.baud = (self.usart.baud & 0x0F00) | u16::from(v),
            UBRR0H => self.usart.baud = (self.usart.baud & 0x00FF) | u16::from(v & 0x0F) << 8,
            UDR0 => {
                // Extended I/O is reached only by the two-cycle stores, and a
                // write lands as the instruction ends.
                let cycle = self.cycle + 2;
                self.usart.write(v, cycle);
            }
            _ => self.data[usize::from(a)] = v,
        }
        if self.pin_irqs_armed() {
            self.irq_armed_seen = true;
        }
        self.refresh_next_event();
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
            .chain([self.usart.next_event()])
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
        let status = self.usart.status();
        if status & UDRE != 0 && self.usart.control_b & 0x20 != 0 {
            return Some(19);
        }
        if status & TXC != 0 && self.usart.control_b & 0x40 != 0 {
            return Some(20);
        }
        None
    }

    /// The flag the hardware clears when it runs a vector. UDRE stays: it is a
    /// state, not an event, and the handler has to fill the buffer to end it.
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
                if self.next_event == u64::MAX {
                    return Stop::Idle;
                }
                self.cycle = self.next_event.min(limit);
                continue;
            }
            let enabled = self.sreg & (1 << I) != 0 && !self.inhibit;
            match enabled.then(|| self.pending_interrupt()).flatten() {
                Some(vector) => self.interrupt(vector, false),
                None => {
                    self.inhibit = false;
                    let cycles = self.execute();
                    self.progress += 1;
                    if self.fault.is_some() {
                        return Stop::Fault(self.cycle);
                    }
                    self.cycle += cycles;
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

    #[cfg(test)]
    pub(super) fn raise_timer_flags(&mut self, t: usize, flags: u8) {
        self.timers[t].raise(flags);
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
        Machine::new(flash_words(&image), 0)
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
        m.set_inputs(PinLevels { high: 0x01, floating: !0x03 });
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
        m.set_inputs(levels(0));
        m.set_inputs(levels(1));
        assert_eq!(m.pcifr, 0, "nothing enabled");
        m.write(0x6B, 0x01); // PCMSK0: PB0
        m.write(0x68, 0x01); // PCICR: PCIE0
        m.set_inputs(levels(1 << 1));
        assert_eq!(m.pcifr, 0x01, "PB0 fell");
        assert_eq!(m.pending_interrupt(), Some(3));
        m.write(0x3B, 0x01);
        m.set_inputs(levels((1 << 1) | (1 << 8)));
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
}
