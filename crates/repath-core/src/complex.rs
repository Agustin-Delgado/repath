//! Complex arithmetic and the complex linear system, for frequency-domain analysis.
//!
//! Kept deliberately small: AC analysis needs the four operations, a magnitude,
//! a phase, and the same sparse elimination the real system uses. Pulling in a
//! numerics crate for that would be more dependency than value.

use crate::linalg::{Scalar, System};
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

impl Scalar for C64 {
    const ZERO: Self = Self::ZERO;
    const ONE: Self = Self::ONE;
    #[inline]
    fn magnitude(self) -> f64 {
        self.abs()
    }
    #[inline]
    fn finite(self) -> bool {
        self.is_finite()
    }
}

/// The complex system AC analysis solves: stamped the same way as the real
/// one, and solved by the same sparse code.
pub type ComplexSystem = System<C64>;

impl System<C64> {
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
