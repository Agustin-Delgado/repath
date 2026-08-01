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
    pub v_il: f64,
    /// Input threshold for a rising signal. Must be above `v_il` — the gap is
    /// the hysteresis that stops a slow edge from producing a burst of events.
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
    pub fn cmos_5v() -> Self {
        Self { v_low: 0.0, v_high: 5.0, v_il: 1.5, v_ih: 3.5, r_out: 50.0, rise: 2e-9, fall: 2e-9 }
    }

    pub fn cmos_3v3() -> Self {
        Self {
            v_low: 0.0,
            v_high: 3.3,
            v_il: 0.99,
            v_ih: 2.31,
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
        StampReport::CLEAN
    }

    fn ac_stamp(&self, sys: &mut ComplexSystem, _ctx: &AcCtx) {
        // A driven digital output is a low impedance to ground as far as a small
        // signal is concerned; a released one is not there at all.
        let g = if self.driving { 1.0 / self.family.r_out.max(1e-6) } else { 1e-12 };
        sys.add_admittance(node_index(self.node), None, C64::real(g));
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
    pub fn sample(&mut self, time: f64, voltage: f64) -> Option<(f64, Logic)> {
        let next = self.classify(voltage);
        let previous = self.state;
        let prior = self.last_sample;
        self.last_sample = Some((time, voltage));

        if next == previous {
            return None;
        }
        self.state = next;

        let threshold = match next {
            Logic::High => self.family.v_ih,
            Logic::Low => self.family.v_il,
            _ => return Some((time + self.delay, next)),
        };

        let crossing = match prior {
            Some((t0, v0)) if (voltage - v0).abs() > f64::MIN_POSITIVE => {
                let alpha = (threshold - v0) / (voltage - v0);
                (t0 + (time - t0) * alpha).clamp(t0, time)
            }
            _ => time,
        };
        Some((crossing + self.delay, next))
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
        // Ramp from 0 V to 5 V across a 10 ns step: 3.5 V is crossed at 7 ns,
        // not at the end of the step.
        let (t, state) = adc.sample(10e-9, 5.0).unwrap();
        assert_eq!(state, Logic::High);
        assert!((t - 7e-9).abs() < 1e-12, "got {t}");
    }
}
