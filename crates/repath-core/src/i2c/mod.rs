//! Devices on an I2C bus, and the bus a microcontroller's TWI talks to them on.
//!
//! The bus is simulated by transaction, not by wire. When the master's TWI
//! clocks out an address or a byte, it hands it to the device at that address
//! here and takes back the acknowledge, at the instant the datasheet's bit
//! timing says the byte is over; SDA and SCL are not driven bit by bit.
//!
//! Why not the electrical bus — open-drain lines, pull-ups, every device a
//! state machine on the wires: a microcontroller here runs ahead of the event
//! queue and only stops for an edge somebody is listening to (`avr::Mcu`). A
//! bus on the wires is four edges a bit, each fed back as an input the chip
//! reads, so every bit would cut its run short and throw away what it had run
//! past; an LCD written through a backpack, six transfers a character, would
//! cost more than the rest of the circuit. Kept inside the chip, the devices
//! are part of what a speculative run copies and throws away, and the bus
//! costs nothing the chip did not already spend.
//!
//! What that leaves out is written down in BACKLOG.md: a bus with a second
//! master or a bit-banged one, a scope on SDA and SCL, which show the idle
//! bus, and anything else on those nets disturbing a transfer. What it keeps
//! is the part that decides whether a sketch works: a device answers only if
//! its SDA and SCL are on the master's SDA and SCL (see `netlist`), only at its
//! own address, and an address nobody has is NACKed as on an empty bus.
//!
//! Pull-ups: every device here is a module that carries its own, as the
//! PCF8574 backpacks do (4.7 kΩ on SDA and SCL), so a bus with a device on it
//! is a pulled-up bus. One without any device is the empty bus the TWI always
//! modelled, held up by the port pull-ups `Wire.begin()` turns on.

mod a00;
pub mod hd44780;
pub mod lcd;
pub mod pcf8574;

pub use hd44780::{Hd44780, Screen};
pub use lcd::LcdModule;
pub use pcf8574::Pcf8574;

use crate::avr::Mcu;
use crate::digital::{DigitalDevice, DigitalDomain, EvalCtx, NetId};

/// The LCD module called `name`, wherever the netlist put it, and the instant
/// its state is as of — `None` for one on no bus, which never changes.
pub fn find_lcd<'a>(domain: &'a DigitalDomain, name: &str) -> Option<(&'a LcdModule, Option<f64>)> {
    if let Some(device) = domain.device(name)
        && let Some(alone) = device.as_any().downcast_ref::<Unattached>()
    {
        return alone.target.as_lcd().map(|lcd| (lcd, None));
    }
    domain.devices().find_map(|device| {
        let mcu = device.as_any().downcast_ref::<Mcu>()?;
        let lcd = mcu.i2c().get(name)?.as_lcd()?;
        Some((lcd, Some(mcu.committed_time())))
    })
}

/// A device the master can address.
#[derive(Debug, Clone)]
pub enum Target {
    /// A character LCD behind a PCF8574 backpack.
    Lcd(LcdModule),
}

impl Target {
    pub fn name(&self) -> &str {
        match self {
            Target::Lcd(lcd) => &lcd.name,
        }
    }

    /// The 7-bit address it answers to.
    pub fn address(&self) -> u8 {
        match self {
            Target::Lcd(lcd) => lcd.address(),
        }
    }

    /// A byte written to it after its address, the transfer ending at `time`
    /// seconds into the run. Whether it acknowledges.
    pub fn write(&mut self, byte: u8, time: f64) -> bool {
        match self {
            Target::Lcd(lcd) => lcd.write(byte, time),
        }
    }

    /// The byte it puts on the bus when read, the transfer ending at `time`.
    pub fn read(&mut self, time: f64) -> u8 {
        match self {
            Target::Lcd(lcd) => lcd.read(time),
        }
    }

    pub fn as_lcd(&self) -> Option<&LcdModule> {
        match self {
            Target::Lcd(lcd) => Some(lcd),
        }
    }
}

/// The devices on one bus.
#[derive(Debug, Clone, Default)]
pub struct Bus {
    pub targets: Vec<Target>,
}

impl Bus {
    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    /// Whether anything answers to `address`.
    pub fn answers(&self, address: u8) -> bool {
        self.targets.iter().any(|t| t.address() == address)
    }

    /// A byte for whatever is at `address`: whether it was acknowledged. Two
    /// devices at one address both take it and both pull SDA down for the
    /// acknowledge, as two modules left on the same jumpers do — they show
    /// the same thing.
    pub fn write(&mut self, address: u8, byte: u8, time: f64) -> bool {
        let mut ack = false;
        for target in self.targets.iter_mut().filter(|t| t.address() == address) {
            ack |= target.write(byte, time);
        }
        ack
    }

    /// A byte from whatever is at `address`. Open drain: where two drive, a
    /// zero from either wins, and with nothing there the pull-ups read ones.
    pub fn read(&mut self, address: u8, time: f64) -> u8 {
        let mut byte = 0xFF;
        for target in self.targets.iter_mut().filter(|t| t.address() == address) {
            byte &= target.read(time);
        }
        byte
    }

    pub fn get(&self, name: &str) -> Option<&Target> {
        self.targets.iter().find(|t| t.name() == name)
    }
}

/// A device whose SDA and SCL reach no microcontroller's TWI: powered, and
/// never spoken to. It stays as it powered up — which, for an LCD module, is
/// something to see: the backlight on and the first line of blocks of a
/// controller nobody initialised.
#[derive(Debug)]
pub struct Unattached {
    pub target: Target,
}

impl DigitalDevice for Unattached {
    fn name(&self) -> &str {
        self.target.name()
    }
    fn kind(&self) -> &'static str {
        "i2c"
    }
    fn input_nets(&self) -> &[NetId] {
        &[]
    }
    fn output_nets(&self) -> &[NetId] {
        &[]
    }
    fn evaluate(&mut self, _ctx: &mut EvalCtx) {}
}
