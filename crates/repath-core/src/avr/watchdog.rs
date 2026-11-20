//! The watchdog timer, behind WDTCSR, with the `wdr` instruction and MCUSR's
//! WDRF.
//!
//! It counts the chip's 128 kHz oscillator, taken here at its nominal
//! frequency: the datasheet gives it only as typical, and a real chip's runs
//! a few percent off with voltage and temperature, so a time-out comes when
//! the table says rather than when a given part would. The count is turned
//! into CPU cycles at the clock the chip is given, as the EEPROM's
//! programming time is, and starts on the CPU cycle that restarted it, where
//! the silicon's runs free and ticks up to one oscillator period (125 cycles
//! at 16 MHz) later.
//!
//! It is the datasheet's safety level 1, the one an Uno's fuses leave it at
//! (WDTON unprogrammed): off from power-on, switched on by writing WDE, and
//! switched off or retimed only by the timed sequence.

/// WDTCSR's bits.
const WDIF: u8 = 1 << 7;
const WDIE: u8 = 1 << 6;
const WDP3: u8 = 1 << 5;
const WDCE: u8 = 1 << 4;
const WDE: u8 = 1 << 3;
const WDP: u8 = 0x07;

/// How long WDCE stays set: the second write has to come within it.
const ARMED_CYCLES: u64 = 4;

/// The oscillator, nominal.
const OSCILLATOR: f64 = 128e3;

/// What a time-out does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timeout {
    /// WDIF is set; the interrupt is pending if WDIE is.
    Interrupt,
    /// A system reset.
    Reset,
}

#[derive(Debug, Clone)]
pub struct Watchdog {
    /// WDIF.
    flag: bool,
    /// WDIE.
    interrupt: bool,
    /// WDE as written. MCUSR's WDRF overrides it to one; see `forced`.
    enable: bool,
    /// WDRF: while set, WDE reads and acts as one whatever was written.
    forced: bool,
    /// WDP3..0, as a number.
    prescaler: u8,
    /// The start of the instruction that set WDCE, while it might still be
    /// set.
    armed_at: Option<u64>,
    /// The cycle the count last started from zero: power-on, `wdr`, a time
    /// out, or the watchdog switched on.
    start: u64,
    /// CPU cycles per oscillator tick.
    cycles_per_tick: f64,
}

impl Watchdog {
    /// Off, as from a reset with WDRF clear, for a chip clocked at
    /// `frequency`, `cycle` cycles into the run.
    pub fn new(frequency: f64, cycle: u64) -> Self {
        Self {
            flag: false,
            interrupt: false,
            enable: false,
            forced: false,
            prescaler: 0,
            armed_at: None,
            start: cycle,
            cycles_per_tick: frequency / OSCILLATOR,
        }
    }

    fn armed(&self, cycle: u64) -> bool {
        self.armed_at.is_some_and(|at| cycle <= at + ARMED_CYCLES)
    }

    /// WDE as the hardware sees it.
    fn resets(&self) -> bool {
        self.enable || self.forced
    }

    fn running(&self) -> bool {
        self.resets() || self.interrupt
    }

    /// The time-out in CPU cycles: 2K oscillator cycles (16 ms) at WDP 0,
    /// doubling up to 1024K (8 s) at 9. The datasheet marks 10 to 15
    /// reserved; they time nothing here rather than guess.
    fn period(&self) -> Option<u64> {
        (self.prescaler <= 9)
            .then(|| ((2048u64 << self.prescaler) as f64 * self.cycles_per_tick).ceil() as u64)
    }

    /// WDTCSR as read at `cycle`.
    pub fn control(&self, cycle: u64) -> u8 {
        let mut v = self.prescaler & WDP;
        if self.prescaler & 8 != 0 {
            v |= WDP3;
        }
        if self.flag {
            v |= WDIF;
        }
        if self.interrupt {
            v |= WDIE;
        }
        if self.armed(cycle) {
            v |= WDCE;
        }
        if self.resets() {
            v |= WDE;
        }
        v
    }

    /// A write to WDTCSR by the instruction starting at `cycle`.
    ///
    /// WDIE can be written at any time and WDIF cleared by writing a one, and
    /// WDE can always be set. Clearing WDE or changing the prescaler takes
    /// the timed sequence: WDCE and WDE written as one in a first write, then
    /// within four cycles — counted, as for the EEPROM, between the starts of
    /// the two instructions — a second with WDCE clear that says what they
    /// are to be. Anything later is taken as an ordinary write.
    pub fn write_control(&mut self, v: u8, cycle: u64) {
        let was_running = self.running();
        let armed = self.armed(cycle);
        if v & WDIF != 0 {
            self.flag = false;
        }
        self.interrupt = v & WDIE != 0;
        if armed && v & WDCE == 0 {
            self.enable = v & WDE != 0;
            self.prescaler = (v & WDP) | if v & WDP3 != 0 { 8 } else { 0 };
            self.armed_at = None;
        } else {
            self.enable |= v & WDE != 0;
            if v & (WDCE | WDE) == WDCE | WDE {
                self.armed_at = Some(cycle);
            }
        }
        if !was_running && self.running() {
            self.start = cycle;
        }
    }

    /// WDRF set or cleared through MCUSR, or by a watchdog reset.
    pub fn set_forced(&mut self, forced: bool, cycle: u64) {
        let was_running = self.running();
        self.forced = forced;
        if !was_running && self.running() {
            self.start = cycle;
        }
    }

    /// `wdr`: the count starts again.
    pub fn restart(&mut self, cycle: u64) {
        self.start = cycle;
    }

    /// The cycle of the next time-out, `u64::MAX` while it is off. A
    /// prescaler shortened to below what has already been counted times out
    /// at once, at `now`.
    pub fn next_event(&self, now: u64) -> u64 {
        match (self.running(), self.period()) {
            (true, Some(period)) => (self.start + period).max(now),
            _ => u64::MAX,
        }
    }

    /// The time-out due at `at`. The count starts again from it, as the
    /// counter wraps and runs on.
    ///
    /// In interrupt and system reset mode the first time-out only sets WDIF,
    /// and the vector's clearing WDIE is what leaves a second one to reset;
    /// one that comes with the first still not served resets too, since an
    /// interrupt nobody took is what this mode is there to catch.
    pub fn event(&mut self, at: u64) -> Option<Timeout> {
        self.start = at;
        if self.interrupt {
            if self.resets() && self.flag {
                return Some(Timeout::Reset);
            }
            self.flag = true;
            return Some(Timeout::Interrupt);
        }
        self.resets().then_some(Timeout::Reset)
    }

    /// WDT, vector 6: pending while WDIF and WDIE are both set.
    pub fn pending(&self) -> bool {
        self.flag && self.interrupt
    }

    /// The vector was taken: WDIF clears, and in interrupt and system reset
    /// mode so does WDIE, which leaves the watchdog in system reset mode
    /// until the handler sets it again.
    pub fn acknowledge(&mut self) {
        self.flag = false;
        if self.resets() {
            self.interrupt = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 16 MHz: 125 CPU cycles an oscillator tick, so 16 ms is 256 000 cycles.
    fn watchdog() -> Watchdog {
        Watchdog::new(16e6, 0)
    }

    const MS16: u64 = 256_000;

    /// avr-libc's `wdt_enable()` and friends: WDCE | WDE, then the setting,
    /// two cycles apart as two `sts` are.
    fn timed(w: &mut Watchdog, v: u8, cycle: u64) {
        w.write_control(WDCE | WDE, cycle);
        w.write_control(v, cycle + 2);
    }

    #[test]
    fn it_is_off_from_power_on() {
        let w = watchdog();
        assert_eq!(w.control(0), 0);
        assert_eq!(w.next_event(0), u64::MAX);
    }

    #[test]
    fn every_prescaler_times_out_at_the_datasheet_count() {
        for p in 0..=9u8 {
            let mut w = watchdog();
            let bits = (p & 7) | if p & 8 != 0 { WDP3 } else { 0 };
            timed(&mut w, WDE | bits, 100);
            assert_eq!(w.control(110), WDE | bits);
            assert_eq!(w.next_event(110), 100 + (MS16 << p), "WDP {p}");
        }
    }

    #[test]
    fn a_reserved_prescaler_times_nothing() {
        let mut w = watchdog();
        timed(&mut w, WDE | WDP3 | 0x02, 0);
        assert_eq!(w.next_event(10), u64::MAX);
    }

    #[test]
    fn wde_alone_switches_it_on_but_not_off() {
        let mut w = watchdog();
        w.write_control(WDE | 0x06, 50);
        // The prescaler needs the sequence; WDE does not.
        assert_eq!(w.control(60), WDE);
        assert_eq!(w.next_event(60), 50 + MS16);
        w.write_control(0, 70);
        assert_eq!(w.control(80), WDE, "cleared without the sequence: ignored");
    }

    #[test]
    fn a_second_write_later_than_four_cycles_is_ignored() {
        let mut w = watchdog();
        w.write_control(WDE, 0);
        w.write_control(WDCE | WDE, 100);
        assert_ne!(w.control(104) & WDCE, 0);
        assert_eq!(w.control(105) & WDCE, 0);
        w.write_control(0x06, 105);
        assert_eq!(w.control(110), WDE, "too late: still on, still 16 ms");
        w.write_control(WDCE | WDE, 200);
        w.write_control(0x06, 204);
        assert_eq!(w.control(210), 0x06, "in time: off, prescaler set");
        assert_eq!(w.next_event(210), u64::MAX);
        // WDCE without WDE does not open the window.
        w.write_control(WDE, 300);
        w.write_control(WDCE, 400);
        w.write_control(0, 402);
        assert_eq!(w.control(410) & WDE, WDE);
    }

    #[test]
    fn wdr_starts_the_count_again() {
        let mut w = watchdog();
        timed(&mut w, WDE, 0);
        w.restart(200_000);
        assert_eq!(w.next_event(200_001), 200_000 + MS16);
    }

    #[test]
    fn interrupt_mode_interrupts_every_period_and_never_resets() {
        let mut w = watchdog();
        timed(&mut w, WDIE, 0);
        let first = w.next_event(0);
        assert_eq!(first, MS16);
        assert_eq!(w.event(first), Some(Timeout::Interrupt));
        assert!(w.pending());
        // Not served: the next one leaves the flag set, and no reset.
        assert_eq!(w.next_event(first), 2 * MS16);
        assert_eq!(w.event(2 * MS16), Some(Timeout::Interrupt));
        w.acknowledge();
        assert!(!w.pending());
        assert_eq!(w.control(0), WDIE, "WDIE stays");
    }

    #[test]
    fn interrupt_and_reset_mode_interrupts_once_then_resets() {
        let mut w = watchdog();
        timed(&mut w, WDIE | WDE, 0);
        assert_eq!(w.event(MS16), Some(Timeout::Interrupt));
        w.acknowledge();
        assert_eq!(w.control(0), WDE, "the vector cleared WDIE and WDIF");
        assert_eq!(w.event(2 * MS16), Some(Timeout::Reset));
        // A handler that sets WDIE again stays in the mode.
        let mut w = watchdog();
        timed(&mut w, WDIE | WDE, 0);
        w.event(MS16);
        w.acknowledge();
        w.write_control(WDIE | WDE, MS16 + 10);
        assert_eq!(w.event(2 * MS16), Some(Timeout::Interrupt));
        // One never served resets at the next.
        let mut w = watchdog();
        timed(&mut w, WDIE | WDE, 0);
        w.event(MS16);
        assert_eq!(w.event(2 * MS16), Some(Timeout::Reset));
    }

    #[test]
    fn wdif_clears_by_writing_a_one() {
        let mut w = watchdog();
        timed(&mut w, WDIE, 0);
        w.event(MS16);
        w.write_control(WDIE, MS16 + 1);
        assert!(w.pending(), "a zero leaves it");
        w.write_control(WDIF | WDIE, MS16 + 2);
        assert!(!w.pending());
    }

    #[test]
    fn wdrf_forces_wde() {
        let mut w = watchdog();
        w.set_forced(true, 1000);
        assert_eq!(w.control(1000), WDE);
        assert_eq!(w.next_event(1000), 1000 + MS16);
        // The sequence clears the written WDE, and WDE still reads one.
        timed(&mut w, 0, 2000);
        assert_eq!(w.control(2010), WDE);
        w.set_forced(false, 3000);
        assert_eq!(w.control(3000), 0);
        assert_eq!(w.next_event(3000), u64::MAX);
    }

    #[test]
    fn a_shorter_prescaler_past_its_count_times_out_at_once() {
        let mut w = watchdog();
        timed(&mut w, WDE | 0x06, 0);
        timed(&mut w, WDE, 2 * MS16);
        assert_eq!(w.next_event(2 * MS16 + 2), 2 * MS16 + 2);
    }

    #[test]
    fn the_period_is_the_oscillators_whatever_the_clock() {
        // At 8 MHz an oscillator tick is 62.5 cycles: 16 ms is 128 000.
        let mut w = Watchdog::new(8e6, 0);
        timed(&mut w, WDE, 0);
        assert_eq!(w.next_event(0), 128_000);
    }
}
