//! Op-amps and voltage-controlled switches.
//!
//! Both saturate, and both use `tanh` to do it. A hard clamp has a discontinuous
//! derivative exactly where the circuit spends its time, which makes Newton
//! oscillate between the two sides of the corner forever. A `tanh` is smooth
//! everywhere, so the Jacobian never lies, and with a high enough gain the
//! difference from an ideal clamp is microvolts.

use crate::complex::{C64, ComplexSystem};
use crate::element::{AcCtx, Element, NodeId, StampCtx, StampReport, node_index};
use crate::linalg::LinearSystem;
use serde::{Deserialize, Serialize};

/// A single-ended op-amp with finite gain and rail saturation.
#[derive(Debug, Clone)]
pub struct OpAmp {
    pub name: String,
    pub out: NodeId,
    /// Non-inverting input.
    pub np: NodeId,
    /// Inverting input.
    pub nn: NodeId,
    /// Open-loop DC gain.
    pub gain: f64,
    pub vmax: f64,
    pub vmin: f64,
    /// Differential gain at the operating point. Near zero once the output is
    /// against a rail, which is exactly right: a saturated op-amp passes no
    /// signal, and AC analysis should say so.
    op_gain: f64,
    branch: usize,
}

impl OpAmp {
    pub fn new(name: impl Into<String>, out: NodeId, np: NodeId, nn: NodeId) -> Self {
        Self {
            name: name.into(),
            out,
            np,
            nn,
            gain: 1e5,
            vmax: 15.0,
            vmin: -15.0,
            op_gain: 1e5,
            branch: 0,
        }
    }

    pub fn with_rails(mut self, vmin: f64, vmax: f64) -> Self {
        self.vmin = vmin;
        self.vmax = vmax;
        self
    }

    pub fn with_gain(mut self, gain: f64) -> Self {
        self.gain = gain.max(1.0);
        self
    }

    /// Output voltage and its derivative with respect to the differential input.
    fn transfer(&self, vd: f64) -> (f64, f64) {
        let mid = 0.5 * (self.vmax + self.vmin);
        let span = 0.5 * (self.vmax - self.vmin).abs().max(1e-9);
        let t = (self.gain * vd / span).tanh();
        (mid + span * t, self.gain * (1.0 - t * t))
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
    fn extra_unknowns(&self) -> usize {
        1
    }
    fn bind(&mut self, first_extra_index: usize) {
        self.branch = first_extra_index;
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let vd = ctx.voltage(self.np) - ctx.voltage(self.nn);
        let (vout, a) = self.transfer(vd);
        self.op_gain = a;

        let (out, np, nn, k) =
            (node_index(self.out), node_index(self.np), node_index(self.nn), Some(self.branch));

        // The branch current leaves the output node.
        sys.add(out, k, 1.0);
        // v(out) - a*(v(np) - v(nn)) = vout - a*vd
        sys.add(k, out, 1.0);
        sys.add(k, np, -a);
        sys.add(k, nn, a);
        sys.add_rhs(k, vout - a * vd);

        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        let (out, np, nn, k) =
            (node_index(self.out), node_index(self.np), node_index(self.nn), Some(self.branch));
        sys.add(out, k, C64::ONE);
        sys.add(k, out, C64::ONE);
        sys.add(k, np, C64::real(-self.op_gain));
        sys.add(k, nn, C64::real(self.op_gain));
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        x.get(self.branch).copied()
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
    fn opamp_saturates_at_the_rails() {
        let a = OpAmp::new("U1", 3, 1, 2).with_rails(-12.0, 12.0);
        let (hi, dhi) = a.transfer(1.0);
        let (lo, _) = a.transfer(-1.0);
        assert!((hi - 12.0).abs() < 1e-6, "got {hi}");
        assert!((lo + 12.0).abs() < 1e-6, "got {lo}");
        // Deep in saturation the gain must fall to zero, or Newton keeps pushing.
        assert!(dhi < 1e-6, "got {dhi}");
    }

    #[test]
    fn opamp_is_linear_near_zero() {
        let a = OpAmp::new("U1", 3, 1, 2).with_gain(1e5).with_rails(-15.0, 15.0);
        let (v, d) = a.transfer(1e-6);
        assert!((v - 0.1).abs() < 1e-3, "got {v}");
        assert!((d - 1e5).abs() / 1e5 < 1e-3, "gain should be near open loop, got {d}");
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
