//! The other end of an Uno's serial port: what the serial monitor types into.
//!
//! On the board, the ATmega328P's RXD is driven by a second chip, an
//! ATmega16U2 running the Arduino-usbserial firmware, through a 1 kΩ resistor.
//! Whatever is sent from the computer leaves that chip as an ordinary UART
//! frame — 8 data bits, no parity, one stop bit, at the baud rate the computer
//! asked for — and that waveform is all the 328P ever sees of it. So this is a
//! logic source that, told to send some bytes, puts their frames on its net,
//! and the chip receives them or garbles them by its own baud rate.
//!
//! It lets go of the net until the first byte is sent: a bare 328P on a
//! breadboard has no converter on its RXD, and nothing here should pull that
//! pin before somebody uses the monitor. From the first byte on it idles high,
//! as the converter's transmitter does. The 1 kΩ is the netlist's to build,
//! where the pin's net reaches the analog side; on a net that is only logic,
//! this drives it directly.

use crate::digital::{DigitalDevice, EvalCtx, Logic, NetId};

/// The 16U2's clock.
const CONVERTER_CLOCK: u64 = 16_000_000;

#[derive(Debug, Clone)]
pub struct UsbSerial {
    pub name: String,
    output: NetId,
    outputs: Vec<NetId>,
    /// Whether it has driven the line yet.
    connected: bool,
    /// When the last frame queued ends, in seconds.
    free_at: f64,
}

impl UsbSerial {
    pub fn new(name: impl Into<String>, output: NetId) -> Self {
        Self { name: name.into(), output, outputs: vec![output], connected: false, free_at: 0.0 }
    }

    /// Seconds a bit lasts when the computer asks for `baud`.
    ///
    /// The rate the converter really runs at, which is not quite the one
    /// asked for: Arduino-usbserial sets the 16U2's divider with LUFA's
    /// `SERIAL_2X_UBBRVAL`, the nearest whole number of eight-cycle ticks,
    /// except at 57 600, which it sets at normal speed for the old
    /// bootloaders. 9600 comes out at 1664 cycles a bit, 9615 baud — the same
    /// divider the Arduino core picks on the 328P, which is why the two agree.
    pub fn bit_time(baud: u32) -> f64 {
        let baud = u64::from(baud.max(1));
        let cycles = if baud == 57_600 {
            16 * ((CONVERTER_CLOCK / 16 + baud / 2) / baud)
        } else {
            8 * ((CONVERTER_CLOCK / 8 + baud / 2) / baud)
        };
        cycles.max(8) as f64 / CONVERTER_CLOCK as f64
    }

    /// Put `bytes` on the line from `ctx.now`, after whatever it is still
    /// sending, as 8N1 frames at `baud`. Returns when the last one ends.
    pub fn send(&mut self, ctx: &mut EvalCtx, bytes: &[u8], baud: u32) -> f64 {
        let bit = Self::bit_time(baud);
        let now = ctx.now;
        let mut start = now.max(self.free_at);
        if !self.connected {
            // Idle for a bit before the first start bit: a line that was
            // let go of reads low, and a start bit is a fall from high.
            self.connected = true;
            ctx.drive(0, self.output, Logic::High, 0.0);
            start = now + bit;
        }
        for &byte in bytes {
            // Start bit, the data least significant first, the stop bit.
            let levels = std::iter::once(false)
                .chain((0..8).map(|i| byte >> i & 1 != 0))
                .chain(std::iter::once(true));
            let mut line = true;
            for (i, high) in levels.enumerate() {
                if high != line {
                    line = high;
                    let at = start + i as f64 * bit;
                    ctx.drive(0, self.output, Logic::from_bool(high), at - now);
                }
            }
            start += 10.0 * bit;
        }
        self.free_at = start;
        start
    }
}

impl DigitalDevice for UsbSerial {
    fn name(&self) -> &str {
        &self.name
    }
    fn kind(&self) -> &'static str {
        "usb_serial"
    }
    fn input_nets(&self) -> &[NetId] {
        &[]
    }
    fn output_nets(&self) -> &[NetId] {
        &self.outputs
    }

    fn initialize(&mut self, ctx: &mut EvalCtx) {
        self.connected = false;
        self.free_at = 0.0;
        ctx.drive(0, self.output, Logic::HighZ, 0.0);
    }

    fn evaluate(&mut self, _ctx: &mut EvalCtx) {}

    fn reset(&mut self) {
        self.connected = false;
        self.free_at = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::digital::DigitalDomain;

    #[test]
    fn its_rates_are_the_dividers_arduino_usbserial_sets() {
        // (2 MHz + baud / 2) / baud ticks of eight cycles; 57 600 at normal
        // speed, (1 MHz + 28 800) / 57 600 = 17 ticks of sixteen.
        let cycles = |baud| UsbSerial::bit_time(baud) * 16e6;
        for (baud, expected) in
            [(9_600, 1_664.0), (115_200, 136.0), (57_600, 272.0), (300, 53_336.0)]
        {
            assert!((cycles(baud) - expected).abs() < 1e-6, "{baud}: {}", cycles(baud));
        }
    }

    #[test]
    fn it_lets_go_of_the_line_until_it_sends_and_then_frames_each_byte() {
        let mut domain = DigitalDomain::new();
        let line = domain.add_net("line");
        domain.add_device(Box::new(UsbSerial::new("USB", line)));
        domain.initialize();
        domain.settle(1e-3);
        assert_eq!(domain.state(line), Logic::HighZ);
        let bit = UsbSerial::bit_time(9_600);
        let send = |domain: &mut DigitalDomain, bytes: &[u8]| {
            domain.act_on("USB", 1e-3, |port: &mut UsbSerial, ctx| port.send(ctx, bytes, 9_600))
        };
        let first = send(&mut domain, b"A").unwrap();
        // Sent while 'A' is still going out, 'B' follows it.
        let second = send(&mut domain, b"B").unwrap();
        domain.settle(1.0);
        // High from the instant of sending, the start bit a bit later, then
        // 'A' = 0x41 and 'B' = 0x42 least significant bit first.
        let a = 1e-3 + bit;
        let b = a + 10.0 * bit;
        assert!((first - b).abs() < 1e-12 && (second - (b + 10.0 * bit)).abs() < 1e-12);
        let mut expected = vec![(1e-3, Logic::High)];
        for (start, flips) in [(a, [0, 1, 2, 7, 8, 9]), (b, [0, 2, 3, 7, 8, 9])] {
            let mut level = Logic::High;
            for i in flips {
                level = level.invert();
                expected.push((start + f64::from(i) * bit, level));
            }
        }
        let log: Vec<(f64, Logic)> = domain.take_log().iter().map(|t| (t.time, t.state)).collect();
        assert_eq!(log.len(), expected.len(), "{log:?}");
        for ((t, s), (te, se)) in log.iter().zip(&expected) {
            assert!((t - te).abs() < 1e-12 && s == se, "{log:?}");
        }
    }
}
