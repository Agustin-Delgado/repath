//! A passive piezo buzzer: what it is being driven at, as tones.
//!
//! Electrically a passive piezo is a capacitor, a ceramic disc a few tens of
//! nanofarads across; the editor builds it as the resistance that draws the
//! same average current, which is what its pin and supply see. What it sounds
//! like is not something the analog side can say: a pin toggling a thousand
//! times a second is folded into an average by its bridge whenever nothing
//! reads the node back, and a waveform kept at the screen's resolution has no
//! edges left in it to count.
//!
//! So the sound is read where the edges are exact: on the logic nets that
//! drive its two legs. This device listens to them and times each rising edge
//! of the drive across the disc — high when the `plus` leg is high and the
//! `minus` leg is not, so a buzzer between two pins toggled in opposition is
//! heard too. Two consecutive periods within [`TOLERANCE`] of each other
//! start a [`Tone`], and it goes on for as long as the periods stay that close
//! to its mean; a lone period is a click, not a pitch — the gap between two
//! notes is one — and a gap longer than [`LONGEST_PERIOD`] is silence. Only
//! the frequency is kept: a piezo's loudness and timbre depend on its
//! resonance and its mounting, which no drawing says anything about.

use crate::digital::{DigitalDevice, DigitalDomain, EvalCtx, Logic, NetId};

/// How far a period may stray from the mean of the tone it is in and still
/// be part of it, as a fraction of that mean.
///
/// Two semitones apart are 5.9 % apart, so a melody's notes never merge; a
/// tone bit-banged with `delayMicroseconds()` wobbles by the few microseconds
/// Timer0's interrupt takes, under 3 % up to a few kilohertz.
pub const TOLERANCE: f64 = 0.04;

/// The longest period counted as a tone, in seconds: 20 Hz, the bottom of
/// hearing. A slower drive is a series of clicks, not a pitch.
pub const LONGEST_PERIOD: f64 = 0.05;

/// The most tones kept. A siren sweeping continuously starts a new one every
/// few percent of pitch, which at worst is a few hundred a second; past this
/// the oldest go.
pub const KEPT: usize = 4096;

/// A stretch of steady pitch: rising edges from `start` to `last` with
/// `cycles` periods between them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tone {
    /// The first rising edge, in seconds.
    pub start: f64,
    /// The last rising edge.
    pub last: f64,
    pub cycles: u32,
    /// When it stops sounding: the rising edge that would have come next,
    /// since the last period's second half is still being driven up to then —
    /// or, where another tone follows straight on, the start of that one.
    pub end: f64,
}

impl Tone {
    /// The mean period, in seconds.
    pub fn period(&self) -> f64 {
        (self.last - self.start) / f64::from(self.cycles)
    }

    pub fn frequency(&self) -> f64 {
        1.0 / self.period()
    }

    fn new(start: f64, last: f64, cycles: u32) -> Self {
        let mut tone = Self { start, last, cycles, end: last };
        tone.end = last + tone.period();
        tone
    }
}

#[derive(Debug, Clone)]
pub struct Buzzer {
    pub name: String,
    plus: Option<NetId>,
    minus: Option<NetId>,
    inputs: Vec<NetId>,
    /// The drive across it as of the last change: plus high and minus not.
    driven: bool,
    last_rise: Option<f64>,
    /// The tone still being extended, if it is sounding.
    open: Option<Tone>,
    /// A single period that may be the first of a tone, if the next agrees.
    pending: Option<Tone>,
    /// Finished tones, oldest first.
    tones: Vec<Tone>,
    /// How many finished tones have been dropped from the front of `tones`.
    dropped: usize,
}

impl Buzzer {
    /// A buzzer with its legs on these nets. A leg on no logic net — ground,
    /// most often — counts as low.
    pub fn new(name: impl Into<String>, plus: Option<NetId>, minus: Option<NetId>) -> Self {
        Self {
            name: name.into(),
            plus,
            minus,
            inputs: plus.into_iter().chain(minus).collect(),
            driven: false,
            last_rise: None,
            open: None,
            pending: None,
            tones: Vec::new(),
            dropped: 0,
        }
    }

    fn drive(&self, ctx: &EvalCtx) -> bool {
        let high = |net: Option<NetId>| net.is_some_and(|n| ctx.read(n) == Logic::High);
        high(self.plus) && !high(self.minus)
    }

    /// Finished tones from the `from`-th of the run on, counting those already
    /// dropped; any of those asked for that are gone are skipped.
    pub fn tones_from(&self, from: usize) -> &[Tone] {
        let skip = from.saturating_sub(self.dropped).min(self.tones.len());
        &self.tones[skip..]
    }

    /// How many tones have finished over the whole run.
    pub fn finished(&self) -> usize {
        self.dropped + self.tones.len()
    }

    /// The tone being extended: still sounding if the run is before its
    /// `end`, finished but not yet known to be otherwise.
    pub fn open(&self) -> Option<Tone> {
        self.open
    }

    /// The tone sounding at `time`, finished or not, if any is.
    pub fn tone_at(&self, time: f64) -> Option<Tone> {
        self.open
            .iter()
            .chain(self.tones.iter().rev())
            .find(|tone| tone.start <= time && time < tone.end)
            .copied()
    }

    fn finish(&mut self) {
        if let Some(tone) = self.open.take() {
            self.tones.push(tone);
            if self.tones.len() > KEPT {
                let excess = self.tones.len() - KEPT;
                self.tones.drain(..excess);
                self.dropped += excess;
            }
        }
    }

    fn rise(&mut self, time: f64) {
        let Some(previous) = self.last_rise.replace(time) else { return };
        let period = time - previous;
        if period <= 0.0 {
            return;
        }
        if period > LONGEST_PERIOD {
            self.finish();
            self.pending = None;
            return;
        }
        let near = |tone: &Tone| (period - tone.period()).abs() <= TOLERANCE * tone.period();
        if let Some(open) = self.open.as_mut().filter(|open| near(open)) {
            *open = Tone::new(open.start, time, open.cycles + 1);
            return;
        }
        self.finish();
        match self.pending.take() {
            Some(first) if near(&first) => {
                if let Some(before) = self.tones.last_mut() {
                    before.end = before.end.min(first.start);
                }
                self.open = Some(Tone::new(first.start, time, 2));
            }
            _ => self.pending = Some(Tone::new(previous, time, 1)),
        }
    }
}

impl DigitalDevice for Buzzer {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "buzzer"
    }
    fn input_nets(&self) -> &[NetId] {
        &self.inputs
    }
    fn output_nets(&self) -> &[NetId] {
        &[]
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.driven = self.drive(ctx);
    }

    fn evaluate(&mut self, ctx: &mut EvalCtx) {
        let driven = self.drive(ctx);
        if driven == self.driven {
            return;
        }
        self.driven = driven;
        if driven {
            self.rise(ctx.now);
        }
    }

    fn reset(&mut self) {
        self.driven = false;
        self.last_rise = None;
        self.open = None;
        self.pending = None;
        self.tones.clear();
        self.dropped = 0;
    }
}

/// The buzzer by this name in a circuit's digital domain.
pub fn find_buzzer<'a>(domain: &'a DigitalDomain, name: &str) -> Option<&'a Buzzer> {
    domain.device(name).and_then(|device| device.as_any().downcast_ref::<Buzzer>())
}
