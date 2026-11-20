//! The MAX7219: a serially interfaced driver for eight digits of seven
//! segments and a point, or — as on the modules most people buy — an 8×8 LED
//! matrix, one digit register a row.
//!
//! From the datasheet: a 16-bit shift register takes DIN on every rising edge
//! of CLK, whatever LOAD is doing; the rising edge of LOAD latches the last
//! sixteen bits in, D15–D12 ignored, D11–D8 the register's address and D7–D0
//! its data. DOUT is the bit sixteen and a half clocks behind DIN, changing on
//! CLK's falling edge, so that several in a chain each take the word meant for
//! them on one LOAD. The registers: no-op (0), the eight digits (1–8), the
//! decode mode (9), the intensity (A), the scan limit (B), shutdown (C) and the
//! display test (F). At power-up the control registers are reset, the display
//! blank and the chip in shutdown.
//!
//! Not modelled: what the display draws, its 800 Hz scan, and the brightness
//! of a digit depending on how many are scanned; a register written while the
//! chip is unpowered (the editor powers it or not, and the engine only sees a
//! powered one). The digit registers power up random on a real chip; here
//! they power up blank, which is what every library writes them to first.

use crate::digital::{DigitalDevice, EvalCtx, Logic, NetId};

/// DOUT's delay after CLK's falling edge, the datasheet's tDO.
const DOUT_DELAY: f64 = 25e-9;

/// The segments of each Code B character, DP excluded, in the order of the
/// no-decode bits: D6 = A, D5 = B, … D0 = G. 0–9, then -, E, H, L, P, blank.
const CODE_B: [u8; 16] = [
    0x7E, 0x30, 0x6D, 0x79, 0x33, 0x5B, 0x5F, 0x70, 0x7F, 0x7B, 0x01, 0x4F, 0x37, 0x0E, 0x67, 0x00,
];

/// The registers, as the program has written them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Registers {
    /// Digits 0 to 7: on a matrix module, rows 0 to 7, D7 the leftmost dot.
    pub digits: [u8; 8],
    /// One bit a digit: decode its low nibble as Code B.
    pub decode: u8,
    /// 0 to 15: a duty cycle of (2n + 1) / 32.
    pub intensity: u8,
    /// The highest digit scanned, 0 to 7.
    pub scan_limit: u8,
    pub shutdown: bool,
    pub test: bool,
}

impl Default for Registers {
    fn default() -> Self {
        Self { digits: [0; 8], decode: 0, intensity: 0, scan_limit: 0, shutdown: true, test: false }
    }
}

impl Registers {
    /// A 16-bit word as LOAD latches it. Whether anything changed.
    pub fn latch(&mut self, word: u16) -> bool {
        let data = word as u8;
        let before = *self;
        match (word >> 8) & 0x0F {
            0x0 => {}
            digit @ 0x1..=0x8 => self.digits[usize::from(digit - 1)] = data,
            0x9 => self.decode = data,
            0xA => self.intensity = data & 0x0F,
            0xB => self.scan_limit = data & 0x07,
            0xC => self.shutdown = data & 1 == 0,
            0xF => self.test = data & 1 != 0,
            // 0xD and 0xE are not registers.
            _ => {}
        }
        *self != before
    }

    /// What each digit lights, DP as D7 and A–G as D6–D0: on a matrix, the
    /// dots of each row. The display test lights everything whatever else is
    /// set, shutdown blanks it, and only digits up to the scan limit are
    /// driven.
    pub fn lit(&self) -> [u8; 8] {
        if self.test {
            return [0xFF; 8];
        }
        let mut lit = [0; 8];
        if self.shutdown {
            return lit;
        }
        for (n, (out, &value)) in lit.iter_mut().zip(&self.digits).enumerate() {
            if n > usize::from(self.scan_limit) {
                break;
            }
            *out = if self.decode >> n & 1 != 0 {
                value & 0x80 | CODE_B[usize::from(value & 0x0F)]
            } else {
                value
            };
        }
        lit
    }

    /// The brightness the display is driven at, from 0 to 1: the display
    /// test runs at full intensity.
    pub fn duty(&self) -> f64 {
        let n = if self.test { 15 } else { self.intensity };
        f64::from(2 * n + 1) / 32.0
    }
}

#[derive(Debug, Clone)]
pub struct Max7219 {
    pub name: String,
    din: NetId,
    clk: NetId,
    load: NetId,
    dout: Option<NetId>,
    inputs: Vec<NetId>,
    outputs: Vec<NetId>,
    /// The last sixteen bits clocked in, the newest as bit 0.
    shift: u16,
    prev_clk: Logic,
    prev_load: Logic,
    /// What DOUT was last driven to.
    dout_level: Logic,
    registers: Registers,
    /// Bumped whenever the registers change, so whoever draws the display
    /// can tell a new picture from the same one.
    version: u64,
    /// The instant they last changed, in seconds.
    changed_at: f64,
}

impl Max7219 {
    pub fn new(
        name: impl Into<String>,
        din: NetId,
        clk: NetId,
        load: NetId,
        dout: Option<NetId>,
    ) -> Self {
        Self {
            name: name.into(),
            din,
            clk,
            load,
            dout,
            inputs: vec![din, clk, load],
            outputs: dout.into_iter().collect(),
            shift: 0,
            prev_clk: Logic::Unknown,
            prev_load: Logic::Unknown,
            dout_level: Logic::Unknown,
            registers: Registers::default(),
            version: 0,
            changed_at: 0.0,
        }
    }

    pub fn registers(&self) -> &Registers {
        &self.registers
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    pub fn changed_at(&self) -> f64 {
        self.changed_at
    }

    fn drive_dout(&mut self, ctx: &mut EvalCtx, delay: f64) {
        let Some(net) = self.dout else { return };
        let level = Logic::from_bool(self.shift & 0x8000 != 0);
        if level != self.dout_level {
            self.dout_level = level;
            ctx.drive(0, net, level, delay);
        }
    }
}

impl DigitalDevice for Max7219 {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "max7219"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.reset();
        self.prev_clk = ctx.read(self.clk);
        self.prev_load = ctx.read(self.load);
        // Never high impedance, the datasheet says; the empty register is a 0.
        self.drive_dout(ctx, 0.0);
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        let clk = ctx.read(self.clk);
        let load = ctx.read(self.load);
        let rising = |prev: Logic, now: Logic| prev == Logic::Low && now == Logic::High;
        if rising(self.prev_clk, clk) {
            // An input left floating or unknown is taken as a 0.
            let din = ctx.read(self.din) == Logic::High;
            self.shift = self.shift << 1 | u16::from(din);
        } else if self.prev_clk == Logic::High && clk == Logic::Low {
            self.drive_dout(ctx, DOUT_DELAY);
        }
        // Latched as LOAD rises: the datasheet allows it to rise with the
        // sixteenth clock edge, so a clock edge seen at the same instant has
        // already been shifted in.
        if rising(self.prev_load, load) && self.registers.latch(self.shift) {
            self.version += 1;
            self.changed_at = ctx.now;
        }
        self.prev_clk = clk;
        self.prev_load = load;
    }

    fn reset(&mut self) {
        self.shift = 0;
        self.prev_clk = Logic::Unknown;
        self.prev_load = Logic::Unknown;
        self.dout_level = Logic::Unknown;
        self.registers = Registers::default();
        self.version = 0;
        self.changed_at = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::digital::{DigitalDomain, LogicSource};

    /// The flips of DIN, CLK and LOAD that send `words` MSB first, as
    /// `shiftOut()` and LedControl do: LOAD low, sixteen clocks with the data
    /// set up before each rising edge, LOAD high. One microsecond a step.
    fn waveforms(words: &[u16]) -> [Vec<f64>; 3] {
        let mut flips: [Vec<f64>; 3] = Default::default();
        let mut levels = [false; 3];
        let mut t = 1e-6;
        let mut set = |which: usize, level: bool, t: f64, flips: &mut [Vec<f64>; 3]| {
            if levels[which] != level {
                levels[which] = level;
                flips[which].push(t);
            }
        };
        // LOAD idles high.
        set(2, true, t, &mut flips);
        for &word in words {
            t += 1e-6;
            set(2, false, t, &mut flips);
            for bit in (0..16).rev() {
                t += 1e-6;
                set(0, word >> bit & 1 != 0, t, &mut flips);
                t += 1e-6;
                set(1, true, t, &mut flips);
                t += 1e-6;
                set(1, false, t, &mut flips);
            }
            t += 1e-6;
            set(2, true, t, &mut flips);
        }
        flips
    }

    /// A MAX7219 sent `words`, with DOUT on a net of its own: the chip, and
    /// the instants DOUT went high.
    fn send(words: &[u16]) -> (Max7219, Vec<f64>) {
        let mut domain = DigitalDomain::new();
        let nets = [domain.add_net("din"), domain.add_net("clk"), domain.add_net("load")];
        let dout = domain.add_net("dout");
        for (net, flips) in nets.iter().zip(waveforms(words)) {
            let source = LogicSource::new(format!("S{net}"), *net, Logic::Low).operated_at(flips);
            domain.add_device(Box::new(source));
        }
        domain.add_device(Box::new(Max7219::new("M1", nets[0], nets[1], nets[2], Some(dout))));
        domain.initialize();
        domain.settle(1e-3);
        let rises = domain
            .take_log()
            .iter()
            .filter(|t| t.net == dout && t.state == Logic::High)
            .map(|t| t.time)
            .collect();
        (crate::spi::find_max7219(&domain, "M1").unwrap().clone(), rises)
    }

    #[test]
    fn it_powers_up_blank_and_shut_down() {
        let r = Registers::default();
        assert!(r.shutdown);
        assert_eq!(r.lit(), [0; 8]);
    }

    /// What LedControl's constructor writes, then a row: display test off,
    /// scan limit 7, no decode, out of shutdown, intensity 8, and row 2.
    #[test]
    fn the_words_ledcontrol_sends_light_a_row() {
        let (chip, _) = send(&[0x0F00, 0x0B07, 0x0900, 0x0C01, 0x0A08, 0x0381]);
        let r = chip.registers();
        assert!(!r.shutdown && !r.test);
        assert_eq!((r.scan_limit, r.intensity, r.decode), (7, 8, 0));
        assert_eq!(r.lit(), [0, 0, 0x81, 0, 0, 0, 0, 0]);
        assert_eq!(r.duty(), 17.0 / 32.0);
        assert_eq!(chip.version(), 4, "the display test and decode were already off");
    }

    #[test]
    fn decode_mode_draws_code_b_and_the_scan_limit_blanks_the_rest() {
        let mut r = Registers::default();
        for word in [0x0C01, 0x0B02, 0x0905, 0x0108, 0x0287, 0x038D, 0x0401] {
            r.latch(word);
        }
        // Digit 0 decoded as 8, digit 1 raw 0x87, digit 2 decoded L with
        // its point; digit 3 is past the limit.
        assert_eq!(r.lit()[..4], [0x7F, 0x87, 0x80 | 0x0E, 0x00]);
        r.latch(0x0F01);
        assert_eq!(r.lit(), [0xFF; 8], "display test");
        assert_eq!(r.duty(), 31.0 / 32.0);
        r.latch(0x0F00);
        r.latch(0x0C00);
        assert_eq!(r.lit(), [0; 8], "shutdown keeps the digits but lights nothing");
        assert_eq!(r.digits[1], 0x87);
    }

    #[test]
    fn dout_follows_din_sixteen_and_a_half_clocks_later() {
        // Two words; the first comes out of DOUT while the second goes in,
        // as the next chip in a chain would take it. 0x8001: its D15 is the
        // top bit of the register after the 16th rising edge and goes out at
        // the falling edge after it, in time for the next chip's 17th rising
        // edge; its D0 follows fifteen clocks later. Word w starts 2 + 50w µs
        // in, and the n-th clock of it falls 3n + 3 µs after that.
        let (chip, rises) = send(&[0x8001, 0x0000]);
        let fall = |n: usize| (2 + 50 * (n / 16) + 3 * (n % 16) + 3) as f64 * 1e-6;
        let expected = [fall(15) + DOUT_DELAY, fall(30) + DOUT_DELAY];
        assert_eq!(rises.len(), 2, "{rises:?}");
        for (got, want) in rises.iter().zip(expected) {
            assert!((got - want).abs() < 1e-12, "{rises:?} against {expected:?}");
        }
        assert_eq!(chip.registers().lit(), [0; 8], "address 0 is the no-op");
    }
}
