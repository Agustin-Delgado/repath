//! Resistor, capacitor and inductor.
//!
//! Capacitors and inductors are handled with companion models: each is replaced,
//! at every timestep, by a conductance (or resistance) in parallel with a source
//! carrying the element's history. That is what turns a differential equation
//! into the plain linear system the solver already knows how to handle.

use crate::complex::{C64, ComplexSystem};
use crate::element::{
    AcCtx, AcceptCtx, Element, Integration, Mode, NodeId, StampCtx, StampReport, node_index,
};
use crate::linalg::LinearSystem;
use crate::lte::Trace;

#[derive(Debug, Clone)]
pub struct Resistor {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    /// Resistance in ohms. Clamped away from zero at stamp time — a literal 0 Ω
    /// is a short, and users draw those constantly.
    pub r: f64,
}

impl Resistor {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, r: f64) -> Self {
        Self { name: name.into(), p, m, r }
    }

    #[inline]
    fn conductance(&self) -> f64 {
        1.0 / self.r.abs().max(1e-9)
    }
}

impl Element for Resistor {
    fn kind(&self) -> &'static str {
        "resistor"
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&mut self, sys: &mut LinearSystem, _ctx: &StampCtx) -> StampReport {
        sys.add_conductance(node_index(self.p), node_index(self.m), self.conductance());
        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        sys.add_admittance(node_index(self.p), node_index(self.m), C64::real(self.conductance()));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        let vp = node_index(self.p).map_or(0.0, |i| x[i]);
        let vm = node_index(self.m).map_or(0.0, |i| x[i]);
        Some((vp - vm) * self.conductance())
    }
}

#[derive(Debug, Clone)]
pub struct Capacitor {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    /// Capacitance in farads.
    pub c: f64,
    /// Initial voltage across the capacitor, applied when the transient starts.
    pub ic: Option<f64>,
    v_prev: f64,
    i_prev: f64,
    charge: Trace,
}

impl Capacitor {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, c: f64) -> Self {
        Self {
            name: name.into(),
            p,
            m,
            c: c.abs().max(1e-18),
            ic: None,
            v_prev: 0.0,
            i_prev: 0.0,
            charge: Trace::default(),
        }
    }

    pub fn with_ic(mut self, v0: f64) -> Self {
        self.ic = Some(v0);
        self.v_prev = v0;
        self
    }

    /// Companion conductance and history current for the current step.
    fn companion(&self, ctx: &StampCtx) -> (f64, f64) {
        match ctx.integration {
            Integration::BackwardEuler => {
                let geq = self.c / ctx.dt;
                (geq, geq * self.v_prev)
            }
            Integration::Trapezoidal => {
                let geq = 2.0 * self.c / ctx.dt;
                (geq, geq * self.v_prev + self.i_prev)
            }
        }
    }
}

impl Element for Capacitor {
    fn kind(&self) -> &'static str {
        "capacitor"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_reactive(&self) -> bool {
        true
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let (p, m) = (node_index(self.p), node_index(self.m));
        match ctx.mode {
            // Open circuit, unless the voltage is pinned: explicitly by an initial
            // condition, or implicitly to zero when the run skips the operating
            // point entirely.
            Mode::OperatingPoint | Mode::InitialConditions => {
                let pinned = match (ctx.mode, self.ic) {
                    (_, Some(v0)) => Some(v0),
                    (Mode::InitialConditions, None) => Some(0.0),
                    _ => None,
                };
                if let Some(v0) = pinned {
                    let g = 1.0 / 1e-6;
                    sys.add_conductance(p, m, g);
                    sys.add_current(p, m, -g * v0);
                }
            }
            Mode::Transient => {
                let (geq, ieq) = self.companion(ctx);
                sys.add_conductance(p, m, geq);
                // The history term is a constant current source; the current
                // leaving node p through the element is `geq*v - ieq`.
                sys.add_current(p, m, -ieq);
            }
        }
        StampReport::CLEAN
    }

    fn accept(&mut self, ctx: &AcceptCtx) {
        let v = ctx.voltage(self.p) - ctx.voltage(self.m);
        if ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            let geq = match ctx.integration {
                Integration::BackwardEuler => self.c / ctx.dt,
                Integration::Trapezoidal => 2.0 * self.c / ctx.dt,
            };
            let ieq = match ctx.integration {
                Integration::BackwardEuler => geq * self.v_prev,
                Integration::Trapezoidal => geq * self.v_prev + self.i_prev,
            };
            self.i_prev = geq * v - ieq;
        }
        self.v_prev = v;
        self.charge.push(ctx.time, self.c * v);
    }

    fn reset(&mut self) {
        self.v_prev = self.ic.unwrap_or(0.0);
        self.i_prev = 0.0;
        self.charge = Trace::default();
    }

    fn max_timestep(&self, _ctx: &AcceptCtx) -> f64 {
        self.charge.suggested_step()
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        // Y = j*omega*C. At DC this is zero, which is an open circuit — correct.
        sys.add_admittance(
            node_index(self.p),
            node_index(self.m),
            C64::imaginary(ctx.omega * self.c),
        );
    }

    fn current(&self, _x: &[f64]) -> Option<f64> {
        Some(self.i_prev)
    }
}

#[derive(Debug, Clone)]
pub struct Inductor {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    /// Inductance in henries.
    pub l: f64,
    /// Initial current through the inductor, p -> m.
    pub ic: Option<f64>,
    branch: usize,
    i_prev: f64,
    v_prev: f64,
    flux: Trace,
}

impl Inductor {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, l: f64) -> Self {
        Self {
            name: name.into(),
            p,
            m,
            l: l.abs().max(1e-15),
            ic: None,
            branch: 0,
            i_prev: 0.0,
            v_prev: 0.0,
            flux: Trace::default(),
        }
    }

    pub fn with_ic(mut self, i0: f64) -> Self {
        self.ic = Some(i0);
        self.i_prev = i0;
        self
    }
}

impl Element for Inductor {
    fn kind(&self) -> &'static str {
        "inductor"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_reactive(&self) -> bool {
        true
    }
    fn extra_unknowns(&self) -> usize {
        1
    }
    fn bind(&mut self, first_extra_index: usize) {
        self.branch = first_extra_index;
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let (p, m, k) = (node_index(self.p), node_index(self.m), Some(self.branch));

        // Branch current couples into both node equations.
        sys.add(p, k, 1.0);
        sys.add(m, k, -1.0);
        sys.add(k, p, 1.0);
        sys.add(k, m, -1.0);

        match ctx.mode {
            Mode::OperatingPoint | Mode::InitialConditions => {
                // At the operating point an inductor is a short, which the
                // coupling stamped above already expresses. When the current is
                // pinned instead, replace that equation with `i = i0`.
                let pinned = match (ctx.mode, self.ic) {
                    (_, Some(i0)) => Some(i0),
                    (Mode::InitialConditions, None) => Some(0.0),
                    _ => None,
                };
                if let Some(i0) = pinned {
                    sys.add(k, p, -1.0);
                    sys.add(k, m, 1.0);
                    sys.add(k, k, 1.0);
                    sys.add_rhs(k, i0);
                }
            }
            Mode::Transient => {
                let req = match ctx.integration {
                    Integration::BackwardEuler => self.l / ctx.dt,
                    Integration::Trapezoidal => 2.0 * self.l / ctx.dt,
                };
                let hist = match ctx.integration {
                    Integration::BackwardEuler => -req * self.i_prev,
                    Integration::Trapezoidal => -req * self.i_prev - self.v_prev,
                };
                sys.add(k, k, -req);
                sys.add_rhs(k, hist);
            }
        }
        StampReport::CLEAN
    }

    fn accept(&mut self, ctx: &AcceptCtx) {
        self.i_prev = ctx.unknown(self.branch);
        self.v_prev = ctx.voltage(self.p) - ctx.voltage(self.m);
        self.flux.push(ctx.time, self.l * self.i_prev);
    }

    fn reset(&mut self) {
        self.i_prev = self.ic.unwrap_or(0.0);
        self.v_prev = 0.0;
        self.flux = Trace::default();
    }

    fn max_timestep(&self, _ctx: &AcceptCtx) -> f64 {
        self.flux.suggested_step()
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        let (p, m, k) = (node_index(self.p), node_index(self.m), Some(self.branch));
        sys.add(p, k, C64::ONE);
        sys.add(m, k, -C64::ONE);
        sys.add(k, p, C64::ONE);
        sys.add(k, m, -C64::ONE);
        // v(p) - v(m) - j*omega*L*i = 0
        sys.add(k, k, -C64::imaginary(ctx.omega * self.l));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        x.get(self.branch).copied()
    }
}

/// A resistor whose value is set externally, used by digital-to-analog bridges
/// and by voltage-controlled switches.
#[derive(Debug, Clone)]
pub struct VariableResistor {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub r: f64,
}

impl VariableResistor {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, r: f64) -> Self {
        Self { name: name.into(), p, m, r }
    }

    #[inline]
    fn conductance(&self) -> f64 {
        1.0 / self.r.abs().clamp(1e-6, 1e12)
    }
}

impl Element for VariableResistor {
    fn kind(&self) -> &'static str {
        "variable_resistor"
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&mut self, sys: &mut LinearSystem, _ctx: &StampCtx) -> StampReport {
        sys.add_conductance(node_index(self.p), node_index(self.m), self.conductance());
        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        sys.add_admittance(node_index(self.p), node_index(self.m), C64::real(self.conductance()));
    }
}
