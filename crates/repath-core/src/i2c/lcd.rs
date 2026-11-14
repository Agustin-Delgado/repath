//! A 16×2 character LCD module with an I2C backpack: an HD44780 on its 4-bit
//! bus, behind a PCF8574 whose port drives it.
//!
//! The backpack everyone buys wires the expander's port as P0 = RS, P1 = R/W,
//! P2 = E, P3 = the backlight's transistor, and P4–P7 = D4–D7; the LCD's D0–D3
//! are left unconnected, so in 8-bit mode they read as the controller's own
//! pull-ups hold them, high. LiquidCrystal_I2C and its relatives are written
//! for exactly that mapping.
//!
//! What the module draws from its supply is not modelled: the editor powers it
//! or not, and the engine only ever sees a powered one.

use super::hd44780::{Hd44780, Screen};
use super::pcf8574::Pcf8574;

const RS: u8 = 1 << 0;
const RW: u8 = 1 << 1;
const E: u8 = 1 << 2;
const BACKLIGHT: u8 = 1 << 3;
/// D3–D0 of the LCD, which the backpack leaves open.
const UNWIRED: u8 = 0x0F;

#[derive(Debug, Clone)]
pub struct LcdModule {
    pub name: String,
    expander: Pcf8574,
    lcd: Hd44780,
    /// Bumped by every write that reaches it, so that whoever draws it can
    /// tell a screen that changed from one that did not without comparing.
    version: u64,
}

impl LcdModule {
    /// A module powered up at the start of the run: the expander's port all
    /// high — backlight on, E high with R/W set for a read — and the
    /// controller in its power-on reset.
    pub fn new(name: impl Into<String>, address: u8) -> Self {
        let mut module = Self {
            name: name.into(),
            expander: Pcf8574::new(address),
            lcd: Hd44780::new(),
            version: 0,
        };
        module.drive(0.0);
        module
    }

    pub fn address(&self) -> u8 {
        self.expander.address()
    }

    pub fn controller(&self) -> &Hd44780 {
        &self.lcd
    }

    pub fn backlight(&self) -> bool {
        self.expander.latch() & BACKLIGHT != 0
    }

    pub fn screen(&self) -> Screen {
        self.lcd.screen()
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// The controller sees the port as it is now.
    fn drive(&mut self, time: f64) {
        let port = self.expander.latch();
        self.lcd.set_pins(
            port & RS != 0,
            port & RW != 0,
            port & E != 0,
            (port & 0xF0) | UNWIRED,
            time,
        );
    }

    pub fn write(&mut self, byte: u8, time: f64) -> bool {
        let ack = self.expander.write(byte);
        self.drive(time);
        self.version += 1;
        ack
    }

    /// The port as read: P4–P7 pulled down where the controller, mid-read,
    /// drives D4–D7 low.
    pub fn read(&mut self, _time: f64) -> u8 {
        let outside = self.lcd.output().map_or(0xFF, |data| data | 0x0F);
        self.expander.read(outside)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What LiquidCrystal_I2C's `write4bits` does with half a byte: put it out
    /// with the backlight bit, then again with E high, then with E low — three
    /// one-byte I2C transfers, each about 200 µs at 100 kHz.
    fn write4bits(module: &mut LcdModule, t: &mut f64, nibble_and_mode: u8) {
        for byte in [nibble_and_mode, nibble_and_mode | E, nibble_and_mode & !E] {
            assert!(module.write(byte | BACKLIGHT, *t));
            *t += 200e-6;
        }
    }

    fn send(module: &mut LcdModule, t: &mut f64, value: u8, mode: u8) {
        write4bits(module, t, (value & 0xF0) | mode);
        write4bits(module, t, (value << 4) | mode);
    }

    #[test]
    fn it_powers_up_lit_and_uninitialised() {
        let module = LcdModule::new("LCD1", 0x27);
        assert!(module.backlight(), "the expander's port powers up high");
        assert!(module.screen().overdriven);
    }

    #[test]
    fn the_backpack_mapping_puts_text_on_the_glass() {
        let mut module = LcdModule::new("LCD1", 0x27);
        let mut t = 50e-3;
        // LiquidCrystal_I2C::begin(): three 0x3 halves, a 0x2, then 0x28,
        // display on, clear, entry mode — and "Hi" with RS high.
        for _ in 0..3 {
            write4bits(&mut module, &mut t, 0x30);
            t += 4.5e-3;
        }
        write4bits(&mut module, &mut t, 0x20);
        for command in [0x28, 0x0C, 0x01, 0x06] {
            send(&mut module, &mut t, command, 0);
            t += 2e-3;
        }
        send(&mut module, &mut t, b'H', RS);
        send(&mut module, &mut t, b'i', RS);
        assert_eq!(module.controller().text()[0].trim_end(), "Hi");
        assert_eq!(module.controller().ignored, 0);
        // The backlight follows P3 alone.
        module.write(0x00, t);
        assert!(!module.backlight());
    }

    #[test]
    fn reading_the_port_mid_read_sees_the_busy_flag_on_p7() {
        let mut module = LcdModule::new("LCD1", 0x27);
        // Still in the power-on reset at 1 ms: busy. Put R/W high and the data
        // pins high (weakly, so the controller can pull them), then raise E.
        module.write(0xF0 | RW, 1e-3);
        module.write(0xF0 | RW | E, 1.2e-3);
        let port = module.read(1.4e-3);
        assert_eq!(port & 0x80, 0x80, "busy");
        // The power-on read latched at time zero left the counter at 1, and
        // the address bits 6–4 of it are zero: P6–P4 pulled low.
        assert_eq!(port & 0x70, 0x00);
        assert_eq!(port & 0x0F, RW | E);
    }
}
