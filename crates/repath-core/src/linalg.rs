//! Sparse LU with threshold partial pivoting, for the real and complex systems.
//!
//! A circuit matrix has a handful of entries per row however large it gets: a
//! node sees the few parts attached to it. A dense solve pays n³ for the n²
//! entries that are almost all zero, which was fine at fifty unknowns and a
//! wall at five hundred. This one pays for the entries that are there and the
//! fill-in elimination makes, which a minimum-degree ordering keeps small.
//!
//! The work is split the way KLU splits it, because a simulation solves the
//! same pattern thousands of times with different numbers:
//!
//! - **Ordering**, once per pattern: a minimum-degree order of the columns on
//!   the pattern of `A + Aᵀ`. Redone only when a stamp lands where none has
//!   before, which in practice is the first iteration of a run.
//! - **Factoring**, left-looking (Gilbert–Peierls), choosing pivots as it goes:
//!   the diagonal while it is within [`PIVOT_THRESHOLD`] of the best candidate,
//!   the best candidate otherwise. It records the pivot of every column and the
//!   pattern of both factors.
//! - **Refactoring**, every Newton iteration after that: the same pivots and the
//!   same patterns, numbers only. A pivot that has stopped being acceptable at
//!   the new numbers is not used; the matrix is factored afresh instead.
//!
//! Pivots are judged against the largest entry of their own row, for the
//! reason written on [`PIVOT_FLOOR`]: what is small depends on the units a
//! circuit happens to be drawn in, and only means anything beside something.

use std::fmt::Debug;
use std::ops::{Add, AddAssign, Div, Mul, Neg, Sub, SubAssign};

/// What the solver needs of a number: the field operations, a size to compare
/// pivots by, and a way to tell an answer that overflowed.
pub trait Scalar:
    Copy
    + Debug
    + PartialEq
    + Add<Output = Self>
    + Sub<Output = Self>
    + Mul<Output = Self>
    + Div<Output = Self>
    + Neg<Output = Self>
    + AddAssign
    + SubAssign
{
    const ZERO: Self;
    const ONE: Self;
    fn magnitude(self) -> f64;
    fn finite(self) -> bool;
}

impl Scalar for f64 {
    const ZERO: Self = 0.0;
    const ONE: Self = 1.0;
    #[inline]
    fn magnitude(self) -> f64 {
        self.abs()
    }
    #[inline]
    fn finite(self) -> bool {
        self.is_finite()
    }
}

/// A pivot within this share of the best candidate in its column is good
/// enough to keep in place of it. SPICE's `pivrel` and KLU's default: low
/// enough that the fill-reducing order is mostly followed, high enough that a
/// multiplier cannot grow past a thousand.
const PIVOT_THRESHOLD: f64 = 1e-3;

/// Dimensionless, and so comparable against a plain number: a pivot worth less
/// than this beside the largest entry of the row it came from carries no
/// information a double can still represent.
///
/// A circuit matrix spans twenty decades on purpose: `gmin` is a picosiemens
/// and a closed switch is a gigasiemens, and both are meant. Judging a pivot
/// against a fixed number therefore answers the wrong question in both
/// directions — a well-conditioned matrix of small entries was reported
/// singular, while a matrix of large ones whose rows were multiples of each
/// other sailed through and returned nonsense. A node held up by nothing but
/// `gmin` is the case that matters: its row is tiny throughout, and relative to
/// itself its pivot is perfectly healthy, which is exactly what makes the
/// floating node solvable rather than a failure.
const PIVOT_FLOOR: f64 = 1e-14;

/// No row: an unknown not yet pivoted.
const NONE: usize = usize::MAX;

/// Where stamps landed: the matrix entries given something other than zero,
/// and every right-hand side row given anything at all.
///
/// What a question about the circuit's shape needs (which unknowns an element
/// touches, which can reach which) without a matrix per question. The
/// questions are asked one element at a time, and a footprint is all of the
/// answer.
#[derive(Clone, Debug, Default)]
pub struct Pattern {
    pub entries: Vec<(usize, usize)>,
    pub rhs: Vec<usize>,
}

impl Pattern {
    pub fn clear(&mut self) {
        self.entries.clear();
        self.rhs.clear();
    }

    /// Every unknown with a row, a column or a right-hand side entry here, in
    /// order, once each.
    pub fn touched(&self) -> Vec<usize> {
        let mut all: Vec<usize> = self
            .entries
            .iter()
            .flat_map(|&(r, c)| [r, c])
            .chain(self.rhs.iter().copied())
            .collect();
        all.sort_unstable();
        all.dedup();
        all
    }
}

/// Label each of `n` unknowns so that two share a label exactly when a chain of
/// `entries` joins them, leaving `barriers` out of every chain. The pattern is
/// asked for, not a matrix, so it can be read off whichever stamp describes the
/// circuit — never off LU factors, where pivoting and fill-in join rows the
/// circuit does not.
pub fn coupled_entries(n: usize, barriers: &[usize], entries: &[(usize, usize)]) -> Vec<usize> {
    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    let mut barrier = vec![false; n];
    for &b in barriers {
        if b < n {
            barrier[b] = true;
        }
    }
    for &(r, c) in entries {
        if r >= n || c >= n || r == c || barrier[r] || barrier[c] {
            continue;
        }
        let (a, b) = (find(&mut parent, r), find(&mut parent, c));
        if a != b {
            parent[a] = b;
        }
    }
    (0..n).map(|i| find(&mut parent, i)).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SolveError {
    /// The matrix is singular to working precision. In circuit terms this almost
    /// always means a floating node or a loop of ideal voltage sources. `row` is
    /// the unknown elimination found nothing left to pin down.
    Singular { row: usize },
    /// The answer came out infinite or not a number. Not a property of the
    /// circuit's topology but of its values at this iterate — an exponential
    /// pushed past range, a model parameter that divides by zero — so it is
    /// kept apart from `Singular`, which blames a node.
    NonFinite,
}

/// Why the last solve gave up, kept for [`System::undetermined`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    /// A row with nothing in it: nothing anywhere refers to this unknown.
    Empty(usize),
    /// Elimination step `k` found no pivot. The column it was eliminating is
    /// left in the upper factor as far as it got.
    Pivot(usize),
}

/// A linear system `A x = b`, stamped an entry at a time and solved sparsely.
///
/// Real for the operating point and transient ([`LinearSystem`]), complex for
/// AC ([`crate::complex::ComplexSystem`]); the same code solves both.
#[derive(Clone, Debug)]
pub struct System<T: Scalar> {
    n: usize,
    /// Per row, the columns stamped so far and the slot each value is kept in,
    /// sorted by column. A slot, once made, lasts as long as the system: the
    /// pattern only grows, so the factors' patterns stay valid as long as it
    /// has not.
    rows: Vec<Vec<(usize, usize)>>,
    /// The row and column of each slot, in the order they were made.
    at: Vec<(usize, usize)>,
    values: Vec<T>,
    b: Vec<T>,
    /// The slot each stamp since the last [`Self::clear`] went to, in order,
    /// and how many stamps there have been. A circuit stamps the same entries
    /// in the same order every iteration, so the slot a stamp went to last
    /// time is almost always the one it goes to now, and checking that is
    /// cheaper than looking it up. A stamp that goes elsewhere is looked up and
    /// written over the old one, so a change of course costs one lookup per
    /// stamp that moved, once.
    trail: Vec<usize>,
    stamps: usize,
    lu: Lu<T>,
    /// Set on a system made by [`Self::pattern`]: where each stamp lands, kept
    /// instead of summed into a matrix.
    record: Option<Pattern>,
}

/// The real system the transient and operating point are solved in.
pub type LinearSystem = System<f64>;

/// The ordering, the factors and the scratch space, all reused across solves.
#[derive(Clone, Debug)]
struct Lu<T> {
    /// How many slots the matrix had when it was last ordered: more now means
    /// a stamp landed somewhere new, and the order is out of date.
    ordered_slots: usize,
    /// Column eliminated at each step.
    order: Vec<usize>,
    /// The matrix by column, in slot terms: column `c` has the rows
    /// `col_row[col_ptr[c]..col_ptr[c + 1]]`, valued at the matching slots.
    col_ptr: Vec<usize>,
    col_row: Vec<usize>,
    col_slot: Vec<usize>,
    /// Whether the factors below come from a successful factorization of the
    /// current pattern, so their pivots can be tried again.
    factored: bool,
    /// Row pivoted at each step, and the step each row was pivoted at.
    pivot_row: Vec<usize>,
    step_of_row: Vec<usize>,
    /// Lower factor by step, unit diagonal left out, rows as stamped.
    l_ptr: Vec<usize>,
    l_row: Vec<usize>,
    l_val: Vec<T>,
    /// Upper factor by step, diagonal kept apart, rows as steps, in the order
    /// the factorization reached them — which is an order they can be applied in.
    u_ptr: Vec<usize>,
    u_step: Vec<usize>,
    u_val: Vec<T>,
    u_diag: Vec<T>,
    /// Reciprocal of each row's largest entry.
    scale: Vec<f64>,
    /// Dense work column, all zero between uses.
    work: Vec<T>,
    /// Depth-first search scratch: visit marks by generation, the stack, the
    /// resume position of each frame, and the rows reached, filled from the end.
    mark: Vec<usize>,
    generation: usize,
    stack: Vec<usize>,
    resume: Vec<usize>,
    reach: Vec<usize>,
    /// The forward substitution's intermediate, by step.
    y: Vec<T>,
    failed: Option<Failure>,
}

impl<T: Scalar> Lu<T> {
    fn new(n: usize) -> Self {
        Self {
            ordered_slots: usize::MAX,
            order: Vec::new(),
            col_ptr: Vec::new(),
            col_row: Vec::new(),
            col_slot: Vec::new(),
            factored: false,
            pivot_row: vec![NONE; n],
            step_of_row: vec![NONE; n],
            l_ptr: Vec::new(),
            l_row: Vec::new(),
            l_val: Vec::new(),
            u_ptr: Vec::new(),
            u_step: Vec::new(),
            u_val: Vec::new(),
            u_diag: Vec::new(),
            scale: vec![0.0; n],
            work: vec![T::ZERO; n],
            mark: vec![0; n],
            generation: 0,
            stack: vec![0; n],
            resume: vec![0; n],
            reach: vec![0; n],
            y: vec![T::ZERO; n],
            failed: None,
        }
    }
}

impl<T: Scalar> System<T> {
    pub fn new(n: usize) -> Self {
        Self {
            n,
            rows: vec![Vec::new(); n],
            at: Vec::new(),
            values: Vec::new(),
            b: vec![T::ZERO; n],
            trail: Vec::new(),
            stamps: 0,
            lu: Lu::new(n),
            record: None,
        }
    }

    /// A system that only records where it is stamped, and cannot be solved.
    pub fn pattern(n: usize) -> Self {
        Self {
            n,
            rows: Vec::new(),
            at: Vec::new(),
            values: Vec::new(),
            b: Vec::new(),
            trail: Vec::new(),
            stamps: 0,
            lu: Lu::new(0),
            record: Some(Pattern::default()),
        }
    }

    /// What a system made by [`Self::pattern`] has recorded since it was last
    /// cleared; `None` for an ordinary one.
    pub fn recorded(&self) -> Option<&Pattern> {
        self.record.as_ref()
    }

    #[inline]
    pub fn size(&self) -> usize {
        self.n
    }

    /// Zero the matrix and right-hand side, keeping the pattern and the factors'
    /// structure for the next solve.
    pub fn clear(&mut self) {
        self.values.fill(T::ZERO);
        self.b.fill(T::ZERO);
        self.stamps = 0;
        if let Some(record) = &mut self.record {
            record.clear();
        }
    }

    /// `A[row][col] += value`. `None` indices are ground and are silently dropped,
    /// which is exactly the row/column elimination that grounding a node performs.
    #[inline]
    pub fn add(&mut self, row: Option<usize>, col: Option<usize>, value: T) {
        if let (Some(r), Some(c)) = (row, col) {
            if let Some(record) = &mut self.record {
                if value != T::ZERO {
                    record.entries.push((r, c));
                }
                return;
            }
            let k = self.stamps;
            self.stamps += 1;
            let slot = match self.trail.get(k) {
                Some(&slot) if self.at[slot] == (r, c) => slot,
                _ => {
                    let slot = self.slot(r, c);
                    if k < self.trail.len() {
                        self.trail[k] = slot;
                    } else {
                        self.trail.push(slot);
                    }
                    slot
                }
            };
            self.values[slot] += value;
        }
    }

    /// The slot entry `(r, c)` is kept in, made if it is new. A new one is kept
    /// even when what is stamped there is zero: a place that is stamped at all
    /// is part of the pattern, and the next iteration may well put something
    /// in it.
    #[inline]
    fn slot(&mut self, r: usize, c: usize) -> usize {
        let row = &mut self.rows[r];
        match row.binary_search_by_key(&c, |&(col, _)| col) {
            Ok(i) => row[i].1,
            Err(i) => {
                let slot = self.at.len();
                row.insert(i, (c, slot));
                self.at.push((r, c));
                self.values.push(T::ZERO);
                slot
            }
        }
    }

    /// `b[row] += value`, dropping ground.
    #[inline]
    pub fn add_rhs(&mut self, row: Option<usize>, value: T) {
        if let Some(r) = row {
            if let Some(record) = &mut self.record {
                record.rhs.push(r);
                return;
            }
            self.b[r] += value;
        }
    }

    #[inline]
    pub fn rhs(&self) -> &[T] {
        &self.b
    }

    /// The entries holding something other than zero right now.
    fn nonzero_entries(&self) -> impl Iterator<Item = (usize, usize)> + '_ {
        self.at.iter().zip(&self.values).filter(|(_, v)| **v != T::ZERO).map(|(&at, _)| at)
    }

    /// Which unknowns can affect which: a label per unknown, equal for any two
    /// joined by a chain of nonzero entries.
    ///
    /// Unknowns in `barriers` are left out of every chain. A node held by an
    /// ideal source is one: everything hangs off the supply rail, and a rail
    /// carries no signal from one thing to another.
    pub fn coupled(&self, barriers: &[usize]) -> Vec<usize> {
        let entries: Vec<(usize, usize)> = self.nonzero_entries().collect();
        coupled_entries(self.n, barriers, &entries)
    }

    /// The unknowns anything has been stamped against since the last
    /// [`Self::clear`]: a row, a column or a right-hand side entry of theirs is
    /// not zero.
    pub fn touched(&self) -> Vec<usize> {
        if let Some(record) = &self.record {
            return record.touched();
        }
        let mut hit = vec![false; self.n];
        for (r, c) in self.nonzero_entries() {
            hit[r] = true;
            hit[c] = true;
        }
        for (i, v) in self.b.iter().enumerate() {
            if *v != T::ZERO {
                hit[i] = true;
            }
        }
        (0..self.n).filter(|&i| hit[i]).collect()
    }

    /// How many entries the last successful factorization holds, both factors
    /// and the diagonal: the measure of what fill-in cost, and so of how good
    /// the ordering was.
    pub fn factor_entries(&self) -> usize {
        if !self.lu.factored {
            return 0;
        }
        self.lu.l_row.len() + self.lu.u_step.len() + self.lu.u_diag.len()
    }

    /// Solve, leaving the matrix and right-hand side as they were stamped; the
    /// solution is written to `x`.
    pub fn solve_into(&mut self, x: &mut Vec<T>) -> Result<(), SolveError> {
        debug_assert!(self.record.is_none(), "a pattern is not a system to solve");
        let n = self.n;
        x.clear();
        x.resize(n, T::ZERO);
        self.lu.failed = None;
        if n == 0 {
            return Ok(());
        }

        // How big an entry is in its own row's terms; see `PIVOT_FLOOR`.
        let scale = &mut self.lu.scale;
        scale.fill(0.0);
        for (&(r, _), v) in self.at.iter().zip(&self.values) {
            scale[r] = scale[r].max(v.magnitude());
        }
        for (r, s) in scale.iter_mut().enumerate() {
            if *s == 0.0 {
                // An empty row: nothing anywhere in the circuit refers to this
                // unknown, so there is nothing to solve for it.
                self.lu.failed = Some(Failure::Empty(r));
                return Err(SolveError::Singular { row: r });
            }
            *s = 1.0 / *s;
        }

        if self.lu.ordered_slots != self.at.len() {
            self.analyze();
        }
        if !(self.lu.factored && self.refactor()) {
            self.factor()?;
        }
        self.substitute(x);

        if x.iter().any(|v| !v.finite()) {
            return Err(SolveError::NonFinite);
        }
        Ok(())
    }

    /// Lay the pattern out by column and order the columns for elimination.
    fn analyze(&mut self) {
        let n = self.n;
        let lu = &mut self.lu;
        lu.col_ptr.clear();
        lu.col_ptr.resize(n + 1, 0);
        for &(_, c) in &self.at {
            lu.col_ptr[c + 1] += 1;
        }
        for c in 0..n {
            lu.col_ptr[c + 1] += lu.col_ptr[c];
        }
        let mut next = lu.col_ptr.clone();
        lu.col_row.resize(self.at.len(), 0);
        lu.col_slot.resize(self.at.len(), 0);
        for (slot, &(r, c)) in self.at.iter().enumerate() {
            lu.col_row[next[c]] = r;
            lu.col_slot[next[c]] = slot;
            next[c] += 1;
        }
        lu.order = minimum_degree(n, &self.at);
        lu.ordered_slots = self.at.len();
        lu.factored = false;
    }

    /// Mark everything reachable from `start` through the lower factor's
    /// columns pivoted so far, appending to `reach` from `top` down in an order
    /// where every row comes before the rows it updates.
    fn depth_first(&mut self, start: usize, mut top: usize) -> usize {
        let lu = &mut self.lu;
        let generation = lu.generation;
        let mut head = 0;
        lu.stack[0] = start;
        lu.mark[start] = generation;
        let step = lu.step_of_row[start];
        lu.resume[0] = if step == NONE { 0 } else { lu.l_ptr[step] };
        loop {
            let row = lu.stack[head];
            let step = lu.step_of_row[row];
            let mut descended = false;
            if step != NONE {
                let end = lu.l_ptr[step + 1];
                let mut p = lu.resume[head];
                while p < end {
                    let child = lu.l_row[p];
                    p += 1;
                    if lu.mark[child] == generation {
                        continue;
                    }
                    lu.resume[head] = p;
                    lu.mark[child] = generation;
                    head += 1;
                    lu.stack[head] = child;
                    let child_step = lu.step_of_row[child];
                    lu.resume[head] = if child_step == NONE { 0 } else { lu.l_ptr[child_step] };
                    descended = true;
                    break;
                }
            }
            if descended {
                continue;
            }
            top -= 1;
            lu.reach[top] = row;
            if head == 0 {
                return top;
            }
            head -= 1;
        }
    }

    /// Factor from scratch, choosing every pivot.
    fn factor(&mut self) -> Result<(), SolveError> {
        let n = self.n;
        {
            let lu = &mut self.lu;
            lu.factored = false;
            lu.step_of_row.fill(NONE);
            lu.l_ptr.clear();
            lu.l_ptr.push(0);
            lu.l_row.clear();
            lu.l_val.clear();
            lu.u_ptr.clear();
            lu.u_ptr.push(0);
            lu.u_step.clear();
            lu.u_val.clear();
            lu.u_diag.clear();
        }
        for k in 0..n {
            let col = self.lu.order[k];
            // The rows this column will touch, in an order they can be
            // eliminated in.
            self.lu.generation = self.lu.generation.wrapping_add(1);
            let mut top = n;
            for p in self.lu.col_ptr[col]..self.lu.col_ptr[col + 1] {
                let row = self.lu.col_row[p];
                if self.lu.mark[row] != self.lu.generation {
                    top = self.depth_first(row, top);
                }
            }
            let lu = &mut self.lu;
            for p in lu.col_ptr[col]..lu.col_ptr[col + 1] {
                lu.work[lu.col_row[p]] = self.values[lu.col_slot[p]];
            }
            // x = L \ A(:, col), over just the rows reached.
            for p in top..n {
                let row = lu.reach[p];
                let step = lu.step_of_row[row];
                if step == NONE {
                    continue;
                }
                let v = lu.work[row];
                if v == T::ZERO {
                    continue;
                }
                for q in lu.l_ptr[step]..lu.l_ptr[step + 1] {
                    let target = lu.l_row[q];
                    lu.work[target] -= lu.l_val[q] * v;
                }
            }
            // What is pivoted already is this column of U; what is not is a
            // candidate for its pivot.
            let (mut best, mut best_mag) = (NONE, 0.0f64);
            for p in top..n {
                let row = lu.reach[p];
                let step = lu.step_of_row[row];
                if step == NONE {
                    let mag = lu.work[row].magnitude() * lu.scale[row];
                    if mag > best_mag {
                        best = row;
                        best_mag = mag;
                    }
                } else {
                    lu.u_step.push(step);
                    lu.u_val.push(lu.work[row]);
                }
            }
            lu.u_ptr.push(lu.u_step.len());
            if best == NONE || best_mag < PIVOT_FLOOR {
                for p in top..n {
                    lu.work[lu.reach[p]] = T::ZERO;
                }
                lu.failed = Some(Failure::Pivot(k));
                return Err(SolveError::Singular { row: col });
            }
            // The diagonal keeps the order's promise about fill-in; it is
            // taken whenever it is not much worse than the best.
            if lu.step_of_row[col] == NONE
                && lu.work[col].magnitude() * lu.scale[col] >= PIVOT_THRESHOLD * best_mag
            {
                best = col;
            }
            let pivot = lu.work[best];
            lu.u_diag.push(pivot);
            lu.pivot_row[k] = best;
            lu.step_of_row[best] = k;
            for p in top..n {
                let row = lu.reach[p];
                if lu.step_of_row[row] == NONE {
                    lu.l_row.push(row);
                    lu.l_val.push(lu.work[row] / pivot);
                }
                lu.work[row] = T::ZERO;
            }
            lu.l_ptr.push(lu.l_row.len());
        }
        self.lu.factored = true;
        Ok(())
    }

    /// Factor again with the pivots and patterns of the last factorization.
    /// False, with nothing usable left, as soon as a pivot is no longer
    /// acceptable at the new numbers.
    fn refactor(&mut self) -> bool {
        let n = self.n;
        let lu = &mut self.lu;
        for k in 0..n {
            let col = lu.order[k];
            for p in lu.col_ptr[col]..lu.col_ptr[col + 1] {
                lu.work[lu.col_row[p]] = self.values[lu.col_slot[p]];
            }
            for q in lu.u_ptr[k]..lu.u_ptr[k + 1] {
                let step = lu.u_step[q];
                let row = lu.pivot_row[step];
                let v = lu.work[row];
                lu.u_val[q] = v;
                lu.work[row] = T::ZERO;
                if v == T::ZERO {
                    continue;
                }
                for r in lu.l_ptr[step]..lu.l_ptr[step + 1] {
                    let target = lu.l_row[r];
                    lu.work[target] -= lu.l_val[r] * v;
                }
            }
            let pivot_row = lu.pivot_row[k];
            let pivot = lu.work[pivot_row];
            lu.work[pivot_row] = T::ZERO;
            let held = pivot.magnitude() * lu.scale[pivot_row];
            let best = lu.l_row[lu.l_ptr[k]..lu.l_ptr[k + 1]]
                .iter()
                .map(|&row| lu.work[row].magnitude() * lu.scale[row])
                .fold(held, f64::max);
            if !(held >= PIVOT_FLOOR && held >= PIVOT_THRESHOLD * best) {
                for &row in &lu.l_row[lu.l_ptr[k]..lu.l_ptr[k + 1]] {
                    lu.work[row] = T::ZERO;
                }
                lu.factored = false;
                return false;
            }
            lu.u_diag[k] = pivot;
            for r in lu.l_ptr[k]..lu.l_ptr[k + 1] {
                let row = lu.l_row[r];
                lu.l_val[r] = lu.work[row] / pivot;
                lu.work[row] = T::ZERO;
            }
        }
        true
    }

    /// Forward and back substitution through the factors.
    fn substitute(&mut self, x: &mut [T]) {
        let n = self.n;
        let lu = &mut self.lu;
        // Forward, in stamped rows: `work` starts as b and has each step's
        // pivot row final by the time the step is reached.
        lu.work.copy_from_slice(&self.b);
        for k in 0..n {
            let v = lu.work[lu.pivot_row[k]];
            lu.y[k] = v;
            if v == T::ZERO {
                continue;
            }
            for q in lu.l_ptr[k]..lu.l_ptr[k + 1] {
                let target = lu.l_row[q];
                lu.work[target] -= lu.l_val[q] * v;
            }
        }
        lu.work.fill(T::ZERO);
        // Back, by step, a column of U at a time.
        for k in (0..n).rev() {
            let z = lu.y[k] / lu.u_diag[k];
            x[lu.order[k]] = z;
            if z == T::ZERO {
                continue;
            }
            for q in lu.u_ptr[k]..lu.u_ptr[k + 1] {
                let step = lu.u_step[q];
                lu.y[step] -= lu.u_val[q] * z;
            }
        }
    }

    /// The unknowns that no equation pins down, after a solve that came back
    /// [`SolveError::Singular`]: largest share first, empty if the last solve
    /// did not fail that way.
    ///
    /// Read off the half-finished factors rather than worked out afresh, so it
    /// costs nothing until it is asked for. Elimination stopped at a column
    /// with no pivot left, which makes that column a combination of the ones
    /// before it; solving the finished triangle for the combination gives a
    /// vector the matrix sends to zero, and the unknowns it has weight on are
    /// the ones free to take any value. Two sources fighting over one node put
    /// their two branch currents in it, and a node with nothing holding it
    /// puts itself.
    pub fn undetermined(&self) -> Vec<usize> {
        let lu = &self.lu;
        let k = match lu.failed {
            None => return Vec::new(),
            // An equation that says nothing: the row is the unknown with the
            // same index, which is all there is to go on.
            Some(Failure::Empty(row)) => return vec![row],
            Some(Failure::Pivot(k)) => k,
        };
        // The failed column's part above the diagonal, negated, is what the
        // columns before it have to make up between them.
        let mut z = vec![T::ZERO; k + 1];
        z[k] = T::ONE;
        for q in lu.u_ptr[k]..lu.u_ptr[k + 1] {
            z[lu.u_step[q]] -= lu.u_val[q];
        }
        for j in (0..k).rev() {
            let v = z[j] / lu.u_diag[j];
            z[j] = v;
            for q in lu.u_ptr[j]..lu.u_ptr[j + 1] {
                z[lu.u_step[q]] -= lu.u_val[q] * v;
            }
        }
        let size: Vec<f64> = z.iter().map(|v| v.magnitude()).collect();
        let largest = size.iter().fold(0.0f64, |m, v| m.max(*v));
        if !largest.is_finite() {
            return vec![lu.order[k]];
        }
        let mut involved: Vec<usize> = (0..=k).filter(|&j| size[j] > 1e-6 * largest).collect();
        involved.sort_by(|&p, &q| size[q].total_cmp(&size[p]).then(lu.order[p].cmp(&lu.order[q])));
        involved.into_iter().map(|j| lu.order[j]).collect()
    }
}

impl System<f64> {
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
}

/// A fill-reducing elimination order: minimum degree on the graph of `A + Aᵀ`.
///
/// The textbook algorithm on an explicit elimination graph, without the
/// refinements of AMD (supervariables, approximate degrees, aggressive
/// absorption). Those buy speed on matrices of millions of entries; a circuit
/// is ordered once per pattern and has a few thousand unknowns at most, and at
/// that size this takes a fraction of one factorization. Ties go to the lower
/// index, so the order — and every answer that depends on rounding — is the
/// same run after run.
fn minimum_degree(n: usize, entries: &[(usize, usize)]) -> Vec<usize> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    let mut adjacent: Vec<Vec<usize>> = vec![Vec::new(); n];
    for &(r, c) in entries {
        if r != c {
            adjacent[r].push(c);
            adjacent[c].push(r);
        }
    }
    for list in &mut adjacent {
        list.sort_unstable();
        list.dedup();
    }
    let mut eliminated = vec![false; n];
    let mut heap: BinaryHeap<Reverse<(usize, usize)>> =
        (0..n).map(|i| Reverse((adjacent[i].len(), i))).collect();
    let mut order = Vec::with_capacity(n);
    let mut merged = Vec::new();
    while let Some(Reverse((degree, v))) = heap.pop() {
        if eliminated[v] || degree != adjacent[v].len() {
            continue;
        }
        eliminated[v] = true;
        order.push(v);
        // Eliminating `v` joins everything it touched into a clique.
        let clique = std::mem::take(&mut adjacent[v]);
        for &u in &clique {
            merged.clear();
            let (mut i, mut j) = (0, 0);
            let own = &adjacent[u];
            while i < own.len() || j < clique.len() {
                let next = match (own.get(i), clique.get(j)) {
                    (Some(&a), Some(&b)) if a == b => {
                        i += 1;
                        j += 1;
                        a
                    }
                    (Some(&a), Some(&b)) if a < b => {
                        i += 1;
                        a
                    }
                    (Some(&a), None) => {
                        i += 1;
                        a
                    }
                    (_, Some(&b)) => {
                        j += 1;
                        b
                    }
                    (None, None) => unreachable!(),
                };
                if next != u && next != v {
                    merged.push(next);
                }
            }
            std::mem::swap(&mut adjacent[u], &mut merged);
            heap.push(Reverse((adjacent[u].len(), u)));
        }
    }
    order
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

    /// A pattern records where stamps land and nothing else, and the labels
    /// read off it are the ones read off the dense matrix the same stamps make.
    #[test]
    fn a_pattern_agrees_with_the_matrix_it_stands_for() {
        let stamp = |sys: &mut LinearSystem| {
            // 0 — 1 joined, 2 — 3 joined, 1 — 2 joined only through 4, which is
            // a barrier, and a zero entry between 0 and 3 that joins nothing.
            sys.add_conductance(Some(0), Some(1), 1e-3);
            sys.add_conductance(Some(2), Some(3), 2.0);
            sys.add_conductance(Some(1), Some(4), 1.0);
            sys.add_conductance(Some(4), Some(2), 1.0);
            sys.add(Some(0), Some(3), 0.0);
            sys.add_rhs(Some(3), 0.0);
        };
        let mut dense = LinearSystem::new(5);
        stamp(&mut dense);
        let mut pattern = LinearSystem::pattern(5);
        stamp(&mut pattern);
        let recorded = pattern.recorded().unwrap();
        assert!(!recorded.entries.contains(&(0, 3)), "a zero entry is not a coupling");
        assert_eq!(recorded.rhs, [3], "a right-hand side row is touched whatever it is given");
        assert_eq!(pattern.touched(), [0, 1, 2, 3, 4]);
        assert_eq!(pattern.touched(), dense.touched());
        let from_dense = dense.coupled(&[4]);
        let from_pattern = coupled_entries(5, &[4], &recorded.entries);
        let same = |labels: &[usize], a: usize, b: usize| labels[a] == labels[b];
        for (a, b) in [(0, 1), (2, 3), (1, 2), (0, 3)] {
            assert_eq!(same(&from_dense, a, b), same(&from_pattern, a, b), "{a} and {b}");
        }
        assert!(same(&from_pattern, 0, 1) && same(&from_pattern, 2, 3));
        assert!(!same(&from_pattern, 1, 2), "joined only through the barrier");
        pattern.clear();
        assert!(pattern.touched().is_empty());
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
    fn a_singular_solve_names_the_unknowns_left_free() {
        // Unknown 0 is pinned on its own; 1 and 2 only ever appear as a sum, so
        // either can take any value as long as the other makes up the rest.
        let mut sys = LinearSystem::new(3);
        sys.add(Some(0), Some(0), 2.0);
        sys.add(Some(1), Some(1), 1.0);
        sys.add(Some(1), Some(2), 1.0);
        sys.add(Some(2), Some(1), 3.0);
        sys.add(Some(2), Some(2), 3.0);
        let mut x = Vec::new();
        assert!(sys.solve_into(&mut x).is_err());
        let mut free = sys.undetermined();
        free.sort();
        assert_eq!(free, vec![1, 2]);

        // And a solve that works leaves nothing to blame.
        let mut sys = LinearSystem::new(1);
        sys.add(Some(0), Some(0), 1.0);
        sys.solve_into(&mut x).unwrap();
        assert!(sys.undetermined().is_empty());
    }

    #[test]
    fn an_empty_row_is_its_own_unknown() {
        let mut sys = LinearSystem::new(2);
        sys.add(Some(0), Some(0), 1.0);
        let mut x = Vec::new();
        assert!(sys.solve_into(&mut x).is_err());
        assert_eq!(sys.undetermined(), vec![1]);
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

    /// Coupling follows the nonzero pattern, and stops at a rail.
    #[test]
    fn coupling_follows_the_entries_and_stops_at_a_barrier() {
        // Unknowns 0-1 joined, 2 on its own, 3 joined to 0 only through 4.
        let mut sys = LinearSystem::new(5);
        sys.add(Some(0), Some(1), 1.0);
        sys.add(Some(3), Some(4), 1.0);
        sys.add(Some(4), Some(0), 1.0);
        let label = sys.coupled(&[]);
        assert_eq!(label[0], label[1]);
        assert_eq!(label[0], label[3]);
        assert_ne!(label[0], label[2]);

        // With 4 a barrier, 3 is cut off from 0.
        let label = sys.coupled(&[4]);
        assert_eq!(label[0], label[1]);
        assert_ne!(label[0], label[3]);
    }
}
