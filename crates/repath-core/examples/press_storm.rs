//! What a run costs while somebody keeps pressing a button on it.
//!
//! ```sh
//! cargo run --release -p repath-core --example press_storm
//! cargo run --release -p repath-core --example press_storm -- 2000   # presses
//! ```
//!
//! The Arduino Uno blink example, compiled to the netlist the editor hands the
//! engine (`examples/bench/uno-blink.json`), run the way the editor runs it: a
//! frame's worth of simulated time at a time, with the push-button on pin 2
//! pressed and released every few frames. Each operation hands the engine the
//! contact's whole control waveform, bounce and all, from the start of the run:
//! more than the editor sends, which is only what is still to come, so that
//! looking a waveform up is measured at its worst.
//!
//! The figure to watch is the cost per block of presses. It should hold still
//! however many presses came before: a cost that climbs with the count is
//! something accumulating per press, which is what this exists to catch. The
//! orderings and the factorizations from scratch should stay at zero: a press
//! changes the contact's resistance, never the matrix's pattern.

use repath_core::prelude::*;
use std::time::Instant;

/// Simulated seconds per frame: sixty frames a second at one second a second.
const FRAME: f64 = 1.0 / 60.0;
/// The step ceiling the editor sets for a four-second window.
const MAX_STEP: f64 = 0.02;
/// Frames from one press to the next, and from a press to its release.
const PRESS_EVERY: usize = 6;
const HELD_FOR: usize = 3;
/// Presses per reported block.
const BLOCK: usize = 100;
/// The push-button's defaults in the editor.
const BOUNCE: f64 = 1e-3;
const CHATTER: i32 = 4;

/// The contact's control signal for these operations: what the editor's
/// `contactControl` makes of a push-button resting open.
fn contact_control(operations: &[f64]) -> Vec<(f64, f64)> {
    let edge = (BOUNCE / 200.0).clamp(1e-12, 1e-6);
    let mut points = vec![(0.0, 0.0)];
    let mut level = 0.0;
    let mut go = |points: &mut Vec<(f64, f64)>, t: f64, to: f64| {
        if to == level {
            return;
        }
        points.push(((t - edge).max(0.0), level));
        points.push((t.max(edge), to));
        level = to;
    };
    for (index, &when) in operations.iter().enumerate() {
        let target = if index % 2 == 0 { 1.0 } else { 0.0 };
        let next = operations.get(index + 1).copied().unwrap_or(f64::INFINITY);
        let train = BOUNCE.min(next - when - 2.0 * edge);
        let span = train / (1.0 - 0.5f64.powi(CHATTER));
        go(&mut points, when, target);
        if span * 0.5f64.powi(CHATTER) <= 2.0 * edge {
            continue;
        }
        let mut elapsed = 0.0;
        for k in 0..CHATTER {
            elapsed += span * 0.5f64.powi(k + 1);
            go(&mut points, when + elapsed, if k % 2 == 0 { 1.0 - target } else { target });
        }
    }
    points
}

fn main() {
    let presses: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1000);
    let netlist: Netlist =
        serde_json::from_str(include_str!("bench/uno-blink.json")).expect("a netlist");
    let mut circuit = netlist.compile().expect("compiles");
    let mut sim = Simulator::default();
    let mut cfg = TransientConfig::new(MAX_STEP * 200.0);
    cfg.max_step = MAX_STEP;
    cfg.initial_step = MAX_STEP / 5.0;
    let (mut run, _) = sim.begin_transient(&mut circuit, cfg).expect("starts");

    println!(
        "{:>8} {:>10} {:>9} {:>9} {:>9} {:>9} {:>10} {:>12}",
        "presses", "sim (s)", "steps", "rejected", "pivoted", "ordered", "ms/block", "us/step"
    );
    // Ten seconds untouched first, as the figure the storm is measured against.
    let idle_started = Instant::now();
    sim.advance_transient(&mut circuit, &mut run, 10.0).expect("advances");
    let spent = idle_started.elapsed().as_secs_f64() * 1e3;
    let steps = run.stats().accepted_steps;
    println!(
        "{:>8} {:>10.2} {:>9} {:>9} {:>9} {:>9} {:>10.1} {:>12.2}",
        "idle",
        run.time(),
        steps,
        run.stats().rejected_steps,
        sim.factorizations().pivoted,
        sim.factorizations().orderings,
        spent,
        spent * 1e3 / steps.max(1) as f64
    );

    let mut operations: Vec<f64> = Vec::new();
    let mut frame = 0usize;
    let mut block_started = Instant::now();
    let mut last_stats = run.stats().clone();
    let mut last_counts = sim.factorizations();
    while operations.len() < 2 * presses {
        let at = run.time();
        let phase = frame % PRESS_EVERY;
        if phase == 0 || phase == HELD_FOR {
            operations.push(at);
            let waveform = Waveform::Pwl { points: contact_control(&operations) };
            assert!(circuit.set_source_waveform("S2__actuator", waveform));
        }
        sim.advance_transient(&mut circuit, &mut run, at + FRAME).expect("advances");
        frame += 1;

        let pressed = operations.len() / 2;
        if phase == HELD_FOR && pressed.is_multiple_of(BLOCK) {
            let stats = run.stats().clone();
            let counts = sim.factorizations();
            let spent = block_started.elapsed().as_secs_f64() * 1e3;
            let steps = stats.accepted_steps - last_stats.accepted_steps;
            println!(
                "{:>8} {:>10.2} {:>9} {:>9} {:>9} {:>9} {:>10.1} {:>12.2}",
                pressed,
                run.time(),
                steps,
                stats.rejected_steps - last_stats.rejected_steps,
                counts.pivoted - last_counts.pivoted,
                counts.orderings - last_counts.orderings,
                spent,
                spent * 1e3 / steps.max(1) as f64
            );
            last_stats = stats;
            last_counts = counts;
            block_started = Instant::now();
        }
    }
}
