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

    /// Third Newton divided difference over the stored window, or `None` while
    /// fewer than four points have been accepted.
    pub fn third_divided_difference(&self) -> Option<f64> {
        if self.filled < 4 {
            return None;
        }
        let d = |a: usize, b: usize, num: f64| {
            let den = self.t[a] - self.t[b];
            if den.abs() < f64::MIN_POSITIVE { None } else { Some(num / den) }
        };
        let d01 = d(0, 1, self.v[0] - self.v[1])?;
        let d12 = d(1, 2, self.v[1] - self.v[2])?;
        let d23 = d(2, 3, self.v[2] - self.v[3])?;
        let d012 = d(0, 2, d01 - d12)?;
        let d123 = d(1, 3, d12 - d23)?;
        d(0, 3, d012 - d123)
    }

    /// Largest next step this signal tolerates, or `INFINITY` when it has no
    /// opinion (not enough history, or the signal is not actually curving).
    pub fn suggested_step(&self) -> f64 {
        let Some(dd3) = self.third_divided_difference() else {
            return f64::INFINITY;
        };
        if !dd3.is_finite() {
            return f64::INFINITY;
        }

        let scale = self.v.iter().fold(0.0f64, |a, v| a.max(v.abs()));
        let spacing =
            (0..3).map(|i| (self.t[i] - self.t[i + 1]).abs()).fold(f64::INFINITY, f64::min);
        if spacing <= 0.0 {
            return f64::INFINITY;
        }

        // A third divided difference divides by the sample spacing three times,
        // so it amplifies rounding error by 1/h^3. Below that floor the number we
        // just computed is noise rather than curvature, and steering the timestep
        // by it would collapse the step on a perfectly straight signal.
        let noise = 8.0 * f64::EPSILON * scale.max(self.tol.chgtol) / spacing.powi(3);
        if dd3.abs() <= noise {
            return f64::INFINITY;
        }

        let tol = self.tol.reltol * scale + self.tol.chgtol;
        // Trapezoidal is second order, so the error scales with dt^3.
        ((self.tol.trtol * tol) / dd3.abs()).cbrt()
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

    #[test]
    fn most_recent_sample_is_first() {
        let mut tr = Trace::default();
        tr.push(1.0, 10.0);
        tr.push(2.0, 20.0);
        assert_eq!(tr.last(), Some((2.0, 20.0)));
    }
}
