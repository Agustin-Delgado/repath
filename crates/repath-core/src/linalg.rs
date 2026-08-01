//! Dense LU decomposition with partial pivoting.
//!
//! Circuits drawn by hand rarely exceed a few hundred unknowns, and a cache-friendly
//! dense solve beats a sparse one at that size. The `Solve` boundary is kept narrow
//! so a sparse (KLU-style) backend can be swapped in when large netlists show up.

/// A dense linear system `A x = b` in row-major order.
#[derive(Clone, Debug)]
pub struct LinearSystem {
    n: usize,
    a: Vec<f64>,
    b: Vec<f64>,
    /// Scratch permutation vector reused across solves.
    perm: Vec<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolveError {
    /// The matrix is singular to working precision. In circuit terms this almost
    /// always means a floating node or a loop of ideal voltage sources.
    Singular { row: usize },
}

impl LinearSystem {
    pub fn new(n: usize) -> Self {
        Self { n, a: vec![0.0; n * n], b: vec![0.0; n], perm: (0..n).collect() }
    }

    #[inline]
    pub fn size(&self) -> usize {
        self.n
    }

    /// Zero the matrix and right-hand side, keeping the allocation.
    pub fn clear(&mut self) {
        self.a.fill(0.0);
        self.b.fill(0.0);
    }

    /// `A[row][col] += value`. `None` indices are ground and are silently dropped,
    /// which is exactly the row/column elimination that grounding a node performs.
    #[inline]
    pub fn add(&mut self, row: Option<usize>, col: Option<usize>, value: f64) {
        if let (Some(r), Some(c)) = (row, col) {
            self.a[r * self.n + c] += value;
        }
    }

    /// `b[row] += value`, dropping ground.
    #[inline]
    pub fn add_rhs(&mut self, row: Option<usize>, value: f64) {
        if let Some(r) = row {
            self.b[r] += value;
        }
    }

    /// Stamp a conductance `g` between two nodes — the four-entry pattern that
    /// shows up in almost every element.
    #[inline]
    pub fn add_conductance(&mut self, p: Option<usize>, m: Option<usize>, g: f64) {
        self.add(p, p, g);
        self.add(m, m, g);
        self.add(p, m, -g);
        self.add(m, p, -g);
    }

    /// Stamp a current source of `i` amps flowing from node `p` to node `m`
    /// *inside* the element, i.e. it pushes current out of `m` and into `p`.
    #[inline]
    pub fn add_current(&mut self, p: Option<usize>, m: Option<usize>, i: f64) {
        self.add_rhs(p, -i);
        self.add_rhs(m, i);
    }

    #[inline]
    pub fn rhs(&self) -> &[f64] {
        &self.b
    }

    /// Solve in place. `self` is destroyed (holds the LU factors afterwards); the
    /// solution is written to `x`.
    pub fn solve_into(&mut self, x: &mut Vec<f64>) -> Result<(), SolveError> {
        let n = self.n;
        x.clear();
        x.resize(n, 0.0);
        if n == 0 {
            return Ok(());
        }

        for (i, p) in self.perm.iter_mut().enumerate() {
            *p = i;
        }

        // Doolittle LU with partial pivoting.
        for k in 0..n {
            let (mut pivot_row, mut pivot_mag) = (k, self.a[k * n + k].abs());
            for r in (k + 1)..n {
                let mag = self.a[r * n + k].abs();
                if mag > pivot_mag {
                    pivot_row = r;
                    pivot_mag = mag;
                }
            }
            if pivot_mag < 1e-20 {
                return Err(SolveError::Singular { row: k });
            }
            if pivot_row != k {
                for c in 0..n {
                    self.a.swap(k * n + c, pivot_row * n + c);
                }
                self.b.swap(k, pivot_row);
                self.perm.swap(k, pivot_row);
            }

            let pivot = self.a[k * n + k];
            for r in (k + 1)..n {
                let factor = self.a[r * n + k] / pivot;
                if factor == 0.0 {
                    continue;
                }
                self.a[r * n + k] = factor;
                for c in (k + 1)..n {
                    self.a[r * n + c] -= factor * self.a[k * n + c];
                }
                self.b[r] -= factor * self.b[k];
            }
        }

        // Back substitution (forward substitution already folded into the loop above).
        for r in (0..n).rev() {
            let row = &self.a[r * n + r + 1..r * n + n];
            let dot: f64 = row.iter().zip(&x[r + 1..]).map(|(a, xc)| a * xc).sum();
            x[r] = (self.b[r] - dot) / self.a[r * n + r];
        }

        if x.iter().any(|v| !v.is_finite()) {
            return Err(SolveError::Singular { row: 0 });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn solves_a_two_by_two() {
        let mut sys = LinearSystem::new(2);
        // [2 1; 1 3] x = [5; 10]  ->  x = [1; 3]
        sys.add(Some(0), Some(0), 2.0);
        sys.add(Some(0), Some(1), 1.0);
        sys.add(Some(1), Some(0), 1.0);
        sys.add(Some(1), Some(1), 3.0);
        sys.add_rhs(Some(0), 5.0);
        sys.add_rhs(Some(1), 10.0);

        let mut x = Vec::new();
        sys.solve_into(&mut x).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-12);
        assert!((x[1] - 3.0).abs() < 1e-12);
    }

    #[test]
    fn needs_pivoting() {
        let mut sys = LinearSystem::new(2);
        // A zero leading pivot must be recovered by a row swap.
        sys.add(Some(0), Some(1), 1.0);
        sys.add(Some(1), Some(0), 1.0);
        sys.add_rhs(Some(0), 2.0);
        sys.add_rhs(Some(1), 3.0);

        let mut x = Vec::new();
        sys.solve_into(&mut x).unwrap();
        assert!((x[0] - 3.0).abs() < 1e-12);
        assert!((x[1] - 2.0).abs() < 1e-12);
    }

    #[test]
    fn reports_singular_matrices() {
        let mut sys = LinearSystem::new(2);
        sys.add(Some(0), Some(0), 1.0);
        sys.add(Some(0), Some(1), 1.0);
        sys.add(Some(1), Some(0), 1.0);
        sys.add(Some(1), Some(1), 1.0);
        let mut x = Vec::new();
        assert!(matches!(sys.solve_into(&mut x), Err(SolveError::Singular { .. })));
    }

    #[test]
    fn ground_indices_are_dropped() {
        let mut sys = LinearSystem::new(1);
        sys.add_conductance(Some(0), None, 0.5);
        // Only the (0,0) self term survives.
        sys.add_rhs(Some(0), 1.0);
        let mut x = Vec::new();
        sys.solve_into(&mut x).unwrap();
        assert!((x[0] - 2.0).abs() < 1e-12);
    }
}
