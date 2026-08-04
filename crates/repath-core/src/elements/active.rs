//! Op-amps and voltage-controlled switches.
//!
//! Both saturate, and both use `tanh` to do it. A hard clamp has a discontinuous
//! derivative exactly where the circuit spends its time, which makes Newton
//! oscillate between the two sides of the corner forever. A `tanh` is smooth
//! everywhere, so the Jacobian never lies, and with a high enough gain the
//! difference from an ideal clamp is microvolts.

use crate::complex::{C64, ComplexSystem};
use crate::element::{
    AcCtx, AcceptCtx, Element, Integration, Mode, NodeId, StampCtx, StampReport, node_index,
};
use crate::linalg::LinearSystem;
use serde::{Deserialize, Serialize};

/// Everything about an op-amp that the first page of a datasheet tells you.
///
/// Each of these is a difference between a circuit that works here and one that
/// works on a bench, and until now every one of them was infinite or zero.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct OpAmpModel {
    /// Open-loop DC gain.
    pub gain: f64,
    /// Gain-bandwidth product, Hz.
    ///
    /// What a closed loop trades against its gain: asking a part good for a
    /// megahertz to give a hundred leaves ten kilohertz, and no amount of
    /// feedback buys it back.
    pub gbw: f64,
    /// Slew rate, volts per second.
    ///
    /// The output can only move as fast as the input stage can charge the
    /// compensation capacitor, and past that it stops following the input at all
    /// and becomes a ramp. It is why a square wave comes out with sloped edges,
    /// and why a large signal runs out of bandwidth long before a small one does.
    pub slew: f64,
    /// Output resistance, ohms. Nothing drives a load for free.
    pub r_out: f64,
    /// Input offset voltage.
    ///
    /// The two halves of the input pair are never quite matched, so an amplifier
    /// with its inputs tied together does not sit at zero — it sits at this,
    /// multiplied by whatever gain the circuit asks for.
    pub v_os: f64,
    /// Input bias current, drawn through whatever each input is connected to.
    /// The reason an integrator drifts with nothing on its input.
    pub i_bias: f64,
    pub v_max: f64,
    pub v_min: f64,
}

impl Default for OpAmpModel {
    fn default() -> Self {
        // A general-purpose bipolar part, near enough a 741.
        Self {
            gain: 1e5,
            gbw: 1e6,
            slew: 0.5e6,
            r_out: 75.0,
            v_os: 1e-3,
            i_bias: 80e-9,
            v_max: 15.0,
            v_min: -15.0,
        }
    }
}

/// Compensation capacitance the model is built around.
///
/// Arbitrary — nothing outside the part can see it. Everything else is derived
/// from it and from the datasheet numbers: the transconductance that gives the
/// stated gain-bandwidth, the load that gives the stated DC gain, and the current
/// limit that gives the stated slew rate.
const CC: f64 = 1e-9;

/// How sharply the gain node stops at a rail, in volts.
///
/// The width of the bend, and also the scale of what is past it: one more slew
/// current for every one of these volts of overshoot. Small enough that the
/// output settles within a few millivolts of the rail, wide enough that Newton
/// sees a curve rather than a corner.
const RAIL_KNEE: f64 = 5e-3;

/// `ln(1 + e^x)`: nothing for negative `x`, `x` itself for large positive `x`.
///
/// Written the long way round on the positive side because `e^x` overflows for
/// an `x` this function is otherwise perfectly happy with.
fn softplus(x: f64) -> f64 {
    if x > 0.0 { x + (-x).exp().ln_1p() } else { x.exp().ln_1p() }
}

/// Its derivative, `1 / (1 + e^-x)`.
fn logistic(x: f64) -> f64 {
    if x > 0.0 {
        1.0 / (1.0 + (-x).exp())
    } else {
        let e = x.exp();
        e / (1.0 + e)
    }
}

/// A single-ended op-amp, modelled the way a macromodel is: a transconductance
/// into a compensated gain node, and a buffer out of it.
///
/// Built this way rather than as a gain block because every limit worth having
/// falls out of the structure instead of being bolted onto it. The pole is the
/// compensation capacitor. The slew rate is the current available to charge it.
/// Saturation is the gain node meeting a rail, and coming back out of saturation
/// takes as long as it takes to discharge — which is why a real op-amp does not
/// recover the instant its input does.
#[derive(Debug, Clone)]
pub struct OpAmp {
    pub name: String,
    pub out: NodeId,
    /// Non-inverting input.
    pub np: NodeId,
    /// Inverting input.
    pub nn: NodeId,
    pub model: OpAmpModel,
    /// Transconductance and gain-node conductance at the operating point. Both
    /// collapse once the output is against a rail, which is exactly right: a
    /// saturated op-amp passes no signal, and AC analysis should say so.
    op_gm: f64,
    op_g: f64,
    /// Gain-node voltage and capacitor current at the last accepted timepoint.
    v_prev: f64,
    i_prev: f64,
    /// First extra unknown: the gain node. Second: the output branch current.
    first: usize,
}

impl OpAmp {
    pub fn new(name: impl Into<String>, out: NodeId, np: NodeId, nn: NodeId) -> Self {
        Self {
            name: name.into(),
            out,
            np,
            nn,
            model: OpAmpModel::default(),
            op_gm: 0.0,
            op_g: 0.0,
            v_prev: 0.0,
            i_prev: 0.0,
            first: 0,
        }
    }

    pub fn with_rails(mut self, v_min: f64, v_max: f64) -> Self {
        self.model.v_min = v_min;
        self.model.v_max = v_max;
        self
    }

    pub fn with_gain(mut self, gain: f64) -> Self {
        self.model.gain = gain.max(1.0);
        self
    }

    pub fn with_model(mut self, model: OpAmpModel) -> Self {
        self.model = model;
        self
    }

    /// Transconductance of the input stage: current per volt of difference, sized
    /// so that `gm / (2*pi*CC)` is the stated gain-bandwidth product.
    fn gm(&self) -> f64 {
        std::f64::consts::TAU * self.model.gbw.max(1.0) * CC
    }

    /// Load on the gain node, sized so that `gm * r` is the stated DC gain.
    fn r_gain(&self) -> f64 {
        (self.model.gain.max(1.0) / self.gm()).max(1.0)
    }

    /// Largest current the input stage will deliver, which is what limits how fast
    /// the gain node — and the output with it — can move.
    fn i_slew(&self) -> f64 {
        (self.model.slew.max(1.0) * CC).max(1e-12)
    }

    /// Current the input stage pushes into the gain node, and its slope.
    ///
    /// A `tanh` rather than a hard limit: the corner of a clamp sits exactly where
    /// a slewing amplifier spends its time, and a derivative that jumps there
    /// makes Newton hunt back and forth across it.
    fn drive(&self, vd: f64) -> (f64, f64) {
        let i_max = self.i_slew();
        let t = (self.gm() * vd / i_max).tanh();
        (i_max * t, self.gm() * (1.0 - t * t))
    }

    /// Current the rails pull out of the gain node, and its slope.
    ///
    /// Nothing at all until the node tries to leave the supply, and then a
    /// conductance that takes everything the input stage can deliver within a few
    /// millivolts. Anchored on the slew current, so the node stops at the rail
    /// however hard it is driven rather than somewhere that depends on the gain.
    ///
    /// Softplus rather than a plain exponential, and the difference is not
    /// cosmetic. An exponential has to be clamped somewhere or it overflows, and
    /// past the clamp it is flat while still reporting the slope it had on the way
    /// up — so Newton solves a tangent that says the node is already where it
    /// should be, and a saturated output stalls at a hundred kilovolts. This grows
    /// linearly instead, and its slope is the slope of what it actually does.
    fn rail(&self, v: f64) -> (f64, f64) {
        let i_max = self.i_slew();
        // Once past the rail: one more slew current for every `RAIL_KNEE` volts.
        let g = i_max / RAIL_KNEE;
        let hi = (v - self.model.v_max) / RAIL_KNEE;
        let lo = (self.model.v_min - v) / RAIL_KNEE;
        (i_max * (softplus(hi) - softplus(lo)), g * (logistic(hi) + logistic(lo)))
    }

    /// Companion conductance and history current for the compensation capacitor.
    fn companion(&self, integration: Integration, dt: f64) -> (f64, f64) {
        match integration {
            Integration::BackwardEuler => {
                let g = CC / dt;
                (g, g * self.v_prev)
            }
            Integration::Trapezoidal => {
                let g = 2.0 * CC / dt;
                (g, g * self.v_prev + self.i_prev)
            }
        }
    }
}

impl Element for OpAmp {
    fn kind(&self) -> &'static str {
        "opamp"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_nonlinear(&self) -> bool {
        true
    }
    fn is_reactive(&self) -> bool {
        // The compensation capacitor, which is the whole reason this part has a
        // bandwidth and a slew rate at all.
        true
    }
    fn extra_unknowns(&self) -> usize {
        2
    }
    fn bind(&mut self, first_extra_index: usize) {
        self.first = first_extra_index;
    }
    fn extra_unknown_name(&self, k: usize) -> Option<String> {
        // The first is a node inside the part, not a current. Calling it one puts
        // a label on a probe that is simply false.
        if k == 0 { Some("v(gain)".into()) } else { Some("i(out)".into()) }
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let m = self.model;
        let (gain_node, branch) = (Some(self.first), Some(self.first + 1));
        let (out, np, nn) = (node_index(self.out), node_index(self.np), node_index(self.nn));

        // Offset belongs on the input, because that is where it is: it is the
        // mismatch the loop has to cancel, so it comes out multiplied by whatever
        // gain the circuit was built for.
        let vd = ctx.voltage(self.np) - ctx.voltage(self.nn) + m.v_os;
        let vc = ctx.unknown(self.first);

        // ---- input stage into the gain node ------------------------------
        let (i_drive, gm) = self.drive(vd);
        let (i_rail, g_rail) = self.rail(vc);
        let g_load = 1.0 / self.r_gain();
        self.op_gm = gm;
        self.op_g = g_load + g_rail;

        // KCL at the gain node: what the load, the rails and the capacitor take
        // out of it is what the input stage puts in.
        sys.add(gain_node, gain_node, g_load + g_rail);
        sys.add(gain_node, np, -gm);
        sys.add(gain_node, nn, gm);
        // Only the *node* part of `vd` is carried by the matrix entries above, so
        // only that part comes back out here. Subtracting the whole of `vd` takes
        // the offset with it, and an amplifier that cannot amplify its own offset
        // is the ideal one this replaced.
        sys.add_rhs(gain_node, i_drive - gm * (vd - m.v_os) - (i_rail - g_rail * vc));

        // The compensation capacitor, and with it the pole and the slew rate.
        if ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            let (geq, ieq) = self.companion(ctx.integration, ctx.dt);
            sys.add(gain_node, gain_node, geq);
            sys.add_rhs(gain_node, ieq);
        }

        // ---- output buffer -----------------------------------------------
        // Unity gain behind `r_out`. The rails were applied at the gain node, so
        // there is nothing left to clamp here.
        sys.add(out, branch, 1.0);
        sys.add(branch, out, 1.0);
        sys.add(branch, gain_node, -1.0);
        sys.add(branch, branch, -m.r_out.max(1e-9));

        // ---- input bias --------------------------------------------------
        // Drawn out of whatever each input is connected to, so a source resistance
        // turns it into an offset of its own.
        if m.i_bias != 0.0 {
            sys.add_rhs(np, -m.i_bias);
            sys.add_rhs(nn, -m.i_bias);
        }

        StampReport::CLEAN
    }

    fn accept(&mut self, ctx: &AcceptCtx) {
        let v = ctx.unknown(self.first);
        if ctx.mode == Mode::Transient && ctx.dt > 0.0 {
            let (geq, ieq) = self.companion(ctx.integration, ctx.dt);
            self.i_prev = geq * v - ieq;
        }
        self.v_prev = v;
    }

    fn reset(&mut self) {
        self.op_gm = 0.0;
        self.op_g = 0.0;
        self.v_prev = 0.0;
        self.i_prev = 0.0;
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        let (gain_node, branch) = (Some(self.first), Some(self.first + 1));
        let (out, np, nn) = (node_index(self.out), node_index(self.np), node_index(self.nn));

        // The same two stages, small-signal. The capacitor is what rolls the gain
        // off; without it every op-amp circuit here kept its gain to infinity.
        sys.add(gain_node, gain_node, C64::new(self.op_g, ctx.omega * CC));
        sys.add(gain_node, np, C64::real(-self.op_gm));
        sys.add(gain_node, nn, C64::real(self.op_gm));

        sys.add(out, branch, C64::ONE);
        sys.add(branch, out, C64::ONE);
        sys.add(branch, gain_node, -C64::ONE);
        sys.add(branch, branch, C64::real(-self.model.r_out.max(1e-9)));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        x.get(self.first + 1).copied()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SwitchModel {
    /// Control voltage at which the switch is fully on.
    pub v_on: f64,
    /// Control voltage at which the switch is fully off.
    pub v_off: f64,
    pub r_on: f64,
    pub r_off: f64,
}

impl Default for SwitchModel {
    fn default() -> Self {
        Self { v_on: 1.0, v_off: 0.0, r_on: 1.0, r_off: 1e9 }
    }
}

/// A voltage-controlled switch. Also the workhorse behind digital output drivers.
#[derive(Debug, Clone)]
pub struct Switch {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub cp: NodeId,
    pub cm: NodeId,
    pub model: SwitchModel,
    /// Conductance at the operating point.
    op_g: f64,
}

impl Switch {
    pub fn new(
        name: impl Into<String>,
        p: NodeId,
        m: NodeId,
        cp: NodeId,
        cm: NodeId,
        model: SwitchModel,
    ) -> Self {
        Self { name: name.into(), p, m, cp, cm, model, op_g: 0.0 }
    }

    /// Conductance and its derivative with respect to the control voltage.
    ///
    /// Interpolation happens in log-conductance, so the transition is smooth
    /// across the nine or so decades between `r_on` and `r_off`.
    fn conductance(&self, vc: f64) -> (f64, f64) {
        let g_on = (1.0 / self.model.r_on.max(1e-9)).ln();
        let g_off = (1.0 / self.model.r_off.max(1e-9)).ln();
        let mid = 0.5 * (self.model.v_on + self.model.v_off);
        let width = ((self.model.v_on - self.model.v_off).abs() * 0.25).max(1e-6);

        let t = ((vc - mid) / width).tanh();
        let s = 0.5 * (1.0 + t);
        let ln_g = g_off + s * (g_on - g_off);
        let g = ln_g.exp();
        // d(g)/d(vc) = g * d(ln g)/d(vc)
        let dsdv = 0.5 * (1.0 - t * t) / width;
        (g, g * (g_on - g_off) * dsdv)
    }
}

impl Element for Switch {
    fn kind(&self) -> &'static str {
        "switch"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn is_nonlinear(&self) -> bool {
        true
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let vc = ctx.voltage(self.cp) - ctx.voltage(self.cm);
        let vsw = ctx.voltage(self.p) - ctx.voltage(self.m);
        let (g, dgdv) = self.conductance(vc);
        self.op_g = g;

        let (p, m) = (node_index(self.p), node_index(self.m));
        let (cp, cm) = (node_index(self.cp), node_index(self.cm));

        sys.add_conductance(p, m, g);

        // The current also depends on the control voltage, and leaving that out
        // of the Jacobian turns Newton into a slow fixed-point iteration.
        let transfer = vsw * dgdv;
        sys.add(p, cp, transfer);
        sys.add(p, cm, -transfer);
        sys.add(m, cp, -transfer);
        sys.add(m, cm, transfer);

        // Compensate the constant part so the linearization passes through the
        // actual operating point.
        let ieq = -transfer * vc;
        sys.add_current(p, m, ieq);

        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        // The control input is a bias, not a signal path: a switch being nudged
        // is not something AC analysis has anything useful to say about.
        sys.add_admittance(node_index(self.p), node_index(self.m), C64::real(self.op_g));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        let v = |n: NodeId| node_index(n).map_or(0.0, |i| x[i]);
        let g = self.conductance(v(self.cp) - v(self.cm)).0;
        Some((v(self.p) - v(self.m)) * g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_input_stage_is_a_transconductance_the_bandwidth_decides() {
        // Small signals: current per volt, sized so `gm / (2*pi*CC)` is the stated
        // gain-bandwidth. Everything else about the model hangs off this number.
        let a = OpAmp::new("U1", 3, 1, 2);
        let expected = std::f64::consts::TAU * a.model.gbw * CC;
        let (i, g) = a.drive(1e-9);
        assert!((g - expected).abs() / expected < 1e-6, "slope was {g}, expected {expected}");
        assert!((i - expected * 1e-9).abs() < 1e-18);
        // And the load it drives gives the stated DC gain.
        assert!((a.gm() * a.r_gain() - a.model.gain).abs() / a.model.gain < 1e-6);
    }

    #[test]
    fn the_input_stage_runs_out_of_current_and_that_is_the_slew_rate() {
        // Past a fraction of a millivolt the stage delivers everything it has, and
        // from there the gain node — and the output with it — can only ramp. Handed
        // a whole volt it must be flat out, with no slope left: an amplifier that is
        // slewing has no gain at all until it catches up.
        let a = OpAmp::new("U1", 3, 1, 2);
        let (i, g) = a.drive(1.0);
        assert!((i - a.i_slew()).abs() / a.i_slew() < 1e-6, "delivered {i} of {}", a.i_slew());
        assert!(g < 1e-9, "still had {g} of slope while flat out");
        // And what it can deliver comes to the slew rate the model was given.
        assert!((a.i_slew() / CC - a.model.slew).abs() / a.model.slew < 1e-9);
    }

    #[test]
    fn the_gain_node_stops_at_the_rails() {
        let a = OpAmp::new("U1", 3, 1, 2).with_rails(-12.0, 12.0);
        // Nothing at all in the middle: the clamp must not lean on the gain.
        let (mid, _) = a.rail(0.0);
        assert!(mid.abs() < 1e-12, "the clamp was drawing {mid} at zero");
        // At the rail it is already taking most of what the input stage can
        // supply, so the node balances within a few millivolts of it however hard
        // it is driven.
        let (hi, slope) = a.rail(12.0);
        assert!(hi > 0.5 * a.i_slew() && hi < a.i_slew(), "got {hi} of {}", a.i_slew());
        assert!(slope > 0.0);
        let (lo, _) = a.rail(-12.0);
        assert!((lo + hi).abs() < 1e-12, "the two rails should mirror: {lo} against {hi}");

        // And past it, it keeps growing rather than flattening off. A clamp that
        // stops rising while still claiming a slope leaves Newton solving a
        // tangent that says the node has already arrived, and a saturated output
        // stalls wherever it happened to overshoot to.
        let (far, far_slope) = a.rail(1e5);
        assert!(far > 1e3 * a.i_slew(), "the clamp gave up at {far}");
        assert!(far_slope > 0.5 * a.i_slew() / RAIL_KNEE, "and its slope with it: {far_slope}");
    }

    #[test]
    fn switch_spans_on_and_off() {
        let s = Switch::new("S1", 1, 2, 3, 0, SwitchModel::default());
        let (g_off, _) = s.conductance(-1.0);
        let (g_on, _) = s.conductance(2.0);
        assert!(g_on / g_off > 1e6, "on/off ratio too small: {g_on} vs {g_off}");
    }

    #[test]
    fn switch_derivative_matches_finite_difference() {
        let s = Switch::new("S1", 1, 2, 3, 0, SwitchModel::default());
        let vc = 0.5;
        let h = 1e-7;
        let (_, analytic) = s.conductance(vc);
        let numeric = (s.conductance(vc + h).0 - s.conductance(vc - h).0) / (2.0 * h);
        let rel = (analytic - numeric).abs() / numeric.abs().max(1e-9);
        assert!(rel < 1e-3, "analytic {analytic} vs numeric {numeric}");
    }
}
