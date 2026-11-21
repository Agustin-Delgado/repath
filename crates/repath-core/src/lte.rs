//! Local truncation error estimation for adaptive timestepping.
//!
//! Reactive elements record their charge (capacitors) or flux (inductors) at each
//! accepted timepoint. The third divided difference of that history approximates
//! the third derivative, which is what the trapezoidal rule's error term depends
//! on. Elements that are changing fast ask for small steps; elements sitting still
//! ask for nothing, and the solver takes the tightest request.
//!
//! This is what makes a simulator feel fast: a 1 ms RC settle followed by a 1 ns
//! logic edge should not cost the same number of steps per second in both regions.

use crate::element::Integration;

/// Tolerances governing step acceptance. Defaults follow Berkeley SPICE.
#[derive(Debug, Clone, Copy)]
pub struct Tolerances {
    /// Relative tolerance on charges and voltages.
    pub reltol: f64,
    /// Absolute floor for charge comparisons, in coulombs.
    pub chgtol: f64,
    /// Absolute floor for voltage comparisons, in volts.
    pub vntol: f64,
    /// Absolute floor for current comparisons, in amps.
    pub abstol: f64,
    /// Fraction of the estimated error budget a step is allowed to consume.
    pub trtol: f64,
}

impl Default for Tolerances {
    fn default() -> Self {
        Self { reltol: 1e-3, chgtol: 1e-14, vntol: 1e-6, abstol: 1e-12, trtol: 7.0 }
    }
}

/// Rolling window of the last four accepted `(time, value)` samples.
#[derive(Debug, Clone)]
pub struct Trace {
    t: [f64; 4],
    v: [f64; 4],
    filled: usize,
    tol: Tolerances,
}

impl Default for Trace {
    fn default() -> Self {
        Self { t: [0.0; 4], v: [0.0; 4], filled: 0, tol: Tolerances::default() }
    }
}

impl Trace {
    pub fn with_tolerances(tol: Tolerances) -> Self {
        Self { tol, ..Default::default() }
    }

    /// Record an accepted sample. Index 0 is always the most recent.
    pub fn push(&mut self, time: f64, value: f64) {
        self.t.rotate_right(1);
        self.v.rotate_right(1);
        self.t[0] = time;
        self.v[0] = value;
        self.filled = (self.filled + 1).min(4);
    }

    /// Newton divided difference of order `k` over the `k + 1` most recent
    /// samples, with the bound rounding puts on it: `None` while fewer samples
    /// than that have been accepted, or when two of them share an instant.
    ///
    /// The bound is the exact one. A divided difference is a weighted sum of
    /// the samples, weight `1/∏(tᵢ − tⱼ)` on each, so an error of a few units
    /// in the last place on every sample moves it by that much times the sum
    /// of the weights' sizes. Judging that by the shortest spacing cubed, as
    /// this once did, called genuine curvature noise whenever one short step
    /// sat in a window of long ones, and the trace then had no opinion for
    /// three steps.
    fn divided_difference(&self, k: usize) -> Option<(f64, f64)> {
        if self.filled < k + 1 {
            return None;
        }
        let mut value = 0.0;
        let mut weights = 0.0;
        for i in 0..=k {
            let mut den = 1.0;
            for j in 0..=k {
                if j != i {
                    den *= self.t[i] - self.t[j];
                }
            }
            if den.abs() < f64::MIN_POSITIVE || !den.is_finite() {
                return None;
            }
            value += self.v[i] / den;
            weights += 1.0 / den.abs();
        }
        let scale = self.v[..=k].iter().fold(0.0f64, |a, v| a.max(v.abs()));
        Some((value, 8.0 * f64::EPSILON * scale.max(self.tol.chgtol) * weights))
    }

    /// Third Newton divided difference over the stored window, or `None` while
    /// fewer than four points have been accepted.
    pub fn third_divided_difference(&self) -> Option<f64> {
        self.divided_difference(3).map(|(value, _)| value)
    }

    /// Largest next step this signal tolerates under the trapezoidal rule, or
    /// `INFINITY` when it has no opinion (not enough history, or the signal is
    /// not actually curving).
    pub fn suggested_step(&self) -> f64 {
        self.suggested_step_for(Integration::Trapezoidal)
    }

    /// Largest next step this signal tolerates under `integration`.
    ///
    /// Each rule's error has its own term. The trapezoidal rule is second order
    /// and its error grows with dt³ times the third derivative; backward Euler
    /// is first order and its error grows with dt² times the second, and that
    /// error is not a wobble but a loss: an oscillator stepped by it gives up a
    /// share (ω·dt)² of its energy every step. Sizing a backward Euler step by
    /// the trapezoidal rule's term let it take steps a quarter of a period long,
    /// and a tank started that way kept an eighth of its amplitude.
    ///
    /// The trapezoidal estimate keeps SPICE's `trtol`, which exists because the
    /// divided difference overstates that rule's error; backward Euler's error
    /// is exactly what it says, and gets no such allowance.
    pub fn suggested_step_for(&self, integration: Integration) -> f64 {
        let (order, allowance) = match integration {
            Integration::Trapezoidal => (3, self.tol.trtol),
            Integration::BackwardEuler => (2, 1.0),
        };
        let Some((dd, noise)) = self.divided_difference(order) else {
            return f64::INFINITY;
        };
        // Below the rounding floor the number is noise rather than curvature,
        // and steering the timestep by it would collapse the step on a perfectly
        // straight signal.
        if !dd.is_finite() || dd.abs() <= noise {
            return f64::INFINITY;
        }
        let scale = self.v[..=order].iter().fold(0.0f64, |a, v| a.max(v.abs()));
        let tol = self.tol.reltol * scale + self.tol.chgtol;
        let step = (allowance * tol) / dd.abs();
        if order == 3 { step.cbrt() } else { step.sqrt() }
    }

    /// Most recent sample, if any.
    pub fn last(&self) -> Option<(f64, f64)> {
        (self.filled > 0).then(|| (self.t[0], self.v[0]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_opinion_without_enough_history() {
        let mut tr = Trace::default();
        tr.push(0.0, 0.0);
        tr.push(1e-6, 1.0);
        assert!(tr.suggested_step().is_infinite());
    }

    #[test]
    fn a_straight_line_has_no_third_derivative() {
        let mut tr = Trace::default();
        for k in 0..4 {
            let t = k as f64 * 1e-6;
            tr.push(t, 3.0 * t);
        }
        // dd3 of a linear signal is zero, so any step is fine.
        assert!(tr.suggested_step() > 1.0);
    }

    #[test]
    fn a_sharply_curving_signal_asks_for_small_steps() {
        let mut calm = Trace::default();
        let mut sharp = Trace::default();
        for k in 0..4 {
            let t = k as f64 * 1e-6;
            calm.push(t, 1e-9 * t);
            // A cubic has a constant, large third divided difference.
            sharp.push(t, (t / 1e-6).powi(3) * 1e-9);
        }
        assert!(sharp.suggested_step() < calm.suggested_step());
        assert!(sharp.suggested_step().is_finite());
    }

    /// A 1 µs RC decay of charge sampled at 0, 0.5 µs, 1 µs and then a sliver
    /// later, the way a step clipped at a breakpoint leaves it. The curvature
    /// is real, q''' = -q₀/τ³·e^(-t/τ), and the step the trapezoidal rule's
    /// error allows from it is cbrt(trtol·tol / |q'''/6|).
    #[test]
    fn one_short_step_in_the_window_does_not_hide_real_curvature() {
        let (q0, tau) = (1e-6, 1e-6);
        let q = |t: f64| q0 * (-t / tau).exp();
        for sliver in [10e-12, 1e-9] {
            let mut tr = Trace::default();
            for t in [0.0, 0.5e-6, 1e-6, 1e-6 + sliver] {
                tr.push(t, q(t));
            }
            let step = tr.suggested_step();
            let tol = Tolerances::default();
            let third = q0 / tau.powi(3) * (-0.5e-6 / tau).exp() / 6.0;
            let scale = q(0.0);
            let expected = (tol.trtol * (tol.reltol * scale + tol.chgtol) / third).cbrt();
            assert!(
                step.is_finite() && (step / expected - 1.0).abs() < 0.5,
                "a {sliver} s sliver: {step} s, the curvature says {expected} s"
            );
        }
    }

    /// Backward Euler's step is set by the second derivative. On a sampled
    /// cosine of angular frequency ω, q'' = -ω²q, and the step it allows is
    /// sqrt(tol / |q''/2|): a few hundredths of a radian, against the tenths
    /// the trapezoidal rule's estimate allows on the same samples.
    #[test]
    fn backward_euler_is_sized_by_its_own_error() {
        let w = 2.0 * std::f64::consts::PI * 5e3;
        let h = 0.01 / w;
        let mut tr = Trace::default();
        for k in 0..4 {
            let t = k as f64 * h;
            tr.push(t, 1e-6 * (w * t).cos());
        }
        let tol = Tolerances::default();
        let expected = ((tol.reltol * 1e-6 + tol.chgtol) / (w * w * 1e-6 / 2.0)).sqrt();
        let be = tr.suggested_step_for(Integration::BackwardEuler);
        assert!((be / expected - 1.0).abs() < 0.05, "{be} s, not {expected} s");
        assert!(be < tr.suggested_step_for(Integration::Trapezoidal) / 3.0);
    }

    #[test]
    fn most_recent_sample_is_first() {
        let mut tr = Trace::default();
        tr.push(1.0, 10.0);
        tr.push(2.0, 20.0);
        assert_eq!(tr.last(), Some((2.0, 20.0)));
    }
}
