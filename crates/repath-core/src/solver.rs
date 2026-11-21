//! Newton-Raphson, the DC operating point, and the mixed-signal transient loop.
//!
//! # Convergence
//!
//! A nonlinear circuit is solved by repeatedly linearizing it and solving the
//! linear system, until the answer stops moving. That works most of the time. The
//! rest of the time it does not, and a simulator is judged almost entirely on
//! what it does then. Three fallbacks run in order, cheapest first:
//!
//! 1. **Plain Newton** from the last known solution.
//! 2. **gmin stepping** — a large conductance is added from every node to ground,
//!    making the circuit trivially solvable, then walked down decade by decade
//!    with each solution seeding the next.
//! 3. **Source stepping** — every independent source is scaled to zero (where the
//!    answer is all zeros) and ramped back up to full value.
//! 4. **Damped Newton** — plain Newton again, with every step shortened so that no
//!    node moves more than half a volt at a time. For the circuit whose Newton
//!    steps are right about the direction and hopelessly wrong about the
//!    distance: an op-amp follower whose input stage is flat out, which leaps
//!    from one rail to the other and back forever when it is let jump.
//!
//! # Timestep control
//!
//! The transient loop never steps over a discontinuity. Before each step it takes
//! the minimum of: the local truncation error budget, the shortest feature of any
//! source waveform, the next waveform corner, the next digital change that reaches
//! an analog node, and the end of any digital-to-analog ramp in flight.
//!
//! Digital events that stay digital are not on that list. The event queue is run
//! ahead of the analog side, up to the end of the step it is about to take, and
//! only a change on a net that a bridge drives into the analog circuit cuts the
//! step short. A counter ticking away at tens of kilohertz behind a one-hertz
//! LED costs the analog solver nothing per tick — which is the difference
//! between a simulation that keeps up with the clock on the wall and one that
//! does not.
//!
//! A digital device that measures a voltage — a microcontroller's converter —
//! says ahead of time when it will sample, and the digital side is not run
//! past that instant until the analog side has solved a timepoint on it and
//! handed the device the node voltages there. The instant is a step limit
//! rather than a corner: nothing changes there, it only has to be solved.
//!
//! And a bridged net switching faster than the step ceiling can show — more
//! edges in one ceiling's worth of time than a screen has pixels for — is not
//! resolved edge by edge either. Its bridge is held at the net's time average
//! over each step, which is what the eye sees of an LED on a kilohertz net and
//! what the scope would draw of it at that timebase. Only where the net's
//! analog side is read back into the digital one is every edge still solved:
//! an oscillator built round an RC does not get to be averaged into silence.

use crate::bridge::LogicFamily;
use crate::circuit::Circuit;
use crate::complex::ComplexSystem;
use crate::digital::{DriverId, Halt, Logic, NetId, Transition};
use crate::element::{AcCtx, AcceptCtx, Element, Integration, Mode, StampCtx, node_index};
use crate::elements::{Failure, VoltageSource};
use crate::linalg::{LinearSystem, SolveError, coupled_entries};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SolverConfig {
    /// Relative tolerance on every unknown.
    pub reltol: f64,
    /// Absolute tolerance for branch currents.
    pub abstol: f64,
    /// Absolute tolerance for node voltages.
    pub vntol: f64,
    /// Conductance added from every node to ground.
    pub gmin: f64,
    /// Newton iteration limit for the operating point.
    pub dc_max_iterations: usize,
    /// Newton iteration limit for a transient timepoint.
    pub transient_max_iterations: usize,
    /// Decades of gmin stepping to try before giving up on it.
    pub gmin_decades: usize,
    /// Steps used to ramp sources from zero to full value.
    pub source_steps: usize,
}

impl Default for SolverConfig {
    fn default() -> Self {
        Self {
            reltol: 1e-3,
            abstol: 1e-12,
            vntol: 1e-6,
            gmin: 1e-12,
            dc_max_iterations: 200,
            transient_max_iterations: 50,
            gmin_decades: 10,
            source_steps: 10,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransientConfig {
    /// Simulated end time in seconds.
    pub stop: f64,
    /// Largest step the loop may take, regardless of what the error estimate says.
    /// Mostly a display concern: it sets the resolution of a flat trace.
    pub max_step: f64,
    /// First step attempted after the operating point.
    pub initial_step: f64,
    /// Skip the operating point and start from initial conditions instead.
    pub use_initial_conditions: bool,
    /// Safety valve so a pathological circuit cannot spin forever.
    pub max_steps: usize,
}

impl TransientConfig {
    pub fn new(stop: f64) -> Self {
        let stop = stop.max(1e-12);
        Self {
            stop,
            max_step: stop / 200.0,
            initial_step: stop / 1000.0,
            use_initial_conditions: false,
            max_steps: 500_000,
        }
    }
}

/// Where in the circuit a failed solve went wrong: the nodes and the elements
/// to look at, most to blame first.
///
/// Worked out only once a solve has failed for good, never on the way: the
/// retries a run makes along the way — a rejected step, a fallback to gmin
/// stepping — fail all the time, and none of them should pay for an
/// explanation nobody reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Culprits {
    /// Node names as the circuit knows them: `a`, not `v(a)`. Never ground.
    pub nodes: Vec<String>,
    /// Element names.
    pub elements: Vec<String>,
}

impl Culprits {
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty() && self.elements.is_empty()
    }
}

/// `" (V1 and V2, at node a)"`, or nothing when there is nobody to name.
impl std::fmt::Display for Culprits {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        fn list(items: &[String]) -> String {
            match items {
                [] => String::new(),
                [one] => one.clone(),
                [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
            }
        }
        let nodes = match self.nodes.len() {
            0 => String::new(),
            1 => format!("node {}", self.nodes[0]),
            _ => format!("nodes {}", list(&self.nodes)),
        };
        match (self.elements.is_empty(), nodes.is_empty()) {
            (true, true) => Ok(()),
            (false, true) => write!(f, " ({})", list(&self.elements)),
            (true, false) => write!(f, " (at {nodes})"),
            (false, false) => write!(f, " ({}, at {nodes})", list(&self.elements)),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SimError {
    /// The matrix has no unique solution — usually a floating section of circuit
    /// or a loop of ideal voltage sources. `culprits` holds the unknowns no
    /// equation pins down, and what they belong to.
    Singular { unknown: String, culprits: Culprits },
    /// Newton ran out of iterations, and every fallback also failed.
    /// `culprits` holds the nodes still moving on the last iteration and the
    /// nonlinear devices on them.
    NoConvergence { time: f64, iterations: usize, culprits: Culprits },
    /// The step had to shrink below anything meaningful to make progress.
    /// `culprits` is what the last attempt at the step failed on.
    TimestepTooSmall { time: f64, step: f64, culprits: Culprits },
    /// The run hit `max_steps`.
    StepLimit { time: f64 },
    /// Nothing to solve.
    Empty,
    /// The solve produced infinities or not-a-number, and every retry did too.
    /// `culprits` holds the nodes that ran off to infinity.
    NonFinite { time: f64, culprits: Culprits },
    /// A loop of logic was still changing at one instant after every delta
    /// cycle it was allowed: zero-delay gates chasing each other.
    DigitalLoop { time: f64, nets: Vec<String> },
    /// More unknowns than the dense solver can hold.
    TooLarge { unknowns: usize, limit: usize },
    /// The analysis was asked for something that cannot be done.
    Invalid { reason: String },
    /// A single run recorded more than it is allowed to keep in memory.
    TooMuchData { time: f64 },
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SimError::Singular { unknown, culprits } => write!(
                f,
                "circuit matrix is singular near {unknown}{culprits}; check for a floating node or a loop of voltage sources"
            ),
            SimError::NoConvergence { time, iterations, culprits } => write!(
                f,
                "failed to converge at t = {time:.6e} s after {iterations} iterations{culprits}"
            ),
            SimError::TimestepTooSmall { time, step, culprits } => {
                write!(f, "timestep collapsed to {step:.3e} s at t = {time:.6e} s{culprits}")
            }
            SimError::StepLimit { time } => {
                write!(f, "hit the step limit at t = {time:.6e} s")
            }
            SimError::Empty => write!(f, "the circuit has nothing to solve"),
            SimError::NonFinite { time, culprits } => write!(
                f,
                "the solution became infinite at t = {time:.6e} s{culprits}; check for a part value of zero or one far out of range"
            ),
            SimError::DigitalLoop { time, nets } => write!(
                f,
                "a loop of logic never settles at t = {time:.6e} s (nets {}); a gate in it needs a delay",
                nets.join(", ")
            ),
            SimError::TooLarge { unknowns, limit } => write!(
                f,
                "the circuit has {unknowns} unknowns and the solver holds at most {limit}"
            ),
            SimError::Invalid { reason } => write!(f, "{reason}"),
            SimError::TooMuchData { time } => write!(
                f,
                "the run was stopped at t = {time:.6e} s because it had recorded more than can be kept in memory; shorten it or widen the step"
            ),
        }
    }
}

impl std::error::Error for SimError {}

impl SimError {
    /// Where in the circuit it went wrong, for the errors that can say.
    pub fn culprits(&self) -> Option<&Culprits> {
        match self {
            SimError::Singular { culprits, .. }
            | SimError::NoConvergence { culprits, .. }
            | SimError::TimestepTooSmall { culprits, .. }
            | SimError::NonFinite { culprits, .. } => Some(culprits),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    pub accepted_steps: usize,
    pub rejected_steps: usize,
    pub newton_iterations: usize,
    /// Events applied by the digital domain.
    pub digital_events: usize,
}

impl Stats {
    /// The work done so far, in analog steps.
    ///
    /// A digital event is a few hundred nanoseconds of bookkeeping; an analog
    /// step is a Newton solve. Counting them as one unit each would have a
    /// frame's budget spent by a fast clock before the analog side had moved,
    /// and not counting the events at all would have a frame with a hundred
    /// thousand of them take as long as it liked.
    pub fn work(&self) -> f64 {
        self.accepted_steps as f64 + self.digital_events as f64 / EVENTS_PER_STEP
    }
}

/// How many digital events cost about as much as one analog step. Measured on
/// a sixteen-stage ripple counter driving LEDs, in the browser: a step of that
/// circuit is about sixteen microseconds, an event about ninety nanoseconds.
const EVENTS_PER_STEP: f64 = 128.0;

/// A bridged net is too fast to resolve once [`UNRESOLVED_RUN`] edges in a row
/// have come closer together than this fraction of the step ceiling, and slow
/// enough to resolve again once one gap is wider than [`RESOLVED_SPACING`] of
/// it.
///
/// The ceiling is the resolution of the trace — a two-hundredth of the screen
/// — so edges an eighth of it apart are sixteen hundred to a screen, past
/// anything a pixel can show. The run of edges asked for before averaging
/// begins is so that a burst does not qualify: a ripple counter starting up
/// toggles every stage within a few gate delays, once. And the gap between
/// the two thresholds is hysteresis, so a net near the line does not change
/// its treatment on every edge.
const UNRESOLVED_SPACING: f64 = 1.0 / 8.0;
const UNRESOLVED_RUN: u32 = 4;
const RESOLVED_SPACING: f64 = 1.0 / 4.0;

/// How a digital-to-analog bridge is being driven.
///
/// Two clocks run here. The digital domain is ahead of the analog solver, so
/// whether a change is to be resolved is decided when the change is absorbed,
/// from the spacing of the edges around it; but the bridge is driven in analog
/// time, and takes each change — and the treatment that came with it — only
/// when the solver reaches it. Deciding and acting at the same moment put a
/// bridge on hold at a level the net had not reached yet.
#[derive(Debug, Clone)]
struct Pacing {
    /// Whether this bridge may be averaged at all: not if anything downstream
    /// of its node is read back by an analog-to-digital bridge. `None` until
    /// the first transient step has been solved and the coupling is known.
    averageable: Option<bool>,
    /// Whether the changes arriving from the digital side are, at present, too
    /// close together to resolve.
    fast: bool,
    /// When the net last changed, in digital time.
    last_change: f64,
    /// How many edges in a row have come too close to resolve.
    fast_run: u32,
    /// The net's level at the last accepted timepoint.
    level: Logic,
    /// Whether the bridge is being held at an average as of the last accepted
    /// timepoint — the treatment of the last change the solver reached.
    averaging: bool,
    /// Changes past the last accepted timepoint, oldest first.
    ahead: Vec<Change>,
}

/// What a run keeps about the digital side between steps: how each net's
/// trace is being recorded, and how each bridge is being driven.
#[derive(Debug, Clone, Default)]
struct Ledger {
    /// Level last written into each net's trace.
    last: Vec<Logic>,
    /// One per digital net.
    tracing: Vec<Tracing>,
    /// One per digital-to-analog bridge, in the circuit's order.
    ///
    /// The digital domain is allowed to run ahead of the analog solver, so a
    /// change it reports can be later than the last accepted timepoint — most
    /// often when the step meant to land on it was refused and retried shorter.
    /// A change to be resolved is a breakpoint until the solver gets there,
    /// and the bridge is told only then: a ramp that began before a timepoint
    /// already accepted would be a change to a solve that is finished.
    pacing: Vec<Pacing>,
    /// The digital log, taken a step at a time; kept so it is not reallocated.
    changes: Vec<Transition>,
}

/// How a net's trace is being recorded: edge by edge, or as a burst.
#[derive(Debug, Clone, Default)]
struct Tracing {
    /// When the net last changed.
    last_change: f64,
    /// How many edges in a row have come too close to resolve.
    fast_run: u32,
    /// The burst being folded into, if the net is in one.
    burst: Option<Burst>,
}

/// A change on a bridged net, with what the bridge is to do about it.
#[derive(Debug, Clone, Copy)]
struct Change {
    time: f64,
    state: Logic,
    /// Solve a timepoint on it and ramp; or fold it into an average.
    resolve: bool,
}

/// A span of a net's trace that was switching too fast to record edge by edge.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Burst {
    /// The first edge folded in.
    pub from: f64,
    /// The last edge folded in.
    pub to: f64,
    /// Edges folded in, both directions.
    pub edges: usize,
    /// Seconds spent high between `from` and `to`.
    pub high: f64,
}

/// Result of a transient run.
#[derive(Debug, Clone, Default)]
pub struct TransientResult {
    /// Label of each unknown, in matrix order.
    pub unknown_names: Vec<String>,
    /// How many of the leading unknowns are node voltages.
    pub node_count: usize,
    pub time: Vec<f64>,
    /// One full solution vector per recorded timepoint.
    pub solution: Vec<Vec<f64>>,
    /// Instance names, matching the inner index of `currents`.
    pub element_names: Vec<String>,
    /// Current through every element, per recorded timepoint.
    pub currents: Vec<Vec<f64>>,
    pub net_names: Vec<String>,
    /// Per net, the instants at which it changed value — except inside a burst.
    pub digital: Vec<Vec<(f64, Logic)>>,
    /// Per net, the spans in which it was switching too fast for the trace.
    ///
    /// A net toggling at a megahertz behind a step ceiling of milliseconds
    /// would put thousands of edges into every pixel of a lane, and cost more
    /// to carry to the screen than to simulate. Past a run of edges closer
    /// together than the ceiling resolves, the trace stops recording them one
    /// by one and keeps the span instead: where it began, where it ended, how
    /// many edges, how long high. Enough to draw the lane as busy and to read
    /// a frequency and a duty off it, which is all a screen could show anyway.
    /// The level the net is at when a burst ends is recorded as a transition
    /// at that instant, so the lane after it is right.
    pub bursts: Vec<Vec<Burst>>,
    /// Parts destroyed during the run, soonest first.
    ///
    /// A failure is not an error: the run carries on with the part open, which is
    /// what the circuit actually does. This is here so the caller can say which
    /// part went and when, rather than leaving someone to work out why the
    /// waveforms change shape partway through.
    pub failures: Vec<Failure>,
    pub stats: Stats,
}

impl TransientResult {
    /// Extract one unknown as a waveform.
    pub fn signal(&self, index: usize) -> Vec<f64> {
        self.solution.iter().map(|row| row.get(index).copied().unwrap_or(0.0)).collect()
    }

    /// One element's current across the whole run.
    pub fn current_signal(&self, index: usize) -> Vec<f64> {
        self.currents.iter().map(|row| row.get(index).copied().unwrap_or(0.0)).collect()
    }

    /// Position of an element by instance name, e.g. `"R1"`.
    pub fn element_index(&self, name: &str) -> Option<usize> {
        self.element_names.iter().position(|n| n == name)
    }

    /// Look up an unknown by its label, e.g. `"v(out)"`.
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.unknown_names.iter().position(|n| n == name)
    }

    pub fn len(&self) -> usize {
        self.time.len()
    }

    pub fn is_empty(&self) -> bool {
        self.time.is_empty()
    }

    /// Take on a later piece of the same run.
    ///
    /// Names are kept from whichever side has them: a chunk from
    /// [`Simulator::advance_transient`] carries none, since they were settled
    /// when the run began.
    pub fn append(&mut self, mut other: TransientResult) {
        if self.unknown_names.is_empty() {
            self.unknown_names = std::mem::take(&mut other.unknown_names);
            self.node_count = other.node_count;
        }
        if self.element_names.is_empty() {
            self.element_names = std::mem::take(&mut other.element_names);
        }
        if self.net_names.is_empty() {
            self.net_names = std::mem::take(&mut other.net_names);
        }
        self.time.append(&mut other.time);
        self.solution.append(&mut other.solution);
        self.currents.append(&mut other.currents);
        if self.digital.len() < other.digital.len() {
            self.digital.resize(other.digital.len(), Vec::new());
        }
        for (net, events) in other.digital.iter_mut().enumerate() {
            self.digital[net].append(events);
        }
        if self.bursts.len() < other.bursts.len() {
            self.bursts.resize(other.bursts.len(), Vec::new());
        }
        for (net, spans) in other.bursts.iter_mut().enumerate() {
            self.bursts[net].append(spans);
        }
        self.failures.append(&mut other.failures);
        self.stats = other.stats;
    }
}

/// A transient run that has started and can be carried further.
///
/// Everything the loop would otherwise keep on its stack. Handing it back to
/// [`Simulator::advance_transient`] picks the run up exactly where it stopped —
/// the circuit itself holds the rest of the state, so anything changed on it in
/// between is simply what the circuit is from that instant on.
#[derive(Debug, Clone)]
pub struct Running {
    cfg: TransientConfig,
    /// Simulated time reached so far.
    t: f64,
    dt: f64,
    euler_steps: usize,
    min_step: f64,
    stats: Stats,
    /// What the run keeps about the digital side between steps.
    ledger: Ledger,
    /// How many destroyed parts the caller has already been told about.
    reported_failures: usize,
    /// Most steps one call to [`Simulator::advance_transient`] may take before
    /// handing back what it has, short of `until`.
    budget: usize,
    /// Backward Euler steps each element still owes, one count per element, on
    /// top of the `euler_steps` the whole circuit owes.
    damp: Vec<usize>,
    /// Of those, the ones owed to a value changed under the element, which are
    /// sized by backward Euler's own error rather than the trapezoidal rule's.
    retuned: Vec<usize>,
    /// Which parts of the circuit a corner in another part can reach.
    coupling: Coupling,
}

/// Which unknowns can affect which, and what each element and bridge touches:
/// enough to tell, of a corner somewhere, which elements it reaches.
///
/// Read off the small-signal stamp at the operating point, one element at a
/// time, as a pattern. Two unknowns are coupled through a chain of entries,
/// except through a node an ideal source holds against ground: the supply rail
/// is common to everything and carries no signal from one part to another.
#[derive(Debug, Clone, Default)]
struct Coupling {
    /// A label per unknown, the same for any two coupled.
    label: Vec<usize>,
    /// Whether each unknown is a node held by an ideal source.
    held: Vec<bool>,
    /// For each held node, the labels of what it is stamped against.
    beside: Vec<Vec<usize>>,
    /// The unknowns each element touches.
    elements: Vec<Vec<usize>>,
    /// The unknowns each bridge into the analog side touches.
    dacs: Vec<Vec<usize>>,
}

/// Where a corner came from.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Origin {
    Element(usize),
    Dac(usize),
}

/// A corner at the newest accepted timepoint: what it reaches takes its next
/// steps damped, and forgets the error history from before it.
fn corner_at_latest(circuit: &mut Circuit, run: &mut Running, origins: &[Origin]) {
    let mut reached = vec![0; run.damp.len()];
    run.coupling.damp(origins, CORNER_DAMPING, &mut reached);
    for ((element, owed), now) in
        circuit.elements_mut().iter_mut().zip(run.damp.iter_mut()).zip(reached)
    {
        if now > 0 {
            element.corner();
            *owed = (*owed).max(now);
        }
    }
}

/// The nodes an ideal voltage source holds against ground.
fn rails(circuit: &Circuit) -> Vec<usize> {
    circuit
        .elements()
        .iter()
        .filter_map(|e| e.as_any().downcast_ref::<VoltageSource>())
        .filter_map(|v| match (node_index(v.p), node_index(v.m)) {
            (Some(p), None) => Some(p),
            (None, Some(m)) => Some(m),
            _ => None,
        })
        .collect()
}

impl Coupling {
    fn learn(circuit: &Circuit, gmin: f64) -> Self {
        let n = circuit.unknown_count();
        let ctx = AcCtx { omega: 1.0, gmin };
        let mut pattern = ComplexSystem::pattern(n);
        let mut entries = Vec::new();
        let mut read = |stamp: &dyn Fn(&mut ComplexSystem)| {
            pattern.clear();
            stamp(&mut pattern);
            let recorded = pattern.recorded().expect("a pattern records");
            entries.extend_from_slice(&recorded.entries);
            recorded.touched()
        };
        let elements: Vec<Vec<usize>> =
            circuit.elements().iter().map(|e| read(&|sys| e.ac_stamp(sys, &ctx))).collect();
        let dacs: Vec<Vec<usize>> =
            circuit.dacs().iter().map(|d| read(&|sys| d.ac_stamp(sys, &ctx))).collect();
        let rails = rails(circuit);
        let label = coupled_entries(n, &rails, &entries);
        let mut held = vec![false; n];
        for &r in &rails {
            held[r] = true;
        }
        let mut beside = vec![Vec::new(); n];
        for &(r, c) in &entries {
            for (a, b) in [(r, c), (c, r)] {
                if held[a] && !held[b] && !beside[a].contains(&label[b]) {
                    beside[a].push(label[b]);
                }
            }
        }
        Self { label, held, beside, elements, dacs }
    }

    fn footprint(&self, origin: Origin) -> &[usize] {
        match origin {
            Origin::Element(e) => self.elements.get(e).map_or(&[], |v| v.as_slice()),
            Origin::Dac(d) => self.dacs.get(d).map_or(&[], |v| v.as_slice()),
        }
    }

    /// Owe `steps` damped steps on every element a corner at `origins` reaches:
    /// whatever shares an unknown with it, and whatever is coupled to that.
    ///
    /// An origin with nothing in its footprint cannot say what it reaches, and
    /// neither can an element with nothing in its own, so either one damps
    /// conservatively: the first everything, the second at every corner.
    fn damp(&self, origins: &[Origin], steps: usize, damp: &mut [usize]) {
        if origins.is_empty() {
            return;
        }
        let mut origin: Vec<usize> = Vec::new();
        for &o in origins {
            let print = self.footprint(o);
            if print.is_empty() {
                for d in damp.iter_mut() {
                    *d = (*d).max(steps);
                }
                return;
            }
            origin.extend_from_slice(print);
        }
        let mut labels: Vec<usize> = Vec::new();
        for &u in &origin {
            if self.held.get(u).copied().unwrap_or(false) {
                labels.extend_from_slice(&self.beside[u]);
            } else if let Some(&l) = self.label.get(u) {
                labels.push(l);
            }
        }
        for (e, print) in self.elements.iter().enumerate() {
            let reached = print.is_empty()
                || print.iter().any(|&u| {
                    origin.contains(&u)
                        || (!self.held.get(u).copied().unwrap_or(false)
                            && self.label.get(u).is_some_and(|l| labels.contains(l)))
                });
            if reached && let Some(d) = damp.get_mut(e) {
                *d = (*d).max(steps);
            }
        }
    }
}

impl Running {
    /// How far the run has got, in seconds.
    pub fn time(&self) -> f64 {
        self.t
    }

    /// Cap the work of each call to [`Simulator::advance_transient`].
    ///
    /// A live run is advanced a frame at a time, and a frame that asks for more
    /// than the engine can solve in its share of the wall clock stalls the whole
    /// page — a clock turned up to a hundred megahertz went from smooth to
    /// several seconds a frame, with nothing in between. Past the budget the call
    /// returns with the run short of `until`, and the caller sees how far it got
    /// from [`Running::time`]: the sweep slows down instead of the screen.
    ///
    /// Distinct from `max_steps`, which is the safety valve for a run that will
    /// never finish and is an error when it trips; this is ordinary pacing.
    pub fn set_budget(&mut self, steps: usize) {
        self.budget = steps.max(1);
    }

    /// Change the step ceiling from here on.
    ///
    /// The ceiling is what sets the resolution of a flat trace, and it was
    /// fixed when the run began from the width of the screen. Zooming the
    /// screen in while the run is going would otherwise show a handful of
    /// samples stretched across it; with this the run tightens up from the
    /// moment of the zoom, and everything already solved stays as it was.
    pub fn set_max_step(&mut self, step: f64) {
        if step.is_finite() && step > 0.0 {
            self.cfg.max_step = step.max(self.min_step);
        }
    }

    pub fn stats(&self) -> &Stats {
        &self.stats
    }
}

/// A single DC operating point.
#[derive(Debug, Clone, Default)]
pub struct OperatingPoint {
    pub unknown_names: Vec<String>,
    pub node_count: usize,
    pub solution: Vec<f64>,
    pub iterations: usize,
}

/// A logarithmic frequency sweep.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AcConfig {
    pub start_hz: f64,
    pub stop_hz: f64,
    /// Frequencies per decade. Ten is enough for a smooth Bode plot.
    pub points_per_decade: usize,
}

impl AcConfig {
    pub fn new(start_hz: f64, stop_hz: f64) -> Self {
        // Anything not a number is kept as it came, for `validate` to refuse:
        // `max` would quietly turn a NaN into the floor.
        let floor = |hz: f64| if hz.is_finite() { hz.max(1e-9) } else { hz };
        Self { start_hz: floor(start_hz), stop_hz: floor(stop_hz), points_per_decade: 20 }
    }

    /// Whether the sweep can be done: finite, positive ends, and no more
    /// than [`MAX_AC_POINTS`] frequencies.
    ///
    /// An infinite stop frequency was an infinite number of decades, turned
    /// into a vector of `usize::MAX` points, and the allocation aborted the
    /// engine rather than failing.
    pub fn validate(&self) -> Result<(), SimError> {
        for (what, hz) in [("start", self.start_hz), ("stop", self.stop_hz)] {
            if !(hz.is_finite() && hz > 0.0) {
                return Err(SimError::Invalid {
                    reason: format!(
                        "the sweep's {what} frequency must be a positive number, not {hz}"
                    ),
                });
            }
        }
        if self.points_per_decade == 0 {
            return Err(SimError::Invalid {
                reason: "a sweep needs at least one point per decade".to_string(),
            });
        }
        let count = self.point_count();
        if count > MAX_AC_POINTS {
            return Err(SimError::Invalid {
                reason: format!(
                    "that sweep is {count} frequencies; the most one sweep solves is {MAX_AC_POINTS}"
                ),
            });
        }
        Ok(())
    }

    fn decades(&self) -> f64 {
        let (lo, hi) = (self.start_hz.min(self.stop_hz), self.start_hz.max(self.stop_hz));
        (hi / lo).log10()
    }

    /// How many frequencies the sweep solves, saturating rather than wrapping.
    fn point_count(&self) -> usize {
        let decades = self.decades();
        if decades.is_nan() || decades <= 0.0 {
            return 1;
        }
        let steps = (decades * self.points_per_decade as f64).round();
        // `as` saturates, and infinity comes out as `usize::MAX`.
        (steps.max(1.0) as usize).saturating_add(1)
    }

    /// The frequencies this configuration sweeps, logarithmically spaced.
    ///
    /// Never more than [`MAX_AC_POINTS`], whatever was asked: a configuration
    /// that would be more is refused by [`Self::validate`], and this does not
    /// allocate for it in the meantime.
    pub fn frequencies(&self) -> Vec<f64> {
        let lo = self.start_hz.min(self.stop_hz);
        let decades = self.decades();
        // One frequency asked for is one frequency swept. Rounding a span of
        // nothing up to a single step handed back the same point twice, and a
        // plot then drew a segment between a point and itself.
        if !decades.is_finite() || decades <= 0.0 {
            return vec![lo];
        }
        let steps = (self.point_count() - 1).min(MAX_AC_POINTS - 1);
        (0..=steps).map(|k| lo * 10f64.powf(decades * k as f64 / steps as f64)).collect()
    }
}

/// Result of an AC sweep. Columnar: one array per unknown, indexed by frequency,
/// because a Bode plot asks for one signal across the sweep, never for every
/// signal at one frequency.
#[derive(Debug, Clone, Default)]
pub struct AcResult {
    pub frequencies: Vec<f64>,
    pub unknown_names: Vec<String>,
    pub node_count: usize,
    /// Magnitude, linear — the caller decides whether to show decibels.
    pub magnitude: Vec<Vec<f64>>,
    /// Phase in degrees, unwrapped so a plot does not jump by 360.
    pub phase: Vec<Vec<f64>>,
}

impl AcResult {
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.unknown_names.iter().position(|n| n == name)
    }

    pub fn is_empty(&self) -> bool {
        self.frequencies.is_empty()
    }
}

/// Holds the scratch buffers so repeated runs do not reallocate.
#[derive(Debug)]
pub struct Simulator {
    pub config: SolverConfig,
    sys: LinearSystem,
    x: Vec<f64>,
    x_next: Vec<f64>,
    x_accepted: Vec<f64>,
    /// Longest step, in volts on any node, that Newton may take. Only the last
    /// operating-point fallback sets it.
    damping: Option<f64>,
    /// The step Newton took last, while damping, to tell a step that doubles
    /// back on it.
    last_step: Vec<f64>,
    /// What the last Newton solve was asked to solve, so a failure can be
    /// stamped again element by element to find who was involved.
    attempt: Attempt,
    /// Which elements the step being solved takes with backward Euler whatever
    /// the rule for the rest, one flag per element. Empty outside a transient.
    damped: Vec<bool>,
    /// Which elements have that step sized by backward Euler's own error.
    sized: Vec<bool>,
}

/// The arguments of one Newton solve, kept for explaining its failure.
#[derive(Debug, Clone, Copy)]
struct Attempt {
    mode: Mode,
    integration: Integration,
    time: f64,
    dt: f64,
    gmin: f64,
}

/// Most nodes, and most elements, a diagnosis names. Past a handful the list
/// stops pointing at anything.
const MOST_BLAMED: usize = 4;

/// Longest move, in volts on any node, a damped Newton step may make.
const DAMPED_STEP: f64 = 0.5;

/// Smallest step the transient loop will attempt, relative to the run length.
const MIN_STEP_FRACTION: f64 = 1e-11;

/// Most unknowns the dense solver takes on.
///
/// The matrix is `n²` doubles, factored in place: four thousand unknowns is
/// 128 MB and a solve of about twenty billion operations, which is already far
/// past interactive. Past this a circuit is refused with a reason, rather than
/// asking a 32-bit address space for gigabytes and having the tab die.
pub const MAX_UNKNOWNS: usize = 4096;

/// Most values one call to [`Simulator::advance_transient`] records, across
/// solutions and element currents together: 160 MB of doubles. A live run
/// hands back a frame at a time and never comes near it; a batch run that
/// would, was going to exhaust memory before it finished anyway.
pub const MAX_RECORDED_VALUES: usize = 20_000_000;

/// Most frequencies an AC sweep solves. Ten thousand is five hundred per
/// decade over twenty decades, far past anything a plot can show.
pub const MAX_AC_POINTS: usize = 10_000;

/// A floor under the step at time `t`: a step shorter than a few units in the
/// last place of `t` does not move the clock, and would be accepted as a step
/// of nothing — forever, since nothing then changes.
fn step_floor(min_step: f64, t: f64) -> f64 {
    min_step.max(4.0 * f64::EPSILON * t.abs())
}

/// A solved step is thrown away when its own error estimate asks for less than
/// this share of it. SPICE's figure: a step is not rejected for being a hair
/// long, which the next one, sized from the new history, makes good on anyway.
const STEP_REJECTION: f64 = 0.9;

/// Damped steps taken after landing on a corner.
///
/// Two is enough to stop the step itself from ringing, and not enough to cover
/// the tail: the response decays over the following few steps while the step
/// size doubles each time, and the trapezoidal rule starts alternating again the
/// moment it is handed back a step much longer than what is decaying. Eight
/// covers the tail of an ordinary edge. It costs first-order accuracy on the
/// part of a transient where the answer is already tiny.
const CORNER_DAMPING: usize = 8;

/// The loop of logic that failed to settle, if one has, as the error it is.
fn unsettled(circuit: &mut Circuit) -> Result<(), SimError> {
    match circuit.digital.take_unsettled() {
        Some(loop_) => Err(SimError::DigitalLoop { time: loop_.time, nets: loop_.nets }),
        None => Ok(()),
    }
}

/// What one element was stamped against at the failed iterate, and whether it
/// was still limiting its own step there.
struct Footprint {
    touched: Vec<usize>,
    limited: bool,
}

/// Which element owns each unknown past the node voltages, in the order
/// [`Circuit::build`] hands them out.
fn branch_owners(circuit: &Circuit) -> Vec<usize> {
    let mut owners = Vec::new();
    for (index, element) in circuit.elements().iter().enumerate() {
        owners.extend(std::iter::repeat_n(index, element.extra_unknowns()));
    }
    owners
}

/// Name what a set of unknowns belongs to: the nodes among them, and the
/// elements whose branch currents they are.
///
/// With footprints to go on, either list left empty is filled from the other:
/// a node with nothing of its own to blame is blamed on what is attached to
/// it, and a branch current on the nodes its element sits between.
fn blame(circuit: &Circuit, unknowns: &[usize], prints: Option<&[Footprint]>) -> Culprits {
    let node_rows = circuit.node_count().saturating_sub(1);
    let owners = branch_owners(circuit);
    let node_name = |i: usize| circuit.node_name(i + 1).unwrap_or("?").to_string();
    let element_name = |e: usize| circuit.elements()[e].name().to_string();

    let mut nodes: Vec<usize> = Vec::new();
    let mut elements: Vec<usize> = Vec::new();
    for &u in unknowns {
        if u < node_rows {
            if !nodes.contains(&u) {
                nodes.push(u);
            }
        } else if let Some(&owner) = owners.get(u - node_rows)
            && !elements.contains(&owner)
        {
            elements.push(owner);
        }
    }
    if let Some(prints) = prints {
        if elements.is_empty() {
            elements = (0..prints.len())
                .filter(|&e| prints[e].touched.iter().any(|t| nodes.contains(t)))
                .collect();
        }
        if nodes.is_empty() {
            for &e in &elements {
                for &t in &prints[e].touched {
                    if t < node_rows && !nodes.contains(&t) {
                        nodes.push(t);
                    }
                }
            }
        }
    }
    nodes.truncate(MOST_BLAMED);
    elements.truncate(MOST_BLAMED);
    Culprits {
        nodes: nodes.into_iter().map(node_name).collect(),
        elements: elements.into_iter().map(element_name).collect(),
    }
}

impl Default for Simulator {
    fn default() -> Self {
        Self::new(SolverConfig::default())
    }
}

impl Simulator {
    pub fn new(config: SolverConfig) -> Self {
        Self {
            config,
            sys: LinearSystem::new(0),
            x: Vec::new(),
            x_next: Vec::new(),
            x_accepted: Vec::new(),
            damping: None,
            last_step: Vec::new(),
            attempt: Attempt {
                mode: Mode::OperatingPoint,
                integration: Integration::BackwardEuler,
                time: 0.0,
                dt: 0.0,
                gmin: 0.0,
            },
            damped: Vec::new(),
            sized: Vec::new(),
        }
    }

    fn prepare(&mut self, circuit: &mut Circuit) -> Result<usize, SimError> {
        if !circuit.is_built() {
            circuit.build();
        }
        let n = circuit.unknown_count();
        // A purely digital circuit has no analog unknowns at all, and that is a
        // legitimate thing to simulate.
        if n == 0 && circuit.digital.net_count() == 0 {
            return Err(SimError::Empty);
        }
        if n > MAX_UNKNOWNS {
            return Err(SimError::TooLarge { unknowns: n, limit: MAX_UNKNOWNS });
        }
        if self.sys.size() != n {
            self.sys = LinearSystem::new(n);
        }
        self.x.resize(n, 0.0);
        self.x_next.resize(n, 0.0);
        self.x_accepted.resize(n, 0.0);
        Ok(n)
    }

    /// One Newton solve at a single operating point or timepoint.
    ///
    /// `self.x` is both the starting guess and, on success, the answer.
    #[allow(clippy::too_many_arguments)]
    fn newton(
        &mut self,
        circuit: &mut Circuit,
        mode: Mode,
        integration: Integration,
        time: f64,
        dt: f64,
        gmin: f64,
        source_scale: f64,
        max_iterations: usize,
        stats: &mut Stats,
    ) -> Result<usize, SimError> {
        let node_rows = circuit.node_count().saturating_sub(1);
        let nonlinear = circuit.has_nonlinear();
        let max_iterations = if nonlinear { max_iterations } else { 1 };
        self.attempt = Attempt { mode, integration, time, dt, gmin };

        for iteration in 0..max_iterations {
            self.sys.clear();
            let limited = {
                let ctx = StampCtx {
                    mode,
                    integration,
                    time,
                    dt,
                    gmin,
                    source_scale,
                    x: &self.x,
                    iteration,
                };
                circuit.stamp_all(&mut self.sys, &ctx, &self.damped)
            };

            self.sys.solve_into(&mut self.x_next).map_err(|e| match e {
                SolveError::Singular { row } => SimError::Singular {
                    unknown: circuit
                        .unknown_names()
                        .get(row)
                        .cloned()
                        .unwrap_or_else(|| format!("unknown #{row}")),
                    culprits: Culprits::default(),
                },
                SolveError::NonFinite => {
                    SimError::NonFinite { time, culprits: Culprits::default() }
                }
            })?;
            stats.newton_iterations += 1;

            // Shorten the step along its own direction, so the answer walks there
            // rather than leaping past it.
            //
            // The allowance halves every time a step turns back on the one before,
            // and grows again while they agree: a fixed allowance walks up to the
            // answer and then steps back and forth across it for good, one
            // allowance either side.
            let mut damped = false;
            if let Some(longest) = self.damping {
                let step: Vec<f64> =
                    self.x.iter().zip(&self.x_next).map(|(old, new)| new - old).collect();
                let turned = self.last_step.len() == step.len()
                    && self.last_step.iter().zip(&step).map(|(a, b)| a * b).sum::<f64>() < 0.0;
                let longest = if turned {
                    (longest * 0.5).max(1e-9)
                } else {
                    (longest * 2.0).min(DAMPED_STEP)
                };
                self.damping = Some(longest);
                let reach = step[..node_rows].iter().map(|d| d.abs()).fold(0.0, f64::max);
                let alpha = if reach > longest { longest / reach } else { 1.0 };
                if alpha < 1.0 {
                    for (old, new) in self.x.iter().zip(self.x_next.iter_mut()) {
                        *new = old + alpha * (*new - old);
                    }
                    damped = true;
                }
                self.last_step = step.iter().map(|d| d * alpha).collect();
            }

            let settled = self.converged(node_rows) && !damped;
            std::mem::swap(&mut self.x, &mut self.x_next);

            if !nonlinear {
                return Ok(iteration + 1);
            }
            // The first iterate is a linearization around an arbitrary guess, so
            // it cannot be trusted even if it happens to look settled.
            if settled && !limited && iteration > 0 {
                return Ok(iteration + 1);
            }
        }

        Err(SimError::NoConvergence {
            time,
            iterations: max_iterations,
            culprits: Culprits::default(),
        })
    }

    /// Whether `x_next` is within tolerance of `x` on every unknown.
    fn converged(&self, node_rows: usize) -> bool {
        self.x.iter().zip(&self.x_next).enumerate().all(|(i, (old, new))| {
            let floor = if i < node_rows { self.config.vntol } else { self.config.abstol };
            let tol = self.config.reltol * old.abs().max(new.abs()) + floor;
            (new - old).abs() <= tol
        })
    }

    /// Stamp each element on its own at the last iterate, to see what it is
    /// attached to. Only ever run on a solve that has already failed for good:
    /// it costs an element's worth of matrix per element.
    fn footprints(&self, circuit: &mut Circuit) -> Vec<Footprint> {
        let n = circuit.unknown_count();
        if self.x.len() != n {
            return Vec::new();
        }
        let a = self.attempt;
        let ctx = StampCtx {
            mode: a.mode,
            integration: a.integration,
            time: a.time,
            dt: a.dt,
            gmin: a.gmin,
            // Sources at full value: one stepped down to nothing would stamp
            // nothing, and look attached to nothing.
            source_scale: 1.0,
            x: &self.x,
            // Past the first iteration, so a junction linearizes around the
            // iterate rather than around its own starting guess.
            iteration: 1,
        };
        // A pattern rather than a matrix: an n × n matrix per element was 128 MB
        // and n² of work each at the size limit, and froze the tab for tens of
        // seconds before a large circuit's failure could be reported.
        let mut scratch = LinearSystem::pattern(n);
        circuit
            .elements_mut()
            .iter_mut()
            .map(|element| {
                scratch.clear();
                let report = element.stamp(&mut scratch, &ctx);
                Footprint { touched: scratch.touched(), limited: report.limited }
            })
            .collect()
    }

    /// Fill in who is to blame on an error that has finished failing.
    ///
    /// Called where a failure leaves the engine, never inside the retries:
    /// the buffers still hold the last attempt, and it is read from them.
    fn explain(&mut self, circuit: &mut Circuit, err: SimError) -> SimError {
        match err {
            SimError::Singular { unknown, culprits } if culprits.is_empty() => {
                let free = self.sys.undetermined();
                let prints = self.footprints(circuit);
                SimError::Singular { unknown, culprits: blame(circuit, &free, Some(&prints)) }
            }
            SimError::NoConvergence { time, iterations, culprits } if culprits.is_empty() => {
                let culprits = self.unsettled_culprits(circuit);
                SimError::NoConvergence { time, iterations, culprits }
            }
            SimError::NonFinite { time, culprits } if culprits.is_empty() => {
                // The failed solve left its answer in `x_next`: whatever came
                // out infinite there is what ran away.
                let blown: Vec<usize> =
                    (0..self.x_next.len()).filter(|&i| !self.x_next[i].is_finite()).collect();
                let prints = self.footprints(circuit);
                SimError::NonFinite { time, culprits: blame(circuit, &blown, Some(&prints)) }
            }
            other => other,
        }
    }

    /// The nodes Newton was still moving when it ran out of iterations, and
    /// the nonlinear devices on them.
    ///
    /// The last two iterates are still in `x` and `x_next`. An unknown whose
    /// last step was outside tolerance is still moving; the ones moving most
    /// are named first. A damped Newton may have shrunk every step inside
    /// tolerance and still not be done, so where nothing is outside it the
    /// unknowns moving most of all are taken instead.
    fn unsettled_culprits(&self, circuit: &mut Circuit) -> Culprits {
        let node_rows = circuit.node_count().saturating_sub(1);
        let cfg = self.config;
        let ratio: Vec<f64> = self
            .x
            .iter()
            .zip(&self.x_next)
            .enumerate()
            .map(|(i, (new, old))| {
                let floor = if i < node_rows { cfg.vntol } else { cfg.abstol };
                let tol = cfg.reltol * old.abs().max(new.abs()) + floor;
                let r = (new - old).abs() / tol;
                if r.is_finite() { r } else { f64::MAX }
            })
            .collect();
        let most = ratio.iter().copied().fold(0.0, f64::max);
        let threshold = if most > 1.0 { 1.0 } else { most / 10.0 };
        let mut moving: Vec<usize> =
            (0..ratio.len()).filter(|&i| most > 0.0 && ratio[i] > threshold).collect();
        moving.sort_by(|&p, &q| ratio[q].total_cmp(&ratio[p]).then(p.cmp(&q)));

        let prints = self.footprints(circuit);
        // A device is to blame when it is nonlinear and sits on something still
        // moving, or when it is still limiting its own step: limiting alone
        // keeps Newton from calling anything converged.
        let mut suspects: Vec<(usize, bool, f64)> = prints
            .iter()
            .enumerate()
            .filter_map(|(e, print)| {
                let score = print
                    .touched
                    .iter()
                    .filter(|t| moving.contains(t))
                    .map(|&t| ratio[t])
                    .fold(0.0, f64::max);
                let nonlinear = circuit.elements()[e].is_nonlinear();
                (print.limited || (nonlinear && score > 0.0)).then_some((e, print.limited, score))
            })
            .collect();
        suspects.sort_by(|p, q| q.1.cmp(&p.1).then(q.2.total_cmp(&p.2)).then(p.0.cmp(&q.0)));

        suspects.truncate(MOST_BLAMED);
        // The nodes to name are the moving ones the suspects sit on: a linear
        // node still catching up with them is following, not failing.
        let on_suspect = |i: &usize| suspects.iter().any(|&(e, ..)| prints[e].touched.contains(i));
        let moving_nodes: Vec<usize> = moving
            .iter()
            .copied()
            .filter(|i| *i < node_rows && (suspects.is_empty() || on_suspect(i)))
            .collect();
        let mut culprits = blame(circuit, &moving_nodes, None);
        culprits.elements =
            suspects.iter().map(|&(e, ..)| circuit.elements()[e].name().to_string()).collect();
        if culprits.elements.is_empty() {
            // Nothing nonlinear on what is moving: blame whatever owns the
            // branch currents that are, or failing that what sits on the nodes.
            culprits.elements = blame(circuit, &moving, Some(&prints)).elements;
        }
        if culprits.nodes.is_empty() {
            let touched: Vec<usize> = suspects
                .iter()
                .flat_map(|&(e, ..)| prints[e].touched.iter().copied())
                .filter(|&t| t < node_rows)
                .collect();
            culprits.nodes = blame(circuit, &touched, None).nodes;
        }
        culprits
    }

    /// Solve the DC operating point, escalating through the convergence aids.
    pub fn operating_point(&mut self, circuit: &mut Circuit) -> Result<OperatingPoint, SimError> {
        self.prepare(circuit)?;
        circuit.reset();
        self.bring_up_digital(circuit)?;
        let mut stats = Stats::default();
        self.solve_operating_point(circuit, &mut stats).map_err(|e| self.explain(circuit, e))?;
        Ok(OperatingPoint {
            unknown_names: circuit.unknown_names(),
            node_count: circuit.node_count().saturating_sub(1),
            solution: self.x.clone(),
            iterations: stats.newton_iterations,
        })
    }

    fn solve_operating_point(
        &mut self,
        circuit: &mut Circuit,
        stats: &mut Stats,
    ) -> Result<(), SimError> {
        let cfg = self.config;
        self.x.fill(0.0);

        // 1. Straight Newton from zero.
        let direct = self.newton(
            circuit,
            Mode::OperatingPoint,
            Integration::BackwardEuler,
            0.0,
            0.0,
            cfg.gmin,
            1.0,
            cfg.dc_max_iterations,
            stats,
        );
        match direct {
            Ok(_) => return Ok(()),
            // A singular matrix will not be fixed by a better initial guess, but
            // gmin stepping adds real conductance, so it is still worth a try.
            Err(SimError::NoConvergence { .. })
            | Err(SimError::Singular { .. })
            | Err(SimError::NonFinite { .. }) => {}
            Err(other) => return Err(other),
        }

        // 2. gmin stepping.
        self.x.fill(0.0);
        let mut gmin_ok = true;
        for decade in (0..=cfg.gmin_decades).rev() {
            let gmin = cfg.gmin * 10f64.powi(decade as i32);
            if self
                .newton(
                    circuit,
                    Mode::OperatingPoint,
                    Integration::BackwardEuler,
                    0.0,
                    0.0,
                    gmin,
                    1.0,
                    cfg.dc_max_iterations,
                    stats,
                )
                .is_err()
            {
                gmin_ok = false;
                break;
            }
        }
        if gmin_ok {
            return Ok(());
        }

        // 3. Source stepping. Starting over means the analog elements only: the
        // logic was settled before any of this, and it is the logic the answer
        // has to be found around.
        self.x.fill(0.0);
        circuit.reset_elements();
        let mut stepped = Ok(0);
        // At least one step, or the first scale is 0/0.
        let steps = cfg.source_steps.max(1);
        for step in 0..=steps {
            let scale = step as f64 / steps as f64;
            stepped = self.newton(
                circuit,
                Mode::OperatingPoint,
                Integration::BackwardEuler,
                0.0,
                0.0,
                cfg.gmin,
                scale,
                cfg.dc_max_iterations,
                stats,
            );
            if stepped.is_err() {
                break;
            }
        }
        // Anything stage 1 would have tolerated, this tolerates too: damped
        // Newton is a different path to the answer, and an iterate that
        // overflowed partway up the ramp says nothing against it.
        match stepped {
            Ok(_) => return Ok(()),
            Err(SimError::NoConvergence { .. })
            | Err(SimError::Singular { .. })
            | Err(SimError::NonFinite { .. }) => {}
            Err(other) => return Err(other),
        }

        // 4. Damped Newton. Slow — a node that has ten volts to go takes twenty
        // iterations to get there — so it is last, and given the room for it.
        self.x.fill(0.0);
        circuit.reset_elements();
        self.damping = Some(DAMPED_STEP);
        self.last_step.clear();
        let damped = self.newton(
            circuit,
            Mode::OperatingPoint,
            Integration::BackwardEuler,
            0.0,
            0.0,
            cfg.gmin,
            1.0,
            cfg.dc_max_iterations * 10,
            stats,
        );
        self.damping = None;
        damped.map(|_| ())
    }

    /// Sweep a source and record the operating point at each value.
    ///
    /// `apply` receives the sweep value and should update the circuit — typically
    /// by writing a new [`crate::elements::Waveform::Dc`] into a source. Each
    /// point is seeded from the previous one, which is what makes an I-V curve
    /// converge where a cold start would not.
    pub fn dc_sweep<F>(
        &mut self,
        circuit: &mut Circuit,
        values: &[f64],
        mut apply: F,
    ) -> Result<Vec<Vec<f64>>, SimError>
    where
        F: FnMut(&mut Circuit, f64),
    {
        self.prepare(circuit)?;
        circuit.reset();
        self.bring_up_digital(circuit)?;
        let mut stats = Stats::default();
        let mut out = Vec::with_capacity(values.len());

        for (i, value) in values.iter().enumerate() {
            apply(circuit, *value);
            // Seeded from the previous point, which is what makes an I-V curve
            // solve where a cold start would not. When that is not enough the
            // convergence aids are still there: a sweep that walks into a region
            // the seed cannot reach used to abandon the whole curve at the first
            // point it could not manage, rather than starting that one over.
            let seeded = i > 0
                && self
                    .newton(
                        circuit,
                        Mode::OperatingPoint,
                        Integration::BackwardEuler,
                        0.0,
                        0.0,
                        self.config.gmin,
                        1.0,
                        self.config.dc_max_iterations,
                        &mut stats,
                    )
                    .is_ok();
            if !seeded {
                self.solve_operating_point(circuit, &mut stats)
                    .map_err(|e| self.explain(circuit, e))?;
            }
            out.push(self.x.clone());
        }
        Ok(out)
    }

    /// Sweep frequency and report how a small signal propagates.
    ///
    /// The operating point is solved first and every nonlinear device linearizes
    /// around it, which is what makes this a *small-signal* analysis: it says how
    /// a wiggle behaves, not what the circuit does when driven hard. An amplifier
    /// biased into cutoff will correctly report no gain.
    ///
    /// The drive comes from whichever sources were given an AC magnitude; with
    /// none, everything is zero and the answer is uninteresting rather than wrong.
    pub fn ac_sweep(&mut self, circuit: &mut Circuit, cfg: AcConfig) -> Result<AcResult, SimError> {
        cfg.validate()?;
        let n = self.prepare(circuit)?;
        circuit.reset();
        // The bias every device is linearised at depends on what the logic is
        // driving, exactly as it does for a transient run.
        self.bring_up_digital(circuit)?;

        let mut stats = Stats::default();
        self.solve_operating_point(circuit, &mut stats).map_err(|e| self.explain(circuit, e))?;

        let frequencies = cfg.frequencies();
        let unknown_names = circuit.unknown_names();
        let mut magnitude = vec![Vec::with_capacity(frequencies.len()); n];
        let mut phase = vec![Vec::with_capacity(frequencies.len()); n];

        let mut sys = ComplexSystem::new(n);
        let mut x = Vec::new();

        for &hz in &frequencies {
            sys.clear();
            let ctx = AcCtx { omega: std::f64::consts::TAU * hz, gmin: self.config.gmin };
            circuit.ac_stamp_all(&mut sys, &ctx);

            sys.solve_into(&mut x).map_err(|e| match e.row {
                // Not a node's fault: the numbers themselves overflowed.
                None => SimError::NonFinite { time: 0.0, culprits: Culprits::default() },
                // Only the row the complex solve stopped at is known here: blame
                // that unknown and whatever owns it.
                Some(row) => SimError::Singular {
                    unknown: unknown_names.get(row).cloned().unwrap_or_else(|| format!("#{row}")),
                    culprits: blame(circuit, &[row], None),
                },
            })?;

            for i in 0..n {
                magnitude[i].push(x[i].abs());
                phase[i].push(x[i].arg().to_degrees());
            }
        }

        for series in &mut phase {
            unwrap_phase(series);
        }

        Ok(AcResult {
            frequencies,
            unknown_names,
            node_count: circuit.node_count().saturating_sub(1),
            magnitude,
            phase,
        })
    }

    /// Run a mixed-signal transient analysis from zero to `cfg.stop`.
    ///
    /// A convenience over [`Self::begin_transient`] and [`Self::advance_transient`]
    /// for the case where the whole answer is wanted at once.
    pub fn transient(
        &mut self,
        circuit: &mut Circuit,
        cfg: TransientConfig,
    ) -> Result<TransientResult, SimError> {
        let (mut run, mut result) = self.begin_transient(circuit, cfg)?;
        let rest = self.advance_transient(circuit, &mut run, cfg.stop)?;
        result.append(rest);
        result.stats = run.stats.clone();
        Ok(result)
    }

    /// Start a transient run and solve its first instant.
    ///
    /// The returned [`Running`] holds everything the loop needs to be picked up
    /// again — where it got to, what step it was taking, how many Euler steps it
    /// still owes — so the caller can advance it a little at a time and watch it
    /// happen. That is the difference between a simulation and a recording of
    /// one: nothing here is ever recomputed, so anything done to the circuit
    /// partway through stays done.
    pub fn begin_transient(
        &mut self,
        circuit: &mut Circuit,
        cfg: TransientConfig,
    ) -> Result<(Running, TransientResult), SimError> {
        self.prepare(circuit)?;
        circuit.reset();

        let mut stats = Stats::default();
        let mut result = TransientResult {
            unknown_names: circuit.unknown_names(),
            node_count: circuit.node_count().saturating_sub(1),
            element_names: circuit.element_names(),
            net_names: (0..circuit.digital.net_count())
                .map(|n| circuit.digital.net_name(n).unwrap_or("").to_string())
                .collect(),
            digital: vec![Vec::new(); circuit.digital.net_count()],
            bursts: vec![Vec::new(); circuit.digital.net_count()],
            ..Default::default()
        };

        // Bring the digital side up first: the analog operating point depends on
        // what the digital outputs are driving.
        self.bring_up_digital(circuit)?;

        // Every net's starting value belongs in the trace. Without it a viewer
        // cannot tell what a signal was before its first transition.
        for (net, trace) in result.digital.iter_mut().enumerate() {
            trace.push((0.0, circuit.digital.state(net)));
        }

        let start_mode = if cfg.use_initial_conditions {
            // Pin every reactive element to its initial condition and solve for
            // the node voltages that implies, rather than assuming they are zero.
            self.x.fill(0.0);
            self.newton(
                circuit,
                Mode::InitialConditions,
                Integration::BackwardEuler,
                0.0,
                0.0,
                self.config.gmin,
                1.0,
                self.config.dc_max_iterations,
                &mut stats,
            )
            .map_err(|e| self.explain(circuit, e))?;
            Mode::InitialConditions
        } else {
            self.solve_operating_point(circuit, &mut stats)
                .map_err(|e| self.explain(circuit, e))?;
            Mode::OperatingPoint
        };

        self.accept_timepoint(circuit, start_mode, Integration::BackwardEuler, 0.0, 0.0);
        self.x_accepted.copy_from_slice(&self.x);
        self.record(&mut result, circuit, 0.0);

        let mut ledger = Ledger {
            last: (0..circuit.digital.net_count()).map(|n| circuit.digital.state(n)).collect(),
            tracing: vec![Tracing::default(); circuit.digital.net_count()],
            pacing: circuit
                .dacs()
                .iter()
                .map(|dac| Pacing {
                    averageable: None,
                    fast: false,
                    last_change: 0.0,
                    fast_run: 0,
                    level: circuit.digital.state(dac.net),
                    averaging: false,
                    ahead: Vec::new(),
                })
                .collect(),
            changes: Vec::new(),
        };
        self.exchange_with_digital(
            circuit,
            0.0,
            &mut result,
            &mut stats,
            &mut ledger,
            cfg.max_step,
        );
        unsettled(circuit)?;

        // Measured against the step ceiling rather than the run length, because a
        // run that is advanced piece by piece has no length to measure against —
        // and for a batch run the two are the same number, since `max_step`
        // defaults to a two-hundredth of the stop time.
        let min_step = (cfg.max_step * MIN_STEP_FRACTION * 200.0).max(f64::MIN_POSITIVE);
        let coupling = Coupling::learn(circuit, self.config.gmin);
        let run = Running {
            cfg,
            t: 0.0,
            // A tenth of the first step asked for, as SPICE takes it. The start
            // is damped, and until three timepoints have been accepted nothing
            // can say how long a backward Euler step the circuit tolerates: a
            // tank started at its initial condition gave up a tenth of its
            // energy to each of the first two steps, at a quarter of a radian.
            dt: (cfg.initial_step.min(cfg.max_step) / 10.0).max(min_step),
            // The trapezoidal rule rings if it is started from a step, and the
            // start of a run is the largest step there is: every source arrives
            // at its t = 0 value out of nothing. Damped for as long as any other
            // corner.
            euler_steps: CORNER_DAMPING,
            min_step,
            stats,
            ledger,
            reported_failures: 0,
            budget: usize::MAX,
            damp: vec![0; circuit.elements().len()],
            retuned: vec![0; circuit.elements().len()],
            coupling,
        };
        self.damped.clear();
        self.damped.resize(circuit.elements().len(), false);
        self.sized.clear();
        self.sized.resize(circuit.elements().len(), false);
        Ok((run, result))
    }

    /// Carry a run forward to `until`, and report only what happened on the way.
    ///
    /// The chunk carries no names — those were settled when the run began and do
    /// not change — only the timepoints solved during this call.
    pub fn advance_transient(
        &mut self,
        circuit: &mut Circuit,
        run: &mut Running,
        until: f64,
    ) -> Result<TransientResult, SimError> {
        let cfg = run.cfg;
        let min_step = run.min_step;
        let mut stats = std::mem::take(&mut run.stats);
        let work_at_start = stats.work();
        let mut result = TransientResult {
            digital: vec![Vec::new(); circuit.digital.net_count()],
            bursts: vec![Vec::new(); circuit.digital.net_count()],
            ..Default::default()
        };
        let mut t = run.t;
        let mut dt = run.dt;
        let mut euler_steps = run.euler_steps;
        let restore = |run: &mut Running, t: f64, dt: f64, euler_steps: usize, stats: Stats| {
            run.t = t;
            run.dt = dt;
            run.euler_steps = euler_steps;
            run.stats = stats;
        };
        // A circuit edited since the run began has a different set of elements,
        // and nothing learnt about the old one applies to it.
        let elements = circuit.elements().len();
        if run.damp.len() != elements {
            run.damp = vec![0; elements];
            run.retuned = vec![0; elements];
            run.coupling = Coupling::learn(circuit, self.config.gmin);
        }
        self.damped.resize(elements, false);
        self.sized.resize(elements, false);

        let row = (circuit.unknown_count() + circuit.elements().len()).max(1);
        while t < until - step_floor(min_step, t) {
            // Counted from where this call started rather than from zero: a run
            // that is advanced forever would otherwise trip the safety valve on
            // nothing worse than having been left running.
            //
            // Counted in work rather than in analog steps, so that digital
            // events count too. A run with no budget — a batch run, a Monte
            // Carlo draw — and a fast clock was otherwise bounded by nothing:
            // a hundred megahertz for a second is two hundred million events
            // inside a handful of analog steps.
            if stats.work() - work_at_start >= cfg.max_steps as f64 {
                restore(run, t, dt, euler_steps, stats);
                return Err(SimError::StepLimit { time: t });
            }
            // Out of budget for this call: what was solved goes back as it is,
            // and the next call carries on from here.
            let spent = stats.work() - work_at_start;
            if spent >= run.budget as f64 {
                break;
            }

            // A value somebody changed at this instant changes here, between
            // the timepoint solved with the old one and the step solved with
            // the new. That is a corner like any other edge, and damped like one.
            //
            // And the step starts short again, as at t = 0: the step size was
            // chosen for a circuit that has just stopped existing, and the
            // error estimates that would cut it down are measured on history
            // the change has made meaningless.
            //
            // Damped where the change reaches and nowhere else: an oscillator in
            // another part of the drawing loses energy to every backward Euler
            // step it is made to take, and has nothing to recover from.
            let retuned = circuit.apply_retunes(t + step_floor(min_step, t));
            if !retuned.is_empty() {
                let origins: Vec<Origin> = retuned.into_iter().map(Origin::Element).collect();
                run.coupling.damp(&origins, CORNER_DAMPING, &mut run.damp);
                run.coupling.damp(&origins, CORNER_DAMPING, &mut run.retuned);
                dt = dt.min(cfg.initial_step.max(min_step));
            }

            // A sample owed at the instant already reached — the digital side
            // stopped there for it — is the solution there.
            self.deliver_samples(circuit, t, t);

            let integration =
                if euler_steps > 0 { Integration::BackwardEuler } else { Integration::Trapezoidal };

            // Run the digital side out to where this step could at most end.
            // Whatever it does on its own nets in that span is its business; the
            // first change on a net that reaches the analog circuit is where
            // this step has to end, so that the bridge starts its ramp from a
            // timepoint the solver has actually been at.
            let natural = dt.min(cfg.max_step);
            let proposal = natural.min(until - t);
            // Whichever runs out first, the frame's share or the safety valve:
            // without a budget, one step's worth of a fast clock was otherwise
            // run out in full before the valve was next looked at.
            let allowed = (run.budget as f64).min(cfg.max_steps as f64) - spent;
            let events_allowed = ((allowed * EVENTS_PER_STEP).ceil() as usize).max(1);
            // No further than the next corner, though: a switch thrown there
            // is a change on its way to the digital side, and a device that has
            // already run past it — a microcontroller cannot take back cycles
            // it has run — would answer it a whole step late.
            let mut horizon = match self.next_breakpoint(circuit, t) {
                Some(bp) if bp > t => proposal.min(bp - t),
                _ => proposal,
            };
            // Nor past a change it has already reached and the analog side has
            // not: that change is where this step ends anyway. Without this the
            // queue went on to the next edge at every step the solver took on
            // its way there, the few after each ramp included, and on a fast
            // clock read back through the circuit it ended up whole edges
            // ahead. A crossing the analog side then found was handed to a
            // device that had already seen the edges after it: a shift
            // register clocked through the Uno's LED buffer on pin 13 took in
            // its data bits from four clocks later.
            if let Some(next) = next_resolved(&run.ledger.pacing, t) {
                horizon = horizon.min(next - t);
            }
            let settled = circuit.digital.settle_until(t + horizon, true, events_allowed);
            stats.digital_events += settled.events;
            if let Err(e) = unsettled(circuit) {
                restore(run, t, dt, euler_steps, stats);
                return Err(e);
            }
            self.absorb_digital(circuit, &mut result, &mut run.ledger, cfg.max_step);
            // A change the queue made at this very instant is reached already:
            // the bridge starts its ramp here, not a step late at the end of
            // the step about to be taken.
            let reached = self.reach_changes(circuit, &mut run.ledger.pacing, t);
            if !reached.is_empty() {
                let origins: Vec<Origin> = reached.into_iter().map(Origin::Dac).collect();
                corner_at_latest(circuit, run, &origins);
            }
            if settled.halt == Halt::Budget && settled.time <= t {
                // What ran out was the safety valve, not the frame's share: that
                // is an error, reported at the top of the loop, and never a run
                // handed back short as though it had finished.
                if (cfg.max_steps as f64) < run.budget as f64 {
                    continue;
                }
                // The frame's share went on events that did not get the digital
                // side past the analog one. Nothing to solve; the next call
                // carries on.
                break;
            }

            // Which elements take this step damped: all of them while the whole
            // circuit owes damped steps, otherwise those a corner reached.
            for (flag, &owed) in self.damped.iter_mut().zip(&run.damp) {
                *flag = euler_steps > 0 || owed > 0;
            }
            // And which of them have their step sized by backward Euler's own
            // error: at the start of the run and after a value changed, where
            // whatever is stored — a tank's energy — is at the mercy of the
            // first-order steps. Not after every corner: the edges of a clock
            // come so often that sizing every damped step after them that way
            // cost half as many steps again, for a loss that the source driving
            // the edges makes good on the next one.
            for (flag, &owed) in self.sized.iter_mut().zip(&run.retuned) {
                *flag = euler_steps > 0 || owed > 0;
            }

            let mut step = proposal
                .min(self.element_step_limit(circuit, t))
                .min(self.dac_step_limit(circuit, t));

            // Whether this step ends exactly on a corner — the edge of a pulse,
            // a point in a piecewise-linear table, a digital output changing —
            // and whose corner it is.
            let mut on_corner = false;
            let mut corner: Vec<Origin> = Vec::new();
            if let Some(bp) = self.next_breakpoint(circuit, t)
                && bp > t
                && bp < t + step
            {
                step = bp - t;
                on_corner = true;
                corner.extend(
                    circuit
                        .elements()
                        .iter()
                        .enumerate()
                        .filter(|(_, e)| e.next_breakpoint(t) == Some(bp))
                        .map(|(k, _)| Origin::Element(k)),
                );
                corner.extend(
                    circuit
                        .dacs()
                        .iter()
                        .enumerate()
                        .filter(|(_, d)| d.next_breakpoint(t) == Some(bp))
                        .map(|(k, _)| Origin::Dac(k)),
                );
            }
            if let Some(next) = next_resolved(&run.ledger.pacing, t)
                && next < t + step
            {
                corner.clear();
                step = next - t;
                on_corner = true;
                corner.extend(
                    run.ledger
                        .pacing
                        .iter()
                        .enumerate()
                        .filter(|(_, p)| p.ahead.iter().any(|c| c.resolve && c.time == next))
                        .map(|(k, _)| Origin::Dac(k)),
                );
            }
            // A converter samples there: the voltage it gets is the one solved
            // at that instant, not one interpolated across a step.
            if let Some(due) = circuit.digital.next_sample_due()
                && due > t
                && due < t + step
            {
                step = due - t;
            }
            // Not a corner: the queue was simply not run any further, and the
            // analog side is not to get ahead of it.
            if settled.halt == Halt::Budget && settled.time < t + step {
                step = settled.time - t;
                on_corner = false;
            }
            step = step.max(step_floor(min_step, t));
            // A step that would stop short of `until` by less than the clock can
            // resolve goes all the way: the run counts as there, and stopping a
            // sliver short of it left a single shot that never finished, with
            // every later call to finish it returning nothing.
            if until - (t + step) > 0.0 && until - (t + step) < step_floor(min_step, until) {
                step = until - t;
            }

            // Attempt the step, backing off if Newton refuses to converge.
            let mut attempt = step;
            let mut integration = integration;
            loop {
                // Every attempt starts from the last accepted timepoint and from
                // nothing else. The unknowns were always put back; the devices were
                // not, so a nonlinear part went into the retry seeded with the last
                // guess of the attempt that had just failed — and the answer to a
                // step therefore depended on how many rejections preceded it.
                self.x.copy_from_slice(&self.x_accepted);
                for element in circuit.elements_mut() {
                    element.rewind();
                }
                self.hold_averages(circuit, &run.ledger.pacing, t, attempt);
                match self.newton(
                    circuit,
                    Mode::Transient,
                    integration,
                    t + attempt,
                    attempt,
                    self.config.gmin,
                    1.0,
                    self.config.transient_max_iterations,
                    &mut stats,
                ) {
                    Ok(_) => {
                        // Solved is not yet accepted. The step was sized from the
                        // history before it, which cannot see an onset that starts
                        // inside it; its own point can. A step longer than the one
                        // its error estimate now asks for is thrown away and taken
                        // again at that length — SPICE's test, the same 0.9 — and
                        // since nothing has been accepted, nothing has to be undone:
                        // the devices record a timepoint only once it is final, and
                        // the digital side has consumed nothing from this one.
                        let allowed =
                            self.trial_step_limit(circuit, t + attempt, attempt, integration);
                        let floor = step_floor(min_step, t);
                        if allowed < STEP_REJECTION * attempt && attempt > floor {
                            stats.rejected_steps += 1;
                            attempt = allowed.max(floor);
                            continue;
                        }
                        break;
                    }
                    // An iterate that overflowed is a step too long for the
                    // exponentials in it, as much as one that did not settle.
                    Err(failed @ (SimError::NoConvergence { .. } | SimError::NonFinite { .. })) => {
                        stats.rejected_steps += 1;
                        attempt /= 8.0;
                        // Backward Euler is more forgiving; fall back to it while
                        // fighting through whatever is happening here.
                        integration = Integration::BackwardEuler;
                        euler_steps = euler_steps.max(2);
                        if attempt < step_floor(min_step, t) {
                            restore(run, t, dt, euler_steps, stats);
                            let culprits = match self.explain(circuit, failed) {
                                SimError::NoConvergence { culprits, .. }
                                | SimError::NonFinite { culprits, .. } => culprits,
                                _ => Culprits::default(),
                            };
                            // The failed iterate has been read for the
                            // explanation; what the run holds is the last
                            // timepoint it actually solved.
                            self.x.copy_from_slice(&self.x_accepted);
                            return Err(SimError::TimestepTooSmall {
                                time: t,
                                step: attempt,
                                culprits,
                            });
                        }
                    }
                    Err(other) => {
                        restore(run, t, dt, euler_steps, stats);
                        let explained = self.explain(circuit, other);
                        self.x.copy_from_slice(&self.x_accepted);
                        return Err(explained);
                    }
                }
            }

            let from = t;
            t += attempt;
            self.accept_timepoint(circuit, Mode::Transient, integration, t, attempt);
            self.deliver_samples(circuit, from, t);
            self.x_accepted.copy_from_slice(&self.x);
            stats.accepted_steps += 1;
            let mut reached = self.reach_changes(circuit, &mut run.ledger.pacing, t);
            if run.ledger.pacing.iter().any(|p| p.averageable.is_none()) {
                self.learn_coupling(&run.coupling, circuit, &mut run.ledger.pacing);
            }
            euler_steps = euler_steps.saturating_sub(1);
            for owed in run.damp.iter_mut().chain(run.retuned.iter_mut()) {
                *owed = owed.saturating_sub(1);
            }

            // Anything alternating step by step is the integrator, not the
            // circuit. One damped step kills the mode; backward Euler has no
            // ringing in it at all. Damped where it rings, and what that reaches.
            let ringing: Vec<Origin> = circuit
                .elements()
                .iter()
                .enumerate()
                .filter(|(_, e)| e.is_ringing())
                .map(|(k, _)| Origin::Element(k))
                .collect();
            run.coupling.damp(&ringing, 1, &mut run.damp);

            // Having just landed on a corner, take the next couple of steps with
            // backward Euler.
            //
            // The trapezoidal rule is second-order accurate and, on a step, rings:
            // the companion current alternates sign every timestep and decays by
            // about a third each time, which is not a property of the circuit but
            // of the integrator. It is invisible on a voltage — the ripple is tiny
            // beside the level — and glaring on a capacitive current, which is
            // *made* of the difference between consecutive points. A gate that had
            // finished charging went on showing microamps swapping direction every
            // step, and the drawing animated it: dots jittering back and forth
            // along a wire carrying nothing. Two damped steps kill it, which is
            // what every SPICE does at a breakpoint and this did only at t = 0.
            //
            // Damped where the corner reaches, not everywhere: a pulse source or
            // a clock beside a tank used to put the whole circuit on backward
            // Euler at every edge, and the tank gave up its energy to them.
            if on_corner && attempt >= step {
                corner_at_latest(circuit, run, &corner);
            }

            self.record(&mut result, circuit, t);
            reached.extend(self.exchange_with_digital(
                circuit,
                t,
                &mut result,
                &mut stats,
                &mut run.ledger,
                cfg.max_step,
            ));
            // A bridge that started a ramp here is a corner where it is.
            if !reached.is_empty() {
                let origins: Vec<Origin> = reached.into_iter().map(Origin::Dac).collect();
                corner_at_latest(circuit, run, &origins);
            }
            if let Err(e) = unsettled(circuit) {
                restore(run, t, dt, euler_steps, stats);
                return Err(e);
            }
            if result.time.len().saturating_mul(row) > MAX_RECORDED_VALUES {
                restore(run, t, dt, euler_steps, stats);
                return Err(SimError::TooMuchData { time: t });
            }

            // Grow back gradually. Doubling every step overshoots straight into
            // the next rejection.
            //
            // But only grow back from a step that was actually refused. A step
            // that was merely cut short — by a corner, a ramp, an element's
            // error estimate — says nothing against the size it was cut from,
            // and doubling up from a two-nanosecond ramp to a twenty-millisecond
            // cruise took twenty-five steps of nothing happening after every
            // logic edge that reached an LED.
            //
            // Nor is the end of the call such a reason: a step cut short by
            // `until` used to start the next call from twice the sliver that was
            // left, and a run advanced a frame at a time took half as many steps
            // again as the same run in one go.
            dt = if attempt >= step && step < natural {
                natural
            } else {
                (attempt * 2.0).min(cfg.max_step)
            };
        }

        // A burst still open goes out as far as it has got, and carries on in
        // the next piece from where this one left it: the caller joins them.
        for (net, tracing) in run.ledger.tracing.iter_mut().enumerate() {
            if let Some(burst) = tracing.burst.as_mut()
                && burst.edges > 0
            {
                result.bursts[net].push(*burst);
                result.digital[net].push((burst.to, run.ledger.last[net]));
                *burst = Burst { from: burst.to, to: burst.to, edges: 0, high: 0.0 };
            }
        }

        let mut failures: Vec<Failure> =
            circuit.elements().iter().filter_map(|e| e.failure()).collect();
        failures.sort_by(|a, b| a.time.total_cmp(&b.time));
        // Only the ones nobody has been told about yet. A part is destroyed once,
        // and reporting it again in every chunk would have it explode on the
        // drawing every frame for the rest of the run.
        result.failures = failures.split_off(run.reported_failures.min(failures.len()));
        run.reported_failures += result.failures.len();

        result.stats = stats.clone();
        restore(run, t, dt, euler_steps, stats);
        Ok(result)
    }

    /// Tightest step any element is willing to take from the current state.
    ///
    /// Each by the error of the rule it will take the step with, where that
    /// matters: a backward Euler step is first order, and the trapezoidal
    /// rule's error term allows it steps far too long for that.
    fn element_step_limit(&self, circuit: &Circuit, t: f64) -> f64 {
        let ctx = AcceptCtx {
            mode: Mode::Transient,
            integration: Integration::Trapezoidal,
            time: t,
            dt: 0.0,
            x: &self.x_accepted,
        };
        let euler = AcceptCtx { integration: Integration::BackwardEuler, ..ctx };
        circuit
            .elements()
            .iter()
            .enumerate()
            .map(|(k, e)| {
                let sized = self.sized.get(k).copied().unwrap_or(false);
                e.max_timestep(if sized { &euler } else { &ctx })
            })
            .fold(f64::INFINITY, f64::min)
    }

    /// Tightest step any element asks for once the timepoint just solved at
    /// `time` is counted as accepted — judged by the same rule each element's
    /// step was sized by in [`Self::element_step_limit`], and recording nothing.
    fn trial_step_limit(
        &self,
        circuit: &Circuit,
        time: f64,
        dt: f64,
        integration: Integration,
    ) -> f64 {
        let ctx = AcceptCtx { mode: Mode::Transient, integration, time, dt, x: &self.x };
        let trapezoidal = AcceptCtx { integration: Integration::Trapezoidal, ..ctx };
        let euler = AcceptCtx { integration: Integration::BackwardEuler, ..ctx };
        circuit
            .elements()
            .iter()
            .enumerate()
            .map(|(k, e)| {
                let sized = self.sized.get(k).copied().unwrap_or(false);
                e.trial_timestep(if sized { &euler } else { &trapezoidal })
            })
            .fold(f64::INFINITY, f64::min)
    }

    fn dac_step_limit(&self, circuit: &Circuit, t: f64) -> f64 {
        circuit.dacs().iter().map(|d| d.max_timestep(t)).fold(f64::INFINITY, f64::min)
    }

    fn next_breakpoint(&self, circuit: &Circuit, t: f64) -> Option<f64> {
        let from_elements = circuit.elements().iter().filter_map(|e| e.next_breakpoint(t));
        let from_dacs = circuit.dacs().iter().filter_map(|d| d.next_breakpoint(t));
        let retune = circuit.next_retune().filter(|&at| at > t);
        from_elements
            .chain(from_dacs)
            .chain(retune)
            .fold(None::<f64>, |acc, bp| Some(acc.map_or(bp, |a| a.min(bp))))
    }

    fn accept_timepoint(
        &mut self,
        circuit: &mut Circuit,
        mode: Mode,
        integration: Integration,
        time: f64,
        dt: f64,
    ) {
        let ctx = AcceptCtx { mode, integration, time, dt, x: &self.x };
        let euler = AcceptCtx { integration: Integration::BackwardEuler, ..ctx };
        for (k, element) in circuit.elements_mut().iter_mut().enumerate() {
            let damped = mode == Mode::Transient && self.damped.get(k).copied().unwrap_or(false);
            element.accept(if damped { &euler } else { &ctx });
        }
    }

    /// Hand every device measuring analog nodes what it is owed by `to`: the
    /// solution accepted at `from` and the one just solved at `to`, joined by a
    /// straight line for an instant in between. A sample instant is a step
    /// limit, so that is the exception — a step the floor stretched past it,
    /// or one the instant appeared inside after the step was chosen.
    fn deliver_samples(&self, circuit: &mut Circuit, from: f64, to: f64) {
        let (old, new) = (&self.x_accepted, &self.x);
        // The instant is a cycle count over a frequency and the step to it a
        // difference, so landing on it is only exact to a rounding.
        let until = to + 4.0 * f64::EPSILON * to.abs();
        let span = to - from;
        circuit.digital.deliver_samples(until, |at, node| {
            let Some(i) = node_index(node).filter(|&i| i < new.len()) else { return 0.0 };
            let alpha = if span > 0.0 { ((at - from) / span).clamp(0.0, 1.0) } else { 1.0 };
            old[i] + (new[i] - old[i]) * alpha
        });
    }

    /// Sample every ADC, let the digital domain settle to the accepted instant,
    /// and hand any resulting net changes back to the DAC bridges.
    fn exchange_with_digital(
        &mut self,
        circuit: &mut Circuit,
        t: f64,
        result: &mut TransientResult,
        stats: &mut Stats,
        ledger: &mut Ledger,
        max_step: f64,
    ) -> Vec<usize> {
        // Analog -> digital.
        let mut pending: Vec<(f64, DriverId, NetId, Logic)> = Vec::new();
        {
            let x = &self.x;
            for adc in circuit.adcs_mut() {
                let at = |n| crate::element::node_index(n).map_or(0.0, |i| x[i]);
                let mut v = at(adc.node);
                // Read as a share of the supply, when the thresholds are one. A
                // supply that has collapsed reads everything as low rather than
                // dividing by nothing.
                if let Some((plus, minus)) = adc.reference {
                    let span = at(plus) - at(minus);
                    v = if span > 1e-3 { (v - at(minus)) / span } else { 0.0 };
                }
                if let Some((when, state)) = adc.sample(t, v) {
                    // At the instant the bridge worked out, not at the end of the
                    // step. Rounding it up to `t` was the whole interpolation
                    // undone: a crossing is always somewhere inside the step that
                    // found it, so `max(t)` could only ever be `t`. On a coarse
                    // step that put every edge on the analog grid — a ramp
                    // crossing its threshold at 700 µs was recorded at 727 µs —
                    // and the propagation delays of everything downstream were
                    // measured from there.
                    //
                    // Nothing is scheduled in the past by it: the bridge never
                    // reports an instant earlier than its own previous sample,
                    // which is the last time the queue was settled.
                    pending.push((when, adc.driver(), adc.net, state));
                }
            }
        }
        for (when, driver, net, state) in pending {
            circuit.digital.schedule(when, driver, net, state);
            stats.digital_events += 1;
        }

        // Let the event queue run out to the current instant. Anything the ADCs
        // just scheduled is due by now or soon; what the queue had already got
        // to beyond `t` stays where it is.
        //
        // A crossing the bridge found inside the step is scheduled at the
        // instant it happened, and the queue may already have been run past
        // that instant. It goes in anyway and comes out first: what it wakes is
        // evaluated at its own time, late only in the sense that a device which
        // fired between the crossing and here did not see it. That device would
        // have needed the analog side to stop at a crossing nobody knew about
        // until the step that found it, which is one step of error either way —
        // the same as before the queue was allowed ahead.
        let settled = circuit.digital.settle_until(t, false, usize::MAX);
        stats.digital_events += settled.events;
        self.absorb_digital(circuit, result, ledger, max_step);
        self.reach_changes(circuit, &mut ledger.pacing, t)
    }

    /// Take what the digital domain has done since it was last asked: into the
    /// recorded waveforms, and — for the nets that reach the analog circuit —
    /// to the bridges, once the analog side has got to where each change is.
    fn absorb_digital(
        &mut self,
        circuit: &mut Circuit,
        result: &mut TransientResult,
        ledger: &mut Ledger,
        max_step: f64,
    ) {
        let Ledger { last, tracing, pacing, changes } = ledger;
        let mut rewatch = false;
        // Into the recorded waveforms, at the instant the net actually took the
        // value and not at the end of the analog step that happened to notice.
        //
        // The "did it really change" test is against the level carried by the run
        // rather than against the last entry in this result: a run advanced in
        // pieces hands back one result per piece, and a chunk that starts empty
        // would take the first sample of an unchanged net as a transition.
        circuit.digital.swap_log(changes);
        for change in changes.iter() {
            if let (Some(trace), Some(previous), Some(tracing)) = (
                result.digital.get_mut(change.net),
                last.get_mut(change.net),
                tracing.get_mut(change.net),
            ) && *previous != change.state
            {
                record(
                    trace,
                    &mut result.bursts[change.net],
                    tracing,
                    change.time,
                    *previous,
                    change.state,
                    max_step,
                );
                *previous = change.state;
            }
            for (dac, pace) in circuit.dacs().iter().zip(pacing.iter_mut()) {
                if dac.net != change.net {
                    continue;
                }
                // Too fast to resolve, or slow enough again? Judged by the gap
                // since the net last moved, against the step ceiling.
                let gap = change.time - pace.last_change;
                pace.last_change = change.time;
                pace.fast_run =
                    if gap < max_step * UNRESOLVED_SPACING { pace.fast_run + 1 } else { 0 };
                let was = pace.fast;
                if pace.fast {
                    pace.fast = gap <= max_step * RESOLVED_SPACING;
                } else {
                    pace.fast = pace.averageable == Some(true) && pace.fast_run >= UNRESOLVED_RUN;
                }
                rewatch |= pace.fast != was;
                pace.ahead.push(Change {
                    time: change.time,
                    state: change.state,
                    resolve: !pace.fast,
                });
            }
        }
        if rewatch {
            // Only the nets being resolved edge by edge stop the queue.
            let watched: Vec<NetId> = circuit
                .dacs()
                .iter()
                .zip(pacing.iter())
                .filter(|(_, p)| !p.fast)
                .map(|(d, _)| d.net)
                .collect();
            circuit.digital.watch(watched);
        }
    }

    /// The solver is at `t`: every change up to it has been reached, and the
    /// bridges take them.
    ///
    /// A change to be resolved is answered with a ramp, and the bridge is told
    /// `t` rather than the change's own time, deliberately. A ramp that began
    /// before the timepoint just accepted would be a change to a solve that is
    /// already finished — the analog side would step from a voltage it was
    /// solved at to one partway along an edge it never saw. Worse for a fast
    /// edge inside a slow step: the whole ramp would be in the past, so the
    /// output would jump, which is the one thing this bridge exists to never
    /// do. So the record is honest about when the logic moved, and the analog
    /// side starts moving at the earliest instant it can honour — which is this
    /// one, since a change to be resolved is a breakpoint and the step ends on
    /// it.
    ///
    /// A change to be averaged only moves the level the next average starts
    /// from; the bridge itself is set at each attempt, from what the step ahead
    /// holds.
    ///
    /// Returns the bridges that started a ramp.
    fn reach_changes(
        &mut self,
        circuit: &mut Circuit,
        pacing: &mut [Pacing],
        t: f64,
    ) -> Vec<usize> {
        let mut ramped = Vec::new();
        for (k, (dac, pace)) in circuit.dacs_mut().iter_mut().zip(pacing.iter_mut()).enumerate() {
            let reached = pace.ahead.iter().take_while(|c| c.time <= t).count();
            for change in pace.ahead.drain(..reached) {
                pace.level = change.state;
                pace.averaging = !change.resolve;
                if change.resolve {
                    dac.notify(change.state, t);
                    if ramped.last() != Some(&k) {
                        ramped.push(k);
                    }
                }
            }
        }
        ramped
    }

    /// Hold every bridge that is being averaged at its net's time average over
    /// the step about to be attempted, from `t` to `t + step`.
    ///
    /// Being averaged means either that the last change reached was one to
    /// fold in, or that the step ahead holds one: the first such change is
    /// where the bridge stops answering edges with ramps, and it is not a
    /// breakpoint, so the step is simply averaged from there.
    fn hold_averages(&mut self, circuit: &mut Circuit, pacing: &[Pacing], t: f64, step: f64) {
        if step <= 0.0 {
            return;
        }
        let end = t + step;
        for (dac, pace) in circuit.dacs_mut().iter_mut().zip(pacing) {
            let within = |c: &&Change| c.time > t && c.time < end;
            if !pace.averaging && !pace.ahead.iter().filter(within).any(|c| !c.resolve) {
                continue;
            }
            let mut level = pace.level;
            let mut from = t;
            let mut sum = 0.0;
            for change in &pace.ahead {
                if change.time <= t {
                    level = change.state;
                    continue;
                }
                if change.time >= end {
                    break;
                }
                sum += dac.level_voltage(level) * (change.time - from);
                level = change.state;
                from = change.time;
            }
            sum += dac.level_voltage(level) * (end - from);
            dac.hold(sum / step);
        }
    }

    /// Work out, from the transient matrix just solved, which bridges drive a
    /// part of the circuit nothing reads back — the ones that may be averaged.
    ///
    /// Two unknowns are coupled when a chain of nonzero entries joins them,
    /// except through a node an ideal source holds: the supply rail is common
    /// to everything and carries no signal. A bridge whose node shares a chain
    /// with an analog-to-digital bridge's node is left alone: what it drives
    /// comes back as logic, and an oscillator built that way would be averaged
    /// into a level that never crosses a threshold.
    fn learn_coupling(&mut self, coupling: &Coupling, circuit: &Circuit, pacing: &mut [Pacing]) {
        // The same pattern the damping reads, learnt once at the operating
        // point: a dense complex matrix for the question cost 256 MB at the size
        // limit, twice what that limit is there to bound.
        let label = &coupling.label;
        let read: Vec<usize> = circuit
            .adcs()
            .iter()
            .filter_map(|adc| node_index(adc.node))
            .filter_map(|i| label.get(i).copied())
            .collect();
        for (dac, pace) in circuit.dacs().iter().zip(pacing.iter_mut()) {
            let coupled =
                node_index(dac.node).and_then(|i| label.get(i)).is_some_and(|l| read.contains(l));
            pace.averageable = Some(!coupled);
        }
    }

    /// Start the logic, let it settle at t = 0, and put every bridge at the level
    /// its net settled to. Whatever the analog side is about to solve is solved
    /// around these levels, so it comes first, in every analysis.
    fn bring_up_digital(&mut self, circuit: &mut Circuit) -> Result<(), SimError> {
        let bridged: Vec<NetId> = circuit.dacs().iter().map(|d| d.net).collect();
        circuit.digital.watch(bridged);
        circuit.digital.initialize();
        circuit.digital.settle(0.0);
        unsettled(circuit)?;
        // The starting levels are levels, not changes: whoever records the run
        // reads them off the nets.
        circuit.digital.take_log();
        self.force_dac_levels(circuit, 0.0);
        Ok(())
    }

    /// Snap every DAC to its net's current level with no ramp. Used only at t=0,
    /// where a ramp would be an artifact rather than physics.
    fn force_dac_levels(&mut self, circuit: &mut Circuit, t: f64) {
        let levels: Vec<Logic> =
            circuit.dacs().iter().map(|d| circuit.digital.state(d.net)).collect();
        for (dac, state) in circuit.dacs_mut().iter_mut().zip(levels) {
            dac.set_level(state, t);
        }
    }

    fn record(&self, result: &mut TransientResult, circuit: &Circuit, t: f64) {
        result.time.push(t);
        result.solution.push(self.x.clone());

        let mut currents = Vec::new();
        circuit.collect_currents(&self.x, &mut currents);
        result.currents.push(currents);
    }

    /// Convenience: the last solved unknown vector.
    pub fn solution(&self) -> &[f64] {
        &self.x
    }
}

/// Put one change on a net into its trace: as an edge, or folded into a burst.
///
/// The same spacing that decides whether a bridge resolves an edge decides
/// whether the trace records it. Past a run of edges closer together than the
/// ceiling can show, the trace keeps a burst instead, and the burst ends at
/// the first edge that comes after a gap wide enough to see — that edge is
/// recorded, along with the level the net was at when the burst ended, so the
/// lane between the two is drawn right.
fn record(
    trace: &mut Vec<(f64, Logic)>,
    bursts: &mut Vec<Burst>,
    tracing: &mut Tracing,
    time: f64,
    before: Logic,
    state: Logic,
    max_step: f64,
) {
    let gap = time - tracing.last_change;
    tracing.last_change = time;
    tracing.fast_run = if gap < max_step * UNRESOLVED_SPACING { tracing.fast_run + 1 } else { 0 };
    if let Some(burst) = tracing.burst.as_mut() {
        if gap <= max_step * RESOLVED_SPACING {
            burst.to = time;
            burst.edges += 1;
            if before == Logic::High {
                burst.high += gap;
            }
            return;
        }
        if burst.edges > 0 {
            bursts.push(*burst);
            trace.push((burst.to, before));
        }
        tracing.burst = None;
    } else if tracing.fast_run >= UNRESOLVED_RUN {
        tracing.burst = Some(Burst { from: time, to: time, edges: 1, high: 0.0 });
        return;
    }
    trace.push((time, state));
}

/// The earliest change past `t` that the bridges are to resolve, if any: the
/// analog step has to end there.
fn next_resolved(pacing: &[Pacing], t: f64) -> Option<f64> {
    pacing
        .iter()
        .flat_map(|p| p.ahead.iter())
        .filter(|c| c.resolve && c.time > t)
        .map(|c| c.time)
        .reduce(f64::min)
}

/// Remove the 360-degree jumps `atan2` introduces.
///
/// A phase response that slides past -180 belongs below it on the plot, not
/// teleported to +180. Without this an ordinary two-pole rolloff looks like it
/// has a discontinuity in the middle of it.
fn unwrap_phase(series: &mut [f64]) {
    let mut offset = 0.0;
    for i in 1..series.len() {
        let delta = (series[i] + offset) - series[i - 1];
        if delta > 180.0 {
            offset -= 360.0;
        } else if delta < -180.0 {
            offset += 360.0;
        }
        series[i] += offset;
    }
}

/// Default logic thresholds used when a circuit does not specify a family.
pub fn default_family() -> LogicFamily {
    LogicFamily::cmos_5v()
}
