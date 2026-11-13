//! The 1 KB data EEPROM, behind EEAR, EEDR and EECR.
//!
//! It is fresh at the start of every run — erased, every byte 0xFF, as a chip
//! out of the factory is — and kept through a reset within one, since that is
//! what non-volatile means. The `.eep` image a toolchain writes for `EEMEM`
//! data is not loaded.
//!
//! The programming time is the one thing on the chip not counted in CPU
//! clocks: the datasheet gives it in milliseconds, timed by the calibrated RC
//! oscillator whatever the CPU runs at, so it is turned into cycles at the
//! clock the chip is given.

pub const SIZE: usize = 1024;

/// EECR's bits.
const EERE: u8 = 1 << 0;
const EEPE: u8 = 1 << 1;
const EEMPE: u8 = 1 << 2;
const EERIE: u8 = 1 << 3;
const EEPM: u8 = 0x30;

/// How long EEMPE stays set: EEPE has to be written within it.
const ARMED_CYCLES: u64 = 4;

/// The datasheet's programming times: erase and write, and erase or write
/// alone.
const ERASE_AND_WRITE: f64 = 3.4e-3;
const ERASE_OR_WRITE: f64 = 1.8e-3;

#[derive(Debug, Clone)]
pub struct Eeprom {
    pub cells: [u8; SIZE],
    /// EEAR, ten bits.
    address: u16,
    /// EEDR.
    pub data: u8,
    /// EECR's EEPM bits, in place.
    mode: u8,
    /// EERIE.
    interrupt: bool,
    /// The start of the instruction that set EEMPE, while it might still be
    /// set.
    armed_at: Option<u64>,
    /// The cycle a write in progress is done at.
    busy_until: Option<u64>,
    /// The two programming times, in CPU cycles.
    times: [u64; 2],
}

impl Eeprom {
    /// Erased, for a chip clocked at `frequency`.
    pub fn new(frequency: f64) -> Self {
        let cycles = |seconds: f64| (seconds * frequency).ceil() as u64;
        Self {
            cells: [0xFF; SIZE],
            address: 0,
            data: 0,
            mode: 0,
            interrupt: false,
            armed_at: None,
            busy_until: None,
            times: [cycles(ERASE_AND_WRITE), cycles(ERASE_OR_WRITE)],
        }
    }

    fn busy(&self) -> bool {
        self.busy_until.is_some()
    }

    fn armed(&self, cycle: u64) -> bool {
        self.armed_at.is_some_and(|at| cycle <= at + ARMED_CYCLES)
    }

    /// EECR as read at `cycle`.
    pub fn control(&self, cycle: u64) -> u8 {
        let mut v = self.mode;
        if self.interrupt {
            v |= EERIE;
        }
        if self.armed(cycle) {
            v |= EEMPE;
        }
        if self.busy() {
            v |= EEPE;
        }
        v
    }

    /// EEARL and EEARH.
    pub fn address_byte(&self, high: bool) -> u8 {
        if high { (self.address >> 8) as u8 } else { self.address as u8 }
    }

    /// While a write is in progress the address cannot be changed.
    pub fn set_address_byte(&mut self, high: bool, v: u8) {
        if self.busy() {
            return;
        }
        self.address = if high {
            (self.address & 0x00FF) | u16::from(v & 0x03) << 8
        } else {
            (self.address & 0x0300) | u16::from(v)
        };
    }

    /// A write to EECR by the instruction starting at `cycle`. Returns the
    /// cycles the CPU is halted for before its next instruction: four after a
    /// read, two after starting a write.
    ///
    /// EEPE starts a write only within four cycles of EEMPE being set by an
    /// earlier write — counted here between the starts of the two
    /// instructions, so `sbi EEMPE` then `sbi EEPE` makes it and a third
    /// instruction between them does not.
    pub fn write_control(&mut self, v: u8, cycle: u64) -> u64 {
        let armed = self.armed(cycle);
        self.interrupt = v & EERIE != 0;
        if self.busy() {
            // Neither the mode nor the address can change under a write, and
            // nothing can be read.
            return 0;
        }
        self.mode = v & EEPM;
        if v & EEPE != 0 && armed {
            let cell = &mut self.cells[usize::from(self.address)];
            // The bits of EEPM, from the datasheet's table: 00 erases and
            // writes, 01 only erases, 10 only writes — which can clear bits
            // and never set them, the half of programming that is not the
            // erase. 11 is reserved, and does nothing here rather than guess.
            let time = match self.mode >> 4 {
                0 => {
                    *cell = self.data;
                    self.times[0]
                }
                1 => {
                    *cell = 0xFF;
                    self.times[1]
                }
                2 => {
                    *cell &= self.data;
                    self.times[1]
                }
                _ => return 0,
            };
            // Written now and finished later: nothing can read it in between,
            // so when within the programming time it changes is not visible.
            self.busy_until = Some(cycle + time);
            self.armed_at = None;
            return 2;
        }
        if v & EEMPE != 0 {
            self.armed_at = Some(cycle);
        }
        if v & EERE != 0 {
            self.data = self.cells[usize::from(self.address)];
            return 4;
        }
        0
    }

    pub fn next_event(&self) -> u64 {
        self.busy_until.unwrap_or(u64::MAX)
    }

    /// The write in progress is done.
    pub fn event(&mut self) {
        self.busy_until = None;
    }

    /// EE_READY: a level, not a flag. It asks for as long as EERIE is set and
    /// no write is in progress, so its handler starts a write or clears EERIE.
    pub fn interrupt(&self) -> bool {
        self.interrupt && !self.busy()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 16 MHz: 3.4 ms is 54 400 cycles and 1.8 ms is 28 800.
    fn eeprom() -> Eeprom {
        Eeprom::new(16e6)
    }

    fn at(e: &mut Eeprom, address: u16) {
        e.set_address_byte(false, address as u8);
        e.set_address_byte(true, (address >> 8) as u8);
    }

    fn read(e: &mut Eeprom, cycle: u64) -> u8 {
        assert_eq!(e.write_control(EERE, cycle), 4, "a read halts the CPU four cycles");
        e.data
    }

    /// What avr-libc's eeprom_write_byte does: EEPM written with the rest of
    /// EECR, then `sbi EEMPE` and `sbi EEPE`, two cycles apart.
    fn program(e: &mut Eeprom, mode: u8, data: u8, cycle: u64) -> u64 {
        e.data = data;
        e.write_control(mode, cycle);
        e.write_control(mode | EEMPE, cycle + 1);
        e.write_control(mode | EEMPE | EEPE, cycle + 3)
    }

    #[test]
    fn it_starts_erased_and_reads_all_ten_address_bits() {
        let mut e = eeprom();
        at(&mut e, 0x3FF);
        assert_eq!((e.address_byte(false), e.address_byte(true)), (0xFF, 0x03));
        assert_eq!(read(&mut e, 0), 0xFF);
        // Bits above the tenth are not there.
        e.set_address_byte(true, 0xFF);
        assert_eq!(e.address_byte(true), 0x03);
    }

    #[test]
    fn a_write_takes_the_datasheet_time_and_reads_back() {
        let mut e = eeprom();
        at(&mut e, 5);
        assert_eq!(program(&mut e, 0x00, 42, 100), 2, "a write halts the CPU two cycles");
        assert_ne!(e.control(103) & EEPE, 0);
        assert_eq!(e.next_event(), 103 + 54_400);
        // Busy: nothing can be read, nor the address moved.
        assert_eq!(e.write_control(EERE, 200), 0);
        at(&mut e, 6);
        assert_eq!(e.address_byte(false), 5);
        e.event();
        assert_eq!(e.control(103 + 54_400) & EEPE, 0);
        assert_eq!(read(&mut e, 60_000), 42);
        at(&mut e, 6);
        assert_eq!(read(&mut e, 60_010), 0xFF, "its neighbour is untouched");
    }

    #[test]
    fn eepe_needs_eempe_set_within_four_cycles_before() {
        let mut e = eeprom();
        e.data = 0;
        // EEPE alone, and EEMPE with EEPE in the same write: nothing.
        assert_eq!(e.write_control(EEPE, 0), 0);
        assert_eq!(e.write_control(EEMPE | EEPE, 10), 0);
        assert_eq!(e.next_event(), u64::MAX);
        // That EEMPE does count for a write four cycles on, and not five.
        assert_ne!(e.control(14) & EEMPE, 0);
        assert_eq!(e.control(15) & EEMPE, 0);
        e.write_control(EEMPE, 20);
        assert_eq!(e.write_control(EEPE, 25), 0);
        assert_eq!(e.next_event(), u64::MAX);
        e.write_control(EEMPE, 30);
        assert_eq!(e.write_control(EEPE, 34), 2);
        assert_eq!(read_after(&mut e), 0);
    }

    fn read_after(e: &mut Eeprom) -> u8 {
        let done = e.next_event();
        e.event();
        read(e, done)
    }

    #[test]
    fn the_modes_erase_write_or_both() {
        let mut e = eeprom();
        program(&mut e, 0x00, 0b1010_1010, 0);
        assert_eq!(read_after(&mut e), 0b1010_1010);
        // Write only: bits can be cleared, never set, and in 1.8 ms.
        program(&mut e, 0x20, 0b0110_0110, 100_000);
        assert_eq!(e.next_event(), 100_003 + 28_800);
        assert_eq!(read_after(&mut e), 0b0010_0010);
        // Erase only: back to 0xFF, also 1.8 ms.
        program(&mut e, 0x10, 0x00, 200_000);
        assert_eq!(e.next_event(), 200_003 + 28_800);
        assert_eq!(read_after(&mut e), 0xFF);
        // Reserved: no write.
        assert_eq!(program(&mut e, 0x30, 0x00, 300_000), 0);
        assert_eq!(e.next_event(), u64::MAX);
    }

    #[test]
    fn the_mode_is_held_while_a_write_is_in_progress() {
        let mut e = eeprom();
        program(&mut e, 0x10, 0x00, 0);
        e.write_control(0x20, 10);
        assert_eq!(e.control(10) & EEPM, 0x10);
    }

    #[test]
    fn ee_ready_asks_while_enabled_and_idle() {
        let mut e = eeprom();
        assert!(!e.interrupt());
        e.write_control(EERIE, 0);
        assert!(e.interrupt(), "nothing to wait for");
        e.data = 7;
        e.write_control(EERIE | EEMPE, 1);
        e.write_control(EERIE | EEPE, 3);
        assert!(!e.interrupt(), "a write in progress");
        e.event();
        assert!(e.interrupt());
    }

    #[test]
    fn the_programming_time_is_milliseconds_whatever_the_clock() {
        // At 8 MHz, 3.4 ms is 27 200 cycles.
        let mut e = Eeprom::new(8e6);
        program(&mut e, 0x00, 1, 0);
        assert_eq!(e.next_event(), 3 + 27_200);
    }
}
