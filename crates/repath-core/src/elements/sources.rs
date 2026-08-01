//! Independent and controlled sources.
//!
//! Waveforms report their own *breakpoints* — the instants where the signal is
//! not differentiable, like the corners of a pulse. The transient loop lands
//! exactly on those instants instead of stepping over them, which is the
//! difference between a clean square wave and one with rounded, jittery edges.

use crate::element::{AcceptCtx, Element, NodeId, StampCtx, StampReport, node_index};
use crate::linalg::LinearSystem;
use serde::{Deserialize, Serialize};

/// A time-varying stimulus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Waveform {
    Dc {
        value: f64,
    },
    Sine {
        offset: f64,
        amplitude: f64,
        frequency: f64,
        #[serde(default)]
        delay: f64,
        /// Exponential decay in 1/s. Zero for a steady sine.
        #[serde(default)]
        damping: f64,
        /// Phase offset in degrees.
        #[serde(default)]
        phase: f64,
    },
    Pulse {
        v1: f64,
        v2: f64,
        #[serde(default)]
        delay: f64,
        rise: f64,
        fall: f64,
        width: f64,
        /// Zero or negative means a single, non-repeating pulse.
        #[serde(default)]
        period: f64,
    },
    /// Piecewise linear, held flat outside the given range.
    Pwl {
        points: Vec<(f64, f64)>,
    },
}

impl Default for Waveform {
    fn default() -> Self {
        Waveform::Dc { value: 0.0 }
    }
}

impl Waveform {
    pub fn value(&self, t: f64) -> f64 {
        match self {
            Waveform::Dc { value } => *value,
            Waveform::Sine { offset, amplitude, frequency, delay, damping, phase } => {
                if t < *delay {
                    return *offset + amplitude * (phase.to_radians()).sin();
                }
                let td = t - delay;
                let envelope = if *damping != 0.0 { (-damping * td).exp() } else { 1.0 };
                offset
                    + amplitude
                        * envelope
                        * (std::f64::consts::TAU * frequency * td + phase.to_radians()).sin()
            }
            Waveform::Pulse { v1, v2, delay, rise, fall, width, period } => {
                if t < *delay {
                    return *v1;
                }
                let mut td = t - delay;
                if *period > 0.0 {
                    td %= period;
                }
                let (rise, fall) = (rise.max(0.0), fall.max(0.0));
                if td < rise {
                    lerp(*v1, *v2, td / rise.max(f64::MIN_POSITIVE))
                } else if td < rise + width {
                    *v2
                } else if td < rise + width + fall {
                    lerp(*v2, *v1, (td - rise - width) / fall.max(f64::MIN_POSITIVE))
                } else {
                    *v1
                }
            }
            Waveform::Pwl { points } => {
                if points.is_empty() {
                    return 0.0;
                }
                if t <= points[0].0 {
                    return points[0].1;
                }
                for w in points.windows(2) {
                    let ((t0, v0), (t1, v1)) = (w[0], w[1]);
                    if t <= t1 {
                        let span = t1 - t0;
                        return if span <= 0.0 { v1 } else { lerp(v0, v1, (t - t0) / span) };
                    }
                }
                points[points.len() - 1].1
            }
        }
    }

    /// The first instant strictly after `t` where this waveform has a corner.
    pub fn next_breakpoint(&self, t: f64) -> Option<f64> {
        const EPS: f64 = 1e-15;
        match self {
            Waveform::Dc { .. } => None,
            Waveform::Sine { delay, .. } => (*delay > t + EPS).then_some(*delay),
            Waveform::Pulse { delay, rise, fall, width, period, .. } => {
                let corners = [0.0, *rise, rise + width, rise + width + fall];
                if *period > 0.0 {
                    let cycles = ((t - delay) / period).floor().max(0.0);
                    // Check this cycle and the next so we never miss a wrap-around.
                    (0..=1)
                        .flat_map(|k| {
                            let base = delay + (cycles + k as f64) * period;
                            corners.iter().map(move |c| base + c)
                        })
                        .filter(|bp| *bp > t + EPS)
                        .fold(None::<f64>, |acc, bp| Some(acc.map_or(bp, |a: f64| a.min(bp))))
                } else {
                    corners
                        .iter()
                        .map(|c| delay + c)
                        .filter(|bp| *bp > t + EPS)
                        .fold(None::<f64>, |acc, bp| Some(acc.map_or(bp, |a: f64| a.min(bp))))
                }
            }
            Waveform::Pwl { points } => points.iter().map(|(pt, _)| *pt).find(|pt| *pt > t + EPS),
        }
    }

    /// Largest step that still resolves this waveform's shape, starting from `t`.
    ///
    /// This is deliberately time-dependent. A pulse with a 1 ps rise time only
    /// needs picosecond steps *during* that 1 ps; forcing them across a
    /// millisecond of flat top would be a hundred million wasted steps. Landing
    /// on the edge in the first place is [`Self::next_breakpoint`]'s job.
    pub fn max_timestep(&self, t: f64) -> f64 {
        match self {
            Waveform::Dc { .. } | Waveform::Pwl { .. } => f64::INFINITY,
            // Roughly 50 points per cycle keeps a sine visually and numerically clean.
            Waveform::Sine { frequency, .. } if *frequency > 0.0 => 1.0 / (50.0 * frequency),
            Waveform::Sine { .. } => f64::INFINITY,
            Waveform::Pulse { delay, rise, fall, width, period, .. } => {
                if t < *delay {
                    return f64::INFINITY;
                }
                let mut td = t - delay;
                if *period > 0.0 {
                    td %= period;
                }
                if *rise > 0.0 && td < *rise {
                    rise / 4.0
                } else if *fall > 0.0 && td >= rise + width && td < rise + width + fall {
                    fall / 4.0
                } else {
                    f64::INFINITY
                }
            }
        }
    }
}

#[inline]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

/// An ideal voltage source. Voltage-defined, so it adds a branch current unknown.
#[derive(Debug, Clone)]
pub struct VoltageSource {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub waveform: Waveform,
    branch: usize,
}

impl VoltageSource {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, waveform: Waveform) -> Self {
        Self { name: name.into(), p, m, waveform, branch: 0 }
    }

    pub fn dc(name: impl Into<String>, p: NodeId, m: NodeId, v: f64) -> Self {
        Self::new(name, p, m, Waveform::Dc { value: v })
    }

    pub fn branch_index(&self) -> usize {
        self.branch
    }
}

impl Element for VoltageSource {
    fn kind(&self) -> &'static str {
        "voltage_source"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn extra_unknowns(&self) -> usize {
        1
    }
    fn bind(&mut self, first_extra_index: usize) {
        self.branch = first_extra_index;
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let (p, m, k) = (node_index(self.p), node_index(self.m), Some(self.branch));
        sys.add(p, k, 1.0);
        sys.add(m, k, -1.0);
        sys.add(k, p, 1.0);
        sys.add(k, m, -1.0);
        sys.add_rhs(k, self.waveform.value(ctx.time) * ctx.source_scale);
        StampReport::CLEAN
    }

    fn max_timestep(&self, ctx: &AcceptCtx) -> f64 {
        self.waveform.max_timestep(ctx.time)
    }

    fn next_breakpoint(&self, t: f64) -> Option<f64> {
        self.waveform.next_breakpoint(t)
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        x.get(self.branch).copied()
    }
}

/// An ideal current source. Positive current flows from `p` to `m` inside the
/// source, matching the SPICE sign convention.
#[derive(Debug, Clone)]
pub struct CurrentSource {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub waveform: Waveform,
    /// Value last stamped. A current source has no branch unknown to read the
    /// answer back from, so it remembers what it injected.
    last: f64,
}

impl CurrentSource {
    pub fn new(name: impl Into<String>, p: NodeId, m: NodeId, waveform: Waveform) -> Self {
        Self { name: name.into(), p, m, waveform, last: 0.0 }
    }
}

impl Element for CurrentSource {
    fn kind(&self) -> &'static str {
        "current_source"
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let i = self.waveform.value(ctx.time) * ctx.source_scale;
        self.last = i;
        sys.add_current(node_index(self.p), node_index(self.m), i);
        StampReport::CLEAN
    }

    fn max_timestep(&self, ctx: &AcceptCtx) -> f64 {
        self.waveform.max_timestep(ctx.time)
    }

    fn next_breakpoint(&self, t: f64) -> Option<f64> {
        self.waveform.next_breakpoint(t)
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        let _ = x;
        Some(self.last)
    }

    fn reset(&mut self) {
        self.last = 0.0;
    }
}

/// Voltage-controlled voltage source (SPICE `E`): `v(p,m) = gain * v(cp, cm)`.
#[derive(Debug, Clone)]
pub struct Vcvs {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub cp: NodeId,
    pub cm: NodeId,
    pub gain: f64,
    branch: usize,
}

impl Vcvs {
    pub fn new(
        name: impl Into<String>,
        p: NodeId,
        m: NodeId,
        cp: NodeId,
        cm: NodeId,
        gain: f64,
    ) -> Self {
        Self { name: name.into(), p, m, cp, cm, gain, branch: 0 }
    }
}

impl Element for Vcvs {
    fn kind(&self) -> &'static str {
        "vcvs"
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn extra_unknowns(&self) -> usize {
        1
    }
    fn bind(&mut self, first_extra_index: usize) {
        self.branch = first_extra_index;
    }

    fn stamp(&mut self, sys: &mut LinearSystem, _ctx: &StampCtx) -> StampReport {
        let (p, m, k) = (node_index(self.p), node_index(self.m), Some(self.branch));
        let (cp, cm) = (node_index(self.cp), node_index(self.cm));
        sys.add(p, k, 1.0);
        sys.add(m, k, -1.0);
        sys.add(k, p, 1.0);
        sys.add(k, m, -1.0);
        sys.add(k, cp, -self.gain);
        sys.add(k, cm, self.gain);
        StampReport::CLEAN
    }

    fn current(&self, x: &[f64]) -> Option<f64> {
        x.get(self.branch).copied()
    }
}

/// Voltage-controlled current source (SPICE `G`): `i(p->m) = gm * v(cp, cm)`.
#[derive(Debug, Clone)]
pub struct Vccs {
    pub name: String,
    pub p: NodeId,
    pub m: NodeId,
    pub cp: NodeId,
    pub cm: NodeId,
    pub gm: f64,
}

impl Vccs {
    pub fn new(
        name: impl Into<String>,
        p: NodeId,
        m: NodeId,
        cp: NodeId,
        cm: NodeId,
        gm: f64,
    ) -> Self {
        Self { name: name.into(), p, m, cp, cm, gm }
    }
}

impl Element for Vccs {
    fn kind(&self) -> &'static str {
        "vccs"
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&mut self, sys: &mut LinearSystem, _ctx: &StampCtx) -> StampReport {
        let (p, m) = (node_index(self.p), node_index(self.m));
        let (cp, cm) = (node_index(self.cp), node_index(self.cm));
        sys.add(p, cp, self.gm);
        sys.add(p, cm, -self.gm);
        sys.add(m, cp, -self.gm);
        sys.add(m, cm, self.gm);
        StampReport::CLEAN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulse_walks_through_its_corners() {
        let w = Waveform::Pulse {
            v1: 0.0,
            v2: 5.0,
            delay: 1e-6,
            rise: 1e-9,
            fall: 1e-9,
            width: 2e-6,
            period: 5e-6,
        };
        assert_eq!(w.value(0.0), 0.0);
        assert_eq!(w.value(5e-7), 0.0);
        assert!((w.value(1e-6 + 5e-10) - 2.5).abs() < 1e-9, "midpoint of the rising edge");
        assert_eq!(w.value(2e-6), 5.0);
        assert_eq!(w.value(4e-6), 0.0);
        // Second period repeats.
        assert!((w.value(6e-6 + 100e-9) - 5.0).abs() < 1e-12);
    }

    #[test]
    fn pulse_reports_the_next_corner() {
        let w = Waveform::Pulse {
            v1: 0.0,
            v2: 5.0,
            delay: 1e-6,
            rise: 1e-9,
            fall: 1e-9,
            width: 2e-6,
            period: 5e-6,
        };
        assert_eq!(w.next_breakpoint(0.0), Some(1e-6));
        assert_eq!(w.next_breakpoint(1e-6), Some(1e-6 + 1e-9));
        // Crossing into the next period must still produce a corner ahead of us.
        let bp = w.next_breakpoint(4.5e-6).unwrap();
        assert!(bp > 4.5e-6 && bp <= 6e-6, "got {bp}");
    }

    #[test]
    fn sine_starts_at_its_phase() {
        let w = Waveform::Sine {
            offset: 0.0,
            amplitude: 1.0,
            frequency: 1000.0,
            delay: 0.0,
            damping: 0.0,
            phase: 90.0,
        };
        assert!((w.value(0.0) - 1.0).abs() < 1e-12);
        assert!((w.value(1.0 / 4000.0)).abs() < 1e-9);
    }

    #[test]
    fn sine_limits_the_step_to_resolve_a_cycle() {
        let w = Waveform::Sine {
            offset: 0.0,
            amplitude: 1.0,
            frequency: 1e6,
            delay: 0.0,
            damping: 0.0,
            phase: 0.0,
        };
        assert!((w.max_timestep(0.0) - 2e-8).abs() < 1e-20);
    }

    #[test]
    fn pulse_only_demands_small_steps_on_its_edges() {
        let w = Waveform::Pulse {
            v1: 0.0,
            v2: 5.0,
            delay: 0.0,
            rise: 1e-12,
            fall: 1e-12,
            width: 1e-3,
            period: 0.0,
        };
        // Inside the 1 ps rising edge, steps must be picoseconds.
        assert!(w.max_timestep(0.0) <= 1e-12);
        // On the millisecond flat top, the waveform has no opinion at all. Taking
        // 1 ps steps across that would be a billion pointless timepoints.
        assert!(w.max_timestep(0.5e-3).is_infinite());
        assert!(w.max_timestep(2e-3).is_infinite());
        // And small again on the way down. The fall starts at rise + width,
        // so the edge spans 1e-3 + 1e-12 to 1e-3 + 2e-12.
        assert!(w.max_timestep(1e-3 + 1.5e-12) <= 1e-12);
    }

    #[test]
    fn pwl_interpolates_and_holds() {
        let w = Waveform::Pwl { points: vec![(0.0, 0.0), (1.0, 10.0), (2.0, 10.0)] };
        assert_eq!(w.value(-1.0), 0.0);
        assert!((w.value(0.5) - 5.0).abs() < 1e-12);
        assert_eq!(w.value(99.0), 10.0);
        assert_eq!(w.next_breakpoint(0.5), Some(1.0));
    }
}
