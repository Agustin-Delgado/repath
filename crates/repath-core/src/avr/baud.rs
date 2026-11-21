//! USART0's baud-rate generator, the clock both halves of the USART run off.
//!
//! The datasheet (ATmega328P, "USART0 — Clock Generation"): "The USART Baud
//! Rate Register (UBRRn) and the down-counter connected to it function as a
//! programmable prescaler or baud rate generator. The down-counter, running
//! at system clock (fosc), is loaded with the UBRRn value each time the
//! counter has counted down to zero or when the UBRRnL Register is written.
//! A clock is generated each time the counter reaches zero."
//!
//! So the generator ticks every UBRR0 + 1 cycles, from power-on, whether or
//! not anything is being sent: a write to UBRR0L reloads it, which sets its
//! phase; a write to UBRR0H only changes the value the next reload takes.
//! The receiver samples on every tick. The transmitter divides the ticks by
//! 16 (8 with U2X0) into its bit clock, and starts a frame on that clock's
//! next edge, not on the write that hands it the byte.
//!
//! The datasheet does not say whether that divider is cleared when UBRR0L is
//! written, only that the down-counter is; here it is not — it counts every
//! tick since the chip came out of reset — so its phase is the chip's, and a
//! rewrite of UBRR0L moves the ticks without restarting the count of them.
//!
//! Nothing here ticks cycle by cycle: the ticks of a stretch with one UBRR0
//! value are an arithmetic sequence, so the next one is worked out directly.

/// A stretch of ticks with one reload value: the down-counter loaded at
/// `start`, reaching zero at `start + value`, then every `value + 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Stretch {
    start: u64,
    value: u16,
    /// Ticks since reset before this stretch's first.
    before: u64,
    /// The cycle of its last tick, when a write to UBRR0H has ended it there:
    /// the counter reloads with the new value only after reaching zero.
    last: Option<u64>,
}

impl Stretch {
    fn period(&self) -> u64 {
        u64::from(self.value) + 1
    }

    fn first(&self) -> u64 {
        self.start + u64::from(self.value)
    }

    /// The index within this stretch of its first tick at or after `cycle`.
    fn index_from(&self, cycle: u64) -> u64 {
        cycle.saturating_sub(self.first()).div_ceil(self.period())
    }

    fn at(&self, index: u64) -> u64 {
        self.first() + index * self.period()
    }

    /// Whether a tick of this stretch with `index` exists.
    fn has(&self, index: u64) -> bool {
        self.last.is_none_or(|last| self.at(index) <= last)
    }
}

/// A tick of the generator: when, and how many came before it since reset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tick {
    pub at: u64,
    pub count: u64,
}

#[derive(Debug, Clone)]
pub struct BaudGenerator {
    /// The UBRR0 register, twelve bits.
    register: u16,
    /// The stretch the counter was last loaded into, and the one before it
    /// when a write to UBRR0H has a reload pending.
    current: Stretch,
    earlier: Option<Stretch>,
}

impl BaudGenerator {
    /// Out of reset at `cycle`, UBRR0 = 0: a tick every cycle.
    pub fn new(cycle: u64) -> Self {
        Self {
            register: 0,
            current: Stretch { start: cycle, value: 0, before: 0, last: None },
            earlier: None,
        }
    }

    pub fn register(&self) -> u16 {
        self.register
    }

    /// CPU cycles between ticks at the value UBRR0 holds.
    pub fn period(&self) -> u64 {
        u64::from(self.register) + 1
    }

    /// The first tick at or after `cycle`.
    pub fn tick_from(&self, cycle: u64) -> Tick {
        for stretch in self.earlier.iter().chain([&self.current]) {
            let index = stretch.index_from(cycle.max(stretch.start));
            if stretch.has(index) {
                return Tick { at: stretch.at(index), count: stretch.before + index };
            }
        }
        unreachable!("the current stretch has no end")
    }

    /// The first tick at or after `cycle` whose count since reset is a
    /// multiple of `divisor`: an edge of a clock divided down from this one.
    pub fn divided_from(&self, cycle: u64, divisor: u64) -> u64 {
        for stretch in self.earlier.iter().chain([&self.current]) {
            let index = stretch.index_from(cycle.max(stretch.start));
            let count = stretch.before + index;
            let index = index + (divisor - count % divisor) % divisor;
            if stretch.has(index) {
                return stretch.at(index);
            }
        }
        unreachable!("the current stretch has no end")
    }

    /// The ticks before `cycle`, since reset.
    fn count_before(&self, cycle: u64) -> u64 {
        self.tick_from(cycle).count
    }

    /// UBRR0L written at `cycle`: the down-counter reloads at once.
    pub fn write_low(&mut self, value: u8, cycle: u64) {
        self.register = (self.register & 0x0F00) | u16::from(value);
        let before = self.count_before(cycle);
        self.earlier = None;
        self.current = Stretch { start: cycle, value: self.register, before, last: None };
    }

    /// UBRR0H written at `cycle`: the counter runs down to zero as it was
    /// loaded, and takes the new value at that reload.
    pub fn write_high(&mut self, value: u8, cycle: u64) {
        self.register = (self.register & 0x00FF) | u16::from(value & 0x0F) << 8;
        // Drop a stretch that is over by now.
        if let Some(earlier) = self.earlier
            && earlier.last.is_some_and(|last| last < cycle)
        {
            self.earlier = None;
        }
        let tick = self.tick_from(cycle);
        let mut ending = if self.earlier.is_some() && tick.at < self.current.start {
            // The reload a previous UBRR0H write set up has not happened yet:
            // it takes this value instead.
            self.current.value = self.register;
            return;
        } else {
            self.current
        };
        ending.last = Some(tick.at);
        self.earlier = Some(ending);
        self.current = Stretch {
            start: tick.at + 1,
            value: self.register,
            before: tick.count + 1,
            last: None,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every tick from `from` up to `to`, by brute force: a down-counter
    /// stepped a cycle at a time, as the datasheet draws it.
    fn simulate(writes: &[(u64, bool, u8)], from: u64, to: u64) -> Vec<u64> {
        let mut register: u16 = 0;
        let mut counter: u16 = 0;
        let mut ticks = Vec::new();
        for cycle in 0..to {
            for &(at, low, v) in writes {
                if at == cycle {
                    if low {
                        register = (register & 0x0F00) | u16::from(v);
                        counter = register;
                    } else {
                        register = (register & 0x00FF) | u16::from(v & 0x0F) << 8;
                    }
                }
            }
            if counter == 0 {
                if cycle >= from {
                    ticks.push(cycle);
                }
                counter = register;
            } else {
                counter -= 1;
            }
        }
        ticks
    }

    fn generator(writes: &[(u64, bool, u8)]) -> BaudGenerator {
        let mut g = BaudGenerator::new(0);
        for &(at, low, v) in writes {
            if low {
                g.write_low(v, at);
            } else {
                g.write_high(v, at);
            }
        }
        g
    }

    fn ticks(g: &BaudGenerator, from: u64, to: u64) -> Vec<u64> {
        let mut out = Vec::new();
        let mut at = from;
        loop {
            let t = g.tick_from(at).at;
            if t >= to {
                return out;
            }
            out.push(t);
            at = t + 1;
        }
    }

    #[test]
    fn ticks_every_ubrr_plus_one_cycles_from_the_reload() {
        // UBRR0 = 103 (9600 baud at 16 MHz) written at cycle 50: the counter
        // loads 103 there and reaches zero 103 cycles later, then every 104.
        let writes = [(50, true, 103)];
        let g = generator(&writes);
        assert_eq!(ticks(&g, 51, 2000), simulate(&writes, 51, 2000));
        assert_eq!(g.tick_from(51).at, 153);
        assert_eq!(g.tick_from(154).at, 257);
    }

    #[test]
    fn a_write_to_ubrr0h_waits_for_the_counter_to_run_out() {
        let writes = [(10, true, 200), (100, false, 1), (2000, true, 7), (2003, false, 0)];
        let g_mid = generator(&writes[..2]);
        assert_eq!(ticks(&g_mid, 100, 3000), simulate(&writes[..2], 100, 3000));
        let g = generator(&writes);
        assert_eq!(ticks(&g, 2003, 6000), simulate(&writes, 2003, 6000));
    }

    #[test]
    fn two_writes_to_ubrr0h_before_the_reload_leave_the_last() {
        let writes = [(10, true, 200), (100, false, 1), (120, false, 2)];
        let g = generator(&writes);
        assert_eq!(ticks(&g, 120, 3000), simulate(&writes, 120, 3000));
    }

    #[test]
    fn the_divided_clock_counts_every_tick_since_reset() {
        // Ticks at every cycle until 37, then every 4 from 37 + 3 = 40.
        // 37 ticks (0..=36) came before the write, so the sixteen-tick clock
        // has its edges where the running count is a multiple of 16.
        let writes = [(37, true, 3)];
        let g = generator(&writes);
        let all = simulate(&writes, 0, 1000);
        let edges: Vec<u64> =
            all.iter().enumerate().filter(|(n, _)| n % 16 == 0).map(|(_, &t)| t).collect();
        for cycle in 37..900 {
            let want = *edges.iter().find(|&&t| t >= cycle).unwrap();
            assert_eq!(g.divided_from(cycle, 16), want, "from {cycle}");
        }
    }
}
