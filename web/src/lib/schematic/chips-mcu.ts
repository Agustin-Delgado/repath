/**
 * Microcontrollers: chips that run a program somebody compiled.
 *
 * The ATmega328P is here because it is the chip on an Arduino Uno, which makes
 * it the one a student already has a sketch for. Its port pins are the engine's
 * `mcu` device (`avr` in repath-core); what the silicon puts between those pins
 * and the board — the pull-ups, the reset pull-up — is built in `netlist.ts`
 * from what is declared here.
 *
 * The program is the Intel HEX file the Arduino IDE or arduino-cli writes,
 * carried by the instance as a parameter the way an EEPROM carries its
 * contents. Nothing here compiles anything: repath is a static page with no
 * toolchain behind it.
 */

import type { ChipDef } from './chips';

/** Ports B, C and D as the engine names them. PC6 is the reset leg, wired apart. */
const PORTS: readonly string[] = [
	...[0, 1, 2, 3, 4, 5, 6, 7].map((bit) => `PB${bit}`),
	...[0, 1, 2, 3, 4, 5].map((bit) => `PC${bit}`),
	...[0, 1, 2, 3, 4, 5, 6, 7].map((bit) => `PD${bit}`)
];

/**
 * How an Uno's silkscreen names each port pin, which is how the people using
 * one think of them: D0 to D7 are port D, D8 to D13 the bottom of port B, and
 * A0 to A5 port C. PB6 and PB7 are the crystal on an Uno and have no number.
 */
export const ARDUINO_NAMES: Readonly<Record<string, string>> = Object.fromEntries([
	...[0, 1, 2, 3, 4, 5, 6, 7].map((bit) => [`PD${bit}`, `D${bit}`]),
	...[0, 1, 2, 3, 4, 5].map((bit) => [`PB${bit}`, `D${bit + 8}`]),
	...[0, 1, 2, 3, 4, 5].map((bit) => [`PC${bit}`, `A${bit}`])
]);

/** Flash, in bytes: the most program a 328P holds, and what a HEX file is checked against. */
export const FLASH_BYTES = 32 * 1024;

/** The clock an Uno runs its 328P at, and the one a fresh part starts with. */
export const DEFAULT_CLOCK = 16e6;

/**
 * A port pin's pull-up, in ohms. The datasheet gives 20 to 50 kΩ; this is the
 * middle of that. A sketch that leans on it — a button to ground read with
 * INPUT_PULLUP — works anywhere in the range, so the choice only shows in how
 * fast the pin recovers through whatever capacitance hangs off it.
 */
export const PORT_PULL_UP_OHMS = 35e3;

/**
 * What to tell someone whose program used a part of the chip the engine does
 * not simulate, by the engine's name for it: what is missing, and what that
 * does to what they see. A value nothing computed must not pass for a
 * measurement, and a sketch must not seem to work when it is talking to
 * nobody.
 */
const UNSIMULATED: Readonly<Record<string, string>> = {
	temperature:
		'The temperature sensor is not simulated yet: a conversion of it reads as 0 V, not as the chip’s temperature.',
	'adc-trigger':
		'Auto-triggering the converter from a timer, the comparator or an external interrupt is not simulated yet: only free running is, so no conversion it would start ever starts.',
	i2c: 'Nothing is on the I²C bus: no I²C devices are simulated yet, so every address goes unanswered (Wire.endTransmission() returns 2, Wire.requestFrom() 0).',
	spi: 'SPI is not simulated yet: a transfer ends at once without touching the pins, and what it reads back did not come from any device.',
	comparator:
		'The analog comparator is not simulated yet: its output reads 0 whatever is on its pins, and it never interrupts.',
	watchdog:
		'The watchdog is not simulated yet: it never times out, so it neither resets the chip nor interrupts, and the program runs on.'
};

/** The message for a notice, from the engine's name for the peripheral. */
export function unsimulatedMessage(peripheral: string): string {
	return (
		UNSIMULATED[peripheral] ??
		`The program used a part of the chip that is not simulated yet (${peripheral}).`
	);
}

/** The reset leg's own pull-up: the middle of the datasheet's 30 to 60 kΩ. */
const RESET_PULL_UP_OHMS = 45e3;

export const MCU_CHIPS: readonly ChipDef[] = [
	{
		id: 'ATmega328P',
		role: 'microcontrollers',
		description: "The Arduino Uno's microcontroller, running a compiled .hex",
		aliases: [
			'arduino', 'uno', 'nano', 'avr', 'atmega', 'atmega328', '328p', '328',
			'mcu', 'microcontroller', 'micro', 'sketch'
		],
		// The 28-leg DIP. Pin 1 is PC6, which an Uno uses as RESET, and both
		// supplies come in twice: VCC and GND for the digital side, AVCC and a
		// second ground for port C and the converter. Pin 22 is printed GND on the
		// datasheet; it is AGND here, after the Uno's schematic, because two legs
		// with one name would leave a wire unable to say which it means.
		layout: [
			'RESET', 'PD0', 'PD1', 'PD2', 'PD3', 'PD4', 'VCC', 'GND', 'PB6', 'PB7', 'PD5', 'PD6', 'PD7', 'PB0',
			'PB1', 'PB2', 'PB3', 'PB4', 'PB5', 'AVCC', 'AREF', 'AGND', 'PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5'
		],
		blocks: [
			{
				kind: 'mcu',
				ports: PORTS,
				reset: 'RESET',
				// ADC0 to ADC5. ADC6 and ADC7 are bonded out only on the
				// surface-mount packages.
				converter: {
					inputs: ['PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5'],
					aref: 'AREF',
					avcc: 'AVCC',
					agnd: 'AGND'
				}
			}
		],
		pullUps: { RESET: RESET_PULL_UP_OHMS },
		// A program uses the pins it uses, and the rest are inputs nobody reads;
		// reset has its pull-up, and AREF is needed only by a sketch that uses
		// analogReference(EXTERNAL).
		optional: [...PORTS, 'RESET', 'AREF'],
		boardNames: ARDUINO_NAMES,
		caveat:
			"Runs the .hex the Arduino IDE exports: the CPU, the pins and their pull-ups, interrupts, the three timers, serial in and out — type to it in the inspector — the EEPROM, erased at the start of every run, and analogRead(), which measures A0 to A5 against AVCC, AREF or the internal 1.1 V when its conversion samples. I²C finds nothing on the bus, and there is no watchdog or SPI: a sketch that uses one of these is told so while it runs. AVCC is the converter's supply and reference, so analogRead() needs it wired, as on the real chip; the clock is set in the inspector rather than by a crystal on PB6 and PB7."
	}
];
