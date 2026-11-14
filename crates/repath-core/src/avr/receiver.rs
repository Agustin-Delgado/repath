//! USART0's receiver: the RXD pin read back into bytes the way the silicon
//! reads it.
//!
//! Nothing is handed to it as bytes. It sees the level of PD0 and nothing
//! else, so whatever drives that pin — another chip's transmitter, the USB
//! converter of an Uno, a button — is received as the hardware would receive
//! it, at the baud rate the program set, and a sender at another rate is
//! received as garbage with framing errors.
//!
//! The datasheet's clock recovery and data recovery (ATmega328P, "USART0 —
//! Data Reception"), with one simplification: its sample clock runs free at
//! UBRR0 + 1 CPU cycles a tick, and the start edge falls somewhere between two
//! ticks, so the real receiver's first low sample is up to a tick after the
//! edge. Here the ticks are counted from the edge itself, which takes the
//! middle of that range away and puts every sample a deterministic distance
//! from the edge — at most one sample period early: a sixteenth of a bit, an
//! eighth with U2X0.
//!
//! - A falling edge on an idle line is sample 1 of a start bit. Samples 8, 9
//!   and 10 of 16 (4, 5 and 6 of 8 with U2X0) are the middle of every bit, and
//!   two of the three decide it. A start bit they read high was a spike, and
//!   the receiver waits for the next falling edge.
//! - Data bits follow least significant first, then the parity bit if there is
//!   one; only the first stop bit is looked at, and a low one is a framing
//!   error. The byte is complete at the stop bit's last voting sample.
//! - Two complete bytes wait in UDR0's buffer and a third in the shift
//!   register. A start bit with all three places taken loses the third, and
//!   the next byte read after it carries DOR0.

/// The frame the receiver is set up for, taken from the registers as each
/// start bit begins: changing them halfway through a frame is undefined on
/// the silicon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Format {
    /// CPU cycles between samples: UBRR0 + 1.
    pub period: u64,
    /// Samples a bit: 16, or 8 with U2X0.
    pub samples: u64,
    /// Data bits, 5 to 9.
    pub data: u8,
    /// Whether a parity bit follows the data, and whether it is odd.
    pub parity: Option<bool>,
    /// MPCM0: frames not marked as an address are dropped.
    pub addresses_only: bool,
}

impl Format {
    /// CPU cycles a bit lasts.
    pub fn bit_cycles(&self) -> u64 {
        self.samples * self.period
    }
}

/// A byte as UDR0's buffer holds it, with the flags that go with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Received {
    /// Up to nine bits; the ninth is RXB80.
    pub data: u16,
    pub frame_error: bool,
    pub parity_error: bool,
    /// A byte before this one was lost.
    pub overrun: bool,
}

#[derive(Debug, Clone, Copy)]
struct Frame {
    format: Format,
    /// The cycle of the start bit's first sample.
    first: u64,
    /// The bit being sampled: 0 is the start bit.
    bit: u8,
    /// Samples taken of it so far, and how many read high.
    votes: u8,
    highs: u8,
    /// Data, then parity, least significant first.
    word: u16,
}

impl Frame {
    /// Data and parity bits between the start bit and the stop bit.
    fn payload(&self) -> u8 {
        self.format.data + u8::from(self.format.parity.is_some())
    }

    fn next_sample(&self) -> u64 {
        let f = &self.format;
        let within = f.samples / 2 - 1 + u64::from(self.votes);
        self.first + (f.samples * u64::from(self.bit) + within) * f.period
    }
}

pub const RXC: u8 = 1 << 7;
const FE: u8 = 1 << 4;
const DOR: u8 = 1 << 3;
const UPE: u8 = 1 << 2;

#[derive(Debug, Clone, Default)]
pub struct Receiver {
    frame: Option<Frame>,
    /// UDR0's two-byte buffer, oldest first.
    buffer: [Received; 2],
    count: usize,
    /// A complete byte still in the shift register, the buffer being full.
    held: Option<Received>,
    /// A byte was lost; the next one into the buffer says so.
    lost: bool,
    /// What UDR0 reads with nothing in the buffer: the last byte it gave.
    last: u8,
}

impl Receiver {
    /// The cycle of the next sample, `u64::MAX` with no frame coming in.
    pub fn next_at(&self) -> u64 {
        self.frame.map_or(u64::MAX, |f| f.next_sample())
    }

    /// The line fell at `at`: a start bit, if the receiver is free for one.
    pub fn falling_edge(&mut self, at: u64, format: Format) {
        if self.frame.is_some() {
            return;
        }
        if self.held.take().is_some() {
            self.lost = true;
        }
        self.frame = Some(Frame { format, first: at, bit: 0, votes: 0, highs: 0, word: 0 });
    }

    /// Take the sample due at [`Self::next_at`], the line being `high`.
    ///
    /// Returns whether a new start bit is already under way: the stop bit
    /// came out high but its last sample read low, which is the earliest the
    /// datasheet lets the next frame's start begin. The caller starts it on
    /// the following sample.
    pub fn sample(&mut self, high: bool) -> bool {
        let Some(mut frame) = self.frame else { return false };
        frame.votes += 1;
        frame.highs += u8::from(high);
        if frame.votes < 3 {
            self.frame = Some(frame);
            return false;
        }
        let one = frame.highs >= 2;
        frame.votes = 0;
        frame.highs = 0;
        if frame.bit == 0 {
            if one {
                // Noise, not a start bit.
                self.frame = None;
                return false;
            }
        } else if frame.bit <= frame.payload() {
            frame.word |= u16::from(one) << (frame.bit - 1);
        } else {
            self.frame = None;
            self.complete(&frame, one);
            return one && !high;
        }
        frame.bit += 1;
        self.frame = Some(frame);
        false
    }

    fn complete(&mut self, frame: &Frame, stop: bool) {
        let f = frame.format;
        let data = frame.word & ((1 << f.data) - 1);
        let parity_error = f.parity.is_some_and(|odd| {
            let expected = (data.count_ones() % 2 == 1) ^ odd;
            expected != (frame.word >> f.data & 1 != 0)
        });
        // In multi-processor mode the address mark is the ninth bit, or with
        // fewer the first stop bit.
        let address = if f.data == 9 { data >> 8 != 0 } else { stop };
        if f.addresses_only && !address {
            return;
        }
        let byte = Received {
            data,
            frame_error: !stop,
            parity_error,
            overrun: std::mem::take(&mut self.lost),
        };
        if self.count < 2 {
            self.buffer[self.count] = byte;
            self.count += 1;
        } else {
            self.held = Some(byte);
        }
    }

    /// RXC0, FE0, DOR0 and UPE0 as UCSR0A shows them: the flags of the byte
    /// UDR0 would give next.
    pub fn status(&self) -> u8 {
        if self.count == 0 {
            return 0;
        }
        let b = self.buffer[0];
        RXC | if b.frame_error { FE } else { 0 }
            | if b.overrun { DOR } else { 0 }
            | if b.parity_error { UPE } else { 0 }
    }

    /// RXB80, in place in UCSR0B.
    pub fn ninth_bit(&self) -> u8 {
        if self.count > 0 && self.buffer[0].data & 0x100 != 0 { 0x02 } else { 0 }
    }

    /// Reading UDR0: the oldest byte leaves the buffer, and one waiting in
    /// the shift register takes its place.
    pub fn read(&mut self) -> u8 {
        if self.count == 0 {
            return self.last;
        }
        let byte = self.buffer[0];
        self.buffer[0] = self.buffer[1];
        self.count -= 1;
        if let Some(waiting) = self.held.take() {
            self.buffer[self.count] = waiting;
            self.count += 1;
        }
        self.last = byte.data as u8;
        self.last
    }

    /// RXEN0 cleared: the datasheet has the frame under way lost and the
    /// buffer flushed at once.
    pub fn disable(&mut self) {
        *self = Self { last: self.last, ..Self::default() };
    }
}
