//! Nonlinear semiconductor devices: diode, BJT and MOSFET.
//!
//! Each device linearizes itself around the current Newton iterate: it computes
//! its terminal currents and the partial derivatives of those currents (the small
//! signal conductances), then stamps a conductance plus a correction current. Do
//! that repeatedly and Newton converges on the true nonlinear operating point.
//!
//! Every exponential junction runs through `limit_junction` first. Without it a
//! single overshooting iterate produces `exp(500)` and the solve dies.

use crate::complex::{C64, ComplexSystem};
use crate::element::{
    AcCtx, AcceptCtx, Element, Integration, Mode, NodeId, StampCtx, StampReport, critical_voltage,
    limit_junction, node_index,
};
use crate::linalg::LinearSystem;
use serde::{Deserialize, Serialize};

/// Boltzmann's constant over the elementary charge, in V/K.
const K_OVER_Q: f64 = 8.617_333_262e-5;

/// Thermal voltage `kT/q` at a given temperature in kelvin.
#[inline]
pub fn thermal_voltage(temp_k: f64) -> f64 {
    K_OVER_Q * temp_k.max(1.0)
}

/// Room temperature, 27 °C, the SPICE default.
pub const TNOM: f64 = 300.15;

fn default_vj() -> f64 {
    1.0
}

fn default_grading() -> f64 {
    0.5
}

/// Where the depletion capacitance stops being evaluated and starts being
/// extrapolated, as a fraction of the junction potential.
///
/// SPICE's `FC`. The exact expression runs away as the bias approaches `vj`, and
/// a capacitance that goes to infinity is worse than one that is slightly wrong,
/// so past this point it continues along its own tangent.
const FORWARD_CAP_LIMIT: f64 = 0.5;

/// Current at which a diode's breakdown voltage is defined, amps.
///
/// SPICE's `IBV`, and one milliamp is its default. `bv` is the reverse voltage at
/// *this* current, which is how a zener is specified — not the point where the
/// curve first lifts off the axis.
const BREAKDOWN_KNEE: f64 = 1e-3;

/// `exp` with the argument clamped, so a stray iterate cannot produce infinity
/// even if limiting is bypassed.
#[inline]
fn safe_exp(x: f64) -> f64 {
    x.min(80.0).exp()
}

// ---------------------------------------------------------------------------
// Diode
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DiodeModel {
    /// Saturation current, amps.
    pub is: f64,
    /// Emission coefficient.
    pub n: f64,
    /// Reverse breakdown voltage as a positive number. `None` disables breakdown,
    /// which is what you want for a rectifier and not for a zener.
    pub bv: Option<f64>,
    /// Temperature in kelvin.
    pub temp: f64,
    /// Zero-bias junction capacitance, farads.
    ///
    /// Charge stored in the depletion region. It is what stops a diode turning
    /// off the instant the voltage across it reverses: the stored charge has to
    /// go somewhere first, and until it does the device conducts backwards.
    #[serde(default)]
    pub cj0: f64,
    /// Junction potential, volts. The knee the depletion capacitance climbs to.
    #[serde(default = "default_vj")]
    pub vj: f64,
    /// Grading coefficient. A half for an abrupt junction, a third for a graded one.
    #[serde(default = "default_grading")]
    pub m: f64,
    /// Transit time, seconds — the diffusion charge carried while conducting.
    #[serde(default)]
    pub tt: f64,
    /// Continuous forward current the part is rated for, amps.
    ///
    /// `None` makes it indestructible, which is the right default: a rating is a
    /// datasheet number the caller has to supply, and inventing one would put
    /// parts out of action in circuits that never asked for the behaviour.
    #[serde(default)]
    pub rated: Option<f64>,
}

impl Default for DiodeModel {
    fn default() -> Self {
        // Roughly a 1N4148.
        Self {
            is: 2.52e-9,
            n: 1.752,
            bv: None,
            cj0: 4e-12,
            vj: default_vj(),
            m: default_grading(),
            tt: 5e-9,
            temp: TNOM,
            rated: None,
        }
    }
}

/// How long a steady current of exactly twice the rating takes to destroy a part.
///
/// Everything else follows from it. The dose needed is `rated × BURN_TIME`, so a
/// current of `k` times the rating gets there in `BURN_TIME / (k − 1)`: ten times
/// rated kills in about a tenth of a millisecond, a hundred times in ten
/// microseconds, and anything at or below the rating never does.
///
/// The number is chosen so that both of the cases that matter come out right — a
/// brief pulse well over the rating survives, which is how a multiplexed display
/// works, while the classic mistake of leaving out the series resistor fails fast
/// enough to watch happen.
pub const BURN_TIME: f64 = 1e-3;

/// A part that did not survive the run.
#[derive(Debug, Clone, PartialEq)]
pub struct Failure {
    pub name: String,
    /// Simulated time at which it failed.
    pub time: f64,
    /// Largest forward current it reached before then.
    pub peak: f64,
    /// What it was rated for.
    pub rated: f64,
}

impl DiodeModel {
    /// An LED with the given forward voltage at `rated` amps.
    ///
    /// Inverting `vf = n·Vt·ln(i/is)` for the saturation current is what lets a
    /// caller specify the part the way a datasheet does. An emission coefficient
    /// of 2 puts the slope at about 120 mV per decade of current, which is where
    /// a real indicator LED sits.
    pub fn led(vf: f64, rated: f64) -> Self {
        let n = 2.0;
        let is = rated * (-vf / (n * thermal_voltage(TNOM))).exp();
        Self { is, n, bv: None, tt: 0.0, ..Self::default() }.with_rating(rated)
    }

    /// A zener with the given breakdown voltage.
    pub fn zener(bv: f64) -> Self {
        Self { bv: Some(bv.abs()), ..Self::default() }
    }

    fn with_rating(mut self, rated: f64) -> Self {
        self.rated = Some(rated);
        self
    }
}

#[derive(Debug, Clone)]
pub struct Diode {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub model: DiodeModel,
    v_prev_iter: f64,
    /// Small-signal conductance at the operating point, kept for AC analysis.
    gd_op: f64,
    /// Junction capacitance at the operating point, likewise.
    cd_op: f64,
    /// Voltage and capacitive current at the last accepted timepoint.
    v_prev: f64,
    ic_prev: f64,
    /// Accumulated overcurrent in amp-seconds. Only tracked with a rating.
    dose: f64,
    /// Forward current at the last accepted timepoint, for the trapezoid.
    i_accepted: f64,
    /// Largest forward current reached before failing.
    peak: f64,
    /// When the part failed, if it did. Once set, it stamps as an open circuit.
    blown_at: Option<f64>,
}

impl Diode {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, model: DiodeModel) -> Self {
        Self {
            name: name.into(),
            p,
            m,
            model,
            v_prev_iter: 0.0,
            gd_op: 0.0,
            cd_op: 0.0,
            v_prev: 0.0,
            ic_prev: 0.0,
            dose: 0.0,
            i_accepted: 0.0,
            peak: 0.0,
            blown_at: None,
        }
    }

    /// How this part failed, or `None` if it came through the run intact.
    pub fn failure(&self) -> Option<Failure> {
        Some(Failure {
            name: self.name.clone(),
            time: self.blown_at?,
            peak: self.peak,
            rated: self.model.rated.unwrap_or(0.0),
        })
    }

    /// Charge storage at a given junction voltage, as a capacitance.
    ///
    /// Two parts, and which one matters depends on the bias. Reverse or lightly
    /// forward, it is the depletion region widening and narrowing. Conducting, it
    /// is the carriers in transit, which is `tt` times the small-signal
    /// conductance and swamps the other by orders of magnitude — that is the term
    /// that gives a rectifier its reverse recovery.
    fn capacitance(&self, vd: f64, gd: f64) -> f64 {
        let m = &self.model;
        let depletion = if vd < FORWARD_CAP_LIMIT * m.vj {
            m.cj0 * (1.0 - vd / m.vj).powf(-m.m)
        } else {
            // Continued along the tangent at the limit rather than followed into
            // its own singularity.
            let f = (1.0 - FORWARD_CAP_LIMIT).powf(-m.m);
            let slope = m.m * f / (m.vj * (1.0 - FORWARD_CAP_LIMIT));
            m.cj0 * (f + slope * (vd - FORWARD_CAP_LIMIT * m.vj))
        };
        depletion + m.tt * gd
    }

    /// Current and conductance at a given junction voltage.
    fn evaluate(&self, vd: f64) -> (f64, f64) {
        let vt = thermal_voltage(self.model.temp) * self.model.n;
        // One expression covers both directions: in reverse the exponential
        // decays to zero, leaving the leakage current `-is` and a conductance
        // that tends to zero, which is exactly the physics. gmin, added by the
        // caller, is what keeps the node from floating.
        let e = safe_exp(vd / vt);
        let (mut id, mut gd) = (self.model.is * (e - 1.0), self.model.is * e / vt);

        if let Some(bv) = self.model.bv
            && vd < -bv
        {
            // Breakdown is a second exponential mirrored about -bv, anchored so
            // that the current through it is exactly `BREAKDOWN_KNEE` at -bv.
            //
            // Anchoring it on the saturation current instead — which is what this
            // did first — makes `bv` the foot of the curve rather than a working
            // voltage, and the two are far apart: a part declared as 5.1 V then
            // regulated at 5.8 V once it was carrying a normal 13 mA. A datasheet
            // quotes the voltage at a test current, so that is what `bv` means.
            let e = safe_exp(-(bv + vd) / vt);
            id -= BREAKDOWN_KNEE * e;
            gd += BREAKDOWN_KNEE * e / vt;
        }
        (id, gd)
    }
}

impl Element for Diode {
    fn kind(&self) -> &'static str {
        "diode"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_nonlinear(&self) -> bool {
        true
    }
    fn is_reactive(&self) -> bool {
        // Both, which the element interface allows and nothing else here uses: a
        // junction is a nonlinear resistor and a nonlinear capacitor at once.
        true
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        if self.blown_at.is_some() {
            // The junction is gone: what is left conducts nothing. Not literally
            // nothing, though — gmin holds the nodes it was bridging into the
            // matrix, exactly as it does for a reverse-biased junction, so a part
            // failing cannot leave a node floating and the solve singular.
            self.gd_op = ctx.gmin;
            self.v_prev_iter = 0.0;
            sys.add_conductance(node_index(self.p), node_index(self.m), ctx.gmin);
            return StampReport::CLEAN;
        }

        let vt = thermal_voltage(self.model.temp) * self.model.n;
        let vcrit = critical_voltage(self.model.is, vt);

        let raw = ctx.voltage(self.p) - ctx.voltage(self.m);
        let (vd, limited) = if ctx.iteration == 0 {
            // Start every timepoint from the last converged junction voltage rather
            // than from whatever the linear predictor produced.
            (self.v_prev_iter, false)
        } else {
            limit_junction(raw, self.v_prev_iter, vt, vcrit)
        };
        self.v_prev_iter = vd;

        let (id, gd) = self.evaluate(vd);
        let gd = gd + ctx.gmin;
        self.gd_op = gd;

        // The stored charge, as a conductance and a history current. Only in the
        // time domain: an operating point is where nothing is changing, so a
        // capacitance has nothing to say about it.
        let cd = self.capacitance(vd, gd);
        self.cd_op = cd;
        let (gc, ic_eq) = if ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            match ctx.integration {
                Integration::BackwardEuler => {
                    let g = cd / ctx.dt;
                    (g, g * self.v_prev)
                }
                Integration::Trapezoidal => {
                    let g = 2.0 * cd / ctx.dt;
                    (g, g * self.v_prev + self.ic_prev)
                }
            }
        } else {
            (0.0, 0.0)
        };

        let ieq = id - gd * vd - ic_eq;

        let (p, m) = (node_index(self.p), node_index(self.m));
        sys.add_conductance(p, m, gd + gc);
        sys.add_current(p, m, ieq);

        if limited { StampReport::LIMITED } else { StampReport::CLEAN }
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        // A forward-biased junction is a small resistance, a reverse-biased one is
        // effectively open, and either way it stores charge. All three fall out of
        // what the operating point already computed.
        sys.add_admittance(
            node_index(self.p),
            node_index(self.m),
            C64::new(self.gd_op.max(ctx.gmin), ctx.omega * self.cd_op),
        );
    }

    /// Accumulate the overcurrent this timepoint is worth, and fail if it is enough.
    ///
    /// A dose rather than a threshold, because whether an overcurrent destroys a
    /// part depends on how long it lasts as much as on how large it is. Integrated
    /// with the trapezoid between accepted timepoints: the timestep is adaptive, so
    /// weighting one sample across the whole step that follows it would let a spike
    /// the circuit spent almost no time at destroy something that was never in
    /// danger.
    ///
    /// Only accepted timepoints get here, so a step the solver tried and threw away
    /// contributes nothing.
    fn accept(&mut self, ctx: &AcceptCtx) {
        let current = self.current(ctx.x).unwrap_or(0.0);

        if let Some(rated) = self.model.rated
            && self.blown_at.is_none()
            && ctx.mode == Mode::Transient
            && ctx.dt > 0.0
            && rated > 0.0
        {
            self.peak = self.peak.max(current);
            let before = (self.i_accepted - rated).max(0.0);
            let after = (current - rated).max(0.0);
            self.dose += (before + after) / 2.0 * ctx.dt;
            if self.dose >= rated * BURN_TIME {
                self.blown_at = Some(ctx.time);
            }
        }

        self.i_accepted = current;

        // Roll the capacitive branch forward, the way any reactive element does.
        let vd = ctx.voltage(self.p) - ctx.voltage(self.m);
        if ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            let (_, gd) = self.evaluate(vd);
            let cd = self.capacitance(vd, gd + 1e-12);
            let geq = match ctx.integration {
                Integration::BackwardEuler => cd / ctx.dt,
                Integration::Trapezoidal => 2.0 * cd / ctx.dt,
            };
            let ieq = match ctx.integration {
                Integration::BackwardEuler => geq * self.v_prev,
                Integration::Trapezoidal => geq * self.v_prev + self.ic_prev,
            };
            self.ic_prev = geq * vd - ieq;
        }
        self.v_prev = vd;
    }

    fn max_timestep(&self, ctx: &AcceptCtx) -> f64 {
        // The step out of a failure crosses a discontinuity: whatever the part was
        // carrying goes to nothing between one timepoint and the next. Take that
        // one step short so the solver lands on the edge instead of integrating
        // across it and smearing the jump over a wide interval.
        match self.blown_at {
            Some(at) if ctx.time <= at => BURN_TIME * 1e-3,
            _ => f64::INFINITY,
        }
    }

    fn reset(&mut self) {
        self.v_prev_iter = 0.0;
        self.gd_op = 0.0;
        self.cd_op = 0.0;
        self.v_prev = 0.0;
        self.ic_prev = 0.0;
        self.dose = 0.0;
        self.i_accepted = 0.0;
        self.peak = 0.0;
        self.blown_at = None;
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        if self.blown_at.is_some() {
            return Some(0.0);
        }
        let vp = node_index(self.p).map_or(0.0, |i| x[i]);
        let vm = node_index(self.m).map_or(0.0, |i| x[i]);
        // Both branches. The charge leaving a junction that has just been reversed
        // is most of what flows through it for that moment, and reporting only the
        // conduction term hid reverse recovery from every probe and every trace
        // while the solver was modelling it perfectly well.
        //
        // `i_prev` is this timepoint's, not the last one's: elements are accepted
        // before the point is recorded.
        Some(self.evaluate(vp - vm).0 + self.ic_prev)
    }
}

// ---------------------------------------------------------------------------
// MOSFET, Shichman-Hodges (SPICE level 1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    N,
    P,
}

impl Channel {
    /// +1 for n-channel, -1 for p-channel. Every terminal voltage and the drain
    /// current are multiplied by this, so one set of equations covers both.
    #[inline]
    fn sign(self) -> f64 {
        match self {
            Channel::N => 1.0,
            Channel::P => -1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MosfetModel {
    pub channel: Channel,
    /// Threshold voltage, always given as a positive magnitude.
    pub vto: f64,
    /// Transconductance parameter `mu * Cox`, A/V².
    pub kp: f64,
    /// Channel length modulation, 1/V.
    pub lambda: f64,
    /// Channel width and length in metres; only their ratio matters at level 1.
    pub w: f64,
    pub l: f64,
}

impl Default for MosfetModel {
    fn default() -> Self {
        Self { channel: Channel::N, vto: 2.0, kp: 2e-5, lambda: 0.0, w: 100e-6, l: 10e-6 }
    }
}

impl MosfetModel {
    pub fn nmos() -> Self {
        Self::default()
    }

    pub fn pmos() -> Self {
        Self { channel: Channel::P, ..Self::default() }
    }

    #[inline]
    fn beta(&self) -> f64 {
        self.kp * (self.w / self.l.max(1e-12))
    }
}

/// Three-terminal MOSFET with the bulk tied to the source, which is how they are
/// almost always drawn on a schematic.
#[derive(Debug, Clone)]
pub struct Mosfet {
    pub name: String,
    pub d: NodeId,
    pub g: NodeId,
    pub s: NodeId,
    pub model: MosfetModel,
    /// Transconductance and output conductance at the operating point, with the
    /// terminals as they resolved there — a MOSFET is symmetric and the drain and
    /// source swap when the bias reverses.
    op_gm: f64,
    op_gds: f64,
    op_drain: NodeId,
    op_source: NodeId,
}

/// Drain current and its derivatives, all in n-channel normalized form.
struct MosOp {
    ids: f64,
    gm: f64,
    gds: f64,
}

impl Mosfet {
    pub fn new(
        name: impl Into<String>,
        d: NodeId,
        g: NodeId,
        s: NodeId,
        model: MosfetModel,
    ) -> Self {
        Self {
            name: name.into(),
            d,
            g,
            s,
            model,
            op_gm: 0.0,
            op_gds: 0.0,
            op_drain: d,
            op_source: s,
        }
    }

    /// Evaluate with `vgs`/`vds` already normalized to the n-channel convention
    /// and `vds >= 0` (the caller handles the swapped-terminal case).
    fn evaluate(&self, vgs: f64, vds: f64) -> MosOp {
        let beta = self.model.beta();
        let lambda = self.model.lambda;
        let vgst = vgs - self.model.vto;

        if vgst <= 0.0 {
            // Cutoff. A true zero would leave the drain floating, so the caller
            // adds gmin; here the device itself contributes nothing.
            MosOp { ids: 0.0, gm: 0.0, gds: 0.0 }
        } else if vds < vgst {
            // Triode.
            let modulation = 1.0 + lambda * vds;
            let core = vgst * vds - 0.5 * vds * vds;
            MosOp {
                ids: beta * core * modulation,
                gm: beta * vds * modulation,
                gds: beta * ((vgst - vds) * modulation + core * lambda),
            }
        } else {
            // Saturation.
            let modulation = 1.0 + lambda * vds;
            MosOp {
                ids: 0.5 * beta * vgst * vgst * modulation,
                gm: beta * vgst * modulation,
                gds: 0.5 * beta * vgst * vgst * lambda,
            }
        }
    }
}

impl Element for Mosfet {
    fn kind(&self) -> &'static str {
        "mosfet"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_nonlinear(&self) -> bool {
        true
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let sign = self.model.channel.sign();
        let vd = ctx.voltage(self.d) * sign;
        let vg = ctx.voltage(self.g) * sign;
        let vs = ctx.voltage(self.s) * sign;

        // A MOSFET is symmetric: if the drain sits below the source, the roles
        // swap. Solve in the normal orientation and swap the stamp back after.
        let swapped = vd < vs;
        let (vhi, vlo) = if swapped { (vs, vd) } else { (vd, vs) };
        let op = self.evaluate(vg - vlo, vhi - vlo);

        // Map back to the real terminals.
        let (dn, sn) = if swapped { (self.s, self.d) } else { (self.d, self.s) };
        let (d, g, s) = (node_index(dn), node_index(self.g), node_index(sn));
        self.op_gm = op.gm;
        self.op_gds = op.gds;
        self.op_drain = dn;
        self.op_source = sn;

        // ids = gm*vgs + gds*vds + ieq, with vgs = vg - vs and vds = vd - vs.
        let vgs = vg - vlo;
        let vds = vhi - vlo;
        let ieq = op.ids - op.gm * vgs - op.gds * vds;

        // Row for the drain terminal (current leaving it is +ids).
        sys.add(d, g, op.gm);
        sys.add(d, s, -op.gm);
        sys.add(d, d, op.gds);
        sys.add(d, s, -op.gds);
        // Row for the source terminal (current leaving it is -ids).
        sys.add(s, g, -op.gm);
        sys.add(s, s, op.gm);
        sys.add(s, d, -op.gds);
        sys.add(s, s, op.gds);

        // The constant term flips sign with the channel type because the whole
        // problem was mirrored on the way in.
        let ieq = ieq * sign;
        sys.add_rhs(d, -ieq);
        sys.add_rhs(s, ieq);

        // Keep the drain and source tied to something even in cutoff.
        sys.add_conductance(d, s, ctx.gmin);
        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        let (d, g, s) = (node_index(self.op_drain), node_index(self.g), node_index(self.op_source));
        // The channel-type sign cancels in the derivatives: both the current and
        // the controlling voltage are mirrored, so gm and gds are the same in the
        // real frame as in the normalized one.
        let gm = C64::real(self.op_gm);
        let gds = C64::real(self.op_gds);

        sys.add(d, g, gm);
        sys.add(d, s, -gm);
        sys.add(d, d, gds);
        sys.add(d, s, -gds);
        sys.add(s, g, -gm);
        sys.add(s, s, gm);
        sys.add(s, d, -gds);
        sys.add(s, s, gds);
        sys.add_admittance(d, s, C64::real(ctx.gmin));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        let sign = self.model.channel.sign();
        let v = |n: NodeId| node_index(n).map_or(0.0, |i| x[i]) * sign;
        let (vd, vg, vs) = (v(self.d), v(self.g), v(self.s));
        let swapped = vd < vs;
        let (vhi, vlo) = if swapped { (vs, vd) } else { (vd, vs) };
        let ids = self.evaluate(vg - vlo, vhi - vlo).ids;
        Some(ids * sign * if swapped { -1.0 } else { 1.0 })
    }
}

// ---------------------------------------------------------------------------
// Bipolar junction transistor, Ebers-Moll
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Polarity {
    Npn,
    Pnp,
}

impl Polarity {
    #[inline]
    fn sign(self) -> f64 {
        match self {
            Polarity::Npn => 1.0,
            Polarity::Pnp => -1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BjtModel {
    pub polarity: Polarity,
    /// Transport saturation current.
    pub is: f64,
    /// Forward current gain.
    pub bf: f64,
    /// Reverse current gain.
    pub br: f64,
    /// Forward Early voltage, volts. `None` for none, which is a perfect device.
    ///
    /// Base-width modulation: raising the collector widens the depletion region
    /// into the base, shortening it, and more carriers cross. So the collector
    /// current is not flat against `Vce` after all — it climbs with a slope of
    /// `Ic / VAF`, and that slope *is* the output conductance.
    ///
    /// Leaving it out does not make an amplifier slightly optimistic, it makes it
    /// wrong in kind: with zero output conductance the gain of a stage into a high
    /// impedance is bounded by nothing at all.
    #[serde(default)]
    pub vaf: Option<f64>,
    pub temp: f64,
}

impl Default for BjtModel {
    fn default() -> Self {
        // Roughly a 2N3904.
        // Roughly a 2N3904. A hundred volts is where a small-signal NPN's Early
        // voltage lives, and having one by default is the point: a device with
        // none is not a simpler transistor, it is an impossible one.
        Self {
            polarity: Polarity::Npn,
            is: 6.73e-15,
            bf: 200.0,
            br: 4.0,
            vaf: Some(100.0),
            temp: TNOM,
        }
    }
}

impl BjtModel {
    pub fn npn() -> Self {
        Self::default()
    }

    pub fn pnp() -> Self {
        Self { polarity: Polarity::Pnp, ..Self::default() }
    }
}

#[derive(Debug, Clone)]
pub struct Bjt {
    pub name: String,
    pub c: NodeId,
    pub b: NodeId,
    pub e: NodeId,
    pub model: BjtModel,
    vbe_prev: f64,
    vbc_prev: f64,
    /// Small-signal conductances at the operating point: the two junction
    /// conductances and the two transport transconductances.
    op_gif: f64,
    op_gir: f64,
    op_gbe: f64,
    op_gbc: f64,
}

impl Bjt {
    pub fn new(name: impl Into<String>, c: NodeId, b: NodeId, e: NodeId, model: BjtModel) -> Self {
        Self {
            name: name.into(),
            c,
            b,
            e,
            model,
            vbe_prev: 0.0,
            vbc_prev: 0.0,
            op_gif: 0.0,
            op_gir: 0.0,
            op_gbe: 0.0,
            op_gbc: 0.0,
        }
    }
}

impl Element for Bjt {
    fn kind(&self) -> &'static str {
        "bjt"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_nonlinear(&self) -> bool {
        true
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let m = &self.model;
        let sign = m.polarity.sign();
        let vt = thermal_voltage(m.temp);
        let vcrit = critical_voltage(m.is, vt);

        let vb = ctx.voltage(self.b) * sign;
        let vc = ctx.voltage(self.c) * sign;
        let ve = ctx.voltage(self.e) * sign;

        let (vbe, lim_e, vbc, lim_c) = if ctx.iteration == 0 {
            (self.vbe_prev, false, self.vbc_prev, false)
        } else {
            let (vbe, le) = limit_junction(vb - ve, self.vbe_prev, vt, vcrit);
            let (vbc, lc) = limit_junction(vb - vc, self.vbc_prev, vt, vcrit);
            (vbe, le, vbc, lc)
        };
        self.vbe_prev = vbe;
        self.vbc_prev = vbc;

        // Forward and reverse transport currents and their conductances.
        let ef = safe_exp(vbe / vt);
        let er = safe_exp(vbc / vt);
        let i_f = m.is * (ef - 1.0);
        let i_r = m.is * (er - 1.0);
        let gif = m.is * ef / vt;
        let gir = m.is * er / vt;

        // Base-width modulation. Gummel-Poon's base charge factor with high-level
        // injection left out, which is the term that matters here: the transport
        // current is divided by `qb`, and `1/qb` grows as the collector rises.
        //
        // Clamped away from zero because the factor goes through it in hard
        // saturation, where the model has nothing useful to say anyway and an
        // unclamped value would flip the sign of the transport current.
        let (early, d_early) = match m.vaf {
            Some(vaf) if vaf > 0.0 => ((1.0 - vbc / vaf).max(0.01), -1.0 / vaf),
            _ => (1.0, 0.0),
        };
        let ict = i_f - i_r;
        // d(ict * early)/d(vbe) and −d(ict * early)/d(vbc).
        let gif = gif * early;
        let gir = gir * early - ict * d_early;

        // Base recombination currents.
        let ibe = i_f / m.bf;
        let ibc = i_r / m.br;
        let gbe = gif / m.bf + ctx.gmin;
        let gbc = gir / m.br + ctx.gmin;

        self.op_gif = gif;
        self.op_gir = gir;
        self.op_gbe = gbe;
        self.op_gbc = gbc;

        let ic = ict * early - ibc;
        let ib = ibe + ibc;

        // Linearized: ic = gif*vbe - (gir+gbc)*vbc + iceq
        //             ib = gbe*vbe + gbc*vbc      + ibeq
        let g_cc = gir + gbc;
        let iceq = ic - gif * vbe + g_cc * vbc;
        let ibeq = ib - gbe * vbe - gbc * vbc;

        let (cn, bn, en) = (node_index(self.c), node_index(self.b), node_index(self.e));

        // Collector row: vbe = vb - ve, vbc = vb - vc.
        sys.add(cn, bn, gif - g_cc);
        sys.add(cn, en, -gif);
        sys.add(cn, cn, g_cc);
        // Base row.
        sys.add(bn, bn, gbe + gbc);
        sys.add(bn, en, -gbe);
        sys.add(bn, cn, -gbc);
        // Emitter row is the negated sum of the other two, since the terminal
        // currents must add to zero.
        sys.add(en, bn, -(gif - gir + gbe));
        sys.add(en, en, gif + gbe);
        sys.add(en, cn, -gir);

        let (iceq, ibeq) = (iceq * sign, ibeq * sign);
        sys.add_rhs(cn, -iceq);
        sys.add_rhs(bn, -ibeq);
        sys.add_rhs(en, iceq + ibeq);

        if lim_e || lim_c { StampReport::LIMITED } else { StampReport::CLEAN }
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        let (cn, bn, en) = (node_index(self.c), node_index(self.b), node_index(self.e));
        // The same rows as the DC stamp, without the constant terms: a small
        // signal has no operating point of its own to correct for.
        let g_cc = C64::real(self.op_gir + self.op_gbc);
        let gif = C64::real(self.op_gif);
        let gir = C64::real(self.op_gir);
        let gbe = C64::real(self.op_gbe);
        let gbc = C64::real(self.op_gbc);

        sys.add(cn, bn, gif - g_cc);
        sys.add(cn, en, -gif);
        sys.add(cn, cn, g_cc);

        sys.add(bn, bn, gbe + gbc);
        sys.add(bn, en, -gbe);
        sys.add(bn, cn, -gbc);

        sys.add(en, bn, -(gif - gir + gbe));
        sys.add(en, en, gif + gbe);
        sys.add(en, cn, -gir);
    }

    fn reset(&mut self) {
        self.vbe_prev = 0.0;
        self.vbc_prev = 0.0;
        self.op_gif = 0.0;
        self.op_gir = 0.0;
        self.op_gbe = 0.0;
        self.op_gbc = 0.0;
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        let m = &self.model;
        let sign = m.polarity.sign();
        let vt = thermal_voltage(m.temp);
        let v = |n: NodeId| node_index(n).map_or(0.0, |i| x[i]) * sign;
        let (vbe, vbc) = (v(self.b) - v(self.e), v(self.b) - v(self.c));
        let i_f = m.is * (safe_exp(vbe / vt) - 1.0);
        let i_r = m.is * (safe_exp(vbc / vt) - 1.0);
        Some(((i_f - i_r) - i_r / m.br) * sign)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diode_conducts_forward_and_blocks_reverse() {
        let d = Diode::new("D1", 1, 0, DiodeModel::default());
        let (i_fwd, g_fwd) = d.evaluate(0.7);
        let (i_rev, _) = d.evaluate(-5.0);
        assert!(i_fwd > 1e-3, "expected forward conduction, got {i_fwd}");
        assert!(g_fwd > 0.0);
        assert!(i_rev.abs() < 1e-6, "reverse leakage should be tiny, got {i_rev}");
    }

    #[test]
    fn zener_breaks_down_past_its_rating() {
        let d = Diode::new("D1", 1, 0, DiodeModel::zener(5.1));
        let (i_below, _) = d.evaluate(-4.0);
        let (i_past, _) = d.evaluate(-6.0);
        assert!(i_below.abs() < 1e-6);
        assert!(i_past < -1e-4, "expected breakdown current, got {i_past}");
    }

    #[test]
    fn mosfet_moves_through_its_three_regions() {
        let m = Mosfet::new("M1", 1, 2, 0, MosfetModel { vto: 2.0, ..MosfetModel::nmos() });
        let cutoff = m.evaluate(1.0, 5.0);
        let triode = m.evaluate(5.0, 0.5);
        let saturation = m.evaluate(5.0, 5.0);
        assert_eq!(cutoff.ids, 0.0);
        assert!(triode.ids > 0.0 && triode.gds > 0.0, "triode should be resistive");
        assert!(saturation.ids > triode.ids);
        // Without channel length modulation, saturation current is flat in vds.
        assert!(saturation.gds.abs() < 1e-15);
    }

    #[test]
    fn mosfet_saturation_current_matches_the_closed_form() {
        let model = MosfetModel {
            vto: 1.0,
            kp: 1e-4,
            lambda: 0.0,
            w: 1e-5,
            l: 1e-6,
            ..MosfetModel::nmos()
        };
        let m = Mosfet::new("M1", 1, 2, 0, model);
        let op = m.evaluate(3.0, 5.0);
        // beta/2 * (vgs-vto)^2 = (1e-4 * 10)/2 * 4 = 2e-3
        assert!((op.ids - 2e-3).abs() < 1e-12, "got {}", op.ids);
    }

    #[test]
    fn thermal_voltage_is_about_26mv_at_room_temperature() {
        let vt = thermal_voltage(TNOM);
        assert!((vt - 0.02586).abs() < 1e-4, "got {vt}");
    }
}
