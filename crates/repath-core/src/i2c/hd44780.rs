//! The HD44780 dot-matrix LCD controller: the chip on the back of every 16×2
//! character display.
//!
//! It is driven through its pins — RS, R/W, E and the data bus — the way a
//! backpack's port drives them, and does what the instruction table of the
//! Hitachi datasheet says, taking the execution times printed there for an
//! oscillator at 270 kHz: 37 µs an instruction or a data write, 1.52 ms to
//! clear or return home. While it is busy it ignores what it is sent, which is
//! what the datasheet warns of; LiquidCrystal and its I2C cousins wait fixed
//! times longer than these, so a sketch written against them never meets it.
//!
//! Its display is a 16×2 module: what is drawn is the 16 columns either line's
//! window shows, with the display shift. On the glass, the bias of the 1-line
//! mode the controller powers up in, applied to a module whose contrast is set
//! for two lines, shows the first line's dots all dark and the second blank;
//! that is drawn too, since it is how somebody knows a module was never
//! initialised. The contrast itself is not modelled: it is the trimmer on the
//! backpack, set where text reads.
//!
//! Not modelled: the 5×10 font (a 1602's glass has eight rows a character);
//! the 4 µs after the busy flag clears before the address counter moves;
//! CGRAM's contents at power-on, which are whatever the RAM came up as and are
//! taken as zero; and timing the pins violate (E pulses shorter than 450 ns),
//! which an I2C expander cannot produce at any bus speed.

use super::a00;

/// The controller's clock, the datasheet's typical: what its timings are for.
const OSCILLATOR: f64 = 270e3;
/// Every instruction but two, and a data read or write: 10 clocks.
pub const EXECUTION: f64 = 37e-6;
/// Clear display and return home.
pub const LONG_EXECUTION: f64 = 1.52e-3;
/// How long after power-on the internal reset holds the busy flag.
pub const POWER_ON_BUSY: f64 = 10e-3;
/// The cursor's blink: alternating every 409.6 ms at 250 kHz, the clock that
/// figure is given for — 102 400 clocks — and so 379 ms at 270 kHz.
pub const BLINK_INTERVAL: f64 = 102_400.0 / OSCILLATOR;

/// Columns of the module's glass, and its lines.
pub const COLUMNS: usize = 16;
pub const LINES: usize = 2;
/// Characters of DDRAM each line has in 2-line mode, and in 1-line mode.
const LINE_LENGTH: u8 = 40;
const ONE_LINE_LENGTH: u8 = 80;

/// What the glass shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Screen {
    /// Each character position's dots, line by line, left to right: eight rows
    /// of five, the top row first and the leftmost dot as bit 4.
    pub cells: [[u8; 8]; COLUMNS * LINES],
    /// The cell with the underline cursor in it.
    pub cursor: Option<usize>,
    /// The cell blinking, which alternates with all its dots dark every
    /// [`BLINK_INTERVAL`].
    pub blink: Option<usize>,
    /// The first line's unlit dots show dark: the controller is in 1-line mode.
    pub overdriven: bool,
}

#[derive(Debug, Clone)]
pub struct Hd44780 {
    // The interface.
    eight_bit: bool,
    /// In 4-bit mode, whether the next E is the second half of a transfer.
    second_half: bool,
    /// A write's first half, waiting for its second.
    upper: u8,
    e: bool,
    /// RS and R/W as they were when E rose, which is when the datasheet has
    /// them set up.
    rs: bool,
    rw: bool,
    /// What it puts on D7–D0 while a read holds E high.
    driving: Option<u8>,

    // The registers and memories.
    address: u8,
    in_cgram: bool,
    increment: bool,
    shift_on_entry: bool,
    display_on: bool,
    cursor_on: bool,
    blink_on: bool,
    two_lines: bool,
    /// The DDRAM address the first column of each line shows, less the line's
    /// own start: how far the display has been shifted left.
    shift: u8,
    ddram: [u8; 128],
    cgram: [u8; 64],
    busy_until: f64,
    /// Instructions and data that arrived while it was busy and were lost.
    pub ignored: u32,
}

impl Default for Hd44780 {
    fn default() -> Self {
        Self::new()
    }
}

impl Hd44780 {
    /// As the internal reset leaves it, powered at time zero: 8-bit
    /// interface, one line, display off, the display cleared, incrementing
    /// with no shift — and busy for its first 10 ms.
    pub fn new() -> Self {
        Self {
            eight_bit: true,
            second_half: false,
            upper: 0,
            e: false,
            rs: false,
            rw: false,
            driving: None,
            address: 0,
            in_cgram: false,
            increment: true,
            shift_on_entry: false,
            display_on: false,
            cursor_on: false,
            blink_on: false,
            two_lines: false,
            shift: 0,
            ddram: [b' '; 128],
            cgram: [0; 64],
            busy_until: POWER_ON_BUSY,
            ignored: 0,
        }
    }

    pub fn address_counter(&self) -> u8 {
        self.address
    }

    pub fn busy(&self, time: f64) -> bool {
        time < self.busy_until
    }

    pub fn ddram(&self, address: u8) -> u8 {
        self.ddram[usize::from(address & 0x7F)]
    }

    pub fn cgram(&self, address: u8) -> u8 {
        self.cgram[usize::from(address & 0x3F)]
    }

    pub fn eight_bit(&self) -> bool {
        self.eight_bit
    }

    pub fn two_lines(&self) -> bool {
        self.two_lines
    }

    /// What it is putting on the data bus, D7 to D0: only while a read holds
    /// E high. In 4-bit mode that is one half of the byte at a time, on D7–D4.
    pub fn output(&self) -> Option<u8> {
        self.driving
    }

    /// The pins as they are from `time` on. `data` is D7–D0; in 4-bit mode
    /// only D7–D4 are read.
    pub fn set_pins(&mut self, rs: bool, rw: bool, e: bool, data: u8, time: f64) {
        if e && !self.e {
            self.rs = rs;
            self.rw = rw;
            if rw {
                let byte = self.read_value(time);
                self.driving =
                    Some(if self.eight_bit || !self.second_half { byte } else { byte << 4 });
            }
        } else if !e && self.e {
            // Written data is taken on the falling edge.
            self.driving = None;
            self.falling_edge(data, time);
        }
        self.e = e;
    }

    fn falling_edge(&mut self, data: u8, time: f64) {
        let byte = if self.eight_bit {
            data
        } else if !self.second_half {
            self.second_half = true;
            self.upper = data & 0xF0;
            return;
        } else {
            self.second_half = false;
            self.upper | data >> 4
        };
        if self.rw {
            // A data read is over: the counter moves on, as after a write.
            if self.rs {
                self.step_address(self.increment);
            }
        } else {
            self.execute(self.rs, byte, time);
        }
    }

    /// The byte a read returns: the busy flag and the address counter, or the
    /// data at the counter.
    fn read_value(&self, time: f64) -> u8 {
        if self.rs {
            if self.in_cgram { self.cgram(self.address) } else { self.ddram(self.address) }
        } else {
            (u8::from(self.busy(time)) << 7) | self.address
        }
    }

    /// An instruction (`rs` low) or a byte of data (`rs` high), complete at
    /// `time`.
    fn execute(&mut self, rs: bool, byte: u8, time: f64) {
        if self.busy(time) {
            self.ignored += 1;
            return;
        }
        let mut takes = EXECUTION;
        if rs {
            if self.in_cgram {
                self.cgram[usize::from(self.address & 0x3F)] = byte;
            } else {
                self.ddram[usize::from(self.address & 0x7F)] = byte;
            }
            self.step_address(self.increment);
            if self.shift_on_entry && !self.in_cgram {
                // Shifting with the entry keeps the cursor still on the glass:
                // incrementing moves the display left.
                self.shift_display(!self.increment);
            }
        } else if byte & 0x80 != 0 {
            self.address = byte & 0x7F;
            self.in_cgram = false;
        } else if byte & 0x40 != 0 {
            self.address = byte & 0x3F;
            self.in_cgram = true;
        } else if byte & 0x20 != 0 {
            let eight_bit = byte & 0x10 != 0;
            if eight_bit != self.eight_bit {
                self.second_half = false;
            }
            self.eight_bit = eight_bit;
            self.two_lines = byte & 0x08 != 0;
        } else if byte & 0x10 != 0 {
            let right = byte & 0x04 != 0;
            if byte & 0x08 != 0 {
                self.shift_display(right);
            } else {
                self.step_address(right);
            }
        } else if byte & 0x08 != 0 {
            self.display_on = byte & 0x04 != 0;
            self.cursor_on = byte & 0x02 != 0;
            self.blink_on = byte & 0x01 != 0;
        } else if byte & 0x04 != 0 {
            self.increment = byte & 0x02 != 0;
            self.shift_on_entry = byte & 0x01 != 0;
        } else if byte & 0x02 != 0 {
            self.address = 0;
            self.in_cgram = false;
            self.shift = 0;
            takes = LONG_EXECUTION;
        } else if byte & 0x01 != 0 {
            // Spaces everywhere, home, and incrementing again; the entry
            // shift is left as it was.
            self.ddram = [b' '; 128];
            self.address = 0;
            self.in_cgram = false;
            self.shift = 0;
            self.increment = true;
            takes = LONG_EXECUTION;
        } else {
            // 0x00 is not an instruction.
            return;
        }
        self.busy_until = time + takes;
    }

    /// The address counter one character on or back. DDRAM is two runs of 40
    /// in 2-line mode, 0x00–0x27 and 0x40–0x67, the end of each leading into
    /// the start of the other; one run of 80 in 1-line mode. CGRAM is 64
    /// bytes round.
    fn step_address(&mut self, forward: bool) {
        let a = self.address;
        self.address = if self.in_cgram {
            if forward { (a + 1) & 0x3F } else { a.wrapping_sub(1) & 0x3F }
        } else if self.two_lines {
            match (forward, a) {
                (true, 0x27) => 0x40,
                (true, 0x67) => 0x00,
                (true, _) => a + 1,
                (false, 0x00) => 0x67,
                (false, 0x40) => 0x27,
                (false, _) => a - 1,
            }
        } else if forward {
            (a + 1) % ONE_LINE_LENGTH
        } else {
            (a + ONE_LINE_LENGTH - 1) % ONE_LINE_LENGTH
        };
    }

    /// The display one position right (content moves right) or left.
    fn shift_display(&mut self, right: bool) {
        let n = self.line_length();
        self.shift = if right { (self.shift + n - 1) % n } else { (self.shift + 1) % n };
    }

    fn line_length(&self) -> u8 {
        if self.two_lines { LINE_LENGTH } else { ONE_LINE_LENGTH }
    }

    /// The dots of character code `code`: CGRAM for 0x00–0x0F, the eight
    /// patterns appearing twice; the A00 ROM above that.
    fn glyph(&self, code: u8) -> [u8; 8] {
        if code < 0x10 {
            let base = usize::from(code & 7) * 8;
            let mut rows = [0; 8];
            for (row, byte) in rows.iter_mut().zip(&self.cgram[base..base + 8]) {
                *row = byte & 0x1F;
            }
            rows
        } else {
            a00::glyph(code)
        }
    }

    /// What the 16×2 glass shows.
    pub fn screen(&self) -> Screen {
        let mut screen = Screen {
            cells: [[0; 8]; COLUMNS * LINES],
            cursor: None,
            blink: None,
            overdriven: !self.two_lines,
        };
        if !self.display_on {
            return screen;
        }
        let n = self.line_length();
        // In 1-line mode the second line's commons are not driven at all.
        let lines = if self.two_lines { LINES } else { 1 };
        for line in 0..lines {
            for column in 0..COLUMNS {
                let offset = (self.shift + column as u8) % n;
                let address = if line == 0 { offset } else { 0x40 + offset };
                let cell = line * COLUMNS + column;
                screen.cells[cell] = self.glyph(self.ddram(address));
                if !self.in_cgram && self.address == address {
                    if self.cursor_on {
                        screen.cursor = Some(cell);
                    }
                    if self.blink_on {
                        screen.blink = Some(cell);
                    }
                }
            }
        }
        screen
    }

    /// The text on the glass, a line at a time, for tests and for anyone
    /// reading a run without drawing it. Codes 0x20–0x7D are their ASCII
    /// selves but for 0x5C, which the ROM has as a yen sign; anything else,
    /// custom characters included, is a `?`. Blank while the display is off.
    pub fn text(&self) -> [String; LINES] {
        let line = |base: u8| -> String {
            if !self.display_on || (base != 0 && !self.two_lines) {
                return " ".repeat(COLUMNS);
            }
            let n = self.line_length();
            (0..COLUMNS as u8)
                .map(|c| {
                    let code = self.ddram(base + (self.shift + c) % n);
                    if (0x20..=0x7D).contains(&code) && code != 0x5C { code as char } else { '?' }
                })
                .collect()
        };
        [line(0), line(0x40)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A controller on a 4-bit bus, the way a backpack drives it: each half
    /// put on D7–D4 and clocked in by a pulse on E, a microsecond each way.
    struct Bus {
        lcd: Hd44780,
        t: f64,
    }

    impl Bus {
        /// Past the power-on busy time, in 8-bit mode.
        fn new() -> Self {
            Self { lcd: Hd44780::new(), t: 20e-3 }
        }

        fn pulse(&mut self, rs: bool, rw: bool, data: u8) {
            self.lcd.set_pins(rs, rw, false, data, self.t);
            self.lcd.set_pins(rs, rw, true, data, self.t + 1e-6);
            self.lcd.set_pins(rs, rw, false, data, self.t + 2e-6);
            self.t += 2e-6;
        }

        /// One byte in 4-bit mode, the high half first, then `wait`.
        fn send(&mut self, rs: bool, byte: u8, wait: f64) {
            self.pulse(rs, false, byte & 0xF0);
            self.pulse(rs, false, byte << 4);
            self.t += wait;
        }

        /// The datasheet's 4-bit initialisation by instruction (figure 24),
        /// then 2 lines, display on, cleared, incrementing.
        fn init(&mut self) {
            for wait in [4.1e-3, 100e-6, 100e-6] {
                // D3–D0 are not wired on a 4-bit bus; the controller's pull-ups
                // hold them high.
                self.pulse(false, false, 0x3F);
                self.t += wait;
            }
            self.pulse(false, false, 0x2F);
            self.t += 100e-6;
            self.send(false, 0x28, 100e-6);
            self.send(false, 0x0C, 100e-6);
            self.send(false, 0x01, 2e-3);
            self.send(false, 0x06, 100e-6);
        }

        fn print(&mut self, text: &str) {
            for b in text.bytes() {
                self.send(true, b, 50e-6);
            }
        }
    }

    #[test]
    fn it_powers_up_in_eight_bit_one_line_mode_with_the_display_off() {
        let lcd = Hd44780::new();
        assert!(lcd.eight_bit() && !lcd.two_lines());
        let screen = lcd.screen();
        assert!(screen.overdriven, "1-line mode: the first line shows as blocks");
        assert!(screen.cells.iter().all(|c| *c == [0; 8]), "display off");
        // Busy until the internal reset is done.
        assert!(lcd.busy(9.9e-3) && !lcd.busy(10e-3));
    }

    #[test]
    fn instructions_during_the_power_on_reset_are_lost() {
        let mut lcd = Hd44780::new();
        lcd.set_pins(false, false, true, 0x28, 1e-3);
        lcd.set_pins(false, false, false, 0x28, 2e-3);
        assert_eq!(lcd.ignored, 1);
        assert!(!lcd.two_lines());
    }

    #[test]
    fn the_four_bit_initialisation_ends_in_two_line_mode_taking_the_high_half_first() {
        let mut bus = Bus::new();
        bus.init();
        assert!(!bus.lcd.eight_bit() && bus.lcd.two_lines());
        assert_eq!(bus.lcd.ignored, 0);
        bus.print("Hi");
        assert_eq!(bus.lcd.ddram(0x00), b'H');
        assert_eq!(bus.lcd.ddram(0x01), b'i');
        assert_eq!(bus.lcd.address_counter(), 2);
        assert_eq!(bus.lcd.text()[0], format!("Hi{}", " ".repeat(14)));
        assert!(!bus.lcd.screen().overdriven);
    }

    #[test]
    fn line_two_starts_at_0x40_and_the_counter_runs_from_one_line_into_the_other() {
        let mut bus = Bus::new();
        bus.init();
        bus.send(false, 0x80 | 0x40, 50e-6);
        bus.print("ab");
        assert_eq!(bus.lcd.text()[1], format!("ab{}", " ".repeat(14)));
        // 0x27 is the 40th character of line one; the next goes to 0x40.
        bus.send(false, 0x80 | 0x27, 50e-6);
        bus.print("xy");
        assert_eq!((bus.lcd.ddram(0x27), bus.lcd.ddram(0x40)), (b'x', b'y'));
        assert_eq!(bus.lcd.address_counter(), 0x41);
        // And the end of line two wraps to the start of line one.
        bus.send(false, 0x80 | 0x67, 50e-6);
        bus.print("z");
        assert_eq!(bus.lcd.address_counter(), 0x00);
    }

    #[test]
    fn clear_takes_1_52_ms_and_what_comes_sooner_is_lost() {
        let mut bus = Bus::new();
        bus.init();
        bus.print("abc");
        // Clear, then a character 1.5 ms after its last half went in: lost.
        bus.send(false, 0x01, 1.5e-3 - 2e-6);
        bus.print("X");
        assert_eq!(bus.lcd.ignored, 1);
        assert_eq!(bus.lcd.text()[0], " ".repeat(16));
        // The one after, sent 1.52 ms on, is taken.
        let mut bus = Bus::new();
        bus.init();
        bus.send(false, 0x01, LONG_EXECUTION - 2e-6);
        bus.print("X");
        assert_eq!(bus.lcd.ignored, 0);
        assert_eq!(bus.lcd.ddram(0), b'X');
    }

    #[test]
    fn an_ordinary_instruction_takes_37_us() {
        let mut bus = Bus::new();
        bus.init();
        // A data write, then the next one complete 36 µs after it: lost.
        // Each byte is two pulses of 2 µs, so the wait is 4 µs short of that.
        bus.send(true, b'a', 36e-6 - 4e-6);
        bus.send(true, b'b', 0.0);
        assert_eq!(bus.lcd.ignored, 1);
        assert_eq!(&bus.lcd.text()[0][..2], "a ");
        // 37.5 µs after: taken.
        let mut bus = Bus::new();
        bus.init();
        bus.send(true, b'a', 37.5e-6 - 4e-6);
        bus.send(true, b'b', 0.0);
        assert_eq!(bus.lcd.ignored, 0);
        assert_eq!(&bus.lcd.text()[0][..2], "ab");
    }

    #[test]
    fn the_busy_flag_and_the_address_read_back_a_half_at_a_time() {
        let mut bus = Bus::new();
        bus.init();
        bus.send(false, 0x80 | 0x45, 0.0);
        // Read straight away: busy, address 0x45. The high half comes on the
        // first E, the low half on the second, both on D7–D4.
        bus.lcd.set_pins(false, true, true, 0xFF, bus.t + 1e-6);
        assert_eq!(bus.lcd.output(), Some(0x80 | 0x45));
        bus.lcd.set_pins(false, true, false, 0xFF, bus.t + 2e-6);
        bus.lcd.set_pins(false, true, true, 0xFF, bus.t + 3e-6);
        assert_eq!(bus.lcd.output().map(|d| d & 0xF0), Some(0x50));
        bus.lcd.set_pins(false, true, false, 0xFF, bus.t + 4e-6);
        assert_eq!(bus.lcd.output(), None);
        // After 37 µs the flag is down.
        bus.lcd.set_pins(false, true, true, 0xFF, bus.t + 40e-6);
        assert_eq!(bus.lcd.output(), Some(0x45));
    }

    #[test]
    fn eight_custom_characters_live_in_cgram_and_show_twice() {
        let mut bus = Bus::new();
        bus.init();
        // Character 2's eight rows, as createChar(2, ...) writes them.
        let heart = [0x00, 0x0A, 0x1F, 0x1F, 0x0E, 0x04, 0x00, 0x00];
        bus.send(false, 0x40 | 2 << 3, 50e-6);
        for row in heart {
            bus.send(true, row, 50e-6);
        }
        assert_eq!(bus.lcd.cgram(2 << 3 | 7), 0x00);
        // Back to DDRAM, and code 2 then its alias 10.
        bus.send(false, 0x80, 50e-6);
        bus.send(true, 2, 50e-6);
        bus.send(true, 10, 50e-6);
        let screen = bus.lcd.screen();
        assert_eq!(screen.cells[0], heart);
        assert_eq!(screen.cells[1], heart);
    }

    #[test]
    fn printable_ascii_comes_from_the_rom() {
        let mut bus = Bus::new();
        bus.init();
        bus.print("AH");
        let screen = bus.lcd.screen();
        // The datasheet's table, A and H, as five dots by seven.
        assert_eq!(screen.cells[0], [0x0E, 0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0]);
        assert_eq!(screen.cells[1], [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11, 0]);
        assert_eq!(screen.cells[2], [0; 8], "a space");
    }

    #[test]
    fn the_cursor_and_the_blink_sit_where_the_counter_is() {
        let mut bus = Bus::new();
        bus.init();
        bus.print("ab");
        assert_eq!(bus.lcd.screen().cursor, None, "init turned it off");
        bus.send(false, 0x0F, 50e-6);
        let screen = bus.lcd.screen();
        assert_eq!((screen.cursor, screen.blink), (Some(2), Some(2)));
        bus.send(false, 0x80 | 0x43, 50e-6);
        assert_eq!(bus.lcd.screen().cursor, Some(16 + 3));
        // Moving the cursor left: one instruction, the counter back by one.
        bus.send(false, 0x10, 50e-6);
        assert_eq!(bus.lcd.address_counter(), 0x42);
        // Off with the display, then back on.
        bus.send(false, 0x08, 50e-6);
        assert_eq!(bus.lcd.screen().cells[0], [0; 8]);
        bus.send(false, 0x0C, 50e-6);
        assert_eq!(bus.lcd.text()[0].trim_end(), "ab");
        assert!((BLINK_INTERVAL - 0.3793).abs() < 1e-4);
    }

    #[test]
    fn shifting_the_display_moves_both_lines_and_home_puts_it_back() {
        let mut bus = Bus::new();
        bus.init();
        bus.print("0123456789ABCDEFG");
        bus.send(false, 0x80 | 0x40, 50e-6);
        bus.print("line two");
        // Display shift left: column 0 shows address 1.
        bus.send(false, 0x18, 50e-6);
        assert_eq!(bus.lcd.text()[0], "123456789ABCDEFG");
        assert_eq!(bus.lcd.text()[1], format!("ine two{}", " ".repeat(9)));
        // Right twice: column 0 shows address 39, the end of the line.
        bus.send(false, 0x1C, 50e-6);
        bus.send(false, 0x1C, 50e-6);
        assert_eq!(bus.lcd.text()[0], " 0123456789ABCDE");
        bus.send(false, 0x02, 2e-3);
        assert_eq!(bus.lcd.text()[0], "0123456789ABCDEF");
        assert_eq!(bus.lcd.address_counter(), 0);
    }

    #[test]
    fn entry_mode_decrements_and_shifts() {
        let mut bus = Bus::new();
        bus.init();
        // Decrement: "ab" written from address 5 lands at 5 then 4.
        bus.send(false, 0x04, 50e-6);
        bus.send(false, 0x80 | 5, 50e-6);
        bus.print("ab");
        assert_eq!((bus.lcd.ddram(5), bus.lcd.ddram(4)), (b'a', b'b'));
        assert_eq!(bus.lcd.address_counter(), 3);
        // Increment with shift: each character moves the display left one.
        bus.send(false, 0x07, 50e-6);
        bus.send(false, 0x80, 50e-6);
        bus.print("xyz");
        // Shifted left by three: the first column shows address 3, a space,
        // then the "b" and "a" written backwards at 4 and 5.
        assert_eq!(&bus.lcd.text()[0][..3], " ba");
    }

    #[test]
    fn clear_resets_the_counter_and_the_direction() {
        let mut bus = Bus::new();
        bus.init();
        bus.send(false, 0x04, 50e-6);
        bus.print("q");
        bus.send(false, 0x01, 2e-3);
        bus.print("ok");
        assert_eq!(bus.lcd.text()[0].trim_end(), "ok", "incrementing again from 0");
    }

    #[test]
    fn a_data_read_returns_ddram_and_moves_the_counter() {
        let mut bus = Bus::new();
        bus.init();
        bus.print("Q");
        bus.send(false, 0x80, 50e-6);
        let t = bus.t;
        bus.lcd.set_pins(true, true, true, 0xFF, t);
        let high = bus.lcd.output().unwrap() & 0xF0;
        bus.lcd.set_pins(true, true, false, 0xFF, t + 1e-6);
        bus.lcd.set_pins(true, true, true, 0xFF, t + 2e-6);
        let low = bus.lcd.output().unwrap() >> 4;
        bus.lcd.set_pins(true, true, false, 0xFF, t + 3e-6);
        assert_eq!(high | low, b'Q');
        assert_eq!(bus.lcd.address_counter(), 1);
    }
}
