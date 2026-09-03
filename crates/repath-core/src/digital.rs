//! The event-driven digital domain.
//!
//! Nothing here steps through time. Devices only run when one of their inputs
//! actually changes, and they schedule their outputs into the future by their
//! propagation delay. A 100 MHz clock feeding an idle counter costs a handful of
//! evaluations per cycle, not one per analog timestep.
//!
//! Nets are multiply driven on purpose — that is how a tri-state bus works — so
//! every driver keeps its own value and the net resolves them on read.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

/// A digital net (wire).
pub type NetId = usize;

/// Identifies one device output driving one net.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct DriverId(pub usize);

/// Four-state logic. `Unknown` is a real value, not an error: it is what an
/// uninitialized flip-flop holds and what a bus contention produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Logic {
    Low,
    High,
    Unknown,
    HighZ,
}

impl Logic {
    #[inline]
    pub fn from_bool(b: bool) -> Self {
        if b { Logic::High } else { Logic::Low }
    }

    /// `Some(true|false)` for a driven level, `None` for X and Z.
    #[inline]
    pub fn as_bool(self) -> Option<bool> {
        match self {
            Logic::Low => Some(false),
            Logic::High => Some(true),
            _ => None,
        }
    }

    /// A floating input reads as unknown to the logic that consumes it.
    #[inline]
    pub fn sense(self) -> Self {
        if self == Logic::HighZ { Logic::Unknown } else { self }
    }

    #[inline]
    pub fn invert(self) -> Self {
        match self.sense() {
            Logic::Low => Logic::High,
            Logic::High => Logic::Low,
            other => other,
        }
    }

    #[inline]
    pub fn and(self, other: Self) -> Self {
        // A single dominant zero settles the result even if the other input is X.
        match (self.sense(), other.sense()) {
            (Logic::Low, _) | (_, Logic::Low) => Logic::Low,
            (Logic::High, Logic::High) => Logic::High,
            _ => Logic::Unknown,
        }
    }

    #[inline]
    pub fn or(self, other: Self) -> Self {
        match (self.sense(), other.sense()) {
            (Logic::High, _) | (_, Logic::High) => Logic::High,
            (Logic::Low, Logic::Low) => Logic::Low,
            _ => Logic::Unknown,
        }
    }

    #[inline]
    pub fn xor(self, other: Self) -> Self {
        match (self.as_bool(), other.as_bool()) {
            (Some(a), Some(b)) => Logic::from_bool(a != b),
            _ => Logic::Unknown,
        }
    }

    /// Combine two drivers on the same net.
    #[inline]
    pub fn resolve(self, other: Self) -> Self {
        match (self, other) {
            (Logic::HighZ, x) | (x, Logic::HighZ) => x,
            (a, b) if a == b => a,
            // Two drivers fighting: neither wins.
            _ => Logic::Unknown,
        }
    }
}

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct Event {
    pub time: f64,
    pub driver: DriverId,
    pub net: NetId,
    pub state: Logic,
    /// Insertion order, so events at the same instant fire deterministically.
    seq: u64,
}

impl PartialEq for Event {
    fn eq(&self, other: &Self) -> bool {
        self.time == other.time && self.seq == other.seq
    }
}
impl Eq for Event {}

impl Ord for Event {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reversed: `BinaryHeap` is a max-heap and we want the earliest event.
        other.time.total_cmp(&self.time).then_with(|| other.seq.cmp(&self.seq))
    }
}
impl PartialOrd for Event {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Default)]
pub struct EventQueue {
    heap: BinaryHeap<Event>,
    seq: u64,
}

impl EventQueue {
    pub fn push(&mut self, time: f64, driver: DriverId, net: NetId, state: Logic) {
        self.seq += 1;
        self.heap.push(Event { time, driver, net, state, seq: self.seq });
    }

    /// Time of the next pending event, if any.
    pub fn next_time(&self) -> Option<f64> {
        self.heap.peek().map(|e| e.time)
    }

    /// Remove and return the next event if it is due at or before `time`.
    pub fn pop_due(&mut self, time: f64) -> Option<Event> {
        match self.heap.peek() {
            Some(e) if e.time <= time => self.heap.pop(),
            _ => None,
        }
    }

    pub fn clear(&mut self) {
        self.heap.clear();
        self.seq = 0;
    }

    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/// What a device sees while evaluating.
pub struct EvalCtx<'a> {
    pub now: f64,
    resolved: &'a [Logic],
    queue: &'a mut EventQueue,
    /// First driver id owned by the device being evaluated.
    driver_base: usize,
}

impl EvalCtx<'_> {
    /// Resolved state of a net.
    #[inline]
    pub fn read(&self, net: NetId) -> Logic {
        self.resolved.get(net).copied().unwrap_or(Logic::Unknown)
    }

    /// Drive one of this device's outputs, taking effect after `delay` seconds.
    pub fn drive(&mut self, output_index: usize, net: NetId, state: Logic, delay: f64) {
        let time = self.now + delay.max(0.0);
        self.queue.push(time, DriverId(self.driver_base + output_index), net, state);
    }
}

/// A device in the digital domain.
pub trait DigitalDevice: std::fmt::Debug + Send {
    fn name(&self) -> &str;
    fn kind(&self) -> &'static str;
    /// Nets this device listens to. Changes on these trigger `evaluate`.
    fn input_nets(&self) -> &[NetId];
    /// Nets this device drives, in the order `EvalCtx::drive` indexes them.
    fn output_nets(&self) -> &[NetId];

    /// Called once before time starts. Clocks schedule their first edge here;
    /// combinational parts publish their initial output.
    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.evaluate(ctx);
    }

    /// Called whenever an input net settles on a new value.
    fn evaluate(&mut self, ctx: &mut EvalCtx);

    fn reset(&mut self) {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GateKind {
    Buffer,
    Not,
    And,
    Nand,
    Or,
    Nor,
    Xor,
    Xnor,
}

/// A combinational gate with any number of inputs.
#[derive(Debug, Clone)]
pub struct Gate {
    pub name: String,
    pub kind: GateKind,
    pub inputs: Vec<NetId>,
    pub output: NetId,
    /// Propagation delay in seconds.
    pub delay: f64,
    outputs: Vec<NetId>,
}

impl Gate {
    pub fn new(
        name: impl Into<String>,
        kind: GateKind,
        inputs: Vec<NetId>,
        output: NetId,
        delay: f64,
    ) -> Self {
        Self {
            name: name.into(),
            kind,
            inputs,
            output,
            delay: delay.max(0.0),
            outputs: vec![output],
        }
    }

    fn compute(&self, values: &[Logic]) -> Logic {
        match self.kind {
            GateKind::Buffer => values.first().copied().unwrap_or(Logic::Unknown).sense(),
            GateKind::Not => values.first().copied().unwrap_or(Logic::Unknown).invert(),
            GateKind::And => values.iter().fold(Logic::High, |a, b| a.and(*b)),
            GateKind::Nand => values.iter().fold(Logic::High, |a, b| a.and(*b)).invert(),
            GateKind::Or => values.iter().fold(Logic::Low, |a, b| a.or(*b)),
            GateKind::Nor => values.iter().fold(Logic::Low, |a, b| a.or(*b)).invert(),
            GateKind::Xor => values.iter().fold(Logic::Low, |a, b| a.xor(*b)),
            GateKind::Xnor => values.iter().fold(Logic::Low, |a, b| a.xor(*b)).invert(),
        }
    }
}

impl DigitalDevice for Gate {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "gate"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        let values: Vec<Logic> = self.inputs.iter().map(|n| ctx.read(*n)).collect();
        let out = self.compute(&values);
        ctx.drive(0, self.output, out, self.delay);
    }
}

/// A free-running clock. It has no inputs; it reschedules itself forever.
#[derive(Debug, Clone)]
pub struct Clock {
    pub name: String,
    pub output: NetId,
    /// Time spent low and high per cycle.
    pub low_time: f64,
    pub high_time: f64,
    /// Delay before the first rising edge.
    pub start_delay: f64,
    state: Logic,
    inputs: Vec<NetId>,
    outputs: Vec<NetId>,
}

impl Clock {
    pub fn new(name: impl Into<String>, output: NetId, frequency: f64, duty: f64) -> Self {
        let period = 1.0 / frequency.max(1e-12);
        let duty = duty.clamp(0.01, 0.99);
        Self {
            name: name.into(),
            output,
            low_time: period * (1.0 - duty),
            high_time: period * duty,
            start_delay: 0.0,
            state: Logic::Low,
            // A clock listens to its own output. That is what re-triggers it: the
            // edge it just produced is the event that makes it schedule the next.
            inputs: vec![output],
            outputs: vec![output],
        }
    }
}

impl DigitalDevice for Clock {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "clock"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.state = Logic::Low;
        ctx.drive(0, self.output, Logic::Low, 0.0);
        ctx.drive(0, self.output, Logic::High, self.start_delay + self.low_time);
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        // Reached only when our own edge lands, since the clock has no inputs.
        let current = ctx.read(self.output);
        let (next, hold) = match current {
            Logic::High => (Logic::Low, self.high_time),
            _ => (Logic::High, self.low_time),
        };
        self.state = current;
        ctx.drive(0, self.output, next, hold);
    }
}

/// A logic level somebody set, holding a net at it for the whole run.
///
/// The digital counterpart of a switch, and a genuinely different part rather
/// than a convenience. A switch is a contact: it either connects a net to
/// something or leaves it connected to nothing, and "nothing" is not a logic
/// level — which is why a switch feeding a gate input needs a resistor to hold
/// that input when the contact is open. This drives instead. Both of its
/// positions are a level, so there is nothing to pull and no instant at which
/// the net is adrift.
///
/// It has no inputs, so nothing in the circuit can move it and `evaluate` is
/// never reached after the start. That is the point of it.
///
/// `flips` is when somebody moved it, in seconds from the start of the run: each
/// entry inverts the level from that instant on. A run is replayed from zero
/// every time the drawing changes, so an operation performed halfway through has
/// to be part of the description of the circuit rather than something done to a
/// running one — otherwise the past would be rewritten by every click, and the
/// step you just made would be the one thing the waveform did not show.
#[derive(Debug, Clone)]
pub struct LogicSource {
    pub name: String,
    pub output: NetId,
    pub state: Logic,
    pub flips: Vec<f64>,
    inputs: Vec<NetId>,
    outputs: Vec<NetId>,
}

impl LogicSource {
    pub fn new(name: impl Into<String>, output: NetId, state: Logic) -> Self {
        Self {
            name: name.into(),
            output,
            state,
            flips: Vec::new(),
            inputs: Vec::new(),
            outputs: vec![output],
        }
    }

    /// The same source, operated at each of these instants.
    pub fn operated_at(mut self, flips: impl IntoIterator<Item = f64>) -> Self {
        self.flips = flips.into_iter().filter(|t| t.is_finite() && *t > 0.0).collect();
        self.flips.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        self
    }
}

impl DigitalDevice for LogicSource {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "logic_source"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    /// The whole schedule goes on the queue before time starts.
    ///
    /// Nothing else can put it there: with no inputs this device is never
    /// evaluated again, which is exactly the property that makes it stable.
    fn initialize(&mut self, ctx: &mut EvalCtx) {
        ctx.drive(0, self.output, self.state, 0.0);
        let mut level = self.state;
        for at in self.flips.clone() {
            level = match level {
                Logic::High => Logic::Low,
                _ => Logic::High,
            };
            ctx.drive(0, self.output, level, at);
        }
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        ctx.drive(0, self.output, self.state, 0.0);
    }
}

/// Positive-edge-triggered D flip-flop with an optional asynchronous reset.
#[derive(Debug, Clone)]
pub struct DFlipFlop {
    pub name: String,
    pub clk: NetId,
    pub d: NetId,
    /// Active-high asynchronous reset. `None` if unused.
    pub reset: Option<NetId>,
    pub preset: Option<NetId>,
    pub q: NetId,
    pub qn: NetId,
    /// Clock-to-output delay.
    pub delay: f64,
    prev_clk: Logic,
    stored: Logic,
    inputs: Vec<NetId>,
    outputs: Vec<NetId>,
}

/// The inputs that act whatever the clock is doing.
///
/// Together rather than as two more arguments, because they are one idea: the
/// pair of pins a datasheet groups under "asynchronous inputs", and the pair a
/// caller with neither of them leaves at `default()`.
#[derive(Debug, Clone, Copy, Default)]
pub struct AsyncInputs {
    pub reset: Option<NetId>,
    pub preset: Option<NetId>,
}

impl DFlipFlop {
    pub fn new(
        name: impl Into<String>,
        clk: NetId,
        d: NetId,
        async_inputs: AsyncInputs,
        q: NetId,
        qn: NetId,
        delay: f64,
    ) -> Self {
        let AsyncInputs { reset, preset } = async_inputs;
        let mut inputs = vec![clk, d];
        inputs.extend(reset);
        inputs.extend(preset);
        Self {
            name: name.into(),
            clk,
            d,
            reset,
            preset,
            q,
            qn,
            delay: delay.max(0.0),
            prev_clk: Logic::Unknown,
            // Powers up low rather than unknown. Real hardware comes up in an
            // arbitrary state, but an unknown here can never resolve: a toggle
            // flip-flop feeds `qn` back into `d`, and `invert(X)` is `X`, so a
            // divide-by-two drawn without a reset would sit at X forever. Being
            // useful beats being pedantic; wire up the reset input for rigour.
            stored: Logic::Low,
            inputs,
            outputs: vec![q, qn],
        }
    }

    fn publish(&self, ctx: &mut EvalCtx) {
        ctx.drive(0, self.q, self.stored, self.delay);
        ctx.drive(1, self.qn, self.stored.invert(), self.delay);
    }
}

impl DigitalDevice for DFlipFlop {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "dff"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.prev_clk = ctx.read(self.clk);
        self.publish(ctx);
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        if let Some(rst) = self.reset
            && ctx.read(rst) == Logic::High
        {
            self.prev_clk = ctx.read(self.clk);
            if self.stored != Logic::Low {
                self.stored = Logic::Low;
                self.publish(ctx);
            }
            return;
        }
        // Checked after reset, so holding both puts the output low. A datasheet
        // calls that combination invalid and means it: on real silicon both
        // outputs go high at once and they are supposed to be opposites. Picking
        // an order is not a claim that the hardware does this — it is refusing to
        // leave a part of the model undefined.
        if let Some(pre) = self.preset
            && ctx.read(pre) == Logic::High
        {
            self.prev_clk = ctx.read(self.clk);
            if self.stored != Logic::High {
                self.stored = Logic::High;
                self.publish(ctx);
            }
            return;
        }

        let clk = ctx.read(self.clk);
        let rising = self.prev_clk == Logic::Low && clk == Logic::High;
        self.prev_clk = clk;
        if rising {
            let d = ctx.read(self.d).sense();
            if d != self.stored {
                self.stored = d;
                self.publish(ctx);
            }
        }
    }

    fn reset(&mut self) {
        self.prev_clk = Logic::Unknown;
        self.stored = Logic::Low;
    }
}

/// A tri-state buffer: passes `input` to `output` when `enable` is high, and
/// releases the net to high impedance otherwise. The building block of a bus.
#[derive(Debug, Clone)]
pub struct TriStateBuffer {
    pub name: String,
    pub input: NetId,
    pub enable: NetId,
    pub output: NetId,
    pub delay: f64,
    inputs: Vec<NetId>,
    outputs: Vec<NetId>,
}

impl TriStateBuffer {
    pub fn new(
        name: impl Into<String>,
        input: NetId,
        enable: NetId,
        output: NetId,
        delay: f64,
    ) -> Self {
        Self {
            name: name.into(),
            input,
            enable,
            output,
            delay: delay.max(0.0),
            inputs: vec![input, enable],
            outputs: vec![output],
        }
    }
}

impl DigitalDevice for TriStateBuffer {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "tristate"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        let out = match ctx.read(self.enable) {
            Logic::High => ctx.read(self.input).sense(),
            Logic::Low => Logic::HighZ,
            // An unknown enable means we cannot say whether the net is driven.
            _ => Logic::Unknown,
        };
        ctx.drive(0, self.output, out, self.delay);
    }
}

// ---------------------------------------------------------------------------
// The digital domain
// ---------------------------------------------------------------------------

/// Guard against combinational loops: a chain of zero-delay gates that keeps
/// re-triggering at the same instant would otherwise hang the simulation.
const MAX_DELTA_CYCLES: usize = 10_000;

#[derive(Debug)]
struct Net {
    name: String,
    drivers: Vec<DriverId>,
    resolved: Logic,
}

/// The event-driven half of the simulator.
#[derive(Debug, Default)]
pub struct DigitalDomain {
    nets: Vec<Net>,
    devices: Vec<Box<dyn DigitalDevice>>,
    /// First driver id owned by each device.
    driver_base: Vec<usize>,
    /// Current value published by each driver.
    driver_values: Vec<Logic>,
    /// Net -> devices that read it.
    fanout: Vec<Vec<usize>>,
    queue: EventQueue,
    resolved: Vec<Logic>,
    /// Nets whose resolved value changed during the current instant.
    dirty: Vec<NetId>,
    /// When each net last changed, which is the time of the event that did it and
    /// not the instant somebody got round to asking.
    ///
    /// A settle covers everything due up to a time, so several instants can be
    /// resolved in one call. Stamping the answer with the time of the call is what
    /// puts every digital edge on the analog grid: a gate delay of a nanosecond
    /// inside a microsecond step comes back as having taken a microsecond.
    changed_at: Vec<f64>,
}

impl DigitalDomain {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_net(&mut self, name: impl Into<String>) -> NetId {
        let id = self.nets.len();
        self.nets.push(Net { name: name.into(), drivers: Vec::new(), resolved: Logic::HighZ });
        self.resolved.push(Logic::HighZ);
        self.fanout.push(Vec::new());
        self.changed_at.push(0.0);
        id
    }

    pub fn net_count(&self) -> usize {
        self.nets.len()
    }

    pub fn net_name(&self, net: NetId) -> Option<&str> {
        self.nets.get(net).map(|n| n.name.as_str())
    }

    pub fn state(&self, net: NetId) -> Logic {
        self.resolved.get(net).copied().unwrap_or(Logic::Unknown)
    }

    /// Register a device and wire up its driver slots and fanout.
    pub fn add_device(&mut self, device: Box<dyn DigitalDevice>) -> usize {
        let index = self.devices.len();
        let base = self.driver_values.len();

        for (i, net) in device.output_nets().iter().enumerate() {
            let id = DriverId(base + i);
            self.driver_values.push(Logic::HighZ);
            if let Some(n) = self.nets.get_mut(*net) {
                n.drivers.push(id);
            }
        }
        for net in device.input_nets() {
            if let Some(f) = self.fanout.get_mut(*net)
                && !f.contains(&index)
            {
                f.push(index);
            }
        }

        self.driver_base.push(base);
        self.devices.push(device);
        index
    }

    /// Register an external driver — used by analog-to-digital bridges, which
    /// are not devices but still need to own a slot on a net.
    pub fn add_external_driver(&mut self, net: NetId) -> DriverId {
        let id = DriverId(self.driver_values.len());
        self.driver_values.push(Logic::HighZ);
        if let Some(n) = self.nets.get_mut(net) {
            n.drivers.push(id);
        }
        id
    }

    /// Schedule an event from outside the domain.
    pub fn schedule(&mut self, time: f64, driver: DriverId, net: NetId, state: Logic) {
        self.queue.push(time, driver, net, state);
    }

    /// Move a named source to a level from `at` onwards, as a hand would.
    ///
    /// Only meaningful for a device that drives without listening — a logic
    /// source. Anything with inputs is told what to do by its inputs, and forcing
    /// its output would last exactly until the next thing it heard.
    ///
    /// Returns whether such a device exists.
    pub fn operate(&mut self, name: &str, state: Logic, at: f64) -> bool {
        let Some(index) = self.devices.iter().position(|d| d.name() == name) else {
            return false;
        };
        if !self.devices[index].input_nets().is_empty() {
            return false;
        }
        let Some(&net) = self.devices[index].output_nets().first() else {
            return false;
        };
        self.queue.push(at, DriverId(self.driver_base[index]), net, state);
        true
    }

    /// Time of the earliest pending event.
    pub fn next_event_time(&self) -> Option<f64> {
        self.queue.next_time()
    }

    /// Publish initial values and let clocks schedule their first edges.
    pub fn initialize(&mut self) {
        for index in 0..self.devices.len() {
            let mut device = std::mem::replace(&mut self.devices[index], Box::new(NullDevice));
            let mut ctx = EvalCtx {
                now: 0.0,
                resolved: &self.resolved,
                queue: &mut self.queue,
                driver_base: self.driver_base[index],
            };
            device.initialize(&mut ctx);
            self.devices[index] = device;
        }
        self.settle(0.0);
    }

    /// Nets whose resolved value changed during the most recent [`Self::settle`].
    pub fn changed_nets(&self) -> &[NetId] {
        &self.dirty
    }

    /// When a net last took the value it is holding.
    ///
    /// The time of the event that set it, which is what a waveform has to be drawn
    /// against. It is not the same as the instant the caller settled to: one call
    /// can run out several instants' worth of queue.
    pub fn changed_at(&self, net: NetId) -> f64 {
        self.changed_at.get(net).copied().unwrap_or(0.0)
    }

    /// Apply every event due at or before `time`, then propagate until the
    /// domain is stable. Returns how many nets changed value; the nets themselves
    /// are available from [`Self::changed_nets`].
    pub fn settle(&mut self, time: f64) -> usize {
        self.dirty.clear();
        let mut changed_any = Vec::new();

        for _ in 0..MAX_DELTA_CYCLES {
            let mut applied = false;
            while let Some(event) = self.queue.pop_due(time) {
                applied = true;
                if self.driver_values[event.driver.0] == event.state {
                    continue;
                }
                self.driver_values[event.driver.0] = event.state;
                let resolved = self.resolve(event.net);
                if resolved != self.resolved[event.net] {
                    self.resolved[event.net] = resolved;
                    self.nets[event.net].resolved = resolved;
                    self.changed_at[event.net] = event.time;
                    if !self.dirty.contains(&event.net) {
                        self.dirty.push(event.net);
                    }
                    if !changed_any.contains(&event.net) {
                        changed_any.push(event.net);
                    }
                }
            }

            if self.dirty.is_empty() {
                if !applied {
                    break;
                }
                continue;
            }

            // Re-evaluate everything downstream of the nets that moved.
            let touched: Vec<usize> = {
                let mut devices = Vec::new();
                for net in &self.dirty {
                    for d in &self.fanout[*net] {
                        if !devices.contains(d) {
                            devices.push(*d);
                        }
                    }
                }
                devices
            };
            self.dirty.clear();

            for index in touched {
                let mut device = std::mem::replace(&mut self.devices[index], Box::new(NullDevice));
                let mut ctx = EvalCtx {
                    now: time,
                    resolved: &self.resolved,
                    queue: &mut self.queue,
                    driver_base: self.driver_base[index],
                };
                device.evaluate(&mut ctx);
                self.devices[index] = device;
            }

            // Anything those devices scheduled with zero delay is due right now,
            // so loop again; anything with real delay waits for a later call.
            if self.queue.next_time().is_none_or(|t| t > time) {
                break;
            }
        }

        self.dirty = changed_any;
        self.dirty.len()
    }

    fn resolve(&self, net: NetId) -> Logic {
        self.nets[net]
            .drivers
            .iter()
            .fold(Logic::HighZ, |acc, d| acc.resolve(self.driver_values[d.0]))
    }

    pub fn reset(&mut self) {
        self.queue.clear();
        self.driver_values.fill(Logic::HighZ);
        for (i, n) in self.nets.iter_mut().enumerate() {
            n.resolved = Logic::HighZ;
            self.resolved[i] = Logic::HighZ;
            self.changed_at[i] = 0.0;
        }
        for d in &mut self.devices {
            d.reset();
        }
        self.dirty.clear();
    }
}

/// Placeholder used while a device is temporarily moved out of the vector.
#[derive(Debug)]
struct NullDevice;

impl DigitalDevice for NullDevice {
    fn name(&self) -> &str {
        ""
    }
    fn kind(&self) -> &'static str {
        "null"
    }
    fn input_nets(&self) -> &[NetId] {
        &[]
    }
    fn output_nets(&self) -> &[NetId] {
        &[]
    }
    fn evaluate(&mut self, _ctx: &mut EvalCtx) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn and_is_dominated_by_a_zero() {
        assert_eq!(Logic::Low.and(Logic::Unknown), Logic::Low);
        assert_eq!(Logic::High.and(Logic::Unknown), Logic::Unknown);
        assert_eq!(Logic::High.and(Logic::High), Logic::High);
    }

    #[test]
    fn contention_produces_unknown() {
        assert_eq!(Logic::High.resolve(Logic::Low), Logic::Unknown);
        assert_eq!(Logic::HighZ.resolve(Logic::High), Logic::High);
        assert_eq!(Logic::HighZ.resolve(Logic::HighZ), Logic::HighZ);
    }

    #[test]
    fn events_come_out_in_time_order() {
        let mut q = EventQueue::default();
        q.push(3.0, DriverId(0), 0, Logic::High);
        q.push(1.0, DriverId(0), 1, Logic::Low);
        q.push(2.0, DriverId(0), 2, Logic::High);
        assert_eq!(q.pop_due(10.0).unwrap().net, 1);
        assert_eq!(q.pop_due(10.0).unwrap().net, 2);
        assert_eq!(q.pop_due(10.0).unwrap().net, 0);
        assert!(q.pop_due(10.0).is_none());
    }

    #[test]
    fn events_are_not_delivered_early() {
        let mut q = EventQueue::default();
        q.push(5.0, DriverId(0), 0, Logic::High);
        assert!(q.pop_due(4.9).is_none());
        assert!(q.pop_due(5.0).is_some());
    }

    #[test]
    fn an_inverter_chain_propagates_with_delay() {
        let mut d = DigitalDomain::new();
        let a = d.add_net("a");
        let b = d.add_net("b");
        let c = d.add_net("c");
        d.add_device(Box::new(Gate::new("N1", GateKind::Not, vec![a], b, 1e-9)));
        d.add_device(Box::new(Gate::new("N2", GateKind::Not, vec![b], c, 1e-9)));

        let src = d.add_external_driver(a);
        d.initialize();

        d.schedule(0.0, src, a, Logic::High);
        d.settle(0.0);
        assert_eq!(d.state(a), Logic::High);
        // One gate delay has not elapsed, so nothing downstream may have moved.
        assert_ne!(d.state(b), Logic::Low);
        assert_ne!(d.state(c), Logic::High);

        d.settle(1.5e-9);
        assert_eq!(d.state(b), Logic::Low);
        d.settle(2.5e-9);
        assert_eq!(d.state(c), Logic::High);
    }

    #[test]
    fn flip_flop_captures_on_the_rising_edge() {
        let mut d = DigitalDomain::new();
        let clk = d.add_net("clk");
        let data = d.add_net("d");
        let q = d.add_net("q");
        let qn = d.add_net("qn");
        d.add_device(Box::new(DFlipFlop::new(
            "FF1",
            clk,
            data,
            AsyncInputs::default(),
            q,
            qn,
            1e-9,
        )));

        let clk_drv = d.add_external_driver(clk);
        let d_drv = d.add_external_driver(data);
        d.initialize();

        d.schedule(0.0, clk_drv, clk, Logic::Low);
        d.schedule(0.0, d_drv, data, Logic::High);
        d.settle(0.0);
        // Data alone must not change the output.
        assert_ne!(d.state(q), Logic::High);

        d.schedule(10e-9, clk_drv, clk, Logic::High);
        d.settle(10e-9);
        // Deliberately past the clock-to-output delay: `10e-9 + 1e-9` and the
        // literal `11e-9` are not the same f64, and a test should not depend on
        // which way that lands.
        d.settle(12e-9);
        assert_eq!(d.state(q), Logic::High);
        assert_eq!(d.state(qn), Logic::Low);
    }

    #[test]
    fn preset_and_reset_act_without_a_clock() {
        // Both are asynchronous, which is the whole point of them: a 7474 clears
        // whatever the clock is doing, and a power-on reset has to work before
        // there is a clock at all.
        let mut d = DigitalDomain::new();
        let clk = d.add_net("clk");
        let data = d.add_net("d");
        let rst = d.add_net("rst");
        let pre = d.add_net("pre");
        let q = d.add_net("q");
        let qn = d.add_net("qn");
        d.add_device(Box::new(DFlipFlop::new(
            "FF1",
            clk,
            data,
            AsyncInputs { reset: Some(rst), preset: Some(pre) },
            q,
            qn,
            1e-9,
        )));

        let clk_drv = d.add_external_driver(clk);
        let d_drv = d.add_external_driver(data);
        let rst_drv = d.add_external_driver(rst);
        let pre_drv = d.add_external_driver(pre);
        d.initialize();

        d.schedule(0.0, clk_drv, clk, Logic::Low);
        d.schedule(0.0, d_drv, data, Logic::Low);
        d.schedule(0.0, rst_drv, rst, Logic::Low);
        d.schedule(0.0, pre_drv, pre, Logic::Low);
        d.settle(0.0);
        // Past the publish delay: the initial output is scheduled like any other.
        d.settle(2e-9);
        assert_eq!(d.state(q), Logic::Low);

        // Preset takes it high with the clock sitting still and d holding low.
        d.schedule(10e-9, pre_drv, pre, Logic::High);
        d.settle(10e-9);
        d.settle(12e-9);
        assert_eq!(d.state(q), Logic::High);
        assert_eq!(d.state(qn), Logic::Low);

        // It holds after the preset goes away, because a flip-flop is a thing
        // that holds — this is not the input being followed.
        d.schedule(20e-9, pre_drv, pre, Logic::Low);
        d.settle(20e-9);
        d.settle(22e-9);
        assert_eq!(d.state(q), Logic::High);

        // And reset wins when both are held, which is the order the comment in
        // `evaluate` picks deliberately.
        d.schedule(30e-9, pre_drv, pre, Logic::High);
        d.schedule(30e-9, rst_drv, rst, Logic::High);
        d.settle(30e-9);
        d.settle(32e-9);
        assert_eq!(d.state(q), Logic::Low);
    }

    #[test]
    fn clock_keeps_toggling() {
        let mut d = DigitalDomain::new();
        let clk = d.add_net("clk");
        d.add_device(Box::new(Clock::new("CLK", clk, 1e6, 0.5)));
        d.initialize();

        let period = 1e-6;
        d.settle(period * 0.5);
        assert_eq!(d.state(clk), Logic::High);
        d.settle(period * 1.0);
        assert_eq!(d.state(clk), Logic::Low);
        d.settle(period * 1.5);
        assert_eq!(d.state(clk), Logic::High);
    }

    #[test]
    fn tristate_releases_the_bus() {
        let mut d = DigitalDomain::new();
        let input = d.add_net("in");
        let en = d.add_net("en");
        let bus = d.add_net("bus");
        d.add_device(Box::new(TriStateBuffer::new("T1", input, en, bus, 0.0)));

        let in_drv = d.add_external_driver(input);
        let en_drv = d.add_external_driver(en);
        d.initialize();

        d.schedule(0.0, in_drv, input, Logic::High);
        d.schedule(0.0, en_drv, en, Logic::High);
        d.settle(0.0);
        assert_eq!(d.state(bus), Logic::High);

        d.schedule(1e-9, en_drv, en, Logic::Low);
        d.settle(1e-9);
        assert_eq!(d.state(bus), Logic::HighZ);
    }
}
