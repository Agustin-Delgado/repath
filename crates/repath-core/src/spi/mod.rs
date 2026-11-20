//! Devices on an SPI bus.
//!
//! Unlike the I2C devices (`i2c`), which live inside the microcontroller's
//! TWI and are handed whole bytes, these are ordinary digital devices on the
//! nets: they see DIN, CLK and their select line edge by edge, as a 74HC595
//! made of flip-flops does. The microcontroller's SPI drives those pins for
//! real (`avr::spi`), so a device here does not care whether the bits come
//! from the SPI, from `shiftOut()` or from anything else that toggles the
//! wires — the LedControl library bit-bangs exactly this way.
//!
//! What made the TWI keep its devices inside it is an answer: every I2C byte
//! is acknowledged by the device, which the chip has to read back before it
//! can go on. A display on SPI says nothing back, so its edges cost the chip
//! nothing but the stops it makes to publish them.

pub mod max7219;

pub use max7219::Max7219;

use crate::digital::DigitalDomain;

/// The MAX7219 called `name`, if the domain has one.
pub fn find_max7219<'a>(domain: &'a DigitalDomain, name: &str) -> Option<&'a Max7219> {
    domain.device(name)?.as_any().downcast_ref::<Max7219>()
}
