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
    /// Reciprocal of each row's largest entry, for scaled pivoting. Scratch.
    scale: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolveError {
    /// The matrix is singular to working precision. In circuit terms this almost
    /// always means a floating node or a loop of ideal voltage sources.
    Singular { row: usize },
}

impl LinearSystem {
    pub fn new(n: usize) -> Self {
        Self {
            n,
            a: vec![0.0; n * n],
            b: vec![0.0; n],
            perm: (0..n).collect(),
            scale: vec![0.0; n],
        }
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

        // How big an entry is in this row's own terms.
        //
        // A circuit matrix spans twenty decades on purpose: `gmin` is a picosiemens
        // and a closed switch is a gigasiemens, and both are meant. Judging a pivot
        // against a fixed number therefore answers the wrong question in both
        // directions — a well-conditioned matrix of small entries was reported
        // singular, while a matrix of large ones whose rows were multiples of each
        // other sailed through and returned nonsense. A node held up by nothing but
        // `gmin` is the case that matters: its row is tiny throughout, and relative
        // to itself its pivot is perfectly healthy, which is exactly what makes the
        // floating node solvable rather than a failure.
        for r in 0..n {
            let largest = self.a[r * n..r * n + n].iter().fold(0.0f64, |acc, v| acc.max(v.abs()));
            if largest == 0.0 {
                // An empty row: nothing anywhere in the circuit refers to this
                // unknown, so there is nothing to solve for it.
                return Err(SolveError::Singular { row: r });
            }
            self.scale[r] = 1.0 / largest;
        }

        // Doolittle LU with scaled partial pivoting.
        for k in 0..n {
            let (mut pivot_row, mut pivot_mag) = (k, 0.0);
            for r in k..n {
                let mag = self.scale[r] * self.a[r * n + k].abs();
                if mag > pivot_mag {
                    pivot_row = r;
                    pivot_mag = mag;
                }
            }
            // Dimensionless, and so comparable against a plain number: a pivot
            // worth less than this beside the row it came from carries no
            // information a double can still represent.
            if pivot_mag < 1e-14 {
                return Err(SolveError::Singular { row: k });
            }
            if pivot_row != k {
                for c in 0..n {
                    self.a.swap(k * n + c, pivot_row * n + c);
                }
                self.b.swap(k, pivot_row);
                self.perm.swap(k, pivot_row);
                self.scale.swap(k, pivot_row);
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
    fn small_is_only_small_beside_something() {
        // A scaled identity: condition number one, and about as solvable as a
        // matrix gets. Judged against a fixed floor it was reported singular for
        // no reason other than the units its circuit happened to be written in.
        let mut sys = LinearSystem::new(2);
        sys.add(Some(0), Some(0), 1e-21);
        sys.add(Some(1), Some(1), 1e-21);
        sys.add_rhs(Some(0), 1e-21);
        sys.add_rhs(Some(1), 2e-21);

        let mut x = Vec::new();
        sys.solve_into(&mut x).expect("a scaled identity has an exact answer");
        assert!((x[0] - 1.0).abs() < 1e-12 && (x[1] - 2.0).abs() < 1e-12, "got {x:?}");
    }

    #[test]
    fn large_is_not_the_same_as_independent() {
        // And the mirror image. Two rows that agree to within a part in 1e15 are
        // the same equation as far as a double is concerned, but their entries are
        // enormous — so a fixed floor waved them through and the answer came back
        // as a pair of six-figure numbers with nothing behind them.
        let mut sys = LinearSystem::new(2);
        sys.add(Some(0), Some(0), 1e9);
        sys.add(Some(0), Some(1), 1e9);
        sys.add(Some(1), Some(0), 1e9);
        sys.add(Some(1), Some(1), 1e9 + 1e-6);
        sys.add_rhs(Some(0), 1.0);
        sys.add_rhs(Some(1), 2.0);

        let mut x = Vec::new();
        assert!(matches!(sys.solve_into(&mut x), Err(SolveError::Singular { .. })), "got {x:?}");
    }

    #[test]
    fn a_node_held_up_by_nothing_but_gmin_is_still_solvable() {
        // The case the whole scheme has to keep working. One node carries a real
        // circuit and the other is floating, held only by the picosiemens the
        // solver puts on every node — twenty-one decades apart, and both meant.
        let mut sys = LinearSystem::new(2);
        sys.add(Some(0), Some(0), 1e9);
        sys.add(Some(1), Some(1), 1e-12);
        sys.add_rhs(Some(0), 1e9);

        let mut x = Vec::new();
        sys.solve_into(&mut x).expect("gmin exists precisely so this solves");
        assert!((x[0] - 1.0).abs() < 1e-12, "got {x:?}");
        assert_eq!(x[1], 0.0);
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
