//! The analog-to-digital converter: ADMUX, ADCSRA, ADCSRB, ADCL and ADCH.
//!
//! What a conversion reads is a voltage, and the chip is a digital device
//! that never sees one. So the converter only keeps time here: when a
//! conversion starts, when it samples, when it is done. The voltages come
//! from outside, as an [`AnalogLevels`] measured at the sample-and-hold
//! instant, and a conversion cannot complete without them — the machine stops
//! there and waits to be given them (see `Stop::Sample` and the device in
//! `mod.rs`, which gets them from the analog solver).
//!
//! The timing is the datasheet's, in ADC clocks of `F_CPU / prescaler`: the
//! prescaler runs from the moment ADEN is set, a conversion starts on the
//! ADC clock edge after ADSC is written, samples 1.5 clocks in and is done 13
//! clocks in — 13.5 and 25 for the first after the converter is switched on,
//! which spends the extra twelve initialising its analog circuitry.
//!
//! Not modelled: auto triggering from anything but free running (a timer,
//! the comparator, an external interrupt — the device is told and says so),
//! the start of a conversion on entering ADC noise reduction sleep, the
//! sampling capacitor's load on the pin, and the reference settling after it
//! is switched. The temperature sensor reads 0 V.

/// Data-space addresses.
pub const ADCL: u8 = 0x78;
pub const ADCH: u8 = 0x79;
pub const ADCSRA: u8 = 0x7A;
pub const ADCSRB: u8 = 0x7B;
pub const ADMUX: u8 = 0x7C;
pub const DIDR0: u8 = 0x7E;

// ADCSRA's bits.
const ADEN: u8 = 1 << 7;
const ADSC: u8 = 1 << 6;
const ADATE: u8 = 1 << 5;
const ADIF: u8 = 1 << 4;
const ADIE: u8 = 1 << 3;

// ADMUX's.
const ADLAR: u8 = 1 << 5;

/// ADMUX's MUX3:0 for the temperature sensor.
pub const TEMPERATURE_CHANNEL: u8 = 0x08;

/// The internal bandgap reference, as both an input (MUX 1110) and a
/// reference (REFS 11): the datasheet's typical 1.1 V. A real part is
/// anywhere from 1.0 V to 1.2 V, which is why a sketch that cares calibrates.
pub const BANDGAP: f64 = 1.1;

/// What a conversion can be asked to measure, as it was at its
/// sample-and-hold instant: volts from circuit ground on each ADC pin, and on
/// the three legs that set the reference and the ground it is measured from.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AnalogLevels {
    /// ADC0 to ADC5, which are PC0 to PC5.
    pub channels: [f64; 6],
    pub aref: f64,
    pub avcc: f64,
    pub agnd: f64,
}

impl AnalogLevels {
    /// The conversion's result with ADMUX at `admux`.
    pub fn convert(&self, admux: u8) -> u16 {
        let input = match admux & 0x0F {
            ch @ 0..=5 => self.channels[usize::from(ch)] - self.agnd,
            // ADC6 and ADC7 are bonded out only on the surface-mount
            // packages; on the DIP there is nothing there. The temperature
            // sensor is not modelled, and the device says so.
            0x0E => BANDGAP,
            _ => 0.0,
        };
        let reference = match admux >> 6 {
            1 => self.avcc - self.agnd,
            3 => BANDGAP,
            // 10 is reserved; read as AREF, which is what it differs from by
            // the bit the datasheet gives no meaning.
            _ => self.aref - self.agnd,
        };
        transfer(input, reference)
    }
}

/// The datasheet's single-ended transfer function, ADC = Vin · 1024 / Vref,
/// truncated as a successive approximation does, and clamped to the ten bits
/// there are: 0 is ground and 0x3FF the reference less one LSB, so anything at
/// or past the reference reads 0x3FF. A reference at or below ground has every
/// positive input past it.
pub fn transfer(input: f64, reference: f64) -> u16 {
    // A NaN input reads as ground rather than as anything else.
    if input.is_nan() || input <= 0.0 {
        return 0;
    }
    if reference.is_nan() || reference <= 0.0 || input >= reference {
        return 0x3FF;
    }
    ((input * 1024.0 / reference).floor() as u16).min(0x3FF)
}

#[derive(Debug, Clone, Copy)]
struct Conversion {
    start: u64,
    sample_at: u64,
    done_at: u64,
    /// The channel and reference, as latched when it started.
    admux: u8,
    /// What was there at `sample_at`, once somebody has said.
    levels: Option<AnalogLevels>,
}

#[derive(Debug, Clone, Default)]
pub struct Adc {
    /// ADCSRA's ADEN, ADATE, ADIE and ADPS bits. ADSC and ADIF are state.
    control: u8,
    /// ADIF.
    flag: bool,
    pub admux: u8,
    pub adcsrb: u8,
    pub didr0: u8,
    /// The data register's ten bits.
    result: u16,
    /// Set by reading ADCL, cleared by reading ADCH: until then a conversion
    /// that completes does not reach the data register.
    locked: bool,
    /// The cycle the prescaler was released at: its clock rises every
    /// `prescaler()` cycles from there.
    enabled_at: u64,
    /// Whether a conversion has completed since ADEN was last set: the first
    /// one after is the long one.
    warmed: bool,
    conversion: Option<Conversion>,
}

impl Adc {
    /// CPU cycles per ADC clock, from ADPS2:0. 000 and 001 both divide by two.
    pub fn prescaler(&self) -> u64 {
        1 << (self.control & 0x07).max(1)
    }

    fn enabled(&self) -> bool {
        self.control & ADEN != 0
    }

    /// Auto triggered from its own completion: the only trigger simulated.
    fn free_running(&self) -> bool {
        self.control & (ADEN | ADATE) == ADEN | ADATE && self.adcsrb & 0x07 == 0
    }

    /// Auto triggering asked for from a source that is not simulated.
    pub fn foreign_trigger(&self) -> bool {
        self.control & (ADEN | ADATE) == ADEN | ADATE && self.adcsrb & 0x07 != 0
    }

    /// ADCSRA. ADSC reads one for as long as a conversion is under way, which
    /// in free running is for good.
    pub fn status(&self) -> u8 {
        let mut v = self.control;
        if self.conversion.is_some() {
            v |= ADSC;
        }
        if self.flag {
            v |= ADIF;
        }
        v
    }

    /// A write to ADCSRA that lands at cycle `at`. Returns whether it started
    /// a conversion.
    pub fn write_status(&mut self, v: u8, at: u64) -> bool {
        let was_enabled = self.enabled();
        // ADIF is cleared by writing a one to it, so a read-modify-write of
        // ADCSRA clears a flag it found set.
        if v & ADIF != 0 {
            self.flag = false;
        }
        self.control = v & !(ADSC | ADIF);
        if !self.enabled() {
            // Switching the converter off ends the conversion under way and
            // stops the prescaler.
            self.conversion = None;
            self.warmed = false;
            return false;
        }
        if !was_enabled {
            self.enabled_at = at;
            self.warmed = false;
        }
        // Writing ADSC during a conversion does nothing, nor does writing zero.
        if v & ADSC == 0 || self.conversion.is_some() {
            return false;
        }
        let p = self.prescaler();
        let start = self.enabled_at + p * ((at - self.enabled_at) / p + 1);
        self.begin(start);
        true
    }

    fn begin(&mut self, start: u64) {
        let p = self.prescaler();
        // In half clocks: the sample-and-hold falls between two edges.
        let (sample, done) = if self.warmed { (3, 26) } else { (27, 50) };
        self.conversion = Some(Conversion {
            start,
            sample_at: start + sample * p / 2,
            done_at: start + done * p / 2,
            admux: self.admux,
            levels: None,
        });
    }

    /// A write to ADMUX landing at `at`. The channel and reference are taken
    /// up continuously until a conversion starts, then held for it; ADLAR
    /// changes how the data register reads at once.
    pub fn write_mux(&mut self, v: u8, at: u64) {
        self.admux = v;
        if let Some(c) = self.conversion.as_mut()
            && at < c.start
        {
            c.admux = v;
        }
    }

    /// ADCL, which holds the data register until ADCH is read.
    pub fn read_low(&mut self) -> u8 {
        self.locked = true;
        if self.admux & ADLAR != 0 { (self.result << 6) as u8 } else { self.result as u8 }
    }

    /// ADCH, which releases it.
    pub fn read_high(&mut self) -> u8 {
        self.locked = false;
        if self.admux & ADLAR != 0 { (self.result >> 2) as u8 } else { (self.result >> 8) as u8 }
    }

    pub fn next_event(&self) -> u64 {
        self.conversion.map_or(u64::MAX, |c| c.done_at)
    }

    /// The sample-and-hold cycle of the conversion under way, while nobody has
    /// said what it sampled.
    pub fn sample_needed(&self) -> Option<u64> {
        self.conversion.filter(|c| c.levels.is_none()).map(|c| c.sample_at)
    }

    /// Whether a conversion is due to complete by `at` without its levels.
    pub fn waiting(&self, at: u64) -> bool {
        self.conversion.is_some_and(|c| c.done_at <= at && c.levels.is_none())
    }

    /// What the conversion under way sampled.
    pub fn give(&mut self, levels: AnalogLevels) {
        if let Some(c) = self.conversion.as_mut() {
            c.levels = Some(levels);
        }
    }

    /// The conversion under way is done: its result goes into the data
    /// register, unless that is held, and ADIF is set either way.
    pub fn complete(&mut self) {
        let Some(c) = self.conversion.take() else { return };
        if !self.locked {
            self.result = c.levels.unwrap_or_default().convert(c.admux);
        }
        self.flag = true;
        self.warmed = true;
        // The next one starts on the edge this one finished on, with whatever
        // ADMUX says by then.
        if self.free_running() {
            self.begin(c.done_at);
        }
    }

    pub fn interrupt(&self) -> bool {
        self.flag && self.control & ADIE != 0
    }

    /// Running the vector clears the flag.
    pub fn acknowledge(&mut self) {
        self.flag = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AVCC: u8 = 0x40;

    fn levels(a0: f64) -> AnalogLevels {
        AnalogLevels { channels: [a0, 0.0, 0.0, 0.0, 0.0, 0.0], aref: 0.0, avcc: 5.0, agnd: 0.0 }
    }

    /// Enabled at prescaler 128, with ADMUX on AVCC and ADC0.
    fn arduino() -> Adc {
        let mut adc = Adc { admux: AVCC, ..Default::default() };
        adc.write_status(ADEN | 0x07, 0);
        adc
    }

    #[test]
    fn the_transfer_function_is_vin_times_1024_over_vref() {
        let lsb = 5.0 / 1024.0;
        // Ground, one LSB, half the reference, the reference less an LSB.
        assert_eq!(transfer(0.0, 5.0), 0);
        assert_eq!(transfer(lsb * 0.999, 5.0), 0);
        assert_eq!(transfer(lsb, 5.0), 1);
        assert_eq!(transfer(2.5, 5.0), 512);
        assert_eq!(transfer(2.5 - 1e-9, 5.0), 511);
        assert_eq!(transfer(5.0 - lsb, 5.0), 1023);
        // At or past the reference it can only say "all ones"; below ground,
        // all zeros.
        assert_eq!(transfer(5.0, 5.0), 1023);
        assert_eq!(transfer(7.0, 5.0), 1023);
        assert_eq!(transfer(-0.3, 5.0), 0);
        assert_eq!(transfer(1.0, 0.0), 1023);
        assert_eq!(transfer(f64::NAN, 5.0), 0);
    }

    #[test]
    fn the_reference_and_channel_come_from_admux() {
        let v = AnalogLevels {
            channels: [0.5, 1.0, 0.0, 0.0, 0.0, 4.0],
            aref: 3.3,
            avcc: 5.0,
            agnd: 0.0,
        };
        // REFS 01, AVCC: 0.5 · 1024 / 5 = 102.4.
        assert_eq!(v.convert(0x40), 102);
        // REFS 11, the internal 1.1 V: 0.5 · 1024 / 1.1 = 465.45.
        assert_eq!(v.convert(0xC0), 465);
        // REFS 00, AREF: 1.0 · 1024 / 3.3 = 310.3, on ADC1.
        assert_eq!(v.convert(0x01), 310);
        // ADC5 at 4 V against 5 V: 819.2.
        assert_eq!(v.convert(0x45), 819);
        // The bandgap as the input against AVCC: 1.1 · 1024 / 5 = 225.28; GND.
        assert_eq!(v.convert(0x4E), 225);
        assert_eq!(v.convert(0x4F), 0);
        // Measured from AGND, not from the circuit's ground.
        let lifted = AnalogLevels { agnd: 0.5, ..v };
        // (1.0 - 0.5) · 1024 / (5 - 0.5) = 113.8.
        assert_eq!(lifted.convert(0x41), 113);
    }

    #[test]
    fn the_prescaler_divides_by_the_datasheet_table() {
        let mut adc = Adc::default();
        let table = [2, 2, 4, 8, 16, 32, 64, 128];
        for (bits, divide) in table.iter().enumerate() {
            adc.write_status(bits as u8, 0);
            assert_eq!(adc.prescaler(), *divide, "ADPS {bits:03b}");
        }
    }

    /// What `analogRead()` does on an Uno: ADEN at prescaler 128 once in
    /// `init()`, then ADSC each time. The first conversion is 25 ADC clocks,
    /// 200 µs at 16 MHz; every one after 13, the 104 µs the Arduino reference
    /// gives for a reading.
    #[test]
    fn a_first_conversion_takes_25_clocks_and_the_rest_13() {
        let mut adc = arduino();
        // ADSC lands at 1000. The ADC clock rises every 128 cycles from 0, so
        // the conversion starts on the edge at 1024.
        assert!(adc.write_status(ADEN | ADSC | 0x07, 1000));
        assert_eq!(adc.sample_needed(), Some(1024 + 27 * 64));
        assert_eq!(adc.next_event(), 1024 + 25 * 128);
        assert_eq!(adc.status() & ADSC, ADSC);
        assert!(adc.waiting(1024 + 25 * 128));
        assert!(!adc.waiting(1024 + 25 * 128 - 1));
        adc.give(levels(2.5));
        adc.complete();
        assert_eq!(adc.status() & (ADSC | ADIF), ADIF);
        assert_eq!((adc.read_low(), adc.read_high()), (0x00, 0x02), "512");

        // The next, written back with ADIF as read — which clears it — starts
        // on the edge after 5000: 5120.
        assert!(adc.write_status(ADEN | ADSC | ADIF | 0x07, 5000));
        assert_eq!(adc.status() & ADIF, 0);
        assert_eq!(adc.sample_needed(), Some(5120 + 3 * 64));
        assert_eq!(adc.next_event(), 5120 + 13 * 128);
        assert_eq!(13.0 * 128.0 / 16e6, 104e-6);
    }

    #[test]
    fn enabling_and_starting_at_once_starts_one_adc_clock_later() {
        let mut adc = Adc { admux: AVCC, ..Default::default() };
        assert!(adc.write_status(ADEN | ADSC | 0x02, 10));
        // Prescaler 4 released at 10: the first edge is at 14.
        assert_eq!(adc.sample_needed(), Some(14 + 27 * 2));
        assert_eq!(adc.next_event(), 14 + 25 * 4);
    }

    #[test]
    fn adsc_during_a_conversion_and_zero_do_nothing_and_aden_off_ends_it() {
        let mut adc = arduino();
        assert!(!adc.write_status(ADEN | 0x07, 100), "ADSC not written");
        assert!(adc.write_status(ADEN | ADSC | 0x07, 100));
        let done = adc.next_event();
        assert!(!adc.write_status(ADEN | ADSC | 0x07, 200), "already converting");
        assert_eq!(adc.next_event(), done);
        adc.write_status(0x07, 300);
        assert_eq!(adc.next_event(), u64::MAX);
        assert_eq!(adc.sample_needed(), None);
        // On again, the next is a first conversion again.
        assert!(adc.write_status(ADEN | ADSC | 0x07, 1000));
        assert_eq!(adc.next_event(), 1000 + 128 + 25 * 128);
    }

    #[test]
    fn admux_is_taken_up_until_the_conversion_starts() {
        let mut adc = arduino();
        adc.write_status(ADEN | ADSC | 0x07, 1000);
        // Before the edge at 1024 a new channel still counts; after it, not.
        adc.write_mux(AVCC | 1, 1010);
        adc.write_mux(AVCC | 2, 1030);
        let v = AnalogLevels {
            channels: [0.0, 1.0, 2.0, 0.0, 0.0, 0.0],
            avcc: 5.0,
            ..Default::default()
        };
        adc.give(v);
        adc.complete();
        // 1.0 · 1024 / 5 = 204.8.
        assert_eq!(adc.read_low() as u16 | u16::from(adc.read_high()) << 8, 204);
    }

    #[test]
    fn adlar_left_adjusts_the_result_at_once() {
        let mut adc = arduino();
        adc.write_status(ADEN | ADSC | 0x07, 0);
        adc.give(levels(4.0));
        adc.complete();
        // 4 · 1024 / 5 = 819.2: 819 = 0b11_0011_0011.
        assert_eq!((adc.read_low(), adc.read_high()), (0x33, 0x03));
        adc.write_mux(AVCC | ADLAR, 10_000);
        assert_eq!((adc.read_low(), adc.read_high()), (0b1100_0000, 0b1100_1100));
    }

    #[test]
    fn reading_adcl_holds_the_data_register_until_adch() {
        let mut adc = arduino();
        adc.write_status(ADEN | ADSC | 0x07, 0);
        adc.give(levels(1.0));
        adc.complete();
        // 204 = 0x0CC.
        assert_eq!(adc.read_low(), 0xCC);
        adc.write_status(ADEN | ADSC | ADIF | 0x07, 10_000);
        adc.give(levels(4.0));
        adc.complete();
        // Done between the two reads: the high byte is the old one's, and the
        // new result is lost, though its flag is set.
        assert_eq!(adc.read_high(), 0x00);
        assert_eq!(adc.status() & ADIF, ADIF);
        assert_eq!((adc.read_low(), adc.read_high()), (0xCC, 0x00));
    }

    #[test]
    fn free_running_starts_the_next_on_the_edge_the_last_ended_on() {
        let mut adc = Adc { admux: AVCC, ..Default::default() };
        // Prescaler 16, auto trigger with ADTS 000.
        assert!(adc.write_status(ADEN | ADSC | ADATE | 0x04, 0));
        let first = adc.next_event();
        assert_eq!(first, 16 + 25 * 16);
        adc.give(levels(1.0));
        adc.complete();
        // ADSC stays one, and the next is a normal conversion from `first`.
        assert_eq!(adc.status() & ADSC, ADSC);
        assert_eq!(adc.sample_needed(), Some(first + 24));
        assert_eq!(adc.next_event(), first + 13 * 16);
        assert!(!adc.foreign_trigger());
        // A timer as the trigger is not simulated: no conversion follows.
        adc.adcsrb = 0x03;
        assert!(adc.foreign_trigger());
        adc.give(levels(1.0));
        adc.complete();
        assert_eq!(adc.next_event(), u64::MAX);
    }

    #[test]
    fn the_interrupt_asks_while_the_flag_and_adie_are_set() {
        let mut adc = arduino();
        adc.write_status(ADEN | ADIE | ADSC | 0x07, 0);
        assert!(!adc.interrupt());
        adc.give(levels(1.0));
        adc.complete();
        assert!(adc.interrupt());
        adc.acknowledge();
        assert!(!adc.interrupt());
        assert_eq!(adc.status() & ADIF, 0);
    }
}
