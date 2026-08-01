//! The contract every analog element implements.
//!
//! Nodes are numbered from 0, where 0 is always ground. Because ground is
//! eliminated from the MNA system, the matrix index of a node is simply
//! `node - 1`, and ground maps to `None` — see [`node_index`].

use crate::linalg::LinearSystem;

/// A circuit node. Node 0 is ground by definition.
pub type NodeId = usize;

/// Matrix row/column for a node, or `None` for ground.
#[inline]
pub fn node_index(node: NodeId) -> Option<usize> {
    node.checked_sub(1)
}

/// Which analysis the engine is currently running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// DC operating point: capacitors open, inductors short, time frozen at 0.
    OperatingPoint,
    /// The t=0 state of a run that skips the operating point. Every reactive
    /// element is pinned to its initial condition — a capacitor to its voltage,
    /// an inductor to its current — with zero as the default. Distinct from
    /// `OperatingPoint`, where an inductor with no initial current is a short
    /// rather than an open.
    InitialConditions,
    /// Time-domain stepping with companion models for reactive elements.
    Transient,
}

/// Numerical integration rule for reactive elements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Integration {
    /// First order, unconditionally stable, damps oscillation. Used for the first
    /// step and immediately after a discontinuity.
    BackwardEuler,
    /// Second order, no numerical damping. The default steady-state rule.
    #[default]
    Trapezoidal,
}

/// Everything an element needs to know to stamp itself for one Newton iteration.
pub struct StampCtx<'a> {
    pub mode: Mode,
    pub integration: Integration,
    /// Simulation time at the *end* of the step being solved.
    pub time: f64,
    /// Step size. Zero during the operating point.
    pub dt: f64,
    /// Conductance added from every node to ground to keep the matrix non-singular.
    pub gmin: f64,
    /// Scale factor applied to independent sources, used by source stepping.
    /// 1.0 during normal operation.
    pub source_scale: f64,
    /// The current Newton iterate. Nonlinear elements linearize around this.
    pub x: &'a [f64],
    /// Zero-based Newton iteration counter within the current timepoint.
    pub iteration: usize,
}

impl StampCtx<'_> {
    /// Voltage of a node in the current Newton iterate.
    #[inline]
    pub fn voltage(&self, node: NodeId) -> f64 {
        match node_index(node) {
            Some(i) => self.x.get(i).copied().unwrap_or(0.0),
            None => 0.0,
        }
    }

    /// Value of an extra unknown (a branch current) in the current iterate.
    #[inline]
    pub fn unknown(&self, index: usize) -> f64 {
        self.x.get(index).copied().unwrap_or(0.0)
    }
}

/// Context for rolling element state forward after a timepoint converges.
pub struct AcceptCtx<'a> {
    pub mode: Mode,
    pub integration: Integration,
    pub time: f64,
    pub dt: f64,
    pub x: &'a [f64],
}

impl AcceptCtx<'_> {
    #[inline]
    pub fn voltage(&self, node: NodeId) -> f64 {
        match node_index(node) {
            Some(i) => self.x.get(i).copied().unwrap_or(0.0),
            None => 0.0,
        }
    }

    #[inline]
    pub fn unknown(&self, index: usize) -> f64 {
        self.x.get(index).copied().unwrap_or(0.0)
    }
}

/// What an element reports back after stamping.
#[derive(Debug, Clone, Copy, Default)]
pub struct StampReport {
    /// The element clamped one of its own terminal voltages this iteration.
    /// Newton must not declare convergence while anything is still limiting,
    /// otherwise a clamped (and therefore wrong) operating point looks converged.
    pub limited: bool,
}

impl StampReport {
    pub const CLEAN: Self = Self { limited: false };
    pub const LIMITED: Self = Self { limited: true };
}

/// Lets a `Box<dyn Element>` be downcast back to its concrete type, which is how
/// the editor changes a resistor's value without rebuilding the whole circuit.
///
/// The blanket implementation means no element has to write this out.
pub trait AsAny: 'static {
    fn as_any(&self) -> &dyn std::any::Any;
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
}

impl<T: 'static> AsAny for T {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}

/// An analog circuit element.
pub trait Element: std::fmt::Debug + Send + AsAny {
    /// Short type tag, e.g. `"resistor"`. Used for diagnostics and probing.
    fn kind(&self) -> &'static str;

    /// Instance name as written by the user, e.g. `"R1"`.
    fn name(&self) -> &str;

    /// Extra unknowns (branch currents) this element adds to the MNA system.
    fn extra_unknowns(&self) -> usize {
        0
    }

    /// Called once during build with the matrix index of this element's first
    /// extra unknown. Elements with no extra unknowns can ignore it.
    fn bind(&mut self, first_extra_index: usize) {
        let _ = first_extra_index;
    }

    /// Whether this element must be re-linearized on every Newton iteration.
    fn is_nonlinear(&self) -> bool {
        false
    }

    /// Whether this element stores energy and therefore needs a companion model
    /// and history in transient analysis.
    fn is_reactive(&self) -> bool {
        false
    }

    /// Add this element's contribution to the linearized system.
    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport;

    /// Commit state after a timepoint has converged.
    fn accept(&mut self, ctx: &AcceptCtx) {
        let _ = ctx;
    }

    /// Discard all history and return to the pre-simulation state.
    fn reset(&mut self) {}

    /// Largest step this element can take from the current point without
    /// exceeding the local truncation error budget. `INFINITY` means no opinion.
    fn max_timestep(&self, ctx: &AcceptCtx) -> f64 {
        let _ = ctx;
        f64::INFINITY
    }

    /// Next instant strictly after `t` where this element is not differentiable —
    /// the corner of a pulse, a point in a piecewise-linear table. The transient
    /// loop lands exactly on these instead of stepping across them, which is the
    /// difference between a crisp square wave and a rounded, jittery one.
    fn next_breakpoint(&self, t: f64) -> Option<f64> {
        let _ = t;
        None
    }

    /// Current flowing into the first terminal, for probes. `None` if the element
    /// cannot report it cheaply.
    fn current(&self, x: &[f64]) -> Option<f64> {
        let _ = x;
        None
    }
}

/// Junction voltage limiting, the `pnjlim` routine from Berkeley SPICE.
///
/// Exponential junctions overflow instantly under a raw Newton step: one bad
/// iterate produces `exp(700)` and the whole solve turns to NaN. This damps the
/// step whenever the junction is forward biased hard, which is the single most
/// important convergence aid in any circuit simulator.
///
/// Returns the limited voltage and whether limiting actually kicked in.
pub fn limit_junction(v_new: f64, v_old: f64, vt: f64, vcrit: f64) -> (f64, bool) {
    if v_new > vcrit && (v_new - v_old).abs() > 2.0 * vt {
        if v_old > 0.0 {
            let arg = 1.0 + (v_new - v_old) / vt;
            let limited = if arg > 0.0 { v_old + vt * arg.ln() } else { vcrit };
            (limited, true)
        } else {
            (vt * (v_new / vt).max(1e-12).ln(), true)
        }
    } else {
        // Reverse bias needs no limiting at all: `exp` of a negative number
        // cannot overflow. Clamping it here would be worse than useless — the
        // clamp would report "still limiting" on every iteration, and Newton
        // would never be allowed to declare convergence on any circuit holding a
        // junction in reverse, which is most of them.
        (v_new, false)
    }
}

/// The voltage above which `limit_junction` starts damping, derived from the
/// saturation current so the limit sits near the junction's knee.
pub fn critical_voltage(is: f64, vt: f64) -> f64 {
    vt * (vt / (std::f64::consts::SQRT_2 * is.max(1e-30))).ln()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ground_maps_to_none() {
        assert_eq!(node_index(0), None);
        assert_eq!(node_index(1), Some(0));
        assert_eq!(node_index(7), Some(6));
    }

    #[test]
    fn limiting_damps_a_runaway_forward_step() {
        let vt = 0.025_852;
        let vcrit = critical_voltage(1e-14, vt);
        // Newton wants to jump to 5 V across a junction — that is exp(193).
        let (v, limited) = limit_junction(5.0, 0.6, vt, vcrit);
        assert!(limited);
        assert!(v < 1.0, "expected a damped step, got {v}");
        assert!(v > 0.6, "step should still move forward, got {v}");
    }

    #[test]
    fn reverse_bias_is_never_reported_as_limited() {
        let vt = 0.025_852;
        let vcrit = critical_voltage(1e-14, vt);
        for v in [-0.1, -1.0, -12.0, -400.0] {
            let (out, limited) = limit_junction(v, 0.0, vt, vcrit);
            assert!(!limited, "{v} V reverse must not block convergence");
            assert_eq!(out, v);
        }
    }

    #[test]
    fn limiting_leaves_small_steps_alone() {
        let vt = 0.025_852;
        let vcrit = critical_voltage(1e-14, vt);
        let (v, limited) = limit_junction(0.61, 0.60, vt, vcrit);
        assert!(!limited);
        assert_eq!(v, 0.61);
    }
}
