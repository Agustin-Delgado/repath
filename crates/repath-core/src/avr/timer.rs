//! The three timer/counters, as one piece of logic in three configurations.
//!
//! A timer is never stepped clock by clock. Between two counts at which
//! something can happen — a compare value, TOP, MAX, BOTTOM — a timer only
//! counts, so it jumps the whole stretch at once and does the work of a tick
//! only on the counts that have any. The machine syncs a timer whenever its
//! registers are touched, and at the cycle of the next count that matters.
//!
//! Every clock edge the datasheet's timing diagrams draw is honoured here the
//! same way: a compare flag goes up on the timer clock that moves the counter
//! off the matching value, an overflow on the one that takes it from MAX (or
//! TOP) to BOTTOM, and a fast PWM output is set on that same clock. In the
//! phase-correct modes the overflow flag goes up on arriving at BOTTOM.

/// Bits of a TIFRn register, and of the TIMSKn register that enables them.
pub const TOV: u8 = 1 << 0;
pub const OCFA: u8 = 1 << 1;
pub const OCFB: u8 = 1 << 2;
pub const ICF: u8 = 1 << 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Normal,
    Ctc,
    Fast,
    PhaseCorrect,
    PhaseFrequency,
}

#[derive(Debug, Clone, Copy)]
enum Top {
    Fixed(u16),
    OcrA,
    Icr,
}

#[derive(Debug, Clone, Copy)]
struct Mode {
    kind: Kind,
    top: Top,
    /// WGMn2 (WGM13 on Timer1): in the PWM modes it lets COMnA = 01 toggle
    /// OCnA on compare, which is the only way those modes get a 50 % square
    /// wave of a chosen frequency.
    toggle_a: bool,
}

/// One timer/counter. Timer1 is the 16-bit one; Timer2 has a prescaler of its
/// own, with more taps.
#[derive(Debug, Clone)]
pub struct Timer {
    wide: bool,
    own_prescaler: bool,
    tccra: u8,
    tccrb: u8,
    count: u16,
    /// The compare values in force.
    ocr: [u16; 2],
    /// What the CPU last wrote. The PWM modes take it over at BOTTOM or TOP,
    /// so a duty cycle never changes halfway through a period.
    ocr_buffer: [u16; 2],
    icr: u16,
    flags: u8,
    mask: u8,
    down: bool,
    /// The compare output latches, OCnA and OCnB.
    oc: [bool; 2],
    /// A write to TCNTn blocks any compare match on the next timer clock.
    blocked: bool,
    /// The cycle up to which the count is current.
    synced: u64,
}

impl Timer {
    pub fn timer0() -> Self {
        Self::new(false, false)
    }

    pub fn timer1() -> Self {
        Self::new(true, false)
    }

    pub fn timer2() -> Self {
        Self::new(false, true)
    }

    fn new(wide: bool, own_prescaler: bool) -> Self {
        Self {
            wide,
            own_prescaler,
            tccra: 0,
            tccrb: 0,
            count: 0,
            ocr: [0; 2],
            ocr_buffer: [0; 2],
            icr: 0,
            flags: 0,
            mask: 0,
            down: false,
            oc: [false; 2],
            blocked: false,
            synced: 0,
        }
    }

    /// The same timer as at power-on, its count current from `cycle`.
    pub fn starting_at(mut self, cycle: u64) -> Self {
        self.synced = cycle;
        self
    }

    fn mode(&self) -> Mode {
        use Kind::*;
        if self.wide {
            let wgm = (self.tccra & 3) | ((self.tccrb >> 1) & 0x0C);
            let (kind, top) = match wgm {
                1 => (PhaseCorrect, Top::Fixed(0x00FF)),
                2 => (PhaseCorrect, Top::Fixed(0x01FF)),
                3 => (PhaseCorrect, Top::Fixed(0x03FF)),
                4 => (Ctc, Top::OcrA),
                5 => (Fast, Top::Fixed(0x00FF)),
                6 => (Fast, Top::Fixed(0x01FF)),
                7 => (Fast, Top::Fixed(0x03FF)),
                8 => (PhaseFrequency, Top::Icr),
                9 => (PhaseFrequency, Top::OcrA),
                10 => (PhaseCorrect, Top::Icr),
                11 => (PhaseCorrect, Top::OcrA),
                12 => (Ctc, Top::Icr),
                14 => (Fast, Top::Icr),
                15 => (Fast, Top::OcrA),
                // 13 is reserved; a reserved mode counts like normal.
                _ => (Normal, Top::Fixed(0xFFFF)),
            };
            Mode { kind, top, toggle_a: wgm & 8 != 0 }
        } else {
            let wgm = (self.tccra & 3) | ((self.tccrb >> 1) & 4);
            let (kind, top) = match wgm {
                1 => (PhaseCorrect, Top::Fixed(0xFF)),
                2 => (Ctc, Top::OcrA),
                3 => (Fast, Top::Fixed(0xFF)),
                5 => (PhaseCorrect, Top::OcrA),
                7 => (Fast, Top::OcrA),
                _ => (Normal, Top::Fixed(0xFF)),
            };
            Mode { kind, top, toggle_a: wgm & 4 != 0 }
        }
    }

    fn max(&self) -> u16 {
        if self.wide { 0xFFFF } else { 0x00FF }
    }

    fn top(&self, mode: &Mode) -> u16 {
        match mode.top {
            Top::Fixed(v) => v,
            Top::OcrA => self.ocr[0],
            Top::Icr => self.icr,
        }
    }

    /// CPU cycles per timer clock, or zero while stopped. Clocking from the T0
    /// or T1 pin is not modelled and counts as stopped.
    pub fn divider(&self) -> u64 {
        let cs = (self.tccrb & 7) as usize;
        if self.own_prescaler {
            [0, 1, 8, 32, 64, 128, 256, 1024][cs]
        } else {
            [0, 1, 8, 64, 256, 1024, 0, 0][cs]
        }
    }

    /// Bring the count up to `cycle`.
    ///
    /// The prescaler is free-running from power-on and shared, so a timer
    /// divided by N is clocked at every cycle that is a multiple of N — not N
    /// cycles after it was started. That is what the datasheet means by the
    /// first count after a start coming anywhere from 1 to N cycles later.
    pub fn sync(&mut self, cycle: u64) {
        if cycle <= self.synced {
            return;
        }
        if let (Some(now), Some(then)) =
            (cycle.checked_div(self.divider()), self.synced.checked_div(self.divider()))
        {
            self.advance(now - then);
        }
        self.synced = cycle;
    }

    /// The cycle of the next timer clock that can do anything, or `u64::MAX`
    /// while stopped.
    pub fn next_event(&self) -> u64 {
        let n = self.divider();
        if n == 0 {
            return u64::MAX;
        }
        (self.synced / n + self.quiet_ticks() + 1) * n
    }

    /// How many timer clocks from here only count.
    fn quiet_ticks(&self) -> u64 {
        if self.blocked {
            return 0;
        }
        let mode = self.mode();
        let top = self.top(&mode);
        let max = self.max();
        let marks = [self.ocr[0], self.ocr[1], top, top.wrapping_sub(1) & max, max, 0, 1];
        let at = self.count;
        let distance = marks.iter().filter_map(|&v| {
            if self.down { (v <= at).then(|| at - v) } else { (v >= at).then(|| v - at) }
        });
        u64::from(distance.min().unwrap_or(0))
    }

    fn advance(&mut self, mut ticks: u64) {
        while ticks > 0 {
            let quiet = self.quiet_ticks().min(ticks);
            if quiet > 0 {
                // At most the distance to a mark, so it fits in the counter.
                let q = quiet as u16;
                self.count = if self.down { self.count - q } else { self.count + q };
                ticks -= quiet;
            } else {
                self.tick();
                ticks -= 1;
            }
        }
    }

    fn tick(&mut self) {
        let mode = self.mode();
        let top = self.top(&mode);
        let max = self.max();
        let old = self.count;
        let blocked = std::mem::take(&mut self.blocked);
        match mode.kind {
            Kind::Normal | Kind::Ctc | Kind::Fast => {
                // A count written above TOP runs on to MAX and wraps there.
                let wrap = old == top || old == max;
                self.count = if wrap { 0 } else { old + 1 };
                if !blocked {
                    for ch in 0..2 {
                        if old == self.ocr[ch] {
                            self.compare(ch, &mode, true);
                        }
                    }
                }
                let overflow = match mode.kind {
                    Kind::Fast => old == top,
                    _ => old == max,
                };
                if overflow {
                    self.flags |= TOV;
                }
                if matches!(mode.top, Top::Icr) && old == top {
                    self.flags |= ICF;
                }
                if mode.kind == Kind::Fast && wrap {
                    self.ocr = self.ocr_buffer;
                    for ch in 0..2 {
                        self.bottom(ch);
                    }
                }
            }
            Kind::PhaseCorrect | Kind::PhaseFrequency => {
                let next = if top == 0 {
                    self.down = false;
                    0
                } else if !self.down {
                    if old >= top {
                        self.down = true;
                        old - 1
                    } else {
                        old + 1
                    }
                } else if old == 0 {
                    self.down = false;
                    1
                } else {
                    old - 1
                };
                self.count = next;
                if !blocked {
                    // The direction it leaves the value in decides the action:
                    // leaving TOP is the start of the way down.
                    let up = !self.down;
                    for ch in 0..2 {
                        if old == self.ocr[ch] {
                            self.compare(ch, &mode, up);
                        }
                    }
                }
                if self.down && next == 0 {
                    self.flags |= TOV;
                }
                if matches!(mode.top, Top::Icr) && old == top {
                    self.flags |= ICF;
                }
                let update = match mode.kind {
                    Kind::PhaseCorrect => !self.down && next == top,
                    _ => next == 0,
                };
                if update {
                    self.ocr = self.ocr_buffer;
                }
            }
        }
    }

    fn com(&self, ch: usize) -> u8 {
        (self.tccra >> (6 - 2 * ch)) & 3
    }

    fn compare(&mut self, ch: usize, mode: &Mode, up: bool) {
        self.flags |= if ch == 0 { OCFA } else { OCFB };
        let com = self.com(ch);
        let oc = &mut self.oc[ch];
        match (mode.kind, com) {
            (_, 0) => {}
            (Kind::Normal | Kind::Ctc, 1) => *oc = !*oc,
            (Kind::Normal | Kind::Ctc, 2) => *oc = false,
            (Kind::Normal | Kind::Ctc, _) => *oc = true,
            (_, 1) => {
                if ch == 0 && mode.toggle_a {
                    *oc = !*oc;
                }
            }
            (Kind::Fast, 2) => *oc = false,
            (Kind::Fast, _) => *oc = true,
            // Phase correct: cleared on the way up, set on the way down, and
            // the other way round when inverted.
            (_, 2) => *oc = !up,
            (_, _) => *oc = up,
        }
    }

    /// Fast PWM's other edge, at BOTTOM. Applied after the compare at TOP on
    /// the same clock, which is what makes OCRnx = TOP a constant level rather
    /// than a one-clock notch.
    fn bottom(&mut self, ch: usize) {
        match self.com(ch) {
            2 => self.oc[ch] = true,
            3 => self.oc[ch] = false,
            _ => {}
        }
    }

    /// The level OCnx puts on its pin, or `None` while the pin is the port's.
    pub fn pin(&self, ch: usize) -> Option<bool> {
        let com = self.com(ch);
        if com == 0 {
            return None;
        }
        let mode = self.mode();
        let pwm = !matches!(mode.kind, Kind::Normal | Kind::Ctc);
        if com == 1 && pwm && !(ch == 0 && mode.toggle_a) {
            return None;
        }
        Some(self.oc[ch])
    }

    /// A write to FOCnx: the compare action of a non-PWM mode, with no flag
    /// and no effect on the count.
    pub fn force(&mut self, ch: usize) {
        let mode = self.mode();
        if !matches!(mode.kind, Kind::Normal | Kind::Ctc) {
            return;
        }
        match self.com(ch) {
            1 => self.oc[ch] = !self.oc[ch],
            2 => self.oc[ch] = false,
            3 => self.oc[ch] = true,
            _ => {}
        }
    }

    fn mode_changed(&mut self) {
        let mode = self.mode();
        if matches!(mode.kind, Kind::Normal | Kind::Ctc) {
            self.ocr = self.ocr_buffer;
        }
        if !matches!(mode.kind, Kind::PhaseCorrect | Kind::PhaseFrequency) {
            self.down = false;
        }
    }

    pub fn control_a(&self) -> u8 {
        self.tccra
    }

    pub fn set_control_a(&mut self, v: u8) {
        self.tccra = v;
        self.mode_changed();
    }

    pub fn control_b(&self) -> u8 {
        self.tccrb
    }

    pub fn set_control_b(&mut self, v: u8) {
        self.tccrb = v;
        self.mode_changed();
    }

    pub fn count(&self) -> u16 {
        self.count
    }

    pub fn set_count(&mut self, v: u16) {
        self.count = v & self.max();
        self.blocked = true;
    }

    /// What reads of OCRnx return: the CPU's side of the buffer.
    pub fn compare_value(&self, ch: usize) -> u16 {
        self.ocr_buffer[ch]
    }

    pub fn set_compare_value(&mut self, ch: usize, v: u16) {
        let v = v & self.max();
        self.ocr_buffer[ch] = v;
        if matches!(self.mode().kind, Kind::Normal | Kind::Ctc) {
            self.ocr[ch] = v;
        }
    }

    pub fn capture(&self) -> u16 {
        self.icr
    }

    pub fn set_capture(&mut self, v: u16) {
        self.icr = v;
    }

    pub fn flags(&self) -> u8 {
        self.flags
    }

    /// Writing a one to a flag clears it.
    pub fn clear_flags(&mut self, v: u8) {
        self.flags &= !v;
    }

    pub fn mask(&self) -> u8 {
        self.mask
    }

    pub fn set_mask(&mut self, v: u8) {
        self.mask = v;
    }

    #[cfg(test)]
    pub fn raise(&mut self, flags: u8) {
        self.flags |= flags;
    }

    /// Flags whose interrupt is enabled.
    pub fn pending(&self) -> u8 {
        self.flags & self.mask
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Flags raised, and OCnA's changes, each with its cycle.
    type Trace = (Vec<(u64, u8)>, Vec<(u64, bool)>);

    /// Run a timer cycle by cycle, the slow way, recording the cycle of every
    /// flag and every change of OCnA: what the jumping version must agree with.
    fn trace(timer: &mut Timer, cycles: u64) -> Trace {
        let mut flags = Vec::new();
        let mut edges = Vec::new();
        let mut level = timer.oc[0];
        for c in timer.synced + 1..=timer.synced + cycles {
            timer.sync(c);
            if timer.flags != 0 {
                flags.push((c, timer.flags));
                timer.flags = 0;
            }
            if timer.oc[0] != level {
                level = timer.oc[0];
                edges.push((c, level));
            }
        }
        (flags, edges)
    }

    #[test]
    fn normal_mode_overflows_every_256_clocks() {
        // Prescaler 64: the counter takes 256 clocks of 64 cycles to come back
        // to zero, so TOV0 every 16 384 cycles, the first at 16 384.
        let mut t = Timer::timer0();
        t.set_control_b(3);
        let (flags, _) = trace(&mut t, 3 * 16_384);
        // OCR0A and OCR0B are zero, so their flags rise too, one clock in.
        let overflows: Vec<u64> =
            flags.iter().filter(|(_, f)| f & TOV != 0).map(|(c, _)| *c).collect();
        assert_eq!(overflows, vec![16_384, 32_768, 49_152]);
    }

    #[test]
    fn jumping_agrees_with_counting_clock_by_clock() {
        // Fast PWM to OCR0A, toggling OC0A, with OCR0B inside the period: the
        // events computed by jumping must land on the same cycles as by
        // stepping, with a prescaler that does not divide the start.
        let mut stepped = Timer::timer0().starting_at(5);
        stepped.set_compare_value(0, 99);
        stepped.set_compare_value(1, 40);
        stepped.set_control_a(0x40 | 0x03);
        stepped.set_control_b(0x08 | 2);
        let mut jumped = stepped.clone();
        let (flags, edges) = trace(&mut stepped, 5_000);

        let mut seen_flags = Vec::new();
        let mut seen_edges = Vec::new();
        let mut level = jumped.oc[0];
        while jumped.next_event() <= 5_005 {
            let at = jumped.next_event();
            jumped.sync(at);
            if jumped.flags != 0 {
                seen_flags.push((at, jumped.flags));
                jumped.flags = 0;
            }
            if jumped.oc[0] != level {
                level = jumped.oc[0];
                seen_edges.push((at, level));
            }
        }
        assert_eq!(seen_flags, flags);
        assert_eq!(seen_edges, edges);
        // And the toggle has the period the datasheet gives for it:
        // f = f_clk / (2 N (1 + OCR0A)), so a half period of 8 * 100 cycles.
        assert!(edges.windows(2).all(|w| w[1].0 - w[0].0 == 800), "{edges:?}");
    }

    #[test]
    fn ctc_period_is_one_plus_ocr_clocks() {
        // CTC with OCR0A = 99 at prescaler 8: a match every 100 clocks.
        let mut t = Timer::timer0();
        t.set_control_a(0x02);
        t.set_compare_value(0, 99);
        t.set_control_b(2);
        let (flags, _) = trace(&mut t, 2_500);
        let matches: Vec<u64> =
            flags.iter().filter(|(_, f)| f & OCFA != 0).map(|(c, _)| *c).collect();
        assert_eq!(matches, vec![800, 1_600, 2_400]);
        // TOP is below MAX, so the counter never overflows.
        assert!(flags.iter().all(|(_, f)| f & TOV == 0));
    }

    #[test]
    fn fast_pwm_is_high_for_ocr_plus_one_clocks() {
        // Non-inverting fast PWM, OCR0A = 63: set at BOTTOM, cleared on the
        // clock that leaves 63, so high for 64 of every 256 clocks.
        let mut t = Timer::timer0();
        t.set_compare_value(0, 63);
        t.set_control_a(0x80 | 0x03);
        t.set_control_b(1);
        let (_, edges) = trace(&mut t, 800);
        assert_eq!(edges, vec![(256, true), (320, false), (512, true), (576, false), (768, true)]);
    }

    #[test]
    fn fast_pwm_holds_a_constant_level_at_the_extremes() {
        // The datasheet: OCR0A = MAX is constantly high when non-inverting,
        // and OCR0A = BOTTOM is a one-clock spike every period.
        let mut t = Timer::timer0();
        t.set_compare_value(0, 0xFF);
        t.set_control_a(0x80 | 0x03);
        t.set_control_b(1);
        let (_, edges) = trace(&mut t, 1_024);
        assert_eq!(edges, vec![(256, true)]);

        let mut t = Timer::timer0();
        t.set_compare_value(0, 0);
        t.set_control_a(0x80 | 0x03);
        t.set_control_b(1);
        let (_, edges) = trace(&mut t, 600);
        assert_eq!(edges, vec![(256, true), (257, false), (512, true), (513, false)]);
    }

    #[test]
    fn a_pwm_compare_value_takes_effect_at_bottom() {
        // Fast PWM running with OCR0A = 200; 50 is written halfway through a
        // period. That period still ends at 200; the next one at 50.
        let mut t = Timer::timer0();
        t.set_compare_value(0, 200);
        t.set_control_a(0x80 | 0x03);
        t.set_control_b(1);
        t.sync(300); // into the second period, count 44
        t.set_compare_value(0, 50);
        let (_, edges) = trace(&mut t, 500);
        assert_eq!(edges, vec![(457, false), (512, true), (563, false), (768, true)]);
    }

    #[test]
    fn phase_correct_duty_is_ocr_over_top() {
        // Timer1, 8-bit phase correct, OCR1A = 64: the period is 2 * 255 = 510
        // clocks and the output high for 2 * 64 of them.
        let mut t = Timer::timer1();
        t.set_compare_value(0, 64);
        t.set_control_a(0x80 | 0x01);
        t.set_control_b(1);
        let (flags, edges) = trace(&mut t, 2_000);
        let highs: Vec<u64> = edges.iter().filter(|e| e.1).map(|e| e.0).collect();
        let lows: Vec<u64> = edges.iter().filter(|e| !e.1).map(|e| e.0).collect();
        assert!(highs.windows(2).all(|w| w[1] - w[0] == 510), "{edges:?}");
        for (h, l) in highs.iter().zip(lows.iter().filter(|l| **l > highs[0])) {
            assert_eq!(l - h, 128, "{edges:?}");
        }
        // TOV1 once a period, at BOTTOM.
        let overflows: Vec<u64> =
            flags.iter().filter(|(_, f)| f & TOV != 0).map(|(c, _)| *c).collect();
        assert!(overflows.windows(2).all(|w| w[1] - w[0] == 510), "{overflows:?}");
    }

    #[test]
    fn writing_the_count_blocks_the_next_compare() {
        // CTC to 10: writing 10 into TCNT0 must not raise OCF0A on the clock
        // that leaves it, so the first flag is a whole period later. Whether
        // the blocked clock still clears the counter the datasheet does not
        // say; here it does, since TOP is the counter's business and the
        // blocking is the compare unit's.
        let mut t = Timer::timer0();
        t.set_control_a(0x02);
        t.set_compare_value(0, 10);
        t.set_control_b(1);
        t.set_count(10);
        let (flags, _) = trace(&mut t, 300);
        // Leaves 10 unmatched at clock 1 and matches leaving it again eleven
        // clocks later.
        let first = flags.iter().find(|(_, f)| f & OCFA != 0).map(|(c, _)| *c);
        assert_eq!(first, Some(12));
    }
}
