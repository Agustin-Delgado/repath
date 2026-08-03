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
//!
//! # Timestep control
//!
//! The transient loop never steps over a discontinuity. Before each step it takes
//! the minimum of: the local truncation error budget, the shortest feature of any
//! source waveform, the next waveform corner, the next digital event, and the end
//! of any digital-to-analog ramp in flight.

use crate::bridge::LogicFamily;
use crate::circuit::Circuit;
use crate::complex::ComplexSystem;
use crate::digital::{DriverId, Logic, NetId};
use crate::element::{AcCtx, AcceptCtx, Integration, Mode, StampCtx};
use crate::elements::{Diode, Failure};
use crate::linalg::{LinearSystem, SolveError};

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

#[derive(Debug, Clone, PartialEq)]
pub enum SimError {
    /// The matrix has no unique solution — usually a floating section of circuit
    /// or a loop of ideal voltage sources.
    Singular { unknown: String },
    /// Newton ran out of iterations, and every fallback also failed.
    NoConvergence { time: f64, iterations: usize },
    /// The step had to shrink below anything meaningful to make progress.
    TimestepTooSmall { time: f64, step: f64 },
    /// The run hit `max_steps`.
    StepLimit { time: f64 },
    /// Nothing to solve.
    Empty,
}

impl std::fmt::Display for SimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SimError::Singular { unknown } => write!(
                f,
                "circuit matrix is singular near {unknown}; check for a floating node or a loop of voltage sources"
            ),
            SimError::NoConvergence { time, iterations } => {
                write!(f, "failed to converge at t = {time:.6e} s after {iterations} iterations")
            }
            SimError::TimestepTooSmall { time, step } => {
                write!(f, "timestep collapsed to {step:.3e} s at t = {time:.6e} s")
            }
            SimError::StepLimit { time } => {
                write!(f, "hit the step limit at t = {time:.6e} s")
            }
            SimError::Empty => write!(f, "the circuit has nothing to solve"),
        }
    }
}

impl std::error::Error for SimError {}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    pub accepted_steps: usize,
    pub rejected_steps: usize,
    pub newton_iterations: usize,
    pub digital_events: usize,
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
    /// Per net, the instants at which it changed value.
    pub digital: Vec<Vec<(f64, Logic)>>,
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
        Self { start_hz: start_hz.max(1e-9), stop_hz: stop_hz.max(1e-9), points_per_decade: 20 }
    }

    /// The frequencies this configuration sweeps, logarithmically spaced.
    pub fn frequencies(&self) -> Vec<f64> {
        let (lo, hi) = (self.start_hz.min(self.stop_hz), self.start_hz.max(self.stop_hz));
        let decades = (hi / lo).log10();
        let steps = ((decades * self.points_per_decade as f64).round() as usize).max(1);
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
}

/// Smallest step the transient loop will attempt, relative to the run length.
const MIN_STEP_FRACTION: f64 = 1e-11;

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
                circuit.stamp_all(&mut self.sys, &ctx)
            };

            self.sys.solve_into(&mut self.x_next).map_err(|e| match e {
                SolveError::Singular { row } => SimError::Singular {
                    unknown: circuit
                        .unknown_names()
                        .get(row)
                        .cloned()
                        .unwrap_or_else(|| format!("unknown #{row}")),
                },
            })?;
            stats.newton_iterations += 1;

            let settled = self.converged(node_rows);
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

        Err(SimError::NoConvergence { time, iterations: max_iterations })
    }

    /// Whether `x_next` is within tolerance of `x` on every unknown.
    fn converged(&self, node_rows: usize) -> bool {
        self.x.iter().zip(&self.x_next).enumerate().all(|(i, (old, new))| {
            let floor = if i < node_rows { self.config.vntol } else { self.config.abstol };
            let tol = self.config.reltol * old.abs().max(new.abs()) + floor;
            (new - old).abs() <= tol
        })
    }

    /// Solve the DC operating point, escalating through the convergence aids.
    pub fn operating_point(&mut self, circuit: &mut Circuit) -> Result<OperatingPoint, SimError> {
        self.prepare(circuit)?;
        let mut stats = Stats::default();
        self.solve_operating_point(circuit, &mut stats)?;
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
            Err(SimError::NoConvergence { .. }) | Err(SimError::Singular { .. }) => {}
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

        // 3. Source stepping.
        self.x.fill(0.0);
        circuit.reset();
        for step in 0..=cfg.source_steps {
            let scale = step as f64 / cfg.source_steps as f64;
            self.newton(
                circuit,
                Mode::OperatingPoint,
                Integration::BackwardEuler,
                0.0,
                0.0,
                cfg.gmin,
                scale,
                cfg.dc_max_iterations,
                stats,
            )?;
        }
        Ok(())
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
        let mut stats = Stats::default();
        let mut out = Vec::with_capacity(values.len());

        for (i, value) in values.iter().enumerate() {
            apply(circuit, *value);
            if i == 0 {
                self.solve_operating_point(circuit, &mut stats)?;
            } else {
                self.newton(
                    circuit,
                    Mode::OperatingPoint,
                    Integration::BackwardEuler,
                    0.0,
                    0.0,
                    self.config.gmin,
                    1.0,
                    self.config.dc_max_iterations,
                    &mut stats,
                )?;
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
        let n = self.prepare(circuit)?;
        circuit.reset();

        let mut stats = Stats::default();
        self.solve_operating_point(circuit, &mut stats)?;

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

            sys.solve_into(&mut x).map_err(|e| SimError::Singular {
                unknown: unknown_names.get(e.row).cloned().unwrap_or_else(|| format!("#{}", e.row)),
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

    /// Run a mixed-signal transient analysis.
    pub fn transient(
        &mut self,
        circuit: &mut Circuit,
        cfg: TransientConfig,
    ) -> Result<TransientResult, SimError> {
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
            ..Default::default()
        };

        // Bring the digital side up first: the analog operating point depends on
        // what the digital outputs are driving.
        circuit.digital.initialize();
        circuit.digital.settle(0.0);
        self.force_dac_levels(circuit, 0.0);

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
            )?;
            Mode::InitialConditions
        } else {
            self.solve_operating_point(circuit, &mut stats)?;
            Mode::OperatingPoint
        };

        self.accept_timepoint(circuit, start_mode, Integration::BackwardEuler, 0.0, 0.0);
        self.x_accepted.copy_from_slice(&self.x);
        self.record(&mut result, circuit, 0.0);
        self.exchange_with_digital(circuit, 0.0, &mut result, &mut stats);

        let min_step = (cfg.stop * MIN_STEP_FRACTION).max(f64::MIN_POSITIVE);
        let mut t = 0.0;
        let mut dt = cfg.initial_step.min(cfg.max_step).max(min_step);
        // The trapezoidal rule rings if it is started from a step; a couple of
        // backward-Euler steps damp the transient out first.
        let mut euler_steps = 2usize;

        while t < cfg.stop - min_step {
            if stats.accepted_steps >= cfg.max_steps {
                return Err(SimError::StepLimit { time: t });
            }

            let integration =
                if euler_steps > 0 { Integration::BackwardEuler } else { Integration::Trapezoidal };

            let mut step = dt
                .min(cfg.max_step)
                .min(cfg.stop - t)
                .min(self.element_step_limit(circuit, t))
                .min(self.dac_step_limit(circuit, t));

            if let Some(bp) = self.next_breakpoint(circuit, t)
                && bp > t
                && bp < t + step
            {
                step = bp - t;
            }
            if let Some(event) = circuit.digital.next_event_time()
                && event > t
                && event < t + step
            {
                step = event - t;
            }
            step = step.max(min_step);

            // Attempt the step, backing off if Newton refuses to converge.
            let mut attempt = step;
            let mut integration = integration;
            loop {
                self.x.copy_from_slice(&self.x_accepted);
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
                    Ok(_) => break,
                    Err(SimError::NoConvergence { .. }) => {
                        stats.rejected_steps += 1;
                        attempt /= 8.0;
                        // Backward Euler is more forgiving; fall back to it while
                        // fighting through whatever is happening here.
                        integration = Integration::BackwardEuler;
                        euler_steps = euler_steps.max(2);
                        if attempt < min_step {
                            return Err(SimError::TimestepTooSmall { time: t, step: attempt });
                        }
                    }
                    Err(other) => return Err(other),
                }
            }

            t += attempt;
            self.accept_timepoint(circuit, Mode::Transient, integration, t, attempt);
            self.x_accepted.copy_from_slice(&self.x);
            stats.accepted_steps += 1;
            euler_steps = euler_steps.saturating_sub(1);

            self.record(&mut result, circuit, t);
            self.exchange_with_digital(circuit, t, &mut result, &mut stats);

            // Grow back gradually. Doubling every step overshoots straight into
            // the next rejection.
            dt = (attempt * 2.0).min(cfg.max_step);
        }

        result.failures = circuit
            .elements()
            .iter()
            .filter_map(|e| e.as_any().downcast_ref::<Diode>()?.failure())
            .collect();
        result.failures.sort_by(|a, b| a.time.total_cmp(&b.time));

        result.stats = stats;
        Ok(result)
    }

    /// Tightest step any element is willing to take from the current state.
    fn element_step_limit(&self, circuit: &Circuit, t: f64) -> f64 {
        let ctx = AcceptCtx {
            mode: Mode::Transient,
            integration: Integration::Trapezoidal,
            time: t,
            dt: 0.0,
            x: &self.x_accepted,
        };
        circuit.elements().iter().map(|e| e.max_timestep(&ctx)).fold(f64::INFINITY, f64::min)
    }

    fn dac_step_limit(&self, circuit: &Circuit, t: f64) -> f64 {
        circuit.dacs().iter().map(|d| d.max_timestep(t)).fold(f64::INFINITY, f64::min)
    }

    fn next_breakpoint(&self, circuit: &Circuit, t: f64) -> Option<f64> {
        let from_elements = circuit.elements().iter().filter_map(|e| e.next_breakpoint(t));
        let from_dacs = circuit.dacs().iter().filter_map(|d| d.next_breakpoint(t));
        from_elements
            .chain(from_dacs)
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
        for element in circuit.elements_mut() {
            element.accept(&ctx);
        }
    }

    /// Sample every ADC, let the digital domain settle, and hand any resulting
    /// net changes back to the DAC bridges.
    fn exchange_with_digital(
        &mut self,
        circuit: &mut Circuit,
        t: f64,
        result: &mut TransientResult,
        stats: &mut Stats,
    ) {
        // Analog -> digital.
        let mut pending: Vec<(f64, DriverId, NetId, Logic)> = Vec::new();
        {
            let x = &self.x;
            for adc in circuit.adcs_mut() {
                let v = crate::element::node_index(adc.node).map_or(0.0, |i| x[i]);
                if let Some((when, state)) = adc.sample(t, v) {
                    pending.push((when.max(t), adc.driver(), adc.net, state));
                }
            }
        }
        for (when, driver, net, state) in pending {
            circuit.digital.schedule(when, driver, net, state);
            stats.digital_events += 1;
        }

        // Let the event queue run out to the current instant.
        circuit.digital.settle(t);
        let changed: Vec<(NetId, Logic)> = circuit
            .digital
            .changed_nets()
            .iter()
            .map(|net| (*net, circuit.digital.state(*net)))
            .collect();

        // Digital -> analog, and into the recorded waveforms.
        for (net, state) in &changed {
            if let Some(trace) = result.digital.get_mut(*net)
                && trace.last().map(|(_, s)| *s) != Some(*state)
            {
                trace.push((t, *state));
            }
        }
        if !changed.is_empty() {
            for dac in circuit.dacs_mut() {
                if let Some((_, state)) = changed.iter().find(|(net, _)| *net == dac.net) {
                    dac.notify(*state, t);
                }
            }
        }
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
