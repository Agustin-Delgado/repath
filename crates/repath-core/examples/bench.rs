//! How long the engine takes on circuits large enough to feel the linear solver.
//!
//! ```sh
//! cargo run --release -p repath-core --example bench
//! cargo run --release -p repath-core --example bench -- mesh   # only names containing "mesh"
//! ```
//!
//! Each case is a circuit, the analysis run on it, and what that cost: wall
//! time, the size of the matrix, accepted and rejected steps, and Newton
//! iterations. The circuits are generated — ladders and meshes of resistors and
//! capacitors, a chain of transistor amplifiers, a bank of counters lighting
//! LEDs — or are examples from the editor, compiled to the netlist it hands the
//! engine (`examples/bench/*.json`). Every case is run a few times and the
//! fastest run is reported, so a busy machine skews the numbers less.

use repath_core::prelude::*;
use std::time::{Duration, Instant};

/// Runs of each case; the fastest is reported.
const RUNS: usize = 5;

/// What one run of a case cost.
struct Cost {
    time: Duration,
    unknowns: usize,
    steps: usize,
    rejected: usize,
    newton: usize,
}

enum Analysis {
    OperatingPoint,
    Transient(f64),
    Ac(f64, f64),
}

struct Case {
    name: String,
    parts: usize,
    analysis: Analysis,
    build: Box<dyn Fn() -> Circuit>,
}

impl Case {
    fn new(name: String, analysis: Analysis, build: impl Fn() -> Circuit + 'static) -> Self {
        let parts = build().elements().len();
        Self { name, parts, analysis, build: Box::new(build) }
    }

    fn run(&self) -> Cost {
        let mut circuit = (self.build)();
        let mut sim = Simulator::default();
        let start = Instant::now();
        let (steps, rejected, newton) = match self.analysis {
            Analysis::OperatingPoint => {
                let op = sim.operating_point(&mut circuit).expect("operating point");
                (0, 0, op.iterations)
            }
            Analysis::Transient(stop) => {
                let result =
                    sim.transient(&mut circuit, TransientConfig::new(stop)).expect("transient");
                let stats = &result.stats;
                (stats.accepted_steps, stats.rejected_steps, stats.newton_iterations)
            }
            Analysis::Ac(from, to) => {
                let result = sim.ac_sweep(&mut circuit, AcConfig::new(from, to)).expect("ac");
                (result.frequencies.len(), 0, 0)
            }
        };
        Cost { time: start.elapsed(), unknowns: circuit.unknown_count(), steps, rejected, newton }
    }
}

/// A ladder of `sections` resistors in series, a capacitor from each joint to
/// ground, driven by a pulse: the long thin matrix of a transmission line.
fn rc_ladder(sections: usize) -> Circuit {
    let mut c = Circuit::new();
    let input = c.node("in");
    let pulse = Waveform::Pulse {
        v1: 0.0,
        v2: 5.0,
        delay: 1e-6,
        rise: 1e-7,
        fall: 1e-7,
        width: 20e-6,
        period: 40e-6,
    };
    c.add(Box::new(VoltageSource::new("V1", input, Circuit::GROUND, pulse).with_ac(1.0, 0.0)));
    let mut previous = input;
    for k in 0..sections {
        let next = c.node(&format!("n{k}"));
        c.add(Box::new(Resistor::new(format!("R{k}"), previous, next, 100.0)));
        c.add(Box::new(Capacitor::new(format!("C{k}"), next, Circuit::GROUND, 1e-10)));
        previous = next;
    }
    c
}

/// A `side` × `side` grid of resistors with a capacitor on every node, fed at
/// one corner: the two-dimensional pattern that makes an ordering earn its
/// keep, since a bad one fills the whole band in.
fn rc_mesh(side: usize) -> Circuit {
    let mut c = Circuit::new();
    let nodes: Vec<Vec<NodeId>> =
        (0..side).map(|i| (0..side).map(|j| c.node(&format!("m{i}_{j}"))).collect()).collect();
    let pulse = Waveform::Pulse {
        v1: 0.0,
        v2: 1.0,
        delay: 0.0,
        rise: 1e-7,
        fall: 1e-7,
        width: 5e-6,
        period: 10e-6,
    };
    c.add(Box::new(
        VoltageSource::new("V1", nodes[0][0], Circuit::GROUND, pulse).with_ac(1.0, 0.0),
    ));
    for i in 0..side {
        for j in 0..side {
            if i + 1 < side {
                c.add(Box::new(Resistor::new(
                    format!("Rv{i}_{j}"),
                    nodes[i][j],
                    nodes[i + 1][j],
                    50.0,
                )));
            }
            if j + 1 < side {
                c.add(Box::new(Resistor::new(
                    format!("Rh{i}_{j}"),
                    nodes[i][j],
                    nodes[i][j + 1],
                    50.0,
                )));
            }
            c.add(Box::new(Capacitor::new(
                format!("C{i}_{j}"),
                nodes[i][j],
                Circuit::GROUND,
                1e-11,
            )));
        }
    }
    // A load in the far corner, so the grid is not all one potential at DC.
    let far = nodes[side - 1][side - 1];
    c.add(Box::new(Resistor::new("Rload", far, Circuit::GROUND, 1_000.0)));
    c
}

/// `stages` common-emitter amplifiers in a row, each biased by its own divider
/// and coupled to the next through a capacitor and a resistor: Newton has a
/// junction per stage to settle, and the chain has to be solved as one. Each
/// stage gains about as much as the coupling into the next loses, so the
/// signal stays small however long the chain is.
fn transistor_chain(stages: usize) -> Circuit {
    let mut c = Circuit::new();
    let vcc = c.node("vcc");
    c.add(Box::new(VoltageSource::dc("VCC", vcc, Circuit::GROUND, 12.0)));
    let input = c.node("in");
    let sine = Waveform::Sine {
        offset: 0.0,
        amplitude: 0.01,
        frequency: 1e3,
        delay: 0.0,
        damping: 0.0,
        phase: 0.0,
    };
    c.add(Box::new(VoltageSource::new("VIN", input, Circuit::GROUND, sine).with_ac(1.0, 0.0)));
    let mut previous = input;
    for k in 0..stages {
        let base = c.node(&format!("b{k}"));
        let collector = c.node(&format!("c{k}"));
        let emitter = c.node(&format!("e{k}"));
        let coupling = c.node(&format!("k{k}"));
        c.add(Box::new(Capacitor::new(format!("Cin{k}"), previous, coupling, 10e-6)));
        c.add(Box::new(Resistor::new(format!("Rin{k}"), coupling, base, 33e3)));
        c.add(Box::new(Resistor::new(format!("Rb1_{k}"), vcc, base, 47e3)));
        c.add(Box::new(Resistor::new(format!("Rb2_{k}"), base, Circuit::GROUND, 10e3)));
        c.add(Box::new(Resistor::new(format!("Rc{k}"), vcc, collector, 4.7e3)));
        c.add(Box::new(Resistor::new(format!("Re{k}"), emitter, Circuit::GROUND, 1e3)));
        c.add(Box::new(Bjt::new(format!("Q{k}"), collector, base, emitter, BjtModel::npn())));
        previous = collector;
    }
    c.add(Box::new(Resistor::new("Rload", previous, Circuit::GROUND, 100e3)));
    c
}

/// `chips` four-bit ripple counters off one clock, every output lighting an
/// LED through a resistor, the way a board of logic shows its state: each
/// output is a bridge into the analog side, so the matrix grows with the chips
/// while most of the work stays digital.
fn counter_bank(chips: usize) -> Circuit {
    // A red LED, as the editor compiles one.
    let red_led = serde_json::json!({
        "is": 2.7866356171949316e-18, "n": 2, "bv": null, "rs": 0.568, "temp": 300.15,
        "rated": 0.03, "eg": 2.4227052226423207
    });
    let mut components = Vec::new();
    let mut devices = vec![serde_json::json!({
        "type": "clock", "name": "CLK", "output": "clk", "frequency": 1e6, "duty": 0.5
    })];
    let mut bridges = Vec::new();
    components.push(serde_json::json!({
        "type": "voltage_source", "name": "VDD", "plus": "vdd", "minus": "gnd",
        "waveform": {"type": "dc", "value": 5.0}
    }));
    for chip in 0..chips {
        let mut previous = "clk".to_string();
        for bit in 0..4 {
            let q = format!("q{chip}_{bit}");
            let qn = format!("qn{chip}_{bit}");
            devices.push(serde_json::json!({
                "type": "d_flip_flop", "name": format!("U{chip}:{bit}"), "clock": previous,
                "data": qn, "q": q, "q_not": qn
            }));
            let pin = format!("pin{chip}_{bit}");
            let lamp = format!("lamp{chip}_{bit}");
            bridges.push(serde_json::json!({
                "direction": "to_analog", "name": format!("U{chip}:o{bit}"), "net": q,
                "node": pin, "supplies": [{"plus": "vdd", "minus": "gnd",
                "devices": [format!("U{chip}:{bit}")]}]
            }));
            components.push(serde_json::json!({
                "type": "resistor", "name": format!("R{chip}_{bit}"), "a": pin, "b": lamp,
                "resistance": 330.0
            }));
            components.push(serde_json::json!({
                "type": "diode", "name": format!("D{chip}_{bit}"), "anode": lamp, "cathode": "gnd",
                "model": red_led
            }));
            previous = q;
        }
    }
    let netlist = serde_json::json!({
        "components": components, "devices": devices, "bridges": bridges
    });
    let netlist: Netlist = serde_json::from_value(netlist).expect("a netlist");
    netlist.compile().expect("compiles")
}

/// An example from the editor, as the netlist it compiles to.
fn example(json: &'static str) -> impl Fn() -> Circuit {
    move || {
        let netlist: Netlist = serde_json::from_str(json).expect("a netlist");
        netlist.compile().expect("compiles")
    }
}

fn cases() -> Vec<Case> {
    let mut cases = Vec::new();
    for sections in [50, 150, 500, 1500] {
        cases.push(Case::new(
            format!("rc-ladder-{sections}"),
            Analysis::Transient(100e-6),
            move || rc_ladder(sections),
        ));
    }
    cases.push(Case::new("rc-ladder-500-ac".into(), Analysis::Ac(1.0, 1e9), || rc_ladder(500)));
    for side in [8, 12, 16, 24] {
        cases.push(Case::new(
            format!("rc-mesh-{side}x{side}"),
            Analysis::Transient(20e-6),
            move || rc_mesh(side),
        ));
    }
    cases.push(Case::new("rc-mesh-16x16-op".into(), Analysis::OperatingPoint, || rc_mesh(16)));
    for stages in [10, 30, 80] {
        cases.push(Case::new(
            format!("transistor-chain-{stages}"),
            Analysis::Transient(2e-3),
            move || transistor_chain(stages),
        ));
    }
    cases.push(Case::new("transistor-chain-80-op".into(), Analysis::OperatingPoint, || {
        transistor_chain(80)
    }));
    cases.push(Case::new("transistor-chain-80-ac".into(), Analysis::Ac(10.0, 1e8), || {
        transistor_chain(80)
    }));
    for chips in [4, 16, 48] {
        cases.push(Case::new(
            format!("counter-bank-{chips}"),
            Analysis::Transient(20e-6),
            move || counter_bank(chips),
        ));
    }
    cases.push(Case::new(
        "example-555-blinker".into(),
        Analysis::Transient(2.0),
        example(include_str!("bench/ne555-blinker.json")),
    ));
    cases.push(Case::new(
        "example-ripple-counter".into(),
        Analysis::Transient(40e-6),
        example(include_str!("bench/ripple-counter.json")),
    ));
    cases.push(Case::new(
        "example-adder-4bit".into(),
        Analysis::Transient(1e-3),
        example(include_str!("bench/adder-4bit.json")),
    ));
    cases
}

fn main() {
    let filter: Option<String> = std::env::args().nth(1);
    println!(
        "{:<26} {:>6} {:>8} {:>8} {:>8} {:>8} {:>11}",
        "case", "parts", "unknowns", "steps", "rejected", "newton", "time (ms)"
    );
    for case in cases() {
        if filter.as_ref().is_some_and(|f| !case.name.contains(f.as_str())) {
            continue;
        }
        let cost = (0..RUNS).map(|_| case.run()).min_by_key(|c| c.time).expect("a run");
        println!(
            "{:<26} {:>6} {:>8} {:>8} {:>8} {:>8} {:>11.2}",
            case.name,
            case.parts,
            cost.unknowns,
            cost.steps,
            cost.rejected,
            cost.newton,
            cost.time.as_secs_f64() * 1e3
        );
    }
}
