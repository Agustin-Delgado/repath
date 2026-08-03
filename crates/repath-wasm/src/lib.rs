//! WebAssembly bindings for `repath-core`.
//!
//! Waveforms cross the boundary as `Float64Array` rather than through serde.
//! A 20 000-point run has millions of numbers in it, and serializing those to
//! JSON and back is slower than the simulation that produced them.

use repath_core::digital::Logic;
use repath_core::prelude::*;
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Metadata describing a completed run. Small enough to send as JSON.
#[derive(Serialize)]
struct RunMeta {
    unknown_names: Vec<String>,
    node_count: usize,
    point_count: usize,
    element_names: Vec<String>,
    net_names: Vec<String>,
    digital: Vec<Vec<DigitalTransition>>,
    failures: Vec<PartFailure>,
    stats: RunStats,
}

/// A part that did not survive the run. Reported, not raised: the run continued
/// with it open, which is what the circuit itself does.
#[derive(Serialize)]
struct PartFailure {
    name: String,
    time: f64,
    peak: f64,
    rated: f64,
}

#[derive(Serialize)]
struct DigitalTransition {
    time: f64,
    state: &'static str,
}

#[derive(Serialize)]
struct RunStats {
    accepted_steps: usize,
    rejected_steps: usize,
    newton_iterations: usize,
    digital_events: usize,
}

fn logic_name(state: Logic) -> &'static str {
    match state {
        Logic::Low => "low",
        Logic::High => "high",
        Logic::Unknown => "unknown",
        Logic::HighZ => "highz",
    }
}

fn to_js_error(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// A compiled circuit plus its solver state.
#[wasm_bindgen]
pub struct Simulation {
    circuit: Circuit,
    simulator: Simulator,
    result: Option<TransientResult>,
}

#[wasm_bindgen]
impl Simulation {
    /// Build a simulation from a netlist, given as a JSON string.
    #[wasm_bindgen(constructor)]
    pub fn new(netlist_json: &str) -> Result<Simulation, JsError> {
        let netlist: Netlist = serde_json::from_str(netlist_json).map_err(to_js_error)?;
        let circuit = netlist.compile().map_err(to_js_error)?;
        Ok(Simulation { circuit, simulator: Simulator::default(), result: None })
    }

    /// Solve the DC operating point. Returns `{ names, values }` as JSON.
    #[wasm_bindgen(js_name = operatingPoint)]
    pub fn operating_point(&mut self) -> Result<String, JsError> {
        let op = self.simulator.operating_point(&mut self.circuit).map_err(to_js_error)?;
        #[derive(Serialize)]
        struct Op {
            names: Vec<String>,
            values: Vec<f64>,
            node_count: usize,
            iterations: usize,
        }
        serde_json::to_string(&Op {
            names: op.unknown_names,
            values: op.solution,
            node_count: op.node_count,
            iterations: op.iterations,
        })
        .map_err(to_js_error)
    }

    /// Run a transient analysis. The waveforms stay in Rust; fetch them with
    /// [`Simulation::time`] and [`Simulation::signal`].
    #[wasm_bindgen(js_name = runTransient)]
    pub fn run_transient(&mut self, stop: f64, max_step: f64) -> Result<String, JsError> {
        let mut cfg = TransientConfig::new(stop);
        if max_step > 0.0 {
            cfg.max_step = max_step;
            cfg.initial_step = max_step.min(cfg.initial_step);
        }
        let result = self.simulator.transient(&mut self.circuit, cfg).map_err(to_js_error)?;

        let meta = RunMeta {
            unknown_names: result.unknown_names.clone(),
            node_count: result.node_count,
            point_count: result.time.len(),
            element_names: result.element_names.clone(),
            net_names: result.net_names.clone(),
            digital: result
                .digital
                .iter()
                .map(|trace| {
                    trace
                        .iter()
                        .map(|(t, s)| DigitalTransition { time: *t, state: logic_name(*s) })
                        .collect()
                })
                .collect(),
            failures: result
                .failures
                .iter()
                .map(|f| PartFailure {
                    name: f.name.clone(),
                    time: f.time,
                    peak: f.peak,
                    rated: f.rated,
                })
                .collect(),
            stats: RunStats {
                accepted_steps: result.stats.accepted_steps,
                rejected_steps: result.stats.rejected_steps,
                newton_iterations: result.stats.newton_iterations,
                digital_events: result.stats.digital_events,
            },
        };
        self.result = Some(result);
        serde_json::to_string(&meta).map_err(to_js_error)
    }

    /// Time axis of the last run, as a `Float64Array`.
    pub fn time(&self) -> Vec<f64> {
        self.result.as_ref().map(|r| r.time.clone()).unwrap_or_default()
    }

    /// One unknown from the last run, as a `Float64Array`.
    pub fn signal(&self, index: usize) -> Vec<f64> {
        self.result.as_ref().map(|r| r.signal(index)).unwrap_or_default()
    }

    /// Current through one element across the run, as a `Float64Array`.
    pub fn current(&self, index: usize) -> Vec<f64> {
        self.result.as_ref().map(|r| r.current_signal(index)).unwrap_or_default()
    }

    /// Index of an unknown by label, e.g. `"v(out)"`. Returns -1 if absent.
    #[wasm_bindgen(js_name = indexOf)]
    pub fn index_of(&self, name: &str) -> i32 {
        self.result.as_ref().and_then(|r| r.index_of(name)).map_or(-1, |i| i as i32)
    }
}

/// A frequency-domain run, kept separate from the transient one so switching
/// between analyses does not throw away the other's results.
#[wasm_bindgen]
pub struct FrequencyRun {
    result: AcResult,
}

#[wasm_bindgen]
impl FrequencyRun {
    /// Swept frequencies in hertz, as a `Float64Array`.
    pub fn frequencies(&self) -> Vec<f64> {
        self.result.frequencies.clone()
    }

    /// Linear magnitude of one unknown across the sweep.
    pub fn magnitude(&self, index: usize) -> Vec<f64> {
        self.result.magnitude.get(index).cloned().unwrap_or_default()
    }

    /// Phase of one unknown across the sweep, in degrees, already unwrapped.
    pub fn phase(&self, index: usize) -> Vec<f64> {
        self.result.phase.get(index).cloned().unwrap_or_default()
    }

    /// `{ names, node_count, point_count }` as JSON.
    pub fn meta(&self) -> Result<String, JsError> {
        #[derive(Serialize)]
        struct Meta<'a> {
            names: &'a [String],
            node_count: usize,
            point_count: usize,
        }
        serde_json::to_string(&Meta {
            names: &self.result.unknown_names,
            node_count: self.result.node_count,
            point_count: self.result.frequencies.len(),
        })
        .map_err(to_js_error)
    }
}

/// Sweep a circuit's frequency response.
#[wasm_bindgen(js_name = runFrequencySweep)]
pub fn run_frequency_sweep(
    netlist_json: &str,
    start_hz: f64,
    stop_hz: f64,
    points_per_decade: usize,
) -> Result<FrequencyRun, JsError> {
    let netlist: Netlist = serde_json::from_str(netlist_json).map_err(to_js_error)?;
    let mut circuit = netlist.compile().map_err(to_js_error)?;

    let mut config = AcConfig::new(start_hz, stop_hz);
    if points_per_decade > 0 {
        config.points_per_decade = points_per_decade;
    }
    let result = Simulator::default().ac_sweep(&mut circuit, config).map_err(to_js_error)?;
    Ok(FrequencyRun { result })
}

/// Engine version, so the UI can report which build it is running.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
