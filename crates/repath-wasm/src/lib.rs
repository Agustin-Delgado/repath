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
    /// The whole run, or — once it is live — the piece solved most recently.
    result: Option<TransientResult>,
    running: Option<Running>,
}

#[wasm_bindgen]
impl Simulation {
    /// Build a simulation from a netlist, given as a JSON string.
    #[wasm_bindgen(constructor)]
    pub fn new(netlist_json: &str) -> Result<Simulation, JsError> {
        let netlist: Netlist = serde_json::from_str(netlist_json).map_err(to_js_error)?;
        let circuit = netlist.compile().map_err(to_js_error)?;
        Ok(Simulation { circuit, simulator: Simulator::default(), result: None, running: None })
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
        let meta = meta_of(&result, true);
        self.running = None;
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

    /// Start a run that will be carried forward a piece at a time.
    ///
    /// Returns the same metadata a whole run does, plus the single timepoint at
    /// t = 0 — so the drawing has something to show the instant it starts rather
    /// than a frame of nothing.
    #[wasm_bindgen(js_name = beginLive)]
    pub fn begin_live(&mut self, max_step: f64) -> Result<String, JsError> {
        let step = if max_step > 0.0 { max_step } else { 1e-6 };
        // `stop` only sets defaults here; a live run has no end, and every limit
        // that used to be derived from it is derived from the step instead.
        let mut cfg = TransientConfig::new(step * 200.0);
        cfg.max_step = step;
        cfg.initial_step = step / 5.0;

        let (run, result) =
            self.simulator.begin_transient(&mut self.circuit, cfg).map_err(to_js_error)?;
        let meta = meta_of(&result, true);
        self.running = Some(run);
        self.result = Some(result);
        serde_json::to_string(&meta).map_err(to_js_error)
    }

    /// Carry the live run to `until`, in simulated seconds from its start.
    ///
    /// Only the samples solved during this call are kept: the caller holds the
    /// history, and a run that never ends cannot keep all of it here.
    pub fn advance(&mut self, until: f64) -> Result<String, JsError> {
        let Some(run) = self.running.as_mut() else {
            return Err(JsError::new("no live run has been started"));
        };
        let chunk =
            self.simulator.advance_transient(&mut self.circuit, run, until).map_err(to_js_error)?;
        let meta = meta_of(&chunk, false);
        self.result = Some(chunk);
        serde_json::to_string(&meta).map_err(to_js_error)
    }

    /// How far the live run has got, in seconds.
    #[wasm_bindgen(js_name = liveTime)]
    pub fn live_time(&self) -> f64 {
        self.running.as_ref().map_or(0.0, |r| r.time())
    }

    /// Give a source a new waveform from here on — a hand on a switch.
    ///
    /// The waveform is the JSON the netlist uses, so the caller can hand over a
    /// contact's whole bounce train anchored wherever it likes.
    #[wasm_bindgen(js_name = setSourceWaveform)]
    pub fn set_source_waveform(
        &mut self,
        name: &str,
        waveform_json: &str,
    ) -> Result<bool, JsError> {
        let waveform: Waveform = serde_json::from_str(waveform_json).map_err(to_js_error)?;
        Ok(self.circuit.set_source_waveform(name, waveform))
    }

    /// Move a logic source to a level, from `at` onwards.
    #[wasm_bindgen(js_name = setLogic)]
    pub fn set_logic(&mut self, name: &str, state: &str, at: f64) -> bool {
        let level = match state {
            "high" => Logic::High,
            "low" => Logic::Low,
            "highz" => Logic::HighZ,
            _ => Logic::Unknown,
        };
        self.circuit.operate_logic(name, level, at)
    }
}

/// What a run, or one piece of one, has to say for itself.
///
/// Names travel only with the first piece: they are settled when the run is
/// compiled and repeating them on every frame would be the bulk of the traffic.
fn meta_of(result: &TransientResult, with_names: bool) -> RunMeta {
    RunMeta {
        unknown_names: if with_names { result.unknown_names.clone() } else { Vec::new() },
        node_count: result.node_count,
        point_count: result.time.len(),
        element_names: if with_names { result.element_names.clone() } else { Vec::new() },
        net_names: if with_names { result.net_names.clone() } else { Vec::new() },
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
