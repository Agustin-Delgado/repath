//! Bridges between the analog and digital domains.
//!
//! These are what make the simulator mixed-signal rather than two simulators in
//! a trench coat. The design goal is that neither side ever sees a discontinuity:
//!
//! - A [`DacBridge`] never jumps. When its net changes it ramps its analog output
//!   over a real rise or fall time, so the analog solver sees a continuous
//!   waveform and never has to re-solve a timepoint it already accepted.
//! - An [`AdcBridge`] watches a node between accepted timepoints and, when the
//!   voltage crosses a threshold, interpolates the crossing instant and schedules
//!   the digital event *there* rather than at the end of the step.

use crate::complex::{C64, ComplexSystem};
use crate::digital::{DriverId, Logic, NetId};
use crate::element::{AcCtx, Element, NodeId, StampCtx, StampReport, node_index};
use crate::linalg::LinearSystem;
use serde::{Deserialize, Serialize};

/// Voltage thresholds and timing shared by both bridge directions.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LogicFamily {
    /// Voltage a driven `Low` produces, and below which an input reads `Low`.
    pub v_low: f64,
    /// Voltage a driven `High` produces, and above which an input reads `High`.
    pub v_high: f64,
    /// Input threshold for a falling signal.
    ///
    /// Where an input actually switches, not the datasheet's guaranteed
    /// `V_IL`: a 74HC is promised to read a low below 1.5 V and switches near
    /// half its supply, and it is the second that decides when an edge lands.
    pub v_il: f64,
    /// Input threshold for a rising signal. Must be above `v_il` — the gap is
    /// the hysteresis that stops a slow edge from producing a burst of events.
    /// Narrow for an ordinary gate, which has next to none; a Schmitt input's
    /// is its own and wider.
    pub v_ih: f64,
    /// Output impedance of a driven digital output.
    pub r_out: f64,
    pub rise: f64,
    pub fall: f64,
}

impl Default for LogicFamily {
    fn default() -> Self {
        Self::cmos_5v()
    }
}

impl LogicFamily {
    /// A 74HC on 5 V. NXP's typical input thresholds at 4.5 V are 2.4 V rising
    /// and 2.1 V falling: half the supply, with a tenth of a volt or so between.
    pub fn cmos_5v() -> Self {
        Self { v_low: 0.0, v_high: 5.0, v_il: 2.4, v_ih: 2.6, r_out: 50.0, rise: 2e-9, fall: 2e-9 }
    }

    pub fn cmos_3v3() -> Self {
        Self {
            v_low: 0.0,
            v_high: 3.3,
            v_il: 1.55,
            v_ih: 1.75,
            r_out: 50.0,
            rise: 1e-9,
            fall: 1e-9,
        }
    }

    #[inline]
    fn mid(&self) -> f64 {
        0.5 * (self.v_low + self.v_high)
    }
}

// ---------------------------------------------------------------------------
// Digital -> analog
// ---------------------------------------------------------------------------

/// The package an output belongs to, as far as its current is concerned: the
/// two supply legs that current comes in and goes out on, and the drivers on
/// the bridged net that are that package's outputs.
///
/// A real output stage is a switch to each supply leg. What it sources into a
/// load comes in at the chip's VCC pin, and what it sinks from one leaves at
/// its GND pin, so the supply wire carries the load's current and the chip's
/// pins add up. Without a tap the output's current comes from the ideal
/// reference the bridge is measured against, which is right for a gate symbol
/// with no supply pins drawn and wrong for a package with them.
#[derive(Debug, Clone)]
pub struct SupplyTap {
    pub plus: NodeId,
    pub minus: NodeId,
    /// This package's drivers on the bridged net.
    pub drivers: Vec<DriverId>,
}

/// Half the width of the smooth corner at which an output turns from sinking
/// to sourcing, in amps. A sharp corner at zero current is a kink in the
/// Jacobian; a nanoamp of rounding is far below anything drawn.
const TAP_ROUNDING: f64 = 1e-9;

/// The sourced and sunk parts of an output current `i` (positive out of the
/// output into its load), and their slopes against `i`.
///
/// `is - ik == i` exactly, whatever the rounding, so what the supply legs carry
/// always adds up to what the output delivers.
pub(crate) fn split_output(i: f64) -> (f64, f64, f64, f64) {
    let r = (i * i + TAP_ROUNDING * TAP_ROUNDING).sqrt();
    let is = 0.5 * (i + r);
    let ik = 0.5 * (r - i);
    (is, ik, 0.5 * (1.0 + i / r), -0.5 * (1.0 - i / r))
}

/// A change to whether one of a tap's drivers is driving, waiting for the
/// analog side to reach it. The digital domain runs ahead of the solve, so the
/// change is applied when the solve gets to its instant, not when it is told.
#[derive(Debug, Clone, Copy)]
struct TapChange {
    time: f64,
    tap: usize,
    driver: usize,
    active: bool,
}

/// Drives an analog node from a digital net through a finite output impedance.
///
/// Stamped as a Norton equivalent — a conductance to ground in parallel with a
/// current source — so it costs no extra unknown in the MNA system.
#[derive(Debug, Clone)]
pub struct DacBridge {
    pub name: String,
    pub net: NetId,
    pub node: NodeId,
    pub family: LogicFamily,
    /// The packages whose outputs drive this net, if any have supply legs.
    taps: Vec<SupplyTap>,
    /// Per tap, per driver: whether it is driving at the instant the solve is at.
    tap_active: Vec<Vec<bool>>,
    /// Changes to those, in time order, not yet reached.
    tap_pending: std::collections::VecDeque<TapChange>,
    /// Slopes of the sourced and sunk currents against the node voltage at the
    /// last operating point, for the small-signal analysis.
    tap_slopes: (f64, f64),
    /// Ramp endpoints and timing for the transition in progress.
    from: f64,
    to: f64,
    ramp_start: f64,
    ramp_duration: f64,
    /// False while the net is high impedance, in which case we stop driving.
    driving: bool,
}

impl DacBridge {
    pub fn new(name: impl Into<String>, net: NetId, node: NodeId, family: LogicFamily) -> Self {
        let mid = family.mid();
        Self {
            name: name.into(),
            net,
            node,
            family,
            from: mid,
            to: mid,
            ramp_start: 0.0,
            ramp_duration: 0.0,
            driving: true,
            taps: Vec::new(),
            tap_active: Vec::new(),
            tap_pending: std::collections::VecDeque::new(),
            tap_slopes: (0.0, 0.0),
        }
    }

    /// Draw this output's current through a package's supply legs.
    pub fn add_tap(&mut self, tap: SupplyTap) {
        self.tap_active.push(vec![false; tap.drivers.len()]);
        self.taps.push(tap);
    }

    pub fn taps(&self) -> &[SupplyTap] {
        &self.taps
    }

    /// Where a driver sits among the taps, if it belongs to one.
    fn tap_of(&self, driver: DriverId) -> Option<(usize, usize)> {
        self.taps
            .iter()
            .enumerate()
            .find_map(|(k, tap)| tap.drivers.iter().position(|d| *d == driver).map(|j| (k, j)))
    }

    /// Whether a driver is driving, as of now: for the start of a run.
    pub fn set_driver(&mut self, driver: DriverId, active: bool) {
        if let Some((k, j)) = self.tap_of(driver) {
            self.tap_active[k][j] = active;
        }
    }

    /// Whether a driver is driving from `time` on, applied once the solve
    /// reaches it. Changes arrive in time order.
    pub fn queue_driver(&mut self, time: f64, driver: DriverId, active: bool) {
        if let Some((tap, j)) = self.tap_of(driver) {
            self.tap_pending.push_back(TapChange { time, tap, driver: j, active });
        }
    }

    /// Apply every queued change at or before `t`.
    pub fn reach_drivers(&mut self, t: f64) {
        while let Some(change) = self.tap_pending.front().copied().filter(|c| c.time <= t) {
            self.tap_active[change.tap][change.driver] = change.active;
            self.tap_pending.pop_front();
        }
    }

    /// The share of the output current each tap carries: its drivers that are
    /// driving over all the tapped drivers that are. Two packages driving one
    /// net together — a bus in contention, or two outputs tied — each supply
    /// their part. None of them driving leaves the current on the reference.
    fn tap_share(&self, k: usize) -> f64 {
        let count = |flags: &Vec<bool>| flags.iter().filter(|a| **a).count();
        let total: usize = self.tap_active.iter().map(count).sum();
        if total == 0 { 0.0 } else { count(&self.tap_active[k]) as f64 / total as f64 }
    }

    /// Names of the currents the taps report, after the bridge's own name: per
    /// package, what comes in at its positive leg, what goes out at its negative
    /// one, and what its output puts into the net.
    pub fn tap_names(&self) -> Vec<String> {
        (1..=self.taps.len())
            .flat_map(|k| {
                [
                    format!("{}:p{k}", self.name),
                    format!("{}:m{k}", self.name),
                    format!("{}:o{k}", self.name),
                ]
            })
            .collect()
    }

    /// The output current at node voltage `vn` and instant `t`, positive out of
    /// the output into its load. Zero while released.
    fn output_current(&self, vn: f64, t: f64) -> f64 {
        if !self.driving {
            return 0.0;
        }
        let g = 1.0 / self.family.r_out.max(1e-6);
        g * (self.voltage_at(t) - vn)
    }

    /// The tap currents at a solution, in the order of [`Self::tap_names`]. The
    /// legs' are each into the package, so the positive leg's is what it sources
    /// and the negative leg's is minus what it sinks; the output's is out of the
    /// package into the net. The three add to zero: the package passes on what
    /// it takes in.
    pub fn tap_currents(&self, x: &[f64], t: f64, out: &mut Vec<f64>) {
        let vn = node_index(self.node).map_or(0.0, |i| x.get(i).copied().unwrap_or(0.0));
        let (is, ik, _, _) = split_output(self.output_current(vn, t));
        for k in 0..self.taps.len() {
            let w = self.tap_share(k);
            out.push(w * is);
            out.push(-w * ik);
            out.push(w * (is - ik));
        }
    }

    /// Output voltage at time `t`, interpolated across any ramp in progress.
    pub fn voltage_at(&self, t: f64) -> f64 {
        if self.ramp_duration <= 0.0 {
            return self.to;
        }
        let alpha = ((t - self.ramp_start) / self.ramp_duration).clamp(0.0, 1.0);
        self.from + (self.to - self.from) * alpha
    }

    /// React to the digital net settling on a new value at time `now`.
    pub fn notify(&mut self, state: Logic, now: f64) {
        let current = self.voltage_at(now);
        let (target, driving) = match state {
            Logic::Low => (self.family.v_low, true),
            Logic::High => (self.family.v_high, true),
            // An unresolved net is genuinely somewhere in between; showing that
            // is more honest than silently holding the last good level.
            Logic::Unknown => (self.family.mid(), true),
            Logic::HighZ => (current, false),
        };
        self.driving = driving;
        if !driving {
            self.from = current;
            self.to = current;
            self.ramp_duration = 0.0;
            return;
        }

        let full_swing = (self.family.v_high - self.family.v_low).abs().max(1e-12);
        let slew = if target > current { self.family.rise } else { self.family.fall };
        // Scale the ramp to the fraction of the rail we are actually crossing.
        let duration = slew * ((target - current).abs() / full_swing);

        self.from = current;
        self.to = target;
        self.ramp_start = now;
        self.ramp_duration = duration.max(0.0);
    }

    /// Hold the output at a voltage, with no ramp: the time average of a net
    /// that is switching faster than anything on the analog side can follow.
    pub fn hold(&mut self, voltage: f64) {
        self.driving = true;
        self.from = voltage;
        self.to = voltage;
        self.ramp_duration = 0.0;
    }

    /// The voltage a level is driven to.
    pub fn level_voltage(&self, state: Logic) -> f64 {
        match state {
            Logic::Low => self.family.v_low,
            Logic::High => self.family.v_high,
            _ => self.family.mid(),
        }
    }

    /// Jump straight to a level with no ramp.
    ///
    /// Only correct at t=0, where a ramp would be an artifact of starting the
    /// simulation rather than anything the circuit actually does.
    pub fn set_level(&mut self, state: Logic, now: f64) {
        self.notify(state, now);
        self.from = self.to;
        self.ramp_start = now;
        self.ramp_duration = 0.0;
    }

    /// End of the ramp in progress, if it is still ahead of `t`.
    pub fn next_breakpoint(&self, t: f64) -> Option<f64> {
        let end = self.ramp_start + self.ramp_duration;
        (self.ramp_duration > 0.0 && end > t + 1e-18).then_some(end)
    }

    /// Step limit while a ramp is in flight, so the edge is actually resolved.
    pub fn max_timestep(&self, t: f64) -> f64 {
        let end = self.ramp_start + self.ramp_duration;
        if self.ramp_duration > 0.0 && t < end {
            (self.ramp_duration / 4.0).max(1e-15)
        } else {
            f64::INFINITY
        }
    }

    pub fn reset(&mut self) {
        let mid = self.family.mid();
        self.from = mid;
        self.to = mid;
        self.ramp_start = 0.0;
        self.ramp_duration = 0.0;
        self.driving = true;
        for flags in &mut self.tap_active {
            flags.fill(false);
        }
        self.tap_pending.clear();
        self.tap_slopes = (0.0, 0.0);
    }
}

impl Element for DacBridge {
    fn kind(&self) -> &'static str {
        "dac_bridge"
    }
    fn name(&self) -> &str {
        &self.name
    }

    fn stamp(&mut self, sys: &mut LinearSystem, ctx: &StampCtx) -> StampReport {
        let node = node_index(self.node);
        if !self.driving {
            // Released: leave only enough conductance to keep the node anchored.
            sys.add_conductance(node, None, 1e-12);
            return StampReport::CLEAN;
        }
        let g = 1.0 / self.family.r_out.max(1e-6);
        let v = self.voltage_at(ctx.time) * ctx.source_scale;
        sys.add_conductance(node, None, g);
        // Norton current source pushing the node toward `v`.
        sys.add_current(node, None, -g * v);

        // The same current through the package's supply legs: what the output
        // sources is drawn from its positive leg into the reference the Norton
        // pair returns to, and what it sinks is handed from that reference to
        // its negative leg. The reference then carries nothing on the output's
        // account, and each leg carries what a real output stage's switch to it
        // would. Linearised about the iterate, since the split is not linear.
        if !self.taps.is_empty() {
            let vn = ctx.voltage(self.node);
            let i = g * (v - vn);
            let (is, ik, dis, dik) = split_output(i);
            // Against the node voltage: the output current falls as the node rises.
            let (js, jk) = (-g * dis, -g * dik);
            self.tap_slopes = (js, jk);
            for k in 0..self.taps.len() {
                let w = self.tap_share(k);
                if w == 0.0 {
                    continue;
                }
                let (plus, minus) = (node_index(self.taps[k].plus), node_index(self.taps[k].minus));
                // Out of the positive leg: `w * is`.
                sys.add(plus, node, w * js);
                sys.add_current(plus, None, w * (is - js * vn));
                // Out of the negative leg: `-w * ik`, which is into it.
                sys.add(minus, node, -w * jk);
                sys.add_current(minus, None, -w * (ik - jk * vn));
            }
        }
        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        // A driven digital output is a low impedance to ground as far as a small
        // signal is concerned; a released one is not there at all.
        let g = if self.driving { 1.0 / self.family.r_out.max(1e-6) } else { 1e-12 };
        let node = node_index(self.node);
        sys.add_admittance(node, None, C64::real(g));
        if self.driving {
            let (js, jk) = self.tap_slopes;
            for k in 0..self.taps.len() {
                let w = self.tap_share(k);
                if w == 0.0 {
                    continue;
                }
                let (plus, minus) = (node_index(self.taps[k].plus), node_index(self.taps[k].minus));
                sys.add(plus, node, C64::real(w * js));
                sys.add(minus, node, C64::real(-w * jk));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Analog -> digital
// ---------------------------------------------------------------------------

/// Watches an analog node and drives a digital net when it crosses a threshold.
#[derive(Debug, Clone)]
pub struct AdcBridge {
    pub name: String,
    pub node: NodeId,
    pub net: NetId,
    pub family: LogicFamily,
    /// Input-to-output delay of the receiver.
    pub delay: f64,
    /// Supply nodes the thresholds are fractions of, when they are.
    pub reference: Option<(NodeId, NodeId)>,
    driver: DriverId,
    state: Logic,
    last_sample: Option<(f64, f64)>,
}

impl AdcBridge {
    pub fn new(
        name: impl Into<String>,
        node: NodeId,
        net: NetId,
        family: LogicFamily,
        driver: DriverId,
    ) -> Self {
        Self {
            name: name.into(),
            node,
            net,
            family,
            delay: 0.0,
            reference: None,
            driver,
            state: Logic::Unknown,
            last_sample: None,
        }
    }

    pub fn driver(&self) -> DriverId {
        self.driver
    }

    pub fn state(&self) -> Logic {
        self.state
    }

    /// Logic level a voltage maps to, given the level we are currently reading.
    /// Between the two thresholds the previous level is held — that hysteresis is
    /// what keeps a slowly rising edge from chattering.
    fn classify(&self, v: f64) -> Logic {
        if v >= self.family.v_ih {
            Logic::High
        } else if v <= self.family.v_il {
            Logic::Low
        } else {
            self.state
        }
    }

    /// Feed an accepted analog timepoint.
    ///
    /// Returns the digital event to schedule, if the node crossed a threshold.
    /// The event time is interpolated back to the estimated crossing instant so a
    /// coarse analog step does not smear the edge to the end of the step.
    ///
    /// The instant is never earlier than the previous sample, which is also the
    /// last time the digital domain settled — so the caller can schedule it as it
    /// stands. A negative delay would be the one way to break that, and there is
    /// no such thing as a receiver that answers before it is asked.
    pub fn sample(&mut self, time: f64, voltage: f64) -> Option<(f64, Logic)> {
        let next = self.classify(voltage);
        let previous = self.state;
        let prior = self.last_sample;
        self.last_sample = Some((time, voltage));

        if next == previous {
            return None;
        }
        self.state = next;

        let delay = self.delay.max(0.0);
        let threshold = match next {
            Logic::High => self.family.v_ih,
            Logic::Low => self.family.v_il,
            _ => return Some((time + delay, next)),
        };

        let crossing = match prior {
            Some((t0, v0)) if (voltage - v0).abs() > f64::MIN_POSITIVE => {
                let alpha = (threshold - v0) / (voltage - v0);
                (t0 + (time - t0) * alpha).clamp(t0, time)
            }
            _ => time,
        };
        Some((crossing + delay, next))
    }

    pub fn reset(&mut self) {
        self.state = Logic::Unknown;
        self.last_sample = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dac_ramps_instead_of_jumping() {
        let family = LogicFamily::cmos_5v();
        let mut dac = DacBridge::new("B1", 0, 1, family);
        dac.set_level(Logic::Low, 0.0);
        assert!((dac.voltage_at(0.0) - 0.0).abs() < 1e-9);

        dac.notify(Logic::High, 10e-9);
        // Halfway through a full-swing 2 ns rise.
        let mid = dac.voltage_at(10e-9 + 1e-9);
        assert!((mid - 2.5).abs() < 1e-6, "got {mid}");
        assert!((dac.voltage_at(10e-9 + 2e-9) - 5.0).abs() < 1e-9);
        assert!((dac.voltage_at(1.0) - 5.0).abs() < 1e-9);
    }

    #[test]
    fn dac_ramp_scales_with_the_swing() {
        let family = LogicFamily::cmos_5v();
        let mut dac = DacBridge::new("B1", 0, 1, family);
        dac.set_level(Logic::Low, 0.0);
        // Half a rail of swing should take half the rise time.
        dac.notify(Logic::Unknown, 0.0);
        assert_eq!(dac.next_breakpoint(0.0), Some(1e-9));
    }

    #[test]
    fn dac_releases_on_high_z() {
        let mut dac = DacBridge::new("B1", 0, 1, LogicFamily::cmos_5v());
        dac.set_level(Logic::High, 0.0);
        dac.notify(Logic::HighZ, 5e-9);
        let mut sys = LinearSystem::new(1);
        let ctx = StampCtx {
            mode: crate::element::Mode::Transient,
            integration: Default::default(),
            time: 10e-9,
            dt: 1e-9,
            gmin: 1e-12,
            source_scale: 1.0,
            x: &[5.0],
            iteration: 0,
        };
        dac.stamp(&mut sys, &ctx);
        // Only the anchoring leak, no drive current.
        assert!(sys.rhs()[0].abs() < 1e-15);
    }

    #[test]
    fn adc_holds_between_thresholds() {
        let mut adc = AdcBridge::new("A1", 1, 0, LogicFamily::cmos_5v(), DriverId(0));
        assert_eq!(adc.sample(0.0, 0.0), Some((0.0, Logic::Low)));
        // Inside the hysteresis band nothing changes.
        assert_eq!(adc.sample(1e-9, 2.5), None);
        assert!(adc.sample(2e-9, 4.0).is_some());
        assert_eq!(adc.state(), Logic::High);
        // Coming back down, 2.5 V is still not enough to fall.
        assert_eq!(adc.sample(3e-9, 2.5), None);
        assert!(adc.sample(4e-9, 1.0).is_some());
    }

    #[test]
    fn adc_interpolates_the_crossing_instant() {
        let mut adc = AdcBridge::new("A1", 1, 0, LogicFamily::cmos_5v(), DriverId(0));
        adc.sample(0.0, 0.0);
        // Ramp from 0 V to 5 V across a 10 ns step: the 2.6 V rising threshold
        // is crossed at 5.2 ns, not at the end of the step.
        let (t, state) = adc.sample(10e-9, 5.0).unwrap();
        assert_eq!(state, Logic::High);
        assert!((t - 5.2e-9).abs() < 1e-12, "got {t}");
    }
}
