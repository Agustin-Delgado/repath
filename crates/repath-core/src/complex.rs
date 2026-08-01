//! Complex arithmetic and a complex linear solver, for frequency-domain analysis.
//!
//! Kept deliberately small: AC analysis needs the four operations, a magnitude,
//! a phase, and Gaussian elimination. Pulling in a numerics crate for that would
//! be more dependency than value.

use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

/// A complex number, `re + im·j`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct C64 {
    pub re: f64,
    pub im: f64,
}

impl C64 {
    pub const ZERO: Self = Self { re: 0.0, im: 0.0 };
    pub const ONE: Self = Self { re: 1.0, im: 0.0 };
    /// The imaginary unit.
    pub const J: Self = Self { re: 0.0, im: 1.0 };

    #[inline]
    pub const fn new(re: f64, im: f64) -> Self {
        Self { re, im }
    }

    #[inline]
    pub const fn real(re: f64) -> Self {
        Self { re, im: 0.0 }
    }

    #[inline]
    pub const fn imaginary(im: f64) -> Self {
        Self { re: 0.0, im }
    }

    /// Magnitude, computed with `hypot` so it does not overflow on the way.
    #[inline]
    pub fn abs(self) -> f64 {
        self.re.hypot(self.im)
    }

    /// Squared magnitude — cheaper when only comparing.
    #[inline]
    pub fn norm_squared(self) -> f64 {
        self.re * self.re + self.im * self.im
    }

    /// Phase in radians, in `(-π, π]`.
    #[inline]
    pub fn arg(self) -> f64 {
        self.im.atan2(self.re)
    }

    #[inline]
    pub fn conj(self) -> Self {
        Self { re: self.re, im: -self.im }
    }

    #[inline]
    pub fn is_finite(self) -> bool {
        self.re.is_finite() && self.im.is_finite()
    }
}

impl From<f64> for C64 {
    fn from(value: f64) -> Self {
        Self::real(value)
    }
}

impl Add for C64 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        Self { re: self.re + rhs.re, im: self.im + rhs.im }
    }
}

impl Sub for C64 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        Self { re: self.re - rhs.re, im: self.im - rhs.im }
    }
}

impl Mul for C64 {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self {
        Self { re: self.re * rhs.re - self.im * rhs.im, im: self.re * rhs.im + self.im * rhs.re }
    }
}

impl Div for C64 {
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self {
        let d = rhs.norm_squared();
        if d == 0.0 {
            return Self { re: f64::NAN, im: f64::NAN };
        }
        Self {
            re: (self.re * rhs.re + self.im * rhs.im) / d,
            im: (self.im * rhs.re - self.re * rhs.im) / d,
        }
    }
}

impl Neg for C64 {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        Self { re: -self.re, im: -self.im }
    }
}

impl AddAssign for C64 {
    #[inline]
    fn add_assign(&mut self, rhs: Self) {
        self.re += rhs.re;
        self.im += rhs.im;
    }
}

impl SubAssign for C64 {
    #[inline]
    fn sub_assign(&mut self, rhs: Self) {
        self.re -= rhs.re;
        self.im -= rhs.im;
    }
}

/// A dense complex system `A x = b`, stamped the same way as the real one.
#[derive(Clone, Debug)]
pub struct ComplexSystem {
    n: usize,
    a: Vec<C64>,
    b: Vec<C64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SingularMatrix {
    pub row: usize,
}

impl ComplexSystem {
    pub fn new(n: usize) -> Self {
        Self { n, a: vec![C64::ZERO; n * n], b: vec![C64::ZERO; n] }
    }

    #[inline]
    pub fn size(&self) -> usize {
        self.n
    }

    pub fn clear(&mut self) {
        self.a.fill(C64::ZERO);
        self.b.fill(C64::ZERO);
    }

    /// `A[row][col] += value`, with `None` meaning ground and being dropped.
    #[inline]
    pub fn add(&mut self, row: Option<usize>, col: Option<usize>, value: C64) {
        if let (Some(r), Some(c)) = (row, col) {
            self.a[r * self.n + c] += value;
        }
    }

    #[inline]
    pub fn add_rhs(&mut self, row: Option<usize>, value: C64) {
        if let Some(r) = row {
            self.b[r] += value;
        }
    }

    /// Stamp an admittance between two nodes — the usual four-entry pattern.
    #[inline]
    pub fn add_admittance(&mut self, p: Option<usize>, m: Option<usize>, y: C64) {
        self.add(p, p, y);
        self.add(m, m, y);
        self.add(p, m, -y);
        self.add(m, p, -y);
    }

    /// A current of `i` flowing out of node `p` and into node `m`.
    #[inline]
    pub fn add_current(&mut self, p: Option<usize>, m: Option<usize>, i: C64) {
        self.add_rhs(p, -i);
        self.add_rhs(m, i);
    }

    /// Gaussian elimination with partial pivoting. Consumes the matrix.
    pub fn solve_into(&mut self, x: &mut Vec<C64>) -> Result<(), SingularMatrix> {
        let n = self.n;
        x.clear();
        x.resize(n, C64::ZERO);
        if n == 0 {
            return Ok(());
        }

        for k in 0..n {
            let (mut pivot_row, mut pivot_mag) = (k, self.a[k * n + k].norm_squared());
            for r in (k + 1)..n {
                let mag = self.a[r * n + k].norm_squared();
                if mag > pivot_mag {
                    pivot_row = r;
                    pivot_mag = mag;
                }
            }
            if pivot_mag < 1e-40 {
                return Err(SingularMatrix { row: k });
            }
            if pivot_row != k {
                for c in 0..n {
                    self.a.swap(k * n + c, pivot_row * n + c);
                }
                self.b.swap(k, pivot_row);
            }

            let pivot = self.a[k * n + k];
            for r in (k + 1)..n {
                let factor = self.a[r * n + k] / pivot;
                if factor == C64::ZERO {
                    continue;
                }
                for c in (k + 1)..n {
                    let update = factor * self.a[k * n + c];
                    self.a[r * n + c] -= update;
                }
                let update = factor * self.b[k];
                self.b[r] -= update;
            }
        }

        for r in (0..n).rev() {
            let row = &self.a[r * n + r + 1..r * n + n];
            let dot = row.iter().zip(&x[r + 1..]).fold(C64::ZERO, |acc, (a, xc)| acc + *a * *xc);
            x[r] = (self.b[r] - dot) / self.a[r * n + r];
        }

        if x.iter().any(|v| !v.is_finite()) {
            return Err(SingularMatrix { row: 0 });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic_matches_the_definitions() {
        let a = C64::new(3.0, 4.0);
        let b = C64::new(1.0, -2.0);

        assert_eq!(a + b, C64::new(4.0, 2.0));
        assert_eq!(a - b, C64::new(2.0, 6.0));
        // (3+4j)(1-2j) = 3 - 6j + 4j + 8 = 11 - 2j
        assert_eq!(a * b, C64::new(11.0, -2.0));
        assert_eq!(a.abs(), 5.0);
    }

    #[test]
    fn division_inverts_multiplication() {
        let a = C64::new(3.0, 4.0);
        let b = C64::new(-2.0, 7.0);
        let q = (a * b) / b;
        assert!((q.re - a.re).abs() < 1e-12);
        assert!((q.im - a.im).abs() < 1e-12);
    }

    #[test]
    fn j_squared_is_minus_one() {
        assert_eq!(C64::J * C64::J, C64::real(-1.0));
    }

    #[test]
    fn solves_a_complex_system() {
        // [1+j, 2; 3, 4-j] x = [5; 6]
        let mut sys = ComplexSystem::new(2);
        sys.add(Some(0), Some(0), C64::new(1.0, 1.0));
        sys.add(Some(0), Some(1), C64::real(2.0));
        sys.add(Some(1), Some(0), C64::real(3.0));
        sys.add(Some(1), Some(1), C64::new(4.0, -1.0));
        sys.add_rhs(Some(0), C64::real(5.0));
        sys.add_rhs(Some(1), C64::real(6.0));

        let mut x = Vec::new();
        sys.solve_into(&mut x).unwrap();

        // Substitute back rather than hard-coding an answer worked out by hand.
        let r0 = C64::new(1.0, 1.0) * x[0] + C64::real(2.0) * x[1];
        let r1 = C64::real(3.0) * x[0] + C64::new(4.0, -1.0) * x[1];
        assert!((r0 - C64::real(5.0)).abs() < 1e-12);
        assert!((r1 - C64::real(6.0)).abs() < 1e-12);
    }

    #[test]
    fn reports_a_singular_complex_matrix() {
        let mut sys = ComplexSystem::new(2);
        sys.add(Some(0), Some(0), C64::ONE);
        sys.add(Some(0), Some(1), C64::ONE);
        sys.add(Some(1), Some(0), C64::ONE);
        sys.add(Some(1), Some(1), C64::ONE);
        let mut x = Vec::new();
        assert!(sys.solve_into(&mut x).is_err());
    }

    #[test]
    fn a_capacitor_admittance_leads_by_ninety_degrees() {
        // Y = jωC has a phase of exactly +90 degrees.
        let y = C64::imaginary(2.0 * std::f64::consts::PI * 1000.0 * 1e-6);
        assert!((y.arg() - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
    }
}
