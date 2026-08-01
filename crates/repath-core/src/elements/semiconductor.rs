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
    AcCtx, Element, NodeId, StampCtx, StampReport, critical_voltage, limit_junction, node_index,
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
}

impl Default for DiodeModel {
    fn default() -> Self {
        // Roughly a 1N4148.
        Self { is: 2.52e-9, n: 1.752, bv: None, temp: TNOM }
    }
}

impl DiodeModel {
    /// A red LED: higher forward drop, no useful breakdown region.
    pub fn led_red() -> Self {
        Self { is: 9.3e-20, n: 3.73, bv: None, temp: TNOM }
    }

    /// A zener with the given breakdown voltage.
    pub fn zener(bv: f64) -> Self {
        Self { is: 2.52e-9, n: 1.752, bv: Some(bv.abs()), temp: TNOM }
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
}

impl Diode {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, model: DiodeModel) -> Self {
        Self { name: name.into(), p, m, model, v_prev_iter: 0.0, gd_op: 0.0 }
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
            // Breakdown is modelled as a second exponential mirrored about -bv.
            let e = safe_exp(-(bv + vd) / vt);
            id -= self.model.is * e;
            gd += self.model.is * e / vt;
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

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
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
        let ieq = id - gd * vd;

        let (p, m) = (node_index(self.p), node_index(self.m));
        sys.add_conductance(p, m, gd);
        sys.add_current(p, m, ieq);

        if limited { StampReport::LIMITED } else { StampReport::CLEAN }
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, ctx: &AcCtx) {
        // A forward-biased junction is a small resistance, a reverse-biased one is
        // effectively open. Both fall out of the conductance the operating point
        // already computed.
        sys.add_admittance(
            node_index(self.p),
            node_index(self.m),
            C64::real(self.gd_op.max(ctx.gmin)),
        );
    }

    fn reset(&mut self) {
        self.v_prev_iter = 0.0;
        self.gd_op = 0.0;
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        let vp = node_index(self.p).map_or(0.0, |i| x[i]);
        let vm = node_index(self.m).map_or(0.0, |i| x[i]);
        Some(self.evaluate(vp - vm).0)
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
    pub temp: f64,
}

impl Default for BjtModel {
    fn default() -> Self {
        // Roughly a 2N3904.
        Self { polarity: Polarity::Npn, is: 6.73e-15, bf: 200.0, br: 4.0, temp: TNOM }
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

        // Base recombination currents.
        let ibe = i_f / m.bf;
        let ibc = i_r / m.br;
        let gbe = gif / m.bf + ctx.gmin;
        let gbc = gir / m.br + ctx.gmin;

        self.op_gif = gif;
        self.op_gir = gir;
        self.op_gbe = gbe;
        self.op_gbc = gbc;

        let ic = (i_f - i_r) - ibc;
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
