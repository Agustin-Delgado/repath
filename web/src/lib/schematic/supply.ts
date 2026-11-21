/**
 * What a packaged part draws from its supply just to run.
 *
 * A chip on a drawing has a VCC leg and a GND leg, and those legs carry current:
 * the part's own quiescent draw, and whatever its outputs source into a load or
 * sink from one. The second follows from the circuit — the engine draws each
 * output's current through the package's supply legs — and this is the first:
 * one figure per part, read off its datasheet at a 5 V supply with no load.
 *
 * Datasheets quote a typical where they have one and only a maximum where they
 * do not, which for static CMOS is the usual case. Where it is a maximum it says
 * so below. A figure that depends on what the part is doing — a memory being
 * read or sitting deselected, a CMOS gate's switching current — is not here:
 * one number would be wrong in both directions, and BACKLOG lists those parts.
 */

import type { ChipDef } from './chips';

/** Amps, at 5 V with no load. */
type Figure = number;

/**
 * Analog parts, microcontrollers and the like, by part number: the datasheet's
 * typical supply current with the outputs unloaded.
 */
const BY_PART: Readonly<Record<string, Figure>> = {
	// TI NE555, I_CC at V_CC = 5 V, output low, no load: 3 mA typical. The
	// three 5 kΩ resistors of its divider are built as resistors and draw their
	// own third of a milliamp, so that is not counted twice.
	NE555: 3e-3 - 5 / 15e3,
	// TI LM358 and LM324, I_CC at V+ = 5 V, all amplifiers, no load: 0.7 mA.
	LM358: 0.7e-3,
	LM324: 0.7e-3,
	// TI TL07x, 1.4 mA typical per amplifier.
	TL072: 2.8e-3,
	TL074: 5.6e-3,
	// TI LM741, 1.7 mA typical.
	LM741: 1.7e-3,
	// TI LM393 and LM339, I_CC at V_CC = 5 V, outputs off: 0.4 mA and 0.8 mA.
	LM393: 0.4e-3,
	LM339: 0.8e-3,
	// TI L293D, logic supply (VCC, pin 16) with the outputs high or released:
	// 16 mA typical. The output stages are switches from VCC2 and draw the load
	// through that leg on their own.
	L293D: 16e-3
};

/**
 * The I²C character LCD: an HD44780U controller (0.35 mA typical at 5 V,
 * Hitachi) behind a PCF8574 expander (tens of microamps), so 0.4 mA. The
 * backlight is not in it: it is an LED switched by the expander, tens of
 * milliamps when on, and nothing here follows what the firmware sets it to.
 */
export const LCD_SUPPLY_CURRENT = 0.4e-3;

/**
 * The MAX7219 in shutdown, which is where it starts and where its logic sits:
 * 150 µA typical (Maxim). Lit, its supply current is its LEDs' — up to
 * 330 mA with every segment on at full intensity — and follows what is on the
 * display, which one figure cannot.
 */
export const MATRIX_SUPPLY_CURRENT = 150e-6;

/**
 * The ATmega328P's active supply current at 5 V: 5.2 mA typical at 8 MHz
 * (datasheet, DC characteristics), and in the active modes it scales with the
 * clock — the core is static CMOS, so its current is charge per cycle.
 */
const ATMEGA_PER_HERTZ = 5.2e-3 / 8e6;

/**
 * 74LS parts, TI SN74LS datasheets: the typical I_CC, the mean of the
 * outputs-high and outputs-low figures where the sheet gives both. TTL draws
 * this whatever it is doing — the input and output stages are biased by
 * resistors — which is why one figure per part is honest for it.
 */
const LS: Readonly<Record<string, Figure>> = {
	'7400': 1.6e-3,
	'7402': 2.2e-3,
	'7404': 2.4e-3,
	'7408': 3.4e-3,
	'7410': 1.2e-3,
	'7411': 2.6e-3,
	'7414': 10.2e-3,
	'7420': 0.8e-3,
	'7421': 1.7e-3,
	'7427': 2.7e-3,
	'7430': 0.5e-3,
	'7432': 4e-3,
	'7447': 7e-3,
	'7473': 4e-3,
	'7474': 4e-3,
	'7476': 4e-3,
	'7485': 10e-3,
	'7486': 6.1e-3,
	'7490': 9e-3,
	'74107': 4e-3,
	'74112': 4e-3,
	'74132': 7e-3,
	'74138': 6.3e-3,
	'74139': 6.8e-3,
	'74148': 12e-3,
	'74151': 6e-3,
	'74153': 6.2e-3,
	'74157': 9.7e-3,
	'74161': 18e-3,
	'74163': 18e-3,
	'74164': 16e-3,
	'74165': 21e-3,
	'74193': 19e-3,
	'74194': 15e-3,
	'74283': 19e-3,
	'74373': 24e-3,
	'74374': 27e-3
};

/**
 * Static CMOS: the guaranteed maximum quiescent current at 25 °C, since that
 * is all the sheets give. 74HC (NXP): 2 µA for gates, 4 µA for flip-flops,
 * 8 µA for the larger functions. CD4000B (TI): 0.25 µA for gates, 1 µA for
 * flip-flops and buffers, 5 µA for the larger functions. The real figure is
 * nanoamps; either way it is nothing beside a load.
 */
function cmos(chip: ChipDef): Figure {
	const cd4000 = /^40/.test(chip.id);
	if (chip.role === 'gates') return cd4000 ? 0.25e-6 : 2e-6;
	if (chip.role === 'flip-flops' || /^40(49|50)$/.test(chip.id)) return cd4000 ? 1e-6 : 4e-6;
	return cd4000 ? 5e-6 : 8e-6;
}

/** Whether a part number is a 74-series logic part, as opposed to a CD4000 one. */
const isSeries74 = (id: string) => /^74/.test(id);

/**
 * The part's quiescent supply current in amps, or null where there is no one
 * figure for it (see the module comment).
 *
 * `family` is the drawing's logic family, which decides whether a 74-series
 * part is a 74HC or a 74LS. `clock` is a microcontroller's, in hertz.
 */
export function quiescentCurrent(chip: ChipDef, family: string, clock?: number): number | null {
	const known = BY_PART[chip.id];
	if (known !== undefined) return known;
	if (chip.id === 'ATmega328P' || chip.id === 'ArduinoUno') {
		return ATMEGA_PER_HERTZ * (clock ?? 16e6);
	}
	// Memories draw milliamps while selected and microamps while not; that is
	// a current that follows the chip select, not a figure.
	if (chip.contents || chip.blocks.some((block) => block.kind === 'memory')) return null;
	if (!chip.blocks.length || chip.blocks.some((block) => block.kind === 'mcu')) return null;
	if (isSeries74(chip.id) && family === 'ttl') return LS[chip.id] ?? null;
	return cmos(chip);
}
