//! A hobby servo motor, an SG90 or anything driven like one: three wires,
//! ground, supply and signal, and a horn that turns to the angle the width of
//! the pulses on the signal wire asks for.
//!
//! The servo's own electronics measure every high pulse on the signal wire and
//! drive the motor until the potentiometer on the output shaft agrees with it.
//! That is what this does, on the digital side: it times each pulse from its
//! rising edge to its falling edge, turns the width into a target angle, and
//! swings the horn towards it at the motor's speed.
//!
//! - The mapping is the Arduino Servo library's: 544 µs is 0° and 2400 µs is
//!   180°, so `Servo::write(angle)` lands on that angle. A real SG90's travel
//!   is near enough the same that the library's defaults were chosen for it.
//! - A pulse outside 400–2600 µs, or one that comes less than [`MIN_GAP`]
//!   after the last fell — the 490 Hz of `analogWrite()`, not a servo frame —
//!   is not a position, and is ignored: the horn holds where it was going, as
//!   a real servo's does.
//! - The horn turns at [`SLEW`], the datasheet's 0.1 s per 60°, and only while
//!   pulses keep coming: an analog servo drives its motor in bursts after each
//!   pulse, so with the pulses gone it stops within a frame and stays put.
//!
//! The supply is the netlist's business: the servo's load on its rail is an
//! ordinary resistor there, so nothing here knows what the rail is at.

use crate::digital::{DigitalDevice, EvalCtx, Logic, NetId};

/// The pulse that means 0°, in seconds: the Servo library's `MIN_PULSE_WIDTH`.
pub const PULSE_AT_0: f64 = 544e-6;
/// The pulse that means 180°: the Servo library's `MAX_PULSE_WIDTH`.
pub const PULSE_AT_180: f64 = 2400e-6;
/// The narrowest and widest pulses taken for a position at all. Inside them and
/// past either end of the travel, the horn goes to that end.
pub const MIN_PULSE: f64 = 400e-6;
pub const MAX_PULSE: f64 = 2600e-6;
/// The least the line must have been low before a pulse for it to count: a
/// servo frame is 20 ms, and anything much faster is PWM meant for something
/// else.
pub const MIN_GAP: f64 = 3e-3;
/// How fast the horn turns, in degrees a second: 0.1 s per 60° at 4.8 V.
pub const SLEW: f64 = 600.0;
/// How long the motor keeps being driven after the last pulse it was given,
/// in seconds: a frame and a bit, so pulses every 20 ms drive it without a
/// break.
pub const DRIVE_HOLD: f64 = 25e-3;
/// Where the horn is at the start of a run.
pub const START_ANGLE: f64 = 90.0;

/// The angle a pulse of `width` seconds asks for, or `None` if it is not a
/// position at all.
pub fn angle_for(width: f64) -> Option<f64> {
    if !(MIN_PULSE..=MAX_PULSE).contains(&width) {
        return None;
    }
    let angle = (width - PULSE_AT_0) / (PULSE_AT_180 - PULSE_AT_0) * 180.0;
    Some(angle.clamp(0.0, 180.0))
}

/// The last pulse the servo measured, whether or not it took it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pulse {
    /// When it fell, in seconds.
    pub at: f64,
    /// How long it was high.
    pub width: f64,
    /// Whether it moved the target: in range, and after a long enough gap.
    pub taken: bool,
}

#[derive(Debug, Clone)]
pub struct Servo {
    pub name: String,
    signal: NetId,
    inputs: Vec<NetId>,
    /// When the pulse in progress rose, while the line is high.
    rose: Option<f64>,
    /// When the line last fell; the run starts after a long time low.
    fell: f64,
    /// The horn was at `from` at `since`, turning towards `target` until it
    /// gets there or `driven_until`, whichever is first.
    from: f64,
    since: f64,
    target: f64,
    driven_until: f64,
    last: Option<Pulse>,
    /// Bumped whenever a pulse is measured.
    version: u64,
}

impl Servo {
    pub fn new(name: impl Into<String>, signal: NetId) -> Self {
        Self {
            name: name.into(),
            signal,
            inputs: vec![signal],
            rose: None,
            fell: f64::NEG_INFINITY,
            from: START_ANGLE,
            since: 0.0,
            target: START_ANGLE,
            driven_until: 0.0,
            last: None,
            version: 0,
        }
    }

    /// Where the horn is at `time`, in degrees from the 0° end.
    ///
    /// Asked for an instant before the last pulse it measured, it answers for
    /// that pulse's instant: what happened before is not kept.
    pub fn angle(&self, time: f64) -> f64 {
        let end = time.min(self.driven_until).max(self.since);
        let travel = (end - self.since) * SLEW;
        if self.target >= self.from {
            (self.from + travel).min(self.target)
        } else {
            (self.from - travel).max(self.target)
        }
    }

    /// The angle the last pulse taken asked for.
    pub fn target(&self) -> f64 {
        self.target
    }

    pub fn last_pulse(&self) -> Option<Pulse> {
        self.last
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    fn fall(&mut self, now: f64, rose: f64) {
        let width = now - rose;
        let gap = rose - self.fell;
        let angle = angle_for(width).filter(|_| gap >= MIN_GAP);
        if let Some(angle) = angle {
            self.from = self.angle(now);
            self.since = now;
            self.target = angle;
            self.driven_until = now + DRIVE_HOLD;
        }
        self.last = Some(Pulse { at: now, width, taken: angle.is_some() });
        self.version += 1;
    }
}

impl DigitalDevice for Servo {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "servo"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &[]
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        // A line already high when the run starts is not a pulse whose start
        // anyone saw.
        if ctx.read(self.signal) == Logic::High {
            self.fell = ctx.now;
        }
    }

    /// Anything but a driven high is low: an unknown or let-go line ends a
    /// pulse, and the servo's input pulls down.
    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        let high = ctx.read(self.signal) == Logic::High;
        match (high, self.rose) {
            (true, None) => self.rose = Some(ctx.now),
            (false, Some(rose)) => {
                self.rose = None;
                self.fall(ctx.now, rose);
                self.fell = ctx.now;
            }
            _ => {}
        }
    }

    fn reset(&mut self) {
        *self = Servo::new(std::mem::take(&mut self.name), self.signal);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::digital::{DigitalDomain, LogicSource};

    /// A domain with a servo on a net that a logic source drives high and low
    /// at `edges`, starting low.
    fn driven(edges: &[f64]) -> DigitalDomain {
        let mut domain = DigitalDomain::new();
        let net = domain.add_net("sig");
        domain.add_device(Box::new(
            LogicSource::new("SRC", net, Logic::Low).operated_at(edges.iter().copied()),
        ));
        domain.add_device(Box::new(Servo::new("M1", net)));
        domain.initialize();
        domain
    }

    fn servo(domain: &DigitalDomain) -> &Servo {
        domain.device("M1").unwrap().as_any().downcast_ref::<Servo>().unwrap()
    }

    /// Pulses of `width` every 20 ms from 20 ms on, `count` of them.
    fn frames(width: f64, count: usize) -> Vec<f64> {
        (1..=count).flat_map(|i| [i as f64 * 0.02, i as f64 * 0.02 + width]).collect()
    }

    #[test]
    fn the_servo_library_ends_map_to_the_ends_of_the_travel() {
        assert_eq!(angle_for(544e-6), Some(0.0));
        assert_eq!(angle_for(2400e-6), Some(180.0));
        assert!((angle_for(1472e-6).unwrap() - 90.0).abs() < 1e-9);
        assert_eq!(angle_for(450e-6), Some(0.0), "past the end, but a position");
        assert_eq!(angle_for(300e-6), None);
        assert_eq!(angle_for(3e-3), None);
    }

    #[test]
    fn the_horn_turns_at_its_rated_speed_to_the_angle_asked_for() {
        let mut domain = driven(&frames(544e-6, 20));
        let first = 0.02 + 544e-6;
        // 90° to go at 600°/s is 150 ms, through every pulse on the way.
        domain.settle(first + 0.075);
        assert!((servo(&domain).angle(first + 0.075) - 45.0).abs() < 1e-6);
        domain.settle(0.5);
        let s = servo(&domain);
        assert_eq!(s.angle(0.5), 0.0);
        assert_eq!(s.target(), 0.0);
        assert!(s.last_pulse().unwrap().taken);
    }

    #[test]
    fn a_pulse_out_of_range_or_too_soon_holds_the_last_angle() {
        // Settle at 180°, then pulses of 3 ms, then PWM at 490 Hz.
        let mut edges = frames(2400e-6, 20);
        edges.extend((21..=30).flat_map(|i| [i as f64 * 0.02, i as f64 * 0.02 + 3e-3]));
        let pwm = 0.62;
        edges.extend((0..50).flat_map(|i| [pwm + i as f64 / 490.0, pwm + i as f64 / 490.0 + 1e-3]));
        let mut domain = driven(&edges);
        domain.settle(0.615);
        let s = servo(&domain);
        assert_eq!(s.angle(0.615), 180.0);
        assert_eq!(s.target(), 180.0);
        assert!(!s.last_pulse().unwrap().taken, "3 ms is not a position");
        // The PWM's first pulse follows a long low and is a position, 44°;
        // every one after it comes 1 ms after the last and is not, so the
        // horn has 25 ms of driving towards 44° and then stops.
        domain.settle(0.75);
        let s = servo(&domain);
        assert!((s.angle(0.75) - (180.0 - SLEW * DRIVE_HOLD)).abs() < 1e-6);
        let last = s.last_pulse().unwrap();
        assert!(!last.taken);
        assert!((last.width - 1e-3).abs() < 1e-9);
    }

    #[test]
    fn with_the_pulses_gone_the_horn_stops_where_it_is() {
        // One pulse for 0°: driven for 25 ms after it, so 15° of the way.
        let mut domain = driven(&[0.02, 0.02 + 544e-6]);
        domain.settle(1.0);
        let s = servo(&domain);
        let expected = 90.0 - SLEW * DRIVE_HOLD;
        assert!((s.angle(1.0) - expected).abs() < 1e-6, "{}", s.angle(1.0));
    }
}
