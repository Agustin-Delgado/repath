//! The PCF8574: eight quasi-bidirectional port pins behind an I2C address.
//!
//! Each pin is a latch bit driving a strong pull-down and a weak current
//! source up. Written zero, the pin is low; written one, it is held high only
//! weakly, so anything outside can pull it low — which is how the same pin is
//! an input: write a one, then read what the outside makes of it. There is no
//! direction register. At power-on every latch bit is one.
//!
//! A write takes effect at the acknowledge of the data byte, a read samples
//! the pins for the byte that follows; both are taken here at the end of the
//! byte's transfer, a bit time or less from where the datasheet puts them.

/// The address of a PCF8574 (`0x20`–`0x27`) or a PCF8574A (`0x38`–`0x3F`),
/// with its A2–A0 pins: on the LCD backpacks those are jumpers to pull-ups,
/// all open — high — out of the box, which is 0x27 and 0x3F.
pub fn address(a_variant: bool, a2_a0: u8) -> u8 {
    (if a_variant { 0x38 } else { 0x20 }) | (a2_a0 & 7)
}

#[derive(Debug, Clone)]
pub struct Pcf8574 {
    address: u8,
    latch: u8,
}

impl Pcf8574 {
    pub fn new(address: u8) -> Self {
        Self { address: address & 0x7F, latch: 0xFF }
    }

    pub fn address(&self) -> u8 {
        self.address
    }

    /// What was last written: the pins as far as the chip drives them.
    pub fn latch(&self) -> u8 {
        self.latch
    }

    /// A data byte from the master. It always acknowledges.
    pub fn write(&mut self, byte: u8) -> bool {
        self.latch = byte;
        true
    }

    /// The pins as a read sees them, with `outside` the levels everything
    /// else on them would give alone: a one only where both the latch and the
    /// outside leave it high, since the latch's one is too weak to fight
    /// anything pulling down, and its zero wins over anything pulling up.
    pub fn read(&self, outside: u8) -> u8 {
        self.latch & outside
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_is_the_fixed_part_and_the_three_jumpers() {
        // Datasheet address tables: 0100 A2 A1 A0 for the PCF8574, 0111 A2 A1
        // A0 for the A part.
        assert_eq!(address(false, 0b111), 0x27);
        assert_eq!(address(false, 0b000), 0x20);
        assert_eq!(address(true, 0b111), 0x3F);
        assert_eq!(address(true, 0b010), 0x3A);
    }

    #[test]
    fn pins_power_up_high_and_a_write_sets_them() {
        let mut chip = Pcf8574::new(0x27);
        assert_eq!(chip.read(0xFF), 0xFF, "every latch bit is one at power-on");
        assert!(chip.write(0b1010_0101));
        assert_eq!(chip.latch(), 0b1010_0101);
        assert_eq!(chip.read(0xFF), 0b1010_0101);
    }

    #[test]
    fn a_pin_written_high_reads_what_the_outside_pulls_it_to() {
        let mut chip = Pcf8574::new(0x20);
        chip.write(0xF0);
        // The outside pulls bits 7 and 0 low: bit 7 was a weak one and gives
        // way; bit 0 was already low. Bits 3–1 are driven low by the latch
        // whatever the outside wants.
        assert_eq!(chip.read(0b0111_1110), 0b0111_0000);
    }
}
