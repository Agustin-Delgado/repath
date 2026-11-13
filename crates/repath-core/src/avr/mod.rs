//! A microcontroller in the digital domain: an ATmega328P — the chip on an
//! Arduino Uno — running a compiled program, with its port pins on nets.
//!
//! The chip is cycle-exact, and the digital domain is event-driven; stepping
//! the event queue sixteen million times a simulated second to bridge the two
//! would cost more than everything else in a circuit put together. So the
//! device runs ahead instead, and only ever tells the domain about things that
//! have happened:
//!
//! - It keeps a *committed* machine, at a cycle where everything it did has
//!   been published, and the input levels it last saw.
//! - After every evaluation it *speculates*: a copy of the machine runs on
//!   with the inputs as they are, up to the first cycle at which a pin it
//!   drives (or a pull-up) changes, or up to a horizon. Nothing is emitted; the
//!   device only schedules a wake-up for that cycle, by pulsing a net of its
//!   own the way `digital::Memory` does.
//! - Woken at that cycle with the inputs unchanged, it adopts the copy and
//!   emits the change at that very instant.
//! - Told of an input change before then, it throws the copy away, runs the
//!   committed machine up to the change with the *old* inputs — which is
//!   right, since they held until then — applies the new ones and speculates
//!   again. A copy that never read a pin after the change, with no pin
//!   interrupt armed, would have run the same either way, and is kept.
//!
//! A wake-up left behind by a discarded copy is harmless: being evaluated with
//! nothing new to do is a no-op.
//!
//! Time is `floor(t * f)` cycles from the start of the run. An instruction is
//! atomic, so an input that changes while one runs is seen by the next: the
//! committed machine can stand a few cycles past the domain's clock, never
//! behind it, and what it emits carries the cycle it happened on.

#[cfg(test)]
mod asm;
mod cpu;
pub mod hex;
mod machine;
mod timer;
mod twi;

use std::sync::Arc;

use crate::digital::{DigitalDevice, EvalCtx, Logic, NetId};
pub use machine::{FLASH_BYTES, Fault, Peripheral};
use machine::{Machine, PinLevels, PinOutputs, Stop, Watch, flash_words};

/// The clock an Arduino Uno runs its ATmega328P at.
pub const DEFAULT_FREQUENCY: f64 = 16e6;

/// The longest a speculation runs without an output changing, in seconds.
///
/// Trades the cost of waking against the cost of being wrong: every horizon
/// reached is an evaluation, and every input change throws away whatever was
/// run past it. A millisecond is a thousand wake-ups a simulated second for a
/// program that never touches its pins, and at most a millisecond of work lost
/// to one input change — and less in practice, since a speculation cut short
/// starts again from [`MIN_CHUNK`] and only doubles back up while nothing
/// interrupts it.
const HORIZON: f64 = 1e-3;

/// Where a speculation's length starts after an input cut one short, in
/// cycles: an input toggling every few microseconds wastes about as much as
/// it costs to follow.
const MIN_CHUNK: u64 = 256;

/// A wake-up pulse's width. Anything shorter than a clock cycle will do.
const WAKE_PULSE: f64 = 1e-12;

/// A port pin: PB0–PB7, PC0–PC5 or PD0–PD7. PC6 is RESET, wired separately;
/// PB6 and PB7 are the crystal on an Uno, but a pin all the same on a chip
/// clocked another way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pin(u8);

impl Pin {
    pub fn parse(name: &str) -> Option<Pin> {
        let name = name.trim().to_ascii_uppercase();
        let rest = name.strip_prefix('P')?;
        let (port, bit) = rest.split_at_checked(1)?;
        let port = match port {
            "B" => 0,
            "C" => 1,
            "D" => 2,
            _ => return None,
        };
        let bit: u8 = bit.parse().ok()?;
        let count = if port == 1 { 6 } else { 8 };
        (bit < count).then_some(Pin(port * 8 + bit))
    }

    pub fn name(self) -> String {
        format!("P{}{}", ['B', 'C', 'D'][usize::from(self.0 / 8)], self.0 % 8)
    }

    fn bit(self) -> u32 {
        u32::from(self.0)
    }
}

/// The nets one pin reaches. A pin used both ways is given its output and,
/// separately, a net that reads the level back; either may be absent.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PinNets {
    /// Read by PINx. Low and unknown read as 0. High impedance — nothing
    /// driving the net — reads as whatever the chip puts on the pin itself:
    /// its output, or 1 with its pull-up on, else 0.
    pub input: Option<NetId>,
    /// Driven high or low as an output, high impedance as an input.
    pub output: Option<NetId>,
    /// High while the pin's internal pull-up is on (an input with PORTx set),
    /// low otherwise: for the analog side to hang the resistor from.
    pub pullup: Option<NetId>,
}

/// A byte that went out of USART0, timed when its stop bit ended.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SerialByte {
    pub time: f64,
    pub byte: u8,
}

/// The first time the program used a peripheral that is not simulated, timed
/// at the start of the instruction that did it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Notice {
    pub time: f64,
    pub peripheral: Peripheral,
}

#[derive(Debug)]
struct Speculation {
    machine: Machine,
    /// The cycle to adopt it at.
    stop: u64,
    /// Whether it stopped at the horizon rather than at an event.
    horizon: bool,
}

/// An ATmega328P as a digital device.
pub struct Mcu {
    pub name: String,
    frequency: f64,
    flash: Arc<[u16]>,
    pins: Vec<(Pin, PinNets)>,
    reset: Option<NetId>,
    wake: NetId,
    inputs: Vec<NetId>,
    outputs: Vec<NetId>,
    /// Output slot and pin of each drive net, and of each pull-up net.
    drives: Vec<(usize, u32)>,
    pullups: Vec<(usize, u32)>,
    wake_slot: usize,
    watch: Watch,
    max_chunk: u64,
    committed: Machine,
    speculation: Option<Speculation>,
    /// Input changes the speculation was kept through, for the committed
    /// machine to replay if it has to catch up.
    pending: Vec<(u64, PinLevels)>,
    /// The inputs as last seen, `None` before the first evaluation.
    sampled: Option<PinLevels>,
    in_reset: bool,
    /// What each output slot was last driven to.
    published: Vec<Logic>,
    chunk: u64,
    serial: Vec<SerialByte>,
    notices: Vec<Notice>,
    fault: Option<Fault>,
}

impl std::fmt::Debug for Mcu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mcu")
            .field("name", &self.name)
            .field("frequency", &self.frequency)
            .field("committed", &self.committed)
            .field("fault", &self.fault)
            .finish_non_exhaustive()
    }
}

impl Mcu {
    /// A chip with `firmware` in its flash — a byte image from address zero,
    /// at most [`FLASH_BYTES`]; anything past that is dropped — clocked at
    /// `frequency`. `wake` is a net nobody else drives.
    pub fn new(
        name: impl Into<String>,
        firmware: &[u8],
        frequency: f64,
        pins: &[(Pin, PinNets)],
        reset: Option<NetId>,
        wake: NetId,
    ) -> Self {
        let frequency =
            if frequency.is_finite() && frequency > 0.0 { frequency } else { DEFAULT_FREQUENCY };
        let flash = flash_words(&firmware[..firmware.len().min(FLASH_BYTES)]);
        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        let mut drives = Vec::new();
        let mut pullups = Vec::new();
        let mut watch = Watch::default();
        for &(pin, nets) in pins {
            inputs.extend(nets.input);
            if let Some(net) = nets.output {
                drives.push((outputs.len(), pin.bit()));
                outputs.push(net);
                watch.drive |= 1 << pin.bit();
            }
            if let Some(net) = nets.pullup {
                pullups.push((outputs.len(), pin.bit()));
                outputs.push(net);
                watch.pullup |= 1 << pin.bit();
            }
        }
        inputs.extend(reset);
        inputs.push(wake);
        let wake_slot = outputs.len();
        outputs.push(wake);
        let max_chunk = ((HORIZON * frequency) as u64).max(MIN_CHUNK);
        Self {
            name: name.into(),
            frequency,
            committed: Machine::new(flash.clone(), 0),
            flash,
            pins: pins.to_vec(),
            reset,
            wake,
            inputs,
            published: vec![Logic::Unknown; outputs.len()],
            outputs,
            drives,
            pullups,
            wake_slot,
            watch,
            max_chunk,
            speculation: None,
            pending: Vec::new(),
            sampled: None,
            in_reset: false,
            chunk: MIN_CHUNK,
            serial: Vec::new(),
            notices: Vec::new(),
            fault: None,
        }
    }

    pub fn frequency(&self) -> f64 {
        self.frequency
    }

    /// Every byte sent so far, oldest first. A finished byte is one of the
    /// things a speculation stops at, so it is here as soon as the domain's
    /// clock reaches the end of its stop bit.
    pub fn serial(&self) -> &[SerialByte] {
        &self.serial
    }

    /// Each peripheral the program has used that is not simulated, once, in
    /// the order they were first used. Once means once a run: a program
    /// restarted by RESET does the same again, and is not told twice.
    pub fn notices(&self) -> &[Notice] {
        &self.notices
    }

    /// The instruction that stopped the CPU, if one has.
    pub fn fault(&self) -> Option<Fault> {
        self.fault
    }

    /// Back to power-on.
    fn restart(&mut self) {
        self.committed = Machine::new(self.flash.clone(), 0);
        self.speculation = None;
        self.pending.clear();
        self.sampled = None;
        self.in_reset = false;
        self.published.fill(Logic::Unknown);
        self.chunk = MIN_CHUNK;
        self.serial.clear();
        self.notices.clear();
        self.fault = None;
    }

    /// The cycle an instant falls in. A wake-up meant for cycle n arrives as
    /// n / f give or take a rounding error, so an instant within a hair of a
    /// boundary counts as on it.
    fn cycle_at(&self, t: f64) -> u64 {
        let x = t * self.frequency;
        let slack = (x.abs() * 1e-12).max(1e-6);
        (x + slack).floor().max(0.0) as u64
    }

    fn time_of(&self, cycle: u64) -> f64 {
        cycle as f64 / self.frequency
    }

    fn sample(&self, ctx: &EvalCtx) -> (PinLevels, bool) {
        let mut levels = PinLevels::default();
        for &(pin, nets) in &self.pins {
            let Some(net) = nets.input else { continue };
            let bit = 1 << pin.bit();
            match ctx.read(net) {
                Logic::High => {
                    levels.high |= bit;
                    levels.floating &= !bit;
                }
                Logic::Low | Logic::Unknown => levels.floating &= !bit,
                Logic::HighZ => {}
            }
        }
        // Only a low holds the chip in reset: an Uno pulls RESET up, so an
        // undriven reset net is a running chip.
        let reset = self.reset.is_some_and(|net| ctx.read(net) == Logic::Low);
        (levels, reset)
    }

    /// Drive every output that differs from what was last driven, as of `at`.
    fn publish(&mut self, ctx: &mut EvalCtx, at: u64) {
        let out = if self.in_reset { PinOutputs::default() } else { self.committed.outputs() };
        let delay = (self.time_of(at) - ctx.now).max(0.0);
        let Self { drives, pullups, published, outputs, .. } = self;
        let drive_levels = drives.iter().map(|&(slot, bit)| {
            let level = if out.driven >> bit & 1 == 0 {
                Logic::HighZ
            } else {
                Logic::from_bool(out.level >> bit & 1 != 0)
            };
            (slot, level)
        });
        let pullup_levels =
            pullups.iter().map(|&(slot, bit)| (slot, Logic::from_bool(out.pullup >> bit & 1 != 0)));
        for (slot, level) in drive_levels.chain(pullup_levels) {
            if published[slot] != level {
                published[slot] = level;
                ctx.drive(slot, outputs[slot], level, delay);
            }
        }
    }

    fn wake_at(&self, ctx: &mut EvalCtx, cycle: u64) {
        let delay = (self.time_of(cycle) - ctx.now).max(0.0);
        ctx.drive(self.wake_slot, self.wake, Logic::High, delay);
        ctx.drive(self.wake_slot, self.wake, Logic::Low, delay + WAKE_PULSE);
    }

    /// Take over what the committed machine sent, what it used that is not
    /// simulated, and whether it faulted.
    fn absorb(&mut self) {
        let f = self.frequency;
        self.serial.extend(
            self.committed
                .serial
                .drain(..)
                .map(|(cycle, byte)| SerialByte { time: cycle as f64 / f, byte }),
        );
        for (cycle, peripheral) in self.committed.notices.drain(..) {
            if !self.notices.iter().any(|n| n.peripheral == peripheral) {
                self.notices.push(Notice { time: cycle as f64 / f, peripheral });
            }
        }
        if self.fault.is_none() {
            self.fault = self.committed.fault();
        }
    }

    fn adopt(&mut self, ctx: &mut EvalCtx, speculation: Speculation) {
        self.committed = speculation.machine;
        self.pending.clear();
        self.absorb();
        self.publish(ctx, speculation.stop);
        if speculation.horizon {
            self.chunk = (self.chunk * 2).min(self.max_chunk);
        }
    }

    /// Run a copy ahead from the committed machine and schedule waking at
    /// where it stopped — or adopt it at once if that is already now.
    fn speculate(&mut self, ctx: &mut EvalCtx, now: u64) {
        loop {
            let mut machine = self.committed.clone();
            machine.begin_speculation();
            let before = machine.progress();
            let limit = machine.cycle.max(now) + self.chunk;
            let (stop, horizon) = match machine.run(limit, &self.watch) {
                Stop::Changed(at) | Stop::Fault(at) => (at, false),
                Stop::Limit => (machine.cycle, true),
                // Asleep for good with nothing to wake it: only an input can
                // change that, and an input re-evaluates the device anyway.
                Stop::Idle if machine.progress() == before => {
                    self.speculation = None;
                    return;
                }
                Stop::Idle => (machine.cycle, false),
            };
            let speculation = Speculation { machine, stop, horizon };
            if stop <= now {
                self.adopt(ctx, speculation);
                continue;
            }
            self.wake_at(ctx, stop);
            self.speculation = Some(speculation);
            return;
        }
    }

    /// Run the committed machine on to `until`, publishing anything that
    /// changes on the way — which can only be an instruction that began
    /// before `until` and ends after it.
    fn run_committed(&mut self, ctx: &mut EvalCtx, until: u64) {
        loop {
            match self.committed.run(until, &self.watch) {
                Stop::Changed(at) => self.publish(ctx, at),
                Stop::Fault(_) => {}
                Stop::Limit => break,
                Stop::Idle => {
                    self.committed.idle_until(until);
                    break;
                }
            }
        }
        self.absorb();
    }

    /// Bring the committed machine up to `now` with the inputs it had, the
    /// changes a kept speculation went through replayed where they happened.
    fn catch_up(&mut self, ctx: &mut EvalCtx, now: u64) {
        for (at, levels) in std::mem::take(&mut self.pending) {
            self.run_committed(ctx, at);
            self.committed.set_inputs(levels);
        }
        self.run_committed(ctx, now);
    }
}

impl DigitalDevice for Mcu {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "mcu"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.restart();
        ctx.drive(self.wake_slot, self.wake, Logic::Low, 0.0);
        self.publish(ctx, 0);
        self.evaluate(ctx);
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        let now = self.cycle_at(ctx.now);
        let (levels, reset_low) = self.sample(ctx);

        if reset_low {
            if !self.in_reset {
                // What was emitted stands; from here every pin lets go.
                self.in_reset = true;
                self.speculation = None;
                self.pending.clear();
                self.publish(ctx, now);
            }
            self.sampled = Some(levels);
            return;
        }
        if self.in_reset {
            // Out of reset the chip starts from its reset vector, with no
            // start-up delay; see BACKLOG.md.
            self.in_reset = false;
            self.committed = Machine::new(self.flash.clone(), now);
            self.committed.set_inputs(levels);
            self.sampled = Some(levels);
            self.publish(ctx, now);
            self.speculate(ctx, now);
            return;
        }

        if let Some(due) = self.speculation.take_if(|s| s.stop <= now) {
            self.adopt(ctx, due);
        }
        if self.sampled != Some(levels) {
            match self.speculation.as_mut() {
                Some(s) if !s.machine.depends_on_inputs_from(now) => {
                    s.machine.set_inputs(levels);
                    self.pending.push((now, levels));
                }
                _ => {
                    self.speculation = None;
                    self.chunk = MIN_CHUNK;
                    self.catch_up(ctx, now);
                    self.committed.set_inputs(levels);
                }
            }
            self.sampled = Some(levels);
        }
        if self.speculation.is_none() {
            self.speculate(ctx, now);
        }
    }

    fn reset(&mut self) {
        self.restart();
    }
}

#[cfg(test)]
mod tests {
    use super::asm::*;
    use super::*;
    use crate::digital::{DigitalDomain, LogicSource, Transition};

    const F: f64 = 16e6;

    fn image(words: &[u16]) -> Vec<u8> {
        words.iter().flat_map(|w| w.to_le_bytes()).collect()
    }

    fn pin(name: &str) -> Pin {
        Pin::parse(name).unwrap()
    }

    /// The changes on `net`, each as the cycle it happened on. Every one has
    /// to be on a cycle boundary to within rounding: that is what being
    /// cycle-exact means.
    fn edges(log: &[Transition], net: NetId) -> Vec<(u64, Logic)> {
        log.iter()
            .filter(|t| t.net == net)
            .map(|t| {
                let cycles = t.time * F;
                assert!((cycles - cycles.round()).abs() < 1e-6, "{} is between cycles", t.time);
                (cycles.round() as u64, t.state)
            })
            .collect()
    }

    struct Bench {
        domain: DigitalDomain,
    }

    impl Bench {
        fn new() -> Self {
            Self { domain: DigitalDomain::new() }
        }

        fn net(&mut self, name: &str) -> NetId {
            self.domain.add_net(name)
        }

        fn mcu(&mut self, words: &[u16], pins: &[(&str, PinNets)], reset: Option<NetId>) {
            let wake = self.net("wake");
            let pins: Vec<_> = pins.iter().map(|(n, nets)| (pin(n), *nets)).collect();
            let mcu = Mcu::new("U1", &image(words), F, &pins, reset, wake);
            self.domain.add_device(Box::new(mcu));
        }

        fn run(&mut self, cycles: u64) -> Vec<Transition> {
            self.domain.initialize();
            self.domain.settle(cycles as f64 / F);
            self.domain.take_log()
        }

        fn mcu_state(&self) -> &Mcu {
            let device = self.domain.device("U1").unwrap();
            device.as_any().downcast_ref::<Mcu>().unwrap()
        }
    }

    fn output(net: NetId) -> PinNets {
        PinNets { output: Some(net), ..Default::default() }
    }

    #[test]
    fn pin_names_cover_the_ports_and_nothing_else() {
        assert_eq!(Pin::parse("PB5").map(Pin::name), Some("PB5".into()));
        assert_eq!(Pin::parse(" pd7 ").map(Pin::name), Some("PD7".into()));
        assert_eq!(Pin::parse("PC5").map(Pin::name), Some("PC5".into()));
        for bad in ["PC6", "PB8", "PA0", "P", "B5", "PB", "PB-1"] {
            assert_eq!(Pin::parse(bad), None, "{bad}");
        }
    }

    /// Blink: toggle PB5 around a busy-wait whose length the instruction set
    /// manual fixes, and every edge must land on the cycle it adds up to.
    #[test]
    fn a_blink_loop_toggles_on_the_cycle_its_instructions_add_up_to() {
        //        sbi  DDRB, 5        ; 2  PB5 an output, low
        // loop:  sbi  PINB, 5        ; 2  toggle it
        //        ldi  r24, lo(4000)  ; 1
        //        ldi  r25, hi(4000)  ; 1
        // wait:  sbiw r24, 1         ; 2
        //        brne wait           ; 2 taken, 1 not
        //        rjmp loop           ; 2
        let program = [
            sbi(0x04, 5),
            sbi(0x03, 5),
            ldi(24, 0xA0),
            ldi(25, 0x0F),
            sbiw(24, 1),
            brne(-2),
            rjmp(-6),
        ];
        let mut bench = Bench::new();
        let pb5 = bench.net("pb5");
        bench.mcu(&program, &[("PB5", output(pb5))], None);
        let log = bench.run(80_000);

        // PB5 drives low as `sbi DDRB` ends at 2, and toggles as each `sbi
        // PINB` ends: the first at 4, then every 2 + 1 + 1 + (4 * 4000 - 1)
        // + 2 = 16 005 cycles.
        let period = 2 + 1 + 1 + (4 * 4000 - 1) + 2;
        let mut expected = vec![(2, Logic::Low)];
        let mut level = Logic::High;
        let mut at = 4;
        while at <= 80_000 {
            expected.push((at, level));
            level = level.invert();
            at += period;
        }
        assert_eq!(edges(&log, pb5), expected);
    }

    /// Copy PD2 to PB5 in a polling loop, with PD2 operated from outside at
    /// instants the program cannot know about: every change cuts a
    /// speculation short, and the copy must follow with exactly the latency
    /// of the loop.
    #[test]
    fn an_input_is_followed_with_the_latency_of_the_loop_that_polls_it() {
        //        sbi  DDRB, 5     ; 2
        // loop:  sbis PIND, 2     ; 1, or 2 skipping
        //        rjmp clear       ; 2
        //        sbi  PORTB, 5    ; 2
        //        rjmp loop        ; 2
        // clear: cbi  PORTB, 5    ; 2
        //        rjmp loop        ; 2
        let program =
            [sbi(0x04, 5), sbis(0x09, 2), rjmp(2), sbi(0x05, 5), rjmp(-4), cbi(0x05, 5), rjmp(-6)];
        let mut bench = Bench::new();
        let pd2 = bench.net("pd2");
        let pb5 = bench.net("pb5");
        bench.domain.add_device(Box::new(
            LogicSource::new("SW", pd2, Logic::Low).operated_at([10e-6, 20e-6, 30.5e-6]),
        ));
        // PB5 reads itself back too, so its own edges come round as inputs.
        let pb5_nets = PinNets { input: Some(pb5), output: Some(pb5), pullup: None };
        let pd2_nets = PinNets { input: Some(pd2), ..Default::default() };
        bench.mcu(&program, &[("PB5", pb5_nets), ("PD2", pd2_nets)], None);
        let log = bench.run(800);

        // With PD2 low the loop is sbis 1 + rjmp 2 + cbi 2 + rjmp 2 = 7
        // cycles, `sbis` starting at 2 + 7k; high, it is sbis 2 + sbi 2 +
        // rjmp 2 = 6. An instruction sees an input that changed at or before
        // the cycle it starts on.
        //
        // Rise at 10 us = cycle 160: the first sbis from 160 is at 163; it
        // skips, and sbi ends at 163 + 2 + 2 = 167.
        // Fall at 20 us = 320: sbis runs at 163 + 6j, first from 320 at 325;
        // it does not skip, and cbi ends at 325 + 1 + 2 + 2 = 330.
        // Rise at 30.5 us = 488: sbis at 325 + 7j, first from 488 at 493;
        // sbi ends at 497.
        assert_eq!(
            edges(&log, pb5),
            vec![(2, Logic::Low), (167, Logic::High), (330, Logic::Low), (497, Logic::High)]
        );
    }

    /// The Arduino core's millis() hangs off exactly this: Timer0 overflowing
    /// at prescaler 64 into an interrupt.
    #[test]
    fn a_timer_interrupt_toggles_a_pin_every_overflow() {
        let mut program = vec![nop(); 44];
        program[0] = rjmp(33); // reset vector -> main, word 34
        program[32] = rjmp(9); // TIMER0_OVF, vector 16 -> isr, word 42
        let main = [
            sbi(0x04, 5),  // sbi DDRB, 5           ; 2
            ldi(16, 3),    // ldi r16, 3            ; 1
            out(0x25, 16), // out TCCR0B, r16      ; 1  clk/64
            ldi(16, 1),    // ldi r16, 1            ; 1
            sts(0x6E, 16)[0],
            0x006E,       //       sts TIMSK0, r16       ; 2  TOIE0
            sei(),        //       sei                   ; 1
            idle(),       //       rjmp .                ; 2
            sbi(0x03, 5), // isr: sbi PINB, 5      ; 2
            reti(),       //       reti                  ; 4
        ];
        program[34..44].copy_from_slice(&main);
        let mut bench = Bench::new();
        let pb5 = bench.net("pb5");
        bench.mcu(&program, &[("PB5", output(pb5))], None);
        let log = bench.run(50_000);

        // The prescaler runs from power-on, so the timer counts at every
        // multiple of 64 and overflows 256 counts in: TOV0 at 16 384, and
        // every 16 384 after. The idle loop's boundaries fall on even cycles,
        // so the flag is served at once: 4 cycles of response, `rjmp isr` 2,
        // and `sbi PINB` ends 2 later — 8 after the overflow. PB5 went low as
        // `sbi DDRB` ended at 4.
        assert_eq!(
            edges(&log, pb5),
            vec![
                (4, Logic::Low),
                (16_384 + 8, Logic::High),
                (2 * 16_384 + 8, Logic::Low),
                (3 * 16_384 + 8, Logic::High),
            ]
        );
    }

    #[test]
    fn int0_on_a_falling_edge_interrupts_at_the_next_instruction() {
        let mut program = vec![nop(); 13];
        program[0] = rjmp(3); // reset -> main, word 4
        program[2] = rjmp(8); // INT0, vector 1 -> isr, word 11
        let main = [
            sbi(0x04, 5), // sbi DDRB, 5           ; 2..4
            ldi(16, 2),   // ldi r16, ISC01         ; falling edge
            sts(0x69, 16)[0],
            0x0069,       // sts EICRA, r16
            sbi(0x1D, 0), // sbi EIMSK, INT0
            sei(),        // sei                    ; 9..10
            idle(),       // rjmp .                 ; from 10, every 2
            sbi(0x03, 5), // isr: sbi PINB, 5
            reti(),       // reti
        ];
        program[4..13].copy_from_slice(&main);
        let mut bench = Bench::new();
        let pd2 = bench.net("pd2");
        let pb5 = bench.net("pb5");
        bench.domain.add_device(Box::new(
            LogicSource::new("SW", pd2, Logic::High).operated_at([10e-6, 20e-6, 30e-6]),
        ));
        let pd2_nets = PinNets { input: Some(pd2), ..Default::default() };
        bench.mcu(&program, &[("PB5", output(pb5)), ("PD2", pd2_nets)], None);
        let log = bench.run(1_000);
        // Falls at 160 and 480, both instruction boundaries of the idle loop:
        // 4 cycles of response, `rjmp isr` 2, `sbi PINB` 2. The rise at 320
        // is not an edge it was asked for.
        assert_eq!(
            edges(&log, pb5),
            vec![(4, Logic::Low), (160 + 8, Logic::High), (480 + 8, Logic::Low)]
        );
    }

    #[test]
    fn an_interrupt_that_ends_a_sleep_takes_four_cycles_longer() {
        let mut program = vec![nop(); 47];
        program[0] = rjmp(33); // reset -> main, word 34
        program[32] = rjmp(12); // TIMER0_OVF -> isr, word 45
        let main = [
            ldi(16, 1),    // ldi r16, SE          ; idle mode
            out(0x33, 16), // out SMCR, r16
            ldi(16, 3),    // ldi r16, 3
            out(0x25, 16), // out TCCR0B, r16      ; clk/64
            ldi(16, 1),    // ldi r16, TOIE0
            sts(0x6E, 16)[0],
            0x006E,       // sts TIMSK0, r16
            sbi(0x04, 5), // sbi DDRB, 5          ; ends at 11
            sei(),        // sei
            sleep(),      // loop: sleep          ; asleep from 13
            rjmp(-2),     // rjmp loop
            sbi(0x03, 5), // isr: sbi PINB, 5
            reti(),       // reti
        ];
        program[34..47].copy_from_slice(&main);
        let mut bench = Bench::new();
        let pb5 = bench.net("pb5");
        bench.mcu(&program, &[("PB5", output(pb5))], None);
        let log = bench.run(40_000);
        // Overflows at 16 384 and 32 768 as before, but each now wakes the
        // CPU: 4 + 4 cycles of response, `rjmp isr` 2, `sbi PINB` 2.
        assert_eq!(
            edges(&log, pb5),
            vec![(11, Logic::Low), (16_384 + 12, Logic::High), (32_768 + 12, Logic::Low)]
        );
    }

    #[test]
    fn fast_pwm_on_oc0a_has_the_datasheet_duty_cycle() {
        // Non-inverting fast PWM at clk/1 with OCR0A = 63: high for
        // OCR0A + 1 = 64 of every 256 cycles.
        let program = [
            sbi(0x0A, 6),  // sbi DDRD, 6
            ldi(16, 63),   // ldi r16, 63
            out(0x27, 16), // out OCR0A, r16
            ldi(16, 0x83), // ldi r16, COM0A1 | WGM01 | WGM00
            out(0x24, 16), // out TCCR0A, r16
            ldi(16, 1),    // ldi r16, CS00
            out(0x25, 16), // out TCCR0B, r16
            idle(),
        ];
        let mut bench = Bench::new();
        let pd6 = bench.net("pd6");
        bench.mcu(&program, &[("PD6", output(pd6))], None);
        let log = bench.run(3_000);
        let edges = edges(&log, pd6);
        let rises: Vec<u64> = edges.iter().filter(|e| e.1 == Logic::High).map(|e| e.0).collect();
        let falls: Vec<u64> =
            edges.iter().filter(|e| e.1 == Logic::Low).map(|e| e.0).skip(1).collect();
        assert!(rises.len() >= 10, "{edges:?}");
        assert!(rises.windows(2).all(|w| w[1] - w[0] == 256), "{edges:?}");
        assert!(rises.iter().zip(&falls).all(|(r, f)| f - r == 64), "{edges:?}");
    }

    #[test]
    fn reset_holds_the_pins_released_and_starts_the_program_again() {
        // The blink program, with RESET low until 50 us, low again from 100
        // us to 150 us.
        let program = [
            sbi(0x04, 5),
            sbi(0x03, 5),
            ldi(24, 0xA0),
            ldi(25, 0x0F),
            sbiw(24, 1),
            brne(-2),
            rjmp(-6),
        ];
        let mut bench = Bench::new();
        let rst = bench.net("rst");
        let pb5 = bench.net("pb5");
        bench.domain.add_device(Box::new(
            LogicSource::new("RST", rst, Logic::Low).operated_at([50e-6, 100e-6, 150e-6]),
        ));
        bench.mcu(&program, &[("PB5", output(pb5))], Some(rst));
        let log = bench.run(4_000);
        // 50 us is cycle 800: the program starts there, 2 and 4 cycles to its
        // first two edges. At 1600 the pin lets go; at 2400 it all starts over.
        assert_eq!(
            edges(&log, pb5),
            vec![
                (802, Logic::Low),
                (804, Logic::High),
                (1_600, Logic::HighZ),
                (2_402, Logic::Low),
                (2_404, Logic::High),
            ]
        );
    }

    #[test]
    fn a_byte_written_to_udr0_goes_out_on_txd_and_into_the_log() {
        // 8N1 with UBRR0 = 0: sixteen cycles a bit.
        let program = [
            ldi(16, 0x08), // ldi r16, TXEN0
            sts(0xC1, 16)[0],
            0x00C1,        // sts UCSR0B, r16     ; 1..3
            ldi(16, b'H'), // ldi r16, 'H'        ; 3..4
            sts(0xC6, 16)[0],
            0x00C6, //      sts UDR0, r16        ; 4..6
            idle(),
        ];
        let mut bench = Bench::new();
        let txd = bench.net("txd");
        bench.mcu(&program, &[("PD1", output(txd))], None);
        let log = bench.run(400);
        // TXD idles high from TXEN0 on. The frame starts as the store ends at
        // 6: start bit low, then 'H' = 0x48 least significant bit first —
        // 0 0 0 1 0 0 1 0 — then the stop bit, sixteen cycles each.
        assert_eq!(
            edges(&log, txd),
            vec![
                (3, Logic::High),
                (6, Logic::Low),
                (6 + 4 * 16, Logic::High),
                (6 + 5 * 16, Logic::Low),
                (6 + 7 * 16, Logic::High),
                (6 + 8 * 16, Logic::Low),
                (6 + 9 * 16, Logic::High),
            ]
        );
        let mcu = bench.mcu_state();
        assert_eq!(mcu.serial().len(), 1);
        assert_eq!(mcu.serial()[0].byte, b'H');
        assert!((mcu.serial()[0].time * F - 166.0).abs() < 1e-6);
    }

    #[test]
    fn a_fault_is_reported_and_the_pins_stay_as_they_were() {
        // sbi DDRB, 5 / sbi PORTB, 5 / then an opcode this part lacks.
        let program = [sbi(0x04, 5), sbi(0x05, 5), 0x95D8];
        let mut bench = Bench::new();
        let pb5 = bench.net("pb5");
        bench.mcu(&program, &[("PB5", output(pb5))], None);
        let log = bench.run(10_000);
        assert_eq!(edges(&log, pb5), vec![(2, Logic::Low), (4, Logic::High)]);
        let fault = bench.mcu_state().fault().expect("the CPU should have stopped");
        assert_eq!((fault.pc, fault.cycle), (2, 4));
    }

    #[test]
    fn a_program_that_ignores_its_pins_keeps_its_speculation_through_input_changes() {
        // The blink loop never reads a pin, so a PD2 changing under it must
        // leave the edges exactly where they were.
        let program = [
            sbi(0x04, 5),
            sbi(0x03, 5),
            ldi(24, 0xA0),
            ldi(25, 0x0F),
            sbiw(24, 1),
            brne(-2),
            rjmp(-6),
        ];
        let mut bench = Bench::new();
        let pd2 = bench.net("pd2");
        let pb5 = bench.net("pb5");
        let flips: Vec<f64> = (1..40).map(|i| f64::from(i) * 23.7e-6).collect();
        bench
            .domain
            .add_device(Box::new(LogicSource::new("SW", pd2, Logic::Low).operated_at(flips)));
        let pd2_nets = PinNets { input: Some(pd2), ..Default::default() };
        bench.mcu(&program, &[("PB5", output(pb5)), ("PD2", pd2_nets)], None);
        let log = bench.run(40_000);
        assert_eq!(
            edges(&log, pb5),
            vec![(2, Logic::Low), (4, Logic::High), (16_009, Logic::Low), (32_014, Logic::High)]
        );
    }

    /// A program that starts a conversion on every pass of a loop that reads
    /// a pin, then enables SPI once the loop is done, with that pin flipping
    /// under it — every flip throws a speculation away — and a reset that
    /// starts it all again. Each peripheral comes out once, at the instruction
    /// that first used it.
    #[test]
    fn notices_come_out_once_through_rollbacks_and_resets() {
        let program = [
            ldi(16, 0xC0), // ldi r16, ADEN | ADSC  ; 0..1
            sts(0x7A, 16)[0],
            0x007A,        // sts ADCSRA, r16       ; 1..3   noticed at 1
            ldi(24, 0xE8), // ldi r24, lo(1000)     ; 3..4
            ldi(25, 0x03), // ldi r25, hi(1000)     ; 4..5
            in_(17, 0x09), // loop: in r17, PIND    ; 1
            sts(0x7A, 16)[0],
            0x007A,        // sts ADCSRA, r16       ; 2
            sbiw(24, 1),   // sbiw r24, 1           ; 2
            brne(-5),      // brne loop             ; 2 taken, 1 not
            ldi(16, 0x40), // ldi r16, SPE
            out(0x2C, 16), // out SPCR, r16
            idle(),
        ];
        let mut bench = Bench::new();
        let pd2 = bench.net("pd2");
        let rst = bench.net("rst");
        let flips: Vec<f64> = (1..30).map(|i| f64::from(i) * 23.7e-6).collect();
        bench
            .domain
            .add_device(Box::new(LogicSource::new("SW", pd2, Logic::Low).operated_at(flips)));
        bench.domain.add_device(Box::new(
            LogicSource::new("RST", rst, Logic::High).operated_at([50e-6, 60e-6]),
        ));
        let pd2_nets = PinNets { input: Some(pd2), ..Default::default() };
        bench.mcu(&program, &[("PD2", pd2_nets)], Some(rst));
        bench.run(12_000);
        // The loop starts at 5 and takes 7 cycles a pass but the last, which
        // takes 6: `out SPCR` starts 5 + 7 · 1000 = 7005 cycles in. The reset
        // runs from 50 µs to 60 µs, so the program starts again at cycle 960,
        // and the first run never got that far. The conversion it notices
        // again at 961 was already noticed at 1.
        let notices = bench.mcu_state().notices();
        let cycles: Vec<(Peripheral, f64)> =
            notices.iter().map(|n| (n.peripheral, (n.time * F * 1e6).round() / 1e6)).collect();
        assert_eq!(cycles, vec![(Peripheral::Adc, 1.0), (Peripheral::Spi, 960.0 + 7005.0)]);
    }

    #[test]
    fn a_pull_up_is_reported_on_its_own_net() {
        // ldi r16, 0x04 / out PORTD, r16: PD2 an input with its pull-up on.
        let program = [ldi(16, 0x04), out(0x0B, 16), idle()];
        let mut bench = Bench::new();
        let pull = bench.net("pull");
        let pd2 = PinNets { pullup: Some(pull), ..Default::default() };
        bench.mcu(&program, &[("PD2", pd2)], None);
        let log = bench.run(100);
        assert_eq!(edges(&log, pull), vec![(0, Logic::Low), (2, Logic::High)]);
    }
}
