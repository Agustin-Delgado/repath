/**
 * Integrated circuits, as the parts they are rather than as the gates inside.
 *
 * Nobody builds with a loose NAND. They build with a 7400: four of them in a
 * fourteen-pin package, two of those pins the supply, and a pinout that has to
 * be respected because the plastic does not care what would have been
 * convenient. A catalogue of chips is the difference between a simulator of
 * logic and one somebody can lay out a breadboard from.
 *
 * Nothing here reaches the engine as a new kind of device. A chip is an instance
 * that emits several primitives, the way the seven-segment digit emits eight
 * diodes: a 7400 is four `gate` devices with `kind: 'nand'`, sharing an instance
 * and named for the gate each one is.
 *
 * # Reading a row
 *
 * `layout` is the package, pin 1 first, and it is the part that has to be right:
 * it is what somebody reads off the drawing while counting legs on a real chip.
 * `blocks` is what is inside, written against those same pin names.
 *
 * A pin name a block uses that is not in `layout` is internal — a wire between
 * two blocks that never reaches a leg. Those get a net per instance, so two of
 * the same chip on one drawing do not share the inside of their gates.
 */

/** A primitive inside a package, wired to pin names rather than to nets. */
export interface ChipBlock {
	/** A kind the netlist already knows how to emit. */
	kind: 'and' | 'nand' | 'or' | 'nor' | 'xor' | 'xnor' | 'not' | 'buffer' | 'dff';
	/** Gate inputs, in order. */
	inputs?: readonly string[];
	/** Gate output. */
	output?: string;
	/** Flip-flop pins, for `kind: 'dff'`. */
	clock?: string;
	data?: string;
	reset?: string;
	preset?: string;
	q?: string;
	qn?: string;
}

export interface ChipDef {
	/** What is printed on the part, and the id it is placed by. */
	id: string;
	/** One line, the way a catalogue lists it. */
	description: string;
	/**
	 * Every pin of the package in order, starting at pin 1.
	 *
	 * The length is the package: fourteen entries is a DIP-14. `VCC` and `GND`
	 * are ordinary entries — they are legs like any other and have to be wired,
	 * which is the whole reason they are here.
	 */
	layout: readonly string[];
	/** What is inside, written against the pin names above. */
	blocks: readonly ChipBlock[];
	/** Anything about this part the model does not do. */
	caveat?: string;
}

/**
 * A row of identical two-input gates, which is most of what a logic family is.
 *
 * The 7400 and the 4011 are the same four NANDs in the same fourteen legs and
 * only the number on the lid differs. Writing that out twice invites the second
 * one to drift from the first.
 */
const QUAD_2: readonly string[] = [
	'1A',
	'1B',
	'1Y',
	'2A',
	'2B',
	'2Y',
	'GND',
	'3Y',
	'3A',
	'3B',
	'4Y',
	'4A',
	'4B',
	'VCC'
];

function quad2(kind: ChipBlock['kind'], layout: readonly string[] = QUAD_2) {
	return {
		layout,
		blocks: [1, 2, 3, 4].map((n) => ({ kind, inputs: [`${n}A`, `${n}B`], output: `${n}Y` }))
	};
}

function triple3(kind: ChipBlock['kind']) {
	return {
		layout: ['1A', '1B', '2A', '2B', '2C', '2Y', 'GND', '3Y', '3A', '3B', '3C', '1Y', '1C', 'VCC'],
		blocks: [1, 2, 3].map((n) => ({
			kind,
			inputs: [`${n}A`, `${n}B`, `${n}C`],
			output: `${n}Y`
		}))
	};
}

function dual4(kind: ChipBlock['kind']) {
	return {
		layout: ['1A', '1B', 'NC1', '1C', '1D', '1Y', 'GND', '2Y', '2A', '2B', 'NC2', '2C', '2D', 'VCC'],
		blocks: [1, 2].map((n) => ({
			kind,
			inputs: [`${n}A`, `${n}B`, `${n}C`, `${n}D`],
			output: `${n}Y`
		}))
	};
}

function hexInverter() {
	return {
		layout: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'],
		blocks: [1, 2, 3, 4, 5, 6].map((n) => ({
			kind: 'not' as const,
			inputs: [`${n}A`],
			output: `${n}Y`
		}))
	};
}

export const CHIPS: readonly ChipDef[] = [
	{ id: '7400', description: 'Quad 2-input NAND', ...quad2('nand') },
	{
		id: '7402',
		description: 'Quad 2-input NOR',
		// The output comes first on this one, and it is not a slip: the 7402 is the
		// chip everybody wires as though it were a 7400 and then spends an evening
		// on. The package is what is being modelled, so the trap is modelled too.
		layout: ['1Y', '1A', '1B', '2Y', '2A', '2B', 'GND', '3A', '3B', '3Y', '4A', '4B', '4Y', 'VCC'],
		blocks: [1, 2, 3, 4].map((n) => ({
			kind: 'nor' as const,
			inputs: [`${n}A`, `${n}B`],
			output: `${n}Y`
		}))
	},
	{ id: '7404', description: 'Hex inverter', ...hexInverter() },
	{ id: '7408', description: 'Quad 2-input AND', ...quad2('and') },
	{ id: '7410', description: 'Triple 3-input NAND', ...triple3('nand') },
	{ id: '7420', description: 'Dual 4-input NAND', ...dual4('nand') },
	{ id: '7421', description: 'Dual 4-input AND', ...dual4('and') },
	{ id: '7427', description: 'Triple 3-input NOR', ...triple3('nor') },
	{ id: '7432', description: 'Quad 2-input OR', ...quad2('or') },
	{ id: '7486', description: 'Quad 2-input XOR', ...quad2('xor') },
	{
		id: '74266',
		description: 'Quad 2-input XNOR',
		...quad2('xnor'),
		caveat:
			'The real part has open-drain outputs and wants a pull-up on each one; here they drive like any other gate.'
	}
];

const BY_ID = new Map(CHIPS.map((chip) => [chip.id, chip]));

export function chipById(id: string): ChipDef | undefined {
	return BY_ID.get(id);
}

export function isPower(pin: string): boolean {
	return pin === 'VCC' || pin === 'GND';
}

/**
 * A leg the die does not connect to.
 *
 * Real packages have them — a 7420 is two four-input gates in a case with room
 * for fourteen legs — and leaving them off the symbol would put every pin number
 * after them wrong, which is the one thing a pinout has to get right.
 */
export function isUnused(pin: string): boolean {
	return pin.startsWith('NC');
}

/** Pins that carry a signal: everything that is neither supply nor unused. */
export function signalPins(chip: ChipDef): string[] {
	return chip.layout.filter((pin) => !isPower(pin) && !isUnused(pin));
}
