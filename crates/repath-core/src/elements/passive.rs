//! Resistor, capacitor and inductor.
//!
//! Capacitors and inductors are handled with companion models: each is replaced,
//! at every timestep, by a conductance (or resistance) in parallel with a source
//! carrying the element's history. That is what turns a differential equation
//! into the plain linear system the solver already knows how to handle.

use crate::complex::{C64, ComplexSystem};
use crate::element::{
    AcCtx, AcceptCtx, Element, Integration, Mode, NodeId, RingDetector, StampCtx, StampReport,
    node_index,
};
use crate::elements::semiconductor::{Failure, Heat, TNOM, ThermalModel};
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
    /// First and second order temperature coefficients, per kelvin.
    ///
    /// A carbon film part drifts a few hundred parts per million per degree and a
    /// wirewound one drifts more; the reason a precision divider is built from a
    /// matched pair is that theirs cancel. Zero is a resistor made of nothing that
    /// exists.
    pub tc1: f64,
    pub tc2: f64,
    /// What the part is at, and what its value was measured at, in kelvin.
    pub temp: f64,
    pub tnom: f64,
}

impl Resistor {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, r: f64) -> Self {
        Self { name: name.into(), p, m, r, tc1: 0.0, tc2: 0.0, temp: TNOM, tnom: TNOM }
    }

    pub fn with_tempco(mut self, tc1: f64, tc2: f64) -> Self {
        self.tc1 = tc1;
        self.tc2 = tc2;
        self
    }

    /// Resistance at the temperature the part is actually at.
    fn resistance(&self) -> f64 {
        let d = self.temp - self.tnom;
        if d == 0.0 || (self.tc1 == 0.0 && self.tc2 == 0.0) {
            return self.r;
        }
        // Clamped positive: a coefficient large enough to take a resistance
        // through zero is a description of something that stopped being a
        // resistor, and a negative one would be a source.
        (self.r * (1.0 + self.tc1 * d + self.tc2 * d * d)).max(self.r.abs() * 1e-3)
    }

    #[inline]
    fn conductance(&self) -> f64 {
        1.0 / self.resistance().abs().max(1e-9)
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
    /// Mean current over the step just accepted — what the branch carried.
    i_mean: f64,
    ring: RingDetector,
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
            i_mean: 0.0,
            ring: RingDetector::default(),
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
            // What actually crossed the capacitance over the step, which is the
            // honest thing to report and cannot ring by construction. The
            // companion value above is the same number the stamp uses, and with a
            // settled voltage the trapezoidal form of it is simply `-i_prev`.
            self.i_mean = self.c * (v - self.v_prev) / ctx.dt;
            self.ring.push(self.i_mean);
        }
        self.v_prev = v;
        self.charge.push(ctx.time, self.c * v);
    }

    fn reset(&mut self) {
        self.v_prev = self.ic.unwrap_or(0.0);
        self.i_prev = 0.0;
        self.i_mean = 0.0;
        self.ring.reset();
        self.charge = Trace::default();
    }

    fn is_ringing(&self) -> bool {
        self.ring.ringing()
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
        Some(self.i_mean)
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
    /// Mean voltage across the step just accepted — the dual of a capacitance's
    /// mean current, and the quantity that alternates when this branch rings.
    v_mean: f64,
    ring: RingDetector,
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
            v_mean: 0.0,
            ring: RingDetector::default(),
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
        let i = ctx.unknown(self.branch);
        if ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            // What the branch actually had across it over the step, which cannot
            // ring by construction — the mirror of the capacitor's mean current.
            self.v_mean = self.l * (i - self.i_prev) / ctx.dt;
            self.ring.push(self.v_mean);
        }
        self.i_prev = i;
        self.v_prev = ctx.voltage(self.p) - ctx.voltage(self.m);
        self.flux.push(ctx.time, self.l * self.i_prev);
    }

    fn reset(&mut self) {
        self.i_prev = self.ic.unwrap_or(0.0);
        self.v_prev = 0.0;
        self.v_mean = 0.0;
        self.ring.reset();
        self.flux = Trace::default();
    }

    fn is_ringing(&self) -> bool {
        // An inductance is where the trapezoidal rule rings most readily, and it
        // was the one storage element with nothing watching for it: the capacitor
        // has had this since the ringing was first chased down.
        self.ring.ringing()
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

/// A fuse: a small resistance that opens for good once it has carried too much
/// for too long.
///
/// What melts the element is heat, and what heats it is `i²`. It is the two
/// thermal masses of `ThermalModel`, loaded with `(i / rated)²`: the element
/// itself and the end caps and glass around it. The fast one's time constant
/// comes from the melting integral, the `I²t` every fuse datasheet prints, so a
/// short blows it once that much `i²t` has gone through — ten times the rating
/// through a 1 A fuse with 0.5 A²s lasts about five milliseconds. The slow one
/// is what makes a small overload take seconds, and what lets a fuse ride out a
/// surge followed by a rest. At or below its rating it never blows.
#[derive(Debug, Clone)]
pub struct Fuse {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    /// Cold resistance, ohms.
    pub r: f64,
    /// Current it carries indefinitely, amps.
    pub rated: f64,
    /// Melting integral, A²s.
    pub i2t: f64,
    /// How it heats, worked out from the rating and the melting integral.
    thermal: ThermalModel,
    heat: Heat,
    i_accepted: f64,
    peak: f64,
    blown_at: Option<f64>,
}

impl Fuse {
    pub fn new(
        name: impl Into<String>,
        p: NodeId,
        m: NodeId,
        r: f64,
        rated: f64,
        i2t: f64,
    ) -> Self {
        let rated = rated.abs().max(1e-12);
        let i2t = i2t.abs().max(1e-12);
        // Well past the rating the element melts before any heat leaves it, so
        // what heats it is all of `i²t`: the fast mass's time constant over its
        // share is the melting integral in units of the rating.
        let adiabatic = i2t / (rated * rated);
        let share = 0.4;
        Self {
            name: name.into(),
            p,
            m,
            r: r.abs().max(1e-6),
            rated,
            i2t,
            thermal: ThermalModel { share, fast: share * adiabatic, slow: 25.0 * adiabatic },
            heat: Heat::default(),
            i_accepted: 0.0,
            peak: 0.0,
            blown_at: None,
        }
    }

    fn conductance(&self, gmin: f64) -> f64 {
        if self.blown_at.is_some() { gmin } else { 1.0 / self.r }
    }
}

impl Element for Fuse {
    fn kind(&self) -> &'static str {
        "fuse"
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        // Blown, it is open — held into the matrix by gmin like any open part, so
        // whatever it was feeding is left floating rather than singular.
        sys.add_conductance(node_index(self.p), node_index(self.m), self.conductance(ctx.gmin));
        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        sys.add_admittance(
            node_index(self.p),
            node_index(self.m),
            C64::real(self.conductance(ctx.gmin)),
        );
    }

    /// The same trapezoid over accepted timepoints the LED's burn-out uses, so a
    /// spike the solver barely spent time at does not count as a long one.
    fn accept(&mut self, ctx: &AcceptCtx) {
        let current = self.current(ctx.x).unwrap_or(0.0).abs();
        if self.blown_at.is_none() && ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            self.peak = self.peak.max(current);
            let rated = self.rated * self.rated;
            let load = (self.i_accepted * self.i_accepted + current * current) / 2.0 / rated;
            self.heat.advance(&self.thermal, load, ctx.dt);
            if self.heat.level() >= 1.0 {
                self.blown_at = Some(ctx.time);
            }
        }
        self.i_accepted = current;
    }

    fn max_timestep(&self, ctx: &AcceptCtx) -> f64 {
        // Land on the moment it opens instead of integrating across it, and while
        // it is heating, keep the step short enough that the heat it has left to
        // take is not overshot by much.
        match self.blown_at {
            Some(at) if ctx.time <= at => 1e-9,
            Some(_) => f64::INFINITY,
            None => {
                let load = (self.i_accepted / self.rated).powi(2);
                self.heat.max_step(&self.thermal, load)
            }
        }
    }

    fn reset(&mut self) {
        self.heat = Heat::default();
        self.i_accepted = 0.0;
        self.peak = 0.0;
        self.blown_at = None;
    }

    fn failure(&self) -> Option<Failure> {
        Some(Failure {
            name: self.name.clone(),
            time: self.blown_at?,
            peak: self.peak,
            rated: self.rated,
        })
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        if self.blown_at.is_some() {
            return Some(0.0);
        }
        let vp = node_index(self.p).map_or(0.0, |i| x[i]);
        let vm = node_index(self.m).map_or(0.0, |i| x[i]);
        Some((vp - vm) / self.r)
    }
}

/// Two magnetically coupled windings: a transformer, or a coupled pair of
/// inductors.
///
/// Each winding is an inductor whose flux also links the other, by the mutual
/// inductance `M = k·√(L1·L2)`:
///
/// ```text
/// v1 = r1·i1 + L1·di1/dt + M·di2/dt
/// v2 = r2·i2 + M·di1/dt  + L2·di2/dt
/// ```
///
/// A turns ratio `n` is `√(L2/L1)`, which is how the editor specifies one. The
/// coupling stays below one: at exactly one the inductance matrix is singular and
/// the windings stop being two equations.
#[derive(Debug, Clone)]
pub struct Transformer {
    pub name: String,
    pub p1: NodeId,
    pub m1: NodeId,
    pub p2: NodeId,
    pub m2: NodeId,
    pub l1: f64,
    pub l2: f64,
    /// Coupling coefficient, 0 to just under 1.
    pub k: f64,
    /// Winding resistances.
    pub r1: f64,
    pub r2: f64,
    branch: usize,
    i_prev: [f64; 2],
    v_prev: [f64; 2],
    flux: Trace,
}

impl Transformer {
    pub fn new(
        name: impl Into<String>,
        (p1, m1): (NodeId, NodeId),
        (p2, m2): (NodeId, NodeId),
        (l1, l2): (f64, f64),
        k: f64,
    ) -> Self {
        Self {
            name: name.into(),
            p1,
            m1,
            p2,
            m2,
            l1: l1.abs().max(1e-15),
            l2: l2.abs().max(1e-15),
            k: k.clamp(0.0, 0.999_999),
            r1: 0.0,
            r2: 0.0,
            branch: 0,
            i_prev: [0.0; 2],
            v_prev: [0.0; 2],
            flux: Trace::default(),
        }
    }

    /// Resistance of each winding's copper.
    pub fn with_resistance(mut self, r1: f64, r2: f64) -> Self {
        self.r1 = r1.max(0.0);
        self.r2 = r2.max(0.0);
        self
    }

    fn mutual(&self) -> f64 {
        self.k * (self.l1 * self.l2).sqrt()
    }

    fn inductances(&self) -> [[f64; 2]; 2] {
        [[self.l1, self.mutual()], [self.mutual(), self.l2]]
    }

    fn windings(&self) -> [(Option<usize>, Option<usize>, usize); 2] {
        [
            (node_index(self.p1), node_index(self.m1), self.branch),
            (node_index(self.p2), node_index(self.m2), self.branch + 1),
        ]
    }
}

impl Element for Transformer {
    fn kind(&self) -> &'static str {
        "transformer"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_reactive(&self) -> bool {
        true
    }
    fn extra_unknowns(&self) -> usize {
        2
    }
    fn bind(&mut self, first_extra_index: usize) {
        self.branch = first_extra_index;
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let windings = self.windings();
        let l = self.inductances();
        let r = [self.r1, self.r2];
        for (w, &(p, m, k)) in windings.iter().enumerate() {
            let k = Some(k);
            // Each winding's current enters one node and leaves the other, and
            // its row says what the voltage across the winding is.
            sys.add(p, k, 1.0);
            sys.add(m, k, -1.0);
            match ctx.mode {
                // At DC the windings are their resistances and nothing more.
                Mode::OperatingPoint => {
                    sys.add(k, p, 1.0);
                    sys.add(k, m, -1.0);
                    sys.add(k, k, -r[w]);
                }
                // Before the run starts nothing has built up any flux.
                Mode::InitialConditions => sys.add(k, k, 1.0),
                Mode::Transient => {
                    sys.add(k, p, 1.0);
                    sys.add(k, m, -1.0);
                    sys.add(k, k, -r[w]);
                    let scale = match ctx.integration {
                        Integration::BackwardEuler => 1.0 / ctx.dt,
                        Integration::Trapezoidal => 2.0 / ctx.dt,
                    };
                    let mut hist = 0.0;
                    for (j, &(_, _, kj)) in windings.iter().enumerate() {
                        sys.add(k, Some(kj), -scale * l[w][j]);
                        hist -= scale * l[w][j] * self.i_prev[j];
                    }
                    if ctx.integration == Integration::Trapezoidal {
                        // The trapezoid averages the two ends of the step, so the
                        // inductive drop at the start comes out of the history.
                        hist -= self.v_prev[w] - r[w] * self.i_prev[w];
                    }
                    sys.add_rhs(k, hist);
                }
            }
        }
        StampReport::CLEAN
    }

    fn accept(&mut self, ctx: &AcceptCtx) {
        let [(_, _, k1), (_, _, k2)] = self.windings();
        self.i_prev = [ctx.unknown(k1), ctx.unknown(k2)];
        self.v_prev = [
            ctx.voltage(self.p1) - ctx.voltage(self.m1),
            ctx.voltage(self.p2) - ctx.voltage(self.m2),
        ];
        self.flux.push(ctx.time, self.l1 * self.i_prev[0] + self.mutual() * self.i_prev[1]);
    }

    fn reset(&mut self) {
        self.i_prev = [0.0; 2];
        self.v_prev = [0.0; 2];
        self.flux = Trace::default();
    }

    fn max_timestep(&self, _ctx: &AcceptCtx) -> f64 {
        self.flux.suggested_step()
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        let windings = self.windings();
        let l = self.inductances();
        let r = [self.r1, self.r2];
        for (w, &(p, m, k)) in windings.iter().enumerate() {
            let k = Some(k);
            sys.add(p, k, C64::ONE);
            sys.add(m, k, -C64::ONE);
            sys.add(k, p, C64::ONE);
            sys.add(k, m, -C64::ONE);
            sys.add(k, k, C64::real(-r[w]));
            for (j, &(_, _, kj)) in windings.iter().enumerate() {
                sys.add(k, Some(kj), -C64::imaginary(ctx.omega * l[w][j]));
            }
        }
    }

    /// The secondary's current, reported at its first terminal.
    fn terminal_names(&self) -> &'static [&'static str] {
        &["s"]
    }

    fn terminal_currents(&self, x: &[f64], out: &mut Vec<f64>) {
        out.push(x.get(self.branch + 1).copied().unwrap_or(0.0));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        x.get(self.branch).copied()
    }
}
