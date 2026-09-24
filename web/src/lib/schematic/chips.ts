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

import { ANALOG_CHIPS } from './chips-analog';
import { MEMORY_CHIPS } from './chips-memory';

/** A primitive inside a package, wired to pin names rather than to nets. */
export interface ChipBlock {
	/** A kind the netlist already knows how to emit. */
	kind:
		| 'and'
		| 'nand'
		| 'or'
		| 'nor'
		| 'xor'
		| 'xnor'
		| 'not'
		| 'buffer'
		| 'tristate'
		| 'dff'
		| 'memory';
	/** Gate inputs, in order. A tri-state buffer takes one. */
	inputs?: readonly string[];
	/** Gate output. */
	output?: string;
	/** Tri-state enable, active high: low lets go of the output. */
	enable?: string;
	/** Flip-flop pins, for `kind: 'dff'`. */
	clock?: string;
	data?: string;
	reset?: string;
	preset?: string;
	q?: string;
	qn?: string;
	/** Memory pins, for `kind: 'memory'`: address least significant first. */
	address?: readonly string[];
	dataIn?: readonly string[];
	dataOut?: readonly string[];
	/** Stores what is on `dataIn` while high. */
	write?: string;
	/** From an address or a write to the outputs following it, seconds. */
	delay?: number;
	/**
	 * How an EEPROM writes: address latched as `write` rises and data as it
	 * falls, then `writeTime` putting it in the array. With `page` above one,
	 * words of one page loaded within `loadWindow` of each other go in together.
	 * Absent for a RAM, which stores while `write` is high.
	 */
	programming?: { writeTime: number; page?: number; loadWindow?: number };
}

/**
 * What a chip is for, which is how the palette shelves them.
 *
 * Sixty-odd numbers in one grid is a list only somebody who already knows the
 * number can use. Filed by job, the person who wants "a counter" finds the
 * five there are without knowing that one of them is called 4017.
 */
export const CHIP_ROLES = [
	{ id: 'gates', label: 'Gates and buffers' },
	{ id: 'flip-flops', label: 'Flip-flops' },
	{ id: 'counters', label: 'Counters' },
	{ id: 'shift-registers', label: 'Shift registers' },
	{ id: 'decoders', label: 'Decoders, encoders, multiplexers' },
	{ id: 'display', label: 'Display drivers' },
	{ id: 'arithmetic', label: 'Arithmetic' },
	{ id: 'bus', label: 'Three-state and bus' },
	{ id: 'timers', label: 'Timers' },
	{ id: 'memory', label: 'Memory' },
	{ id: 'amplifiers', label: 'Op-amps and comparators' },
	{ id: 'analog', label: 'Analog switches and drivers' }
] as const;

export type ChipRole = (typeof CHIP_ROLES)[number]['id'];

export interface ChipDef {
	/** What is printed on the part, and the id it is placed by. */
	id: string;
	/** The shelf it is filed on. */
	role: ChipRole;
	/** One line, the way a catalogue lists it. */
	description: string;
	/** Other numbers and names it is sold or spoken of under: `555` for the NE555. */
	aliases?: readonly string[];
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
	/**
	 * The analog half of what is inside, for the parts that are not all logic:
	 * a 555, an op-amp package, an analog switch. Written against the same pin
	 * names, with internal nodes named the same way internal nets are.
	 */
	analog?: readonly AnalogBlock[];
	/**
	 * For a memory somebody programs: it carries its contents as a parameter,
	 * and a word nobody wrote reads `erased`.
	 */
	contents?: { erased: number };
	/** Anything about this part the model does not do. */
	caveat?: string;
}

/**
 * A voltage inside a chip, given outright or as a fraction of its supply.
 *
 * `{ supply: 2 / 3 }` is two thirds of the way from the negative supply leg to
 * the positive one, read off what the drawing powers the chip from. It is how a
 * 555's thresholds follow its supply, and a Schmitt input's too.
 */
export type ChipVolts = number | { supply: number };

/** What an op-amp inside a package is like, from the first page of its datasheet. */
export interface OpAmpSpec {
	gain: number;
	/** Gain-bandwidth product, Hz. */
	gbw: number;
	/** Slew rate, V/s. */
	slew: number;
	rOut: number;
	vOs: number;
	iBias: number;
	/**
	 * How far short of each supply the output stops: above the negative one,
	 * below the positive one. A comparator feeding logic inside the package
	 * swings between fixed levels instead, which is what `fixed` is for.
	 */
	swing: readonly [number, number] | { fixed: readonly [number, number] };
}

/**
 * A primitive inside a package that the analog solver builds.
 *
 * `sense` and `drive` are the two ways across: a `sense` reads a node against
 * a pair of thresholds onto a logic net — a pair apart is a Schmitt input — and
 * a `drive` puts a logic net onto a node at the logic family's levels.
 */
export type AnalogBlock =
	| { kind: 'resistor'; a: string; b: string; ohms: number }
	| { kind: 'diode'; anode: string; cathode: string }
	| { kind: 'npn' | 'pnp'; collector: string; base: string; emitter: string; beta?: number }
	| { kind: 'opamp'; plus: string; minus: string; out: string; spec: OpAmpSpec }
	| {
			kind: 'switch';
			a: string;
			b: string;
			/** Closed when `control` is above `reference` by `on`, open below `off`. */
			control: string;
			reference: string;
			on: ChipVolts;
			off: ChipVolts;
			ron: number;
			roff?: number;
	  }
	| { kind: 'source'; plus: string; minus: string; volts: number }
	| { kind: 'sense'; node: string; net: string; rising?: ChipVolts; falling?: ChipVolts }
	| { kind: 'drive'; net: string; node: string };

/** Every name an analog block connects to, legs and internal nodes alike. */
export function analogTerminals(block: AnalogBlock): string[] {
	switch (block.kind) {
		case 'resistor':
			return [block.a, block.b];
		case 'diode':
			return [block.anode, block.cathode];
		case 'npn':
		case 'pnp':
			return [block.collector, block.base, block.emitter];
		case 'opamp':
			return [block.plus, block.minus, block.out];
		case 'switch':
			return [block.a, block.b, block.control, block.reference];
		case 'source':
			return [block.plus, block.minus];
		case 'sense':
			return [block.node];
		case 'drive':
			return [block.node];
	}
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

/**
 * The 4000 family's own quad pinout, which is not the 74xx one.
 *
 * The two outputs of each side sit together in the middle of it — 3 and 4, 10
 * and 11 — with the inputs out towards the corners. On a 7400 each output
 * follows its own inputs instead. The supply is on the same corners as VCC and
 * GND, and everything in between moved.
 */
const CMOS_QUAD: readonly string[] = [
	'1A',
	'1B',
	'1Y',
	'2Y',
	'2A',
	'2B',
	'VSS',
	'3A',
	'3B',
	'3Y',
	'4Y',
	'4A',
	'4B',
	'VDD'
];

function cmosTriple3(kind: ChipBlock['kind']) {
	// Gate 1 is spread across the package: 1, 2 and 8 into 9. The other two are
	// contiguous, which is what makes the first one easy to miswire.
	return {
		layout: ['1A', '1B', '2A', '2B', '2C', '2Y', 'VSS', '1C', '1Y', '3Y', '3A', '3B', '3C', 'VDD'],
		blocks: [1, 2, 3].map((n) => ({
			kind,
			inputs: [`${n}A`, `${n}B`, `${n}C`],
			output: `${n}Y`
		}))
	};
}

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

/**
 * A JK flip-flop, built out of a D one.
 *
 * There is no JK primitive and there does not need to be: `D = J·Q̄ + K̄·Q` is a
 * JK, and the identity is worth having in the drawing rather than in the engine
 * because it is the thing being taught. Hold both inputs high and it reduces to
 * `D = Q̄`, which is the toggle every divide-by-two is built on.
 *
 * The four gates and the flip-flop talk over nets that never reach a leg, so
 * they are named against the flip-flop's number and get one net per instance.
 */
function jk(
	n: number,
	async: { preset?: string; reset?: string },
	clock = `${n}CLK`
): ChipBlock[] {
	return [
		{ kind: 'not', inputs: [`${n}K`], output: `${n}kn` },
		{ kind: 'and', inputs: [`${n}J`, `${n}QN`], output: `${n}set_t` },
		{ kind: 'and', inputs: [`${n}kn`, `${n}Q`], output: `${n}hold_t` },
		{ kind: 'or', inputs: [`${n}set_t`, `${n}hold_t`], output: `${n}d` },
		{
			kind: 'dff',
			clock,
			data: `${n}d`,
			reset: async.reset,
			preset: async.preset,
			q: `${n}Q`,
			qn: `${n}QN`
		}
	];
}

/**
 * A D latch that is transparent while `enable` is high, out of four NANDs.
 *
 * The engine has an edge-triggered flip-flop and no latch, and a latch is not a
 * flip-flop with the clock held: it follows its input the whole time it is open.
 * Four cross-coupled NANDs are what the silicon does anyway.
 */
function latch(tag: string, data: string, enable: string, q: string): ChipBlock[] {
	return [
		{ kind: 'nand', inputs: [data, enable], output: `${tag}n1` },
		{ kind: 'nand', inputs: [`${tag}n1`, enable], output: `${tag}n2` },
		{ kind: 'nand', inputs: [`${tag}n1`, `${tag}qn`], output: q },
		{ kind: 'nand', inputs: [`${tag}n2`, q], output: `${tag}qn` }
	];
}

/**
 * The seven equations that turn four bits into a digit.
 *
 * Minimised over the ten codes that are digits, with the other six treated as
 * don't-cares — which is why a real 4511 blanks on 10 through 15 rather than
 * showing something: the equations were never asked about those.
 *
 * `bit` names the four data inputs from least significant, and every product is
 * spelled out rather than shared, because a shared term is a net the reader has
 * to hold in their head while checking the one they care about.
 */
function bcd7seg(a: string, bIn: string, c: string, d: string): ChipBlock[] {
	const an = 'seg_an';
	const bn = 'seg_bn';
	const cn = 'seg_cn';
	return [
		{ kind: 'not', inputs: [a], output: an },
		{ kind: 'not', inputs: [bIn], output: bn },
		{ kind: 'not', inputs: [c], output: cn },

		// a = D + B + C·A + C'·A'
		{ kind: 'and', inputs: [c, a], output: 'p_ca' },
		{ kind: 'and', inputs: [cn, an], output: 'p_cnan' },
		{ kind: 'or', inputs: [d, bIn, 'p_ca', 'p_cnan'], output: 'sa' },

		// b = C' + B·A + B'·A'
		{ kind: 'and', inputs: [bIn, a], output: 'p_ba' },
		{ kind: 'and', inputs: [bn, an], output: 'p_bnan' },
		{ kind: 'or', inputs: [cn, 'p_ba', 'p_bnan'], output: 'sb' },

		// c = C + B' + A
		{ kind: 'or', inputs: [c, bn, a], output: 'sc' },

		// d = D + B·A' + C'·A' + C'·B + C·B'·A, which is one term more than an OR
		// takes, so it arrives in two.
		{ kind: 'and', inputs: [bIn, an], output: 'p_ban' },
		{ kind: 'and', inputs: [cn, bIn], output: 'p_cnb' },
		{ kind: 'and', inputs: [c, bn, a], output: 'p_cbna' },
		{ kind: 'or', inputs: [d, 'p_ban', 'p_cnan', 'p_cnb'], output: 'sd_part' },
		{ kind: 'or', inputs: ['sd_part', 'p_cbna'], output: 'sd' },

		// e = B·A' + C'·A'
		{ kind: 'or', inputs: ['p_ban', 'p_cnan'], output: 'se' },

		// f = D + C·B' + C·A' + B'·A'
		{ kind: 'and', inputs: [c, bn], output: 'p_cbn' },
		{ kind: 'and', inputs: [c, an], output: 'p_can' },
		{ kind: 'or', inputs: [d, 'p_cbn', 'p_can', 'p_bnan'], output: 'sf' },

		// g = D + C·B' + C'·B + B·A'
		{ kind: 'or', inputs: [d, 'p_cbn', 'p_cnb', 'p_ban'], output: 'sg' }
	];
}

/**
 * One stage of a synchronous binary counter with parallel load.
 *
 * Synchronous means every flip-flop is on the same clock and the decision is in
 * front of it rather than in the clock line — which is the whole reason to reach
 * for one of these over a ripple counter: all four bits change together, so
 * there is no instant where the count reads as a number it never passed through.
 *
 * `toggle` is the term that says this bit's turn has come: for the lowest bit
 * that is just "counting", and for each one above it every bit below has to be
 * high as well.
 */
function counterBit(
	bit: string,
	load: string,
	loadn: string,
	toggle: string,
	clear: { async: string } | { sync: string }
): ChipBlock[] {
	const q = `Q${bit}`;
	const next = 'sync' in clear ? `${bit}next` : `${bit}d`;
	return [
		{ kind: 'not', inputs: [q], output: `${bit}qn` },
		{ kind: 'not', inputs: [toggle], output: `${bit}hold` },
		// Loading beats counting, which is what makes it a load rather than a hint.
		{ kind: 'and', inputs: [load, bit], output: `${bit}from_pin` },
		{ kind: 'and', inputs: [loadn, toggle, `${bit}qn`], output: `${bit}flip` },
		{ kind: 'and', inputs: [loadn, `${bit}hold`, q], output: `${bit}stay` },
		{ kind: 'or', inputs: [`${bit}from_pin`, `${bit}flip`, `${bit}stay`], output: next },
		// A synchronous clear is one more condition in front of the flip-flop, and
		// the one that beats all the others: it waits for the edge like everything
		// else does, which is the difference between a 74163 and a 74161.
		...('sync' in clear
			? [{ kind: 'and' as const, inputs: [clear.sync, next], output: `${bit}d` }]
			: []),
		{
			kind: 'dff',
			clock: 'CLK',
			data: `${bit}d`,
			reset: 'async' in clear ? clear.async : undefined,
			q,
			qn: `${bit}qn_out`
		}
	];
}

/**
 * A JK flip-flop that acts on the falling edge of its clock.
 *
 * The 7473, 74107 and 74112 all do, and the engine's flip-flop takes the rising
 * one, so the clock arrives through an inverter — the same move the 7490 makes.
 * Preset and clear are active low wherever they exist on these parts.
 */
function fallingJk(n: number, pins: { preset?: string; clear?: string }): ChipBlock[] {
	const blocks: ChipBlock[] = [{ kind: 'not', inputs: [`${n}CLK`], output: `${n}clk_fall` }];
	if (pins.preset) blocks.push({ kind: 'not', inputs: [pins.preset], output: `${n}pre_i` });
	if (pins.clear) blocks.push({ kind: 'not', inputs: [pins.clear], output: `${n}clr_i` });
	return [
		...blocks,
		...jk(
			n,
			{
				preset: pins.preset && `${n}pre_i`,
				reset: pins.clear && `${n}clr_i`
			},
			`${n}clk_fall`
		)
	];
}

/**
 * A chain of D flip-flops, each taking the one before it: a shift register.
 *
 * `names` are the stages in the order data travels. Each stage's output is the
 * name it is given, and its complement is that name with `n` on the end, which
 * is internal unless the package happens to bring it out.
 */
function shiftChain(
	names: readonly string[],
	input: string,
	clock: string,
	async: (stage: string, index: number) => { reset?: string; preset?: string } = () => ({})
): ChipBlock[] {
	return names.map((stage, i) => ({
		kind: 'dff' as const,
		clock,
		data: i === 0 ? input : names[i - 1],
		...async(stage, i),
		q: stage,
		qn: `${stage}n`
	}));
}

/**
 * Loads a flip-flop from a pin without waiting for a clock.
 *
 * The 74165 and 74193 take their parallel data asynchronously: while the load
 * pin is held, each stage is forced to what its data pin says. On a flip-flop
 * that is a preset when the pin is high and a clear when it is low, so each
 * stage gets both, gated by the load.
 */
function asyncLoad(tag: string, load: string, data: string, clear?: string): ChipBlock[] {
	return [
		{ kind: 'not', inputs: [data], output: `${tag}_datan` },
		clear
			? { kind: 'and', inputs: [load, data, `${clear}n`], output: `${tag}_pre` }
			: { kind: 'and', inputs: [load, data], output: `${tag}_pre` },
		...(clear
			? [
					{ kind: 'and' as const, inputs: [load, `${tag}_datan`], output: `${tag}_load0` },
					// Clear beats load, as it does on the part.
					{ kind: 'or' as const, inputs: [clear, `${tag}_load0`], output: `${tag}_rst` }
				]
			: [{ kind: 'and' as const, inputs: [load, `${tag}_datan`], output: `${tag}_rst` }])
	];
}

const LOGIC_CHIPS: readonly ChipDef[] = [
	{ id: '7400', role: 'gates', description: 'Quad 2-input NAND', ...quad2('nand') },
	{
		id: '7402',
		role: 'gates',
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
	{ id: '7404', role: 'gates', description: 'Hex inverter', ...hexInverter() },
	{ id: '7408', role: 'gates', description: 'Quad 2-input AND', ...quad2('and') },
	{ id: '7410', role: 'gates', description: 'Triple 3-input NAND', ...triple3('nand') },
	{ id: '7420', role: 'gates', description: 'Dual 4-input NAND', ...dual4('nand') },
	{ id: '7421', role: 'gates', description: 'Dual 4-input AND', ...dual4('and') },
	{ id: '7427', role: 'gates', description: 'Triple 3-input NOR', ...triple3('nor') },
	{ id: '7432', role: 'gates', description: 'Quad 2-input OR', ...quad2('or') },
	{ id: '7486', role: 'gates', description: 'Quad 2-input XOR', ...quad2('xor') },
	{
		id: '74266',
		role: 'gates',
		description: 'Quad 2-input XNOR',
		// Not the 7400 legs: this one has its outputs paired in the middle, 3 with
		// 4 and 10 with 11, the way the 4000 family lays a quad out.
		...quad2('xnor', ['1A', '1B', '1Y', '2Y', '2A', '2B', 'GND', '3A', '3B', '3Y', '4Y', '4A', '4B', 'VCC']),
		caveat:
			'The real part has open-drain outputs and wants a pull-up on each one; here they drive like any other gate.'
	},

	// The 4000 family. Same gates, different legs — and the legs are the reason
	// both families are here rather than one standing in for the other. A 4011 is
	// four NANDs like a 7400 and its pinout is nothing like it: swap the chip
	// without redrawing and every wire lands on the wrong pin.
	{ id: '4001', role: 'gates', description: 'Quad 2-input NOR (CMOS)', ...quad2('nor', CMOS_QUAD) },
	{
		id: '4002',
		role: 'gates',
		description: 'Dual 4-input NOR (CMOS)',
		layout: ['1Y', '1A', '1B', '1C', '1D', 'NC1', 'VSS', 'NC2', '2A', '2B', '2C', '2D', '2Y', 'VDD'],
		blocks: [1, 2].map((n) => ({
			kind: 'nor' as const,
			inputs: [`${n}A`, `${n}B`, `${n}C`, `${n}D`],
			output: `${n}Y`
		}))
	},
	{ id: '4011', role: 'gates', description: 'Quad 2-input NAND (CMOS)', ...quad2('nand', CMOS_QUAD) },
	{
		id: '4012',
		role: 'gates',
		description: 'Dual 4-input NAND (CMOS)',
		layout: ['1Y', '1A', '1B', '1C', '1D', 'NC1', 'VSS', 'NC2', '2A', '2B', '2C', '2D', '2Y', 'VDD'],
		blocks: [1, 2].map((n) => ({
			kind: 'nand' as const,
			inputs: [`${n}A`, `${n}B`, `${n}C`, `${n}D`],
			output: `${n}Y`
		}))
	},
	{ id: '4023', role: 'gates', description: 'Triple 3-input NAND (CMOS)', ...cmosTriple3('nand') },
	{ id: '4025', role: 'gates', description: 'Triple 3-input NOR (CMOS)', ...cmosTriple3('nor') },
	{
		id: '4069',
		role: 'gates',
		description: 'Hex inverter (CMOS)',
		layout: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'VSS', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VDD'],
		blocks: [1, 2, 3, 4, 5, 6].map((n) => ({
			kind: 'not' as const,
			inputs: [`${n}A`],
			output: `${n}Y`
		}))
	},
	{ id: '4070', role: 'gates', description: 'Quad 2-input XOR (CMOS)', ...quad2('xor', CMOS_QUAD) },
	{ id: '4071', role: 'gates', description: 'Quad 2-input OR (CMOS)', ...quad2('or', CMOS_QUAD) },
	{ id: '4077', role: 'gates', description: 'Quad 2-input XNOR (CMOS)', ...quad2('xnor', CMOS_QUAD) },
	{ id: '4081', role: 'gates', description: 'Quad 2-input AND (CMOS)', ...quad2('and', CMOS_QUAD) },

	// Flip-flops. The D parts map straight onto the engine's; the JK ones are
	// built out of one, which is what `jk` below is for.
	{
		id: '7474',
		role: 'flip-flops',
		description: 'Dual D flip-flop with preset and clear',
		// Preset and clear are active low on this part, so each one arrives through
		// an inverter: the engine's asynchronous inputs act on a high, and the leg
		// on the drawing has to behave the way the bar over its name says.
		layout: [
			'1CLR', '1D', '1CLK', '1PRE', '1Q', '1QN', 'GND',
			'2QN', '2Q', '2PRE', '2CLK', '2D', '2CLR', 'VCC'
		],
		blocks: [1, 2].flatMap((n) => [
			{ kind: 'not' as const, inputs: [`${n}CLR`], output: `${n}clr_i` },
			{ kind: 'not' as const, inputs: [`${n}PRE`], output: `${n}pre_i` },
			{
				kind: 'dff' as const,
				clock: `${n}CLK`,
				data: `${n}D`,
				reset: `${n}clr_i`,
				preset: `${n}pre_i`,
				q: `${n}Q`,
				qn: `${n}QN`
			}
		])
	},
	{
		id: '4013',
		role: 'flip-flops',
		description: 'Dual D flip-flop with set and reset (CMOS)',
		// Active high on this one, so they go straight in.
		layout: [
			'1Q', '1QN', '1CLK', '1RST', '1D', '1SET', 'VSS',
			'2SET', '2D', '2RST', '2CLK', '2QN', '2Q', 'VDD'
		],
		blocks: [1, 2].map((n) => ({
			kind: 'dff' as const,
			clock: `${n}CLK`,
			data: `${n}D`,
			reset: `${n}RST`,
			preset: `${n}SET`,
			q: `${n}Q`,
			qn: `${n}QN`
		}))
	},
	{
		id: '7476',
		role: 'flip-flops',
		description: 'Dual JK flip-flop with preset and clear',
		layout: [
			'1CLK', '1PRE', '1CLR', '1J', 'VCC', '2CLK', '2PRE', '2CLR',
			'2J', '2QN', '2Q', '2K', 'GND', '1QN', '1Q', '1K'
		],
		blocks: [1, 2].flatMap((n) => [
			{ kind: 'not' as const, inputs: [`${n}PRE`], output: `${n}pre_i` },
			{ kind: 'not' as const, inputs: [`${n}CLR`], output: `${n}clr_i` },
			...jk(n, { preset: `${n}pre_i`, reset: `${n}clr_i` })
		]),
		caveat:
			'The real part is master-slave and takes its inputs while the clock is high; this one is edge-triggered.'
	},
	{
		id: '74138',
		role: 'decoders',
		description: '3-to-8 line decoder',
		// Eight outputs, one of them low at a time, chosen by three address pins —
		// and three enables, because this part exists to be stacked: one 74138 can
		// drive the enables of the next and address sixty-four lines.
		layout: [
			'A', 'B', 'C', 'G2A', 'G2B', 'G1', 'Y7', 'GND',
			'Y6', 'Y5', 'Y4', 'Y3', 'Y2', 'Y1', 'Y0', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['A'], output: 'an' },
			{ kind: 'not', inputs: ['B'], output: 'bn' },
			{ kind: 'not', inputs: ['C'], output: 'cn' },
			// Both G2 pins are active low and G1 is active high: the chip is on when
			// G1 is up and neither G2 is.
			{ kind: 'not', inputs: ['G2A'], output: 'g2an' },
			{ kind: 'not', inputs: ['G2B'], output: 'g2bn' },
			{ kind: 'and', inputs: ['G1', 'g2an', 'g2bn'], output: 'en' },
			// One NAND per line, taking the enable and the three address bits in the
			// polarity that line answers to. NAND rather than AND because the outputs
			// are active low, which is what lets several of these share a bus.
			...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
				kind: 'nand' as const,
				inputs: [
					'en',
					n & 1 ? 'A' : 'an',
					n & 2 ? 'B' : 'bn',
					n & 4 ? 'C' : 'cn'
				],
				output: `Y${n}`
			}))
		]
	},
	{
		id: '4511',
		role: 'display',
		description: 'BCD to 7-segment latch/decoder/driver (CMOS)',
		// Outputs go high for a lit segment, which is a common-cathode digit — the
		// polarity the seven-segment part defaults to, so the two go together.
		layout: [
			'B', 'C', 'LT', 'BI', 'LE', 'D', 'A', 'VSS',
			'e', 'd', 'c', 'b', 'a', 'g', 'f', 'VDD'
		],
		blocks: [
			// Latch enable is active high and holds; the latches are open while it is
			// low. A pin that did nothing would be worse than no pin, so they are
			// really here — four of them, four NANDs each.
			{ kind: 'not', inputs: ['LE'], output: 'open' },
			...latch('la', 'A', 'open', 'qa'),
			...latch('lb', 'B', 'open', 'qb'),
			...latch('lc', 'C', 'open', 'qc'),
			...latch('ld', 'D', 'open', 'qd'),
			...bcd7seg('qa', 'qb', 'qc', 'qd'),
			// Lamp test wins over blanking, and both are active low: hold LT down and
			// every segment lights whatever the data says, which is how somebody finds
			// the dead one.
			{ kind: 'not', inputs: ['LT'], output: 'lamp' },
			...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((seg) => ({
				kind: 'and' as const,
				inputs: ['BI', `s${seg}`],
				output: `k${seg}`
			})),
			...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((seg) => ({
				kind: 'or' as const,
				inputs: ['lamp', `k${seg}`],
				output: seg
			}))
		]
	},
	{
		id: '7447',
		role: 'display',
		description: 'BCD to 7-segment decoder/driver, open collector',
		// The 4511's opposite number: outputs pull *down* for a lit segment, which
		// is a common-anode digit. Same seven equations, inverted on the way out.
		layout: [
			'B', 'C', 'LT', 'BI', 'RBI', 'D', 'A', 'GND',
			'e', 'd', 'c', 'b', 'a', 'g', 'f', 'VCC'
		],
		blocks: [
			...bcd7seg('A', 'B', 'C', 'D'),
			{ kind: 'not', inputs: ['LT'], output: 'lamp' },
			// Ripple blanking: hold RBI down and a zero is shown as nothing at all.
			// That is how 007 is displayed as 7 — each leading digit blanks itself and
			// tells the next one along to do the same.
			{ kind: 'not', inputs: ['RBI'], output: 'rbin' },
			{ kind: 'nor', inputs: ['A', 'B', 'C', 'D'], output: 'zero' },
			{ kind: 'and', inputs: ['rbin', 'zero'], output: 'ripple' },
			{ kind: 'not', inputs: ['ripple'], output: 'show' },
			...['a', 'b', 'c', 'd', 'e', 'f', 'g'].flatMap((seg) => [
				// Lamp test wins over both kinds of blanking, which is what makes it a
				// test: it has to light a segment the data would have left dark.
				{ kind: 'and' as const, inputs: ['BI', 'show', `s${seg}`], output: `k${seg}` },
				{ kind: 'or' as const, inputs: ['lamp', `k${seg}`], output: `on_${seg}` },
				// Low means lit on this part, so the last thing every segment meets is
				// an inverter. Wire one of these to a common-cathode digit and it shows
				// the photographic negative of the number.
				{ kind: 'not' as const, inputs: [`on_${seg}`], output: seg }
			])
		],
		caveat:
			'Pin 4 is blanking in only. On the real part it is also the ripple-blanking output that drives the next decoder, which needs an open-collector pin, and those are not modelled — so is the rest of the outputs pulling down rather than driving both ways.'
	},
	{
		id: '74151',
		role: 'decoders',
		description: '8-to-1 multiplexer',
		// Three address pins pick one of eight inputs. Y is the choice and W is its
		// complement, which is on the package because half the circuits that use one
		// of these want the inverse and an inverter is a whole other chip.
		layout: [
			'D3', 'D2', 'D1', 'D0', 'Y', 'W', 'G', 'GND',
			'C', 'B', 'A', 'D7', 'D6', 'D5', 'D4', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['A'], output: 'an' },
			{ kind: 'not', inputs: ['B'], output: 'bn' },
			{ kind: 'not', inputs: ['C'], output: 'cn' },
			{ kind: 'not', inputs: ['G'], output: 'gn' },
			// One AND per input, open only for the address that names it.
			...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
				kind: 'and' as const,
				inputs: [
					`D${n}`,
					n & 1 ? 'A' : 'an',
					n & 2 ? 'B' : 'bn',
					n & 4 ? 'C' : 'cn'
				],
				output: `m${n}`
			})),
			// Eight terms is more than an OR takes, so they arrive in two halves.
			{ kind: 'or', inputs: ['m0', 'm1', 'm2', 'm3'], output: 'lo' },
			{ kind: 'or', inputs: ['m4', 'm5', 'm6', 'm7'], output: 'hi' },
			{ kind: 'or', inputs: ['lo', 'hi'], output: 'picked' },
			// The strobe is active low and blanks the output whatever is selected.
			{ kind: 'and', inputs: ['gn', 'picked'], output: 'Y' },
			{ kind: 'not', inputs: ['Y'], output: 'W' }
		]
	},
	{
		id: '74161',
		role: 'counters',
		description: '4-bit synchronous binary counter with parallel load',
		layout: [
			'CLR', 'CLK', 'A', 'B', 'C', 'D', 'ENP', 'GND',
			'LOAD', 'ENT', 'QD', 'QC', 'QB', 'QA', 'RCO', 'VCC'
		],
		blocks: [
			// Clear and load are active low; both enables are active high and both
			// have to be up for it to count, which is what lets one of these gate the
			// next along in a chain.
			{ kind: 'not', inputs: ['CLR'], output: 'clear' },
			{ kind: 'not', inputs: ['LOAD'], output: 'load' },
			{ kind: 'and', inputs: ['ENP', 'ENT', 'LOAD'], output: 'count' },
			// Each bit flips when every bit below it is high.
			{ kind: 'and', inputs: ['count', 'QA'], output: 'tb' },
			{ kind: 'and', inputs: ['count', 'QA', 'QB'], output: 'tc' },
			{ kind: 'and', inputs: ['count', 'QA', 'QB', 'QC'], output: 'td' },
			...counterBit('A', 'load', 'LOAD', 'count', { async: 'clear' }),
			...counterBit('B', 'load', 'LOAD', 'tb', { async: 'clear' }),
			...counterBit('C', 'load', 'LOAD', 'tc', { async: 'clear' }),
			...counterBit('D', 'load', 'LOAD', 'td', { async: 'clear' }),
			// Ripple carry out: fifteen, and enabled. Five terms is one more than an
			// AND takes, so it arrives in two.
			{ kind: 'and', inputs: ['QA', 'QB', 'QC', 'QD'], output: 'fifteen' },
			{ kind: 'and', inputs: ['fifteen', 'ENT'], output: 'RCO' }
		],
		caveat:
			'Clear is asynchronous here, as on the 74161 proper. The 74163 is the same part with a synchronous one.'
	},
	{
		id: '7490',
		role: 'counters',
		description: 'Decade counter, divide-by-two and divide-by-five',
		// The supply is not on the corners of this one: VCC is pin 5 and GND is pin
		// 10. Wiring it like every other 14-pin part puts five volts across two
		// outputs, which is the kind of thing a drawing should be able to show.
		//
		// The two halves are separate on purpose. Tie QA to CKB and it counts to
		// ten in binary; tie QD to CKA and drive CKB instead and it counts to ten
		// with a symmetrical output, which is what you want for a clock divider.
		layout: [
			'CKB', 'R01', 'R02', 'NC1', 'VCC', 'R91', 'R92',
			'QC', 'QB', 'GND', 'QD', 'QA', 'NC2', 'CKA'
		],
		blocks: [
			// Set-to-nine wins over reset-to-zero, and each needs both of its pins.
			{ kind: 'and', inputs: ['R91', 'R92'], output: 'nine' },
			{ kind: 'nand', inputs: ['R01', 'R02'], output: 'zeron' },
			{ kind: 'nor', inputs: ['zeron', 'nine'], output: 'zero' },
			{ kind: 'or', inputs: ['zero', 'nine'], output: 'clearbc' },

			// This part counts on the falling edge of its clocks, which the engine's
			// flip-flop does not — so each clock pin arrives through an inverter. It
			// is not a detail anyone can ignore: tie QA to CKB for a decade and a
			// rising-edge chain advances the second half one count early, so 1 reads
			// as 3 and the whole sequence comes out interleaved.
			{ kind: 'not', inputs: ['CKA'], output: 'cka_fall' },
			{ kind: 'not', inputs: ['CKB'], output: 'ckb_fall' },

			// The divide-by-two: one flip-flop on its own clock.
			{ kind: 'dff', clock: 'cka_fall', data: 'qan', reset: 'zero', preset: 'nine', q: 'QA', qn: 'qan' },

			// The divide-by-five, which is not a binary counter with a reset: B is
			// held off while D is up, so four is followed by zero rather than five.
			{ kind: 'and', inputs: ['qdn', 'qbn'], output: 'db' },
			{ kind: 'dff', clock: 'ckb_fall', data: 'db', reset: 'clearbc', q: 'QB', qn: 'qbn' },
			// C is clocked by B falling, which is B-bar rising.
			{ kind: 'dff', clock: 'qbn', data: 'qcn', reset: 'clearbc', q: 'QC', qn: 'qcn' },
			// And D comes up on the count after B and C are both high.
			{ kind: 'and', inputs: ['QB', 'QC', 'qdn'], output: 'dd' },
			{ kind: 'dff', clock: 'ckb_fall', data: 'dd', reset: 'zero', preset: 'nine', q: 'QD', qn: 'qdn' }
		]
	},
	{
		id: '74157',
		role: 'decoders',
		description: 'Quad 2-to-1 multiplexer',
		// Four switches worked by one pin: low picks the A side of every channel,
		// high picks B. The strobe blanks all four at once.
		layout: [
			'S', '1A', '1B', '1Y', '2A', '2B', '2Y', 'GND',
			'3Y', '3B', '3A', '4Y', '4B', '4A', 'G', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['S'], output: 'sn' },
			{ kind: 'not', inputs: ['G'], output: 'gn' },
			...[1, 2, 3, 4].flatMap((n) => [
				{ kind: 'and' as const, inputs: ['gn', 'sn', `${n}A`], output: `${n}pa` },
				{ kind: 'and' as const, inputs: ['gn', 'S', `${n}B`], output: `${n}pb` },
				{ kind: 'or' as const, inputs: [`${n}pa`, `${n}pb`], output: `${n}Y` }
			])
		]
	},
	{
		id: '4027',
		role: 'flip-flops',
		description: 'Dual JK flip-flop with set and reset (CMOS)',
		// Flip-flop 2 is the one at pin 1, and 1 is up the right-hand side — the
		// opposite of the 4013, whose first flip-flop starts at pin 1. Same
		// datasheet family, and no rule that says which half comes first.
		layout: [
			'2Q', '2QN', '2CLK', '2RST', '2K', '2J', '2SET', 'VSS',
			'1SET', '1J', '1K', '1RST', '1CLK', '1QN', '1Q', 'VDD'
		],
		blocks: [1, 2].flatMap((n) => jk(n, { preset: `${n}SET`, reset: `${n}RST` }))
	},

	// More gates, for the jobs a quad does not cover.
	{ id: '7411', role: 'gates', description: 'Triple 3-input AND', ...triple3('and') },
	{
		id: '7430',
		role: 'gates',
		description: '8-input NAND',
		// One gate in a fourteen-leg case, so three legs go nowhere. What it is for
		// is spotting one address on an eight-bit bus: every line high, and only
		// then does the output fall.
		layout: ['A', 'B', 'C', 'D', 'E', 'F', 'GND', 'Y', 'NC1', 'NC2', 'G', 'H', 'NC3', 'VCC'],
		blocks: [
			{ kind: 'and', inputs: ['A', 'B', 'C', 'D'], output: 'lo' },
			{ kind: 'and', inputs: ['E', 'F', 'G', 'H'], output: 'hi' },
			{ kind: 'nand', inputs: ['lo', 'hi'], output: 'Y' }
		]
	},
	{
		id: '4049',
		role: 'gates',
		description: 'Hex inverting buffer (CMOS)',
		// The oddest supply in the family: VDD on pin 1 rather than 16, and 13 and
		// 16 go nowhere. A drawing that assumes the corners puts the supply on an
		// output.
		layout: [
			'VDD', '1Y', '1A', '2Y', '2A', '3Y', '3A', 'VSS',
			'4A', '4Y', '5A', '5Y', 'NC1', '6A', '6Y', 'NC2'
		],
		blocks: [1, 2, 3, 4, 5, 6].map((n) => ({
			kind: 'not' as const,
			inputs: [`${n}A`],
			output: `${n}Y`
		})),
		caveat:
			'The real part can sink far more current than an ordinary gate, which is what it is bought for; here it drives like any other.'
	},
	{
		id: '4050',
		role: 'gates',
		description: 'Hex non-inverting buffer (CMOS)',
		// The 4049's pinout without the inversion.
		layout: [
			'VDD', '1Y', '1A', '2Y', '2A', '3Y', '3A', 'VSS',
			'4A', '4Y', '5A', '5Y', 'NC1', '6A', '6Y', 'NC2'
		],
		blocks: [1, 2, 3, 4, 5, 6].map((n) => ({
			kind: 'buffer' as const,
			inputs: [`${n}A`],
			output: `${n}Y`
		})),
		caveat:
			'On the real part the inputs take up to 15 V whatever the supply, which is what makes it a level shifter; that is not modelled.'
	},

	// Arithmetic.
	{
		id: '74283',
		role: 'arithmetic',
		description: '4-bit binary full adder with fast carry',
		// The sum pins are not in order down the package — Σ1 is pin 4, Σ2 pin 1 —
		// which is the thing to check before wiring one.
		layout: [
			'S2', 'B2', 'A2', 'S1', 'A1', 'B1', 'C0', 'GND',
			'C4', 'S4', 'B4', 'A4', 'S3', 'A3', 'B3', 'VCC'
		],
		blocks: [1, 2, 3, 4].flatMap((n) => {
			const carryIn = n === 1 ? 'C0' : `c${n - 1}`;
			return [
				{ kind: 'xor' as const, inputs: [`A${n}`, `B${n}`], output: `x${n}` },
				{ kind: 'xor' as const, inputs: [`x${n}`, carryIn], output: `S${n}` },
				{ kind: 'and' as const, inputs: [`A${n}`, `B${n}`], output: `g${n}` },
				{ kind: 'and' as const, inputs: [`x${n}`, carryIn], output: `p${n}` },
				{ kind: 'or' as const, inputs: [`g${n}`, `p${n}`], output: n === 4 ? 'C4' : `c${n}` }
			];
		}),
		caveat:
			'The carry ripples through the four bits here; the real part looks ahead, so its carry out arrives sooner.'
	},
	{
		id: '7485',
		role: 'arithmetic',
		description: '4-bit magnitude comparator',
		// Three answers out and the same three in, so a pair of these compares
		// eight bits: the low one's outputs go into the high one's inputs, and the
		// high one only asks them when its own four bits are equal.
		layout: [
			'B3', 'LTin', 'EQin', 'GTin', 'GTout', 'EQout', 'LTout', 'GND',
			'B0', 'A0', 'B1', 'A1', 'A2', 'B2', 'A3', 'VCC'
		],
		blocks: [
			...[0, 1, 2, 3].flatMap((n) => [
				{ kind: 'not' as const, inputs: [`A${n}`], output: `an${n}` },
				{ kind: 'not' as const, inputs: [`B${n}`], output: `bn${n}` },
				{ kind: 'and' as const, inputs: [`A${n}`, `bn${n}`], output: `gt${n}` },
				{ kind: 'and' as const, inputs: [`an${n}`, `B${n}`], output: `lt${n}` },
				{ kind: 'xnor' as const, inputs: [`A${n}`, `B${n}`], output: `eq${n}` }
			]),
			// The most significant bit that differs decides, so each term asks that
			// every bit above it was equal.
			{ kind: 'and', inputs: ['eq3', 'gt2'], output: 'gt_2' },
			{ kind: 'and', inputs: ['eq3', 'eq2', 'gt1'], output: 'gt_1' },
			{ kind: 'and', inputs: ['eq3', 'eq2', 'eq1', 'gt0'], output: 'gt_0' },
			{ kind: 'or', inputs: ['gt3', 'gt_2', 'gt_1', 'gt_0'], output: 'greater' },
			{ kind: 'and', inputs: ['eq3', 'lt2'], output: 'lt_2' },
			{ kind: 'and', inputs: ['eq3', 'eq2', 'lt1'], output: 'lt_1' },
			{ kind: 'and', inputs: ['eq3', 'eq2', 'eq1', 'lt0'], output: 'lt_0' },
			{ kind: 'or', inputs: ['lt3', 'lt_2', 'lt_1', 'lt_0'], output: 'less' },
			{ kind: 'and', inputs: ['eq0', 'eq1', 'eq2', 'eq3'], output: 'same' },
			// Equal here hands the question to the cascade inputs. The datasheet's
			// table is followed row for row, including its two odd ones: both cascade
			// inputs high with equality low reads as neither, and all three low reads
			// as both greater and less.
			{ kind: 'not', inputs: ['EQin'], output: 'eqin_n' },
			{ kind: 'not', inputs: ['LTin'], output: 'ltin_n' },
			{ kind: 'not', inputs: ['GTin'], output: 'gtin_n' },
			{ kind: 'and', inputs: ['same', 'eqin_n', 'ltin_n'], output: 'cascade_gt' },
			{ kind: 'and', inputs: ['same', 'eqin_n', 'gtin_n'], output: 'cascade_lt' },
			{ kind: 'or', inputs: ['greater', 'cascade_gt'], output: 'GTout' },
			{ kind: 'or', inputs: ['less', 'cascade_lt'], output: 'LTout' },
			{ kind: 'and', inputs: ['same', 'EQin'], output: 'EQout' }
		]
	},

	// Decoders, encoders and multiplexers.
	{
		id: '74139',
		role: 'decoders',
		description: 'Dual 2-to-4 line decoder',
		// Two independent halves, each with its own enable; the second half's
		// outputs count back up the right-hand side from pin 12.
		layout: [
			'1G', '1A', '1B', '1Y0', '1Y1', '1Y2', '1Y3', 'GND',
			'2Y3', '2Y2', '2Y1', '2Y0', '2B', '2A', '2G', 'VCC'
		],
		blocks: [1, 2].flatMap((h) => [
			{ kind: 'not' as const, inputs: [`${h}G`], output: `${h}en` },
			{ kind: 'not' as const, inputs: [`${h}A`], output: `${h}an` },
			{ kind: 'not' as const, inputs: [`${h}B`], output: `${h}bn` },
			// Active low out, like the 74138, so each line is a NAND.
			...[0, 1, 2, 3].map((n) => ({
				kind: 'nand' as const,
				inputs: [`${h}en`, n & 1 ? `${h}A` : `${h}an`, n & 2 ? `${h}B` : `${h}bn`],
				output: `${h}Y${n}`
			}))
		])
	},
	{
		id: '74148',
		role: 'decoders',
		description: '8-to-3 line priority encoder',
		// Everything on this part is active low, inputs and outputs both: pull
		// input 5 down and A2 A1 A0 read low-high-low, which is 5 inverted. The
		// highest input held wins, which is what makes it a priority encoder and
		// not a plain one.
		layout: [
			'I4', 'I5', 'I6', 'I7', 'EI', 'A2', 'A1', 'GND',
			'A0', 'I0', 'I1', 'I2', 'I3', 'GS', 'EO', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['EI'], output: 'en' },
			...[0, 1, 2, 3, 4, 5, 6, 7].map((n) => ({
				kind: 'not' as const,
				inputs: [`I${n}`],
				output: `on${n}`
			})),
			{ kind: 'or', inputs: ['on4', 'on5', 'on6', 'on7'], output: 'upper' },
			{ kind: 'or', inputs: ['on0', 'on1', 'on2', 'on3'], output: 'lower' },
			{ kind: 'or', inputs: ['upper', 'lower'], output: 'any' },
			{ kind: 'not', inputs: ['any'], output: 'none' },
			// A2 is set by anything in the upper half.
			{ kind: 'nand', inputs: ['en', 'upper'], output: 'A2' },
			// A1 by 7 or 6, or by 3 or 2 when neither 5 nor 4 is held above them. An
			// input that is not held reads high, so "not held" is the pin itself.
			{ kind: 'and', inputs: ['I5', 'I4', 'on3'], output: 'a1_3' },
			{ kind: 'and', inputs: ['I5', 'I4', 'on2'], output: 'a1_2' },
			{ kind: 'or', inputs: ['on7', 'on6', 'a1_3', 'a1_2'], output: 'a1' },
			{ kind: 'nand', inputs: ['en', 'a1'], output: 'A1' },
			// A0 by the odd inputs, each only while no even one above it is held.
			{ kind: 'and', inputs: ['I6', 'on5'], output: 'a0_5' },
			{ kind: 'and', inputs: ['I6', 'I4', 'on3'], output: 'a0_3' },
			{ kind: 'and', inputs: ['I6', 'I4', 'I2', 'on1'], output: 'a0_1' },
			{ kind: 'or', inputs: ['on7', 'a0_5', 'a0_3', 'a0_1'], output: 'a0' },
			{ kind: 'nand', inputs: ['en', 'a0'], output: 'A0' },
			// Group select says something is held; enable out says nothing is, and
			// is what switches on the next encoder down in a chain of them.
			{ kind: 'nand', inputs: ['en', 'any'], output: 'GS' },
			{ kind: 'nand', inputs: ['en', 'none'], output: 'EO' }
		]
	},
	{
		id: '4028',
		role: 'decoders',
		description: 'BCD to decimal decoder (CMOS)',
		// Active high, one line per digit, and codes past nine light nothing: each
		// output is decoded from all four bits, not from the fewest that would do.
		layout: [
			'Q4', 'Q2', 'Q0', 'Q7', 'Q9', 'Q5', 'Q6', 'VSS',
			'Q8', 'A', 'D', 'C', 'B', 'Q1', 'Q3', 'VDD'
		],
		blocks: [
			{ kind: 'not', inputs: ['A'], output: 'an' },
			{ kind: 'not', inputs: ['B'], output: 'bn' },
			{ kind: 'not', inputs: ['C'], output: 'cn' },
			{ kind: 'not', inputs: ['D'], output: 'dn' },
			...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
				kind: 'and' as const,
				inputs: [
					n & 1 ? 'A' : 'an',
					n & 2 ? 'B' : 'bn',
					n & 4 ? 'C' : 'cn',
					n & 8 ? 'D' : 'dn'
				],
				output: `Q${n}`
			}))
		]
	},
	{
		id: '74153',
		role: 'decoders',
		description: 'Dual 4-to-1 multiplexer',
		// Two four-way switches sharing one pair of select pins, each with its own
		// strobe. Pins 2 and 14 are the selects, which puts B before A on the
		// package.
		layout: [
			'1G', 'B', '1C3', '1C2', '1C1', '1C0', '1Y', 'GND',
			'2Y', '2C0', '2C1', '2C2', '2C3', 'A', '2G', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['A'], output: 'an' },
			{ kind: 'not', inputs: ['B'], output: 'bn' },
			...[1, 2].flatMap((h) => [
				{ kind: 'not' as const, inputs: [`${h}G`], output: `${h}en` },
				...[0, 1, 2, 3].map((n) => ({
					kind: 'and' as const,
					inputs: [`${h}en`, `${h}C${n}`, n & 1 ? 'A' : 'an', n & 2 ? 'B' : 'bn'],
					output: `${h}m${n}`
				})),
				{
					kind: 'or' as const,
					inputs: [`${h}m0`, `${h}m1`, `${h}m2`, `${h}m3`],
					output: `${h}Y`
				}
			])
		]
	},

	// Counters.
	{
		id: '74163',
		role: 'counters',
		description: '4-bit synchronous binary counter, synchronous clear',
		// The 74161 with one difference: clear waits for the clock. That is what
		// makes it the part for a counter that stops short of sixteen — decode the
		// last count onto CLR and the next edge takes it to zero, with no glitch of
		// a count that was never meant to show.
		layout: [
			'CLR', 'CLK', 'A', 'B', 'C', 'D', 'ENP', 'GND',
			'LOAD', 'ENT', 'QD', 'QC', 'QB', 'QA', 'RCO', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['LOAD'], output: 'load' },
			{ kind: 'and', inputs: ['ENP', 'ENT', 'LOAD'], output: 'count' },
			{ kind: 'and', inputs: ['count', 'QA'], output: 'tb' },
			{ kind: 'and', inputs: ['count', 'QA', 'QB'], output: 'tc' },
			{ kind: 'and', inputs: ['count', 'QA', 'QB', 'QC'], output: 'td' },
			...counterBit('A', 'load', 'LOAD', 'count', { sync: 'CLR' }),
			...counterBit('B', 'load', 'LOAD', 'tb', { sync: 'CLR' }),
			...counterBit('C', 'load', 'LOAD', 'tc', { sync: 'CLR' }),
			...counterBit('D', 'load', 'LOAD', 'td', { sync: 'CLR' }),
			{ kind: 'and', inputs: ['QA', 'QB', 'QC', 'QD'], output: 'fifteen' },
			{ kind: 'and', inputs: ['fifteen', 'ENT'], output: 'RCO' }
		]
	},
	{
		id: '74193',
		role: 'counters',
		description: '4-bit synchronous up/down binary counter, dual clock',
		// Two clock pins, one for each direction, and the one not in use is held
		// high. Counting happens on the rising edge of whichever one pulsed.
		layout: [
			'B', 'QB', 'QA', 'DOWN', 'UP', 'QC', 'QD', 'GND',
			'D', 'C', 'LOAD', 'CO', 'BO', 'CLR', 'A', 'VCC'
		],
		blocks: [
			// Which way to count is remembered from which pin went low: a latch of two
			// NANDs. By the time the pin comes back up and makes the edge, it is too
			// late to tell which one it was from the pins themselves.
			{ kind: 'nand', inputs: ['UP', 'counting_down'], output: 'counting_up' },
			{ kind: 'nand', inputs: ['DOWN', 'counting_up'], output: 'counting_down' },
			{ kind: 'and', inputs: ['UP', 'DOWN'], output: 'edge' },
			// Load is active low and clear active high, and both act at once.
			{ kind: 'not', inputs: ['LOAD'], output: 'load' },
			{ kind: 'not', inputs: ['CLR'], output: 'CLRn' },
			// Each bit flips when every bit below it is at the end it is counting
			// towards: all high going up, all low going down.
			{ kind: 'and', inputs: ['counting_up', 'QA'], output: 'up_b' },
			{ kind: 'and', inputs: ['counting_down', 'QAn'], output: 'down_b' },
			{ kind: 'or', inputs: ['up_b', 'down_b'], output: 'turn_b' },
			{ kind: 'and', inputs: ['counting_up', 'QA', 'QB'], output: 'up_c' },
			{ kind: 'and', inputs: ['counting_down', 'QAn', 'QBn'], output: 'down_c' },
			{ kind: 'or', inputs: ['up_c', 'down_c'], output: 'turn_c' },
			{ kind: 'and', inputs: ['counting_up', 'QA', 'QB', 'QC'], output: 'up_d' },
			{ kind: 'and', inputs: ['counting_down', 'QAn', 'QBn', 'QCn'], output: 'down_d' },
			{ kind: 'or', inputs: ['up_d', 'down_d'], output: 'turn_d' },
			{ kind: 'xor', inputs: ['QB', 'turn_b'], output: 'next_b' },
			{ kind: 'xor', inputs: ['QC', 'turn_c'], output: 'next_c' },
			{ kind: 'xor', inputs: ['QD', 'turn_d'], output: 'next_d' },
			...(['A', 'B', 'C', 'D'] as const).flatMap((bit) => [
				...asyncLoad(`ld${bit}`, 'load', bit, 'CLR'),
				{
					kind: 'dff' as const,
					clock: 'edge',
					data: bit === 'A' ? 'QAn' : `next_${bit.toLowerCase()}`,
					reset: `ld${bit}_rst`,
					preset: `ld${bit}_pre`,
					q: `Q${bit}`,
					qn: `Q${bit}n`
				}
			]),
			// Carry and borrow pulse low with the clock that runs off either end, and
			// go straight into the matching clock of the next counter in a chain.
			{ kind: 'not', inputs: ['UP'], output: 'up_low' },
			{ kind: 'not', inputs: ['DOWN'], output: 'down_low' },
			{ kind: 'and', inputs: ['QA', 'QB', 'QC', 'QD'], output: 'fifteen' },
			{ kind: 'and', inputs: ['QAn', 'QBn', 'QCn', 'QDn'], output: 'zero' },
			{ kind: 'nand', inputs: ['up_low', 'fifteen'], output: 'CO' },
			{ kind: 'nand', inputs: ['down_low', 'zero'], output: 'BO' }
		]
	},
	{
		id: '4017',
		role: 'counters',
		description: 'Decade counter with ten decoded outputs (CMOS)',
		// The chaser: one of ten outputs high at a time, stepping on each clock. It
		// is a five-stage Johnson counter inside, which is why every output needs
		// only a two-input gate to decode — and why it cannot show a count that it
		// did not pass through.
		layout: [
			'Q5', 'Q1', 'Q0', 'Q2', 'Q6', 'Q7', 'Q3', 'VSS',
			'Q8', 'Q4', 'Q9', 'CO', 'INH', 'CLK', 'RST', 'VDD'
		],
		blocks: [
			// Clock inhibit high freezes it. Gating the clock rather than the data is
			// what the part does, so a falling inhibit with the clock high counts too.
			{ kind: 'not', inputs: ['INH'], output: 'enabled' },
			{ kind: 'and', inputs: ['CLK', 'enabled'], output: 'tick' },
			...shiftChain(['j0', 'j1', 'j2', 'j3', 'j4'], 'j4n', 'tick', () => ({ reset: 'RST' })),
			{ kind: 'and', inputs: ['j0n', 'j4n'], output: 'Q0' },
			{ kind: 'and', inputs: ['j0', 'j1n'], output: 'Q1' },
			{ kind: 'and', inputs: ['j1', 'j2n'], output: 'Q2' },
			{ kind: 'and', inputs: ['j2', 'j3n'], output: 'Q3' },
			{ kind: 'and', inputs: ['j3', 'j4n'], output: 'Q4' },
			{ kind: 'and', inputs: ['j0', 'j4'], output: 'Q5' },
			{ kind: 'and', inputs: ['j0n', 'j1'], output: 'Q6' },
			{ kind: 'and', inputs: ['j1n', 'j2'], output: 'Q7' },
			{ kind: 'and', inputs: ['j2n', 'j3'], output: 'Q8' },
			{ kind: 'and', inputs: ['j3n', 'j4'], output: 'Q9' },
			// Carry out is high for counts 0 to 4 and low for 5 to 9: a square wave at
			// a tenth of the clock, which is what clocks the next 4017 along.
			{ kind: 'buffer', inputs: ['j4n'], output: 'CO' }
		],
		caveat:
			'The real part steers itself back into the ten-state sequence from any state it wakes up in; this one starts at zero and never leaves the sequence, so there is nothing to steer.'
	},
	{
		id: '4040',
		role: 'counters',
		description: '12-stage ripple binary counter (CMOS)',
		// Twelve flip-flops each clocked by the one before: Q12 is the input
		// divided by 4096. Ripple means the bits settle one after another, so a
		// decode of these outputs glitches — that is the price of one pin per bit.
		layout: [
			'Q12', 'Q6', 'Q5', 'Q7', 'Q4', 'Q3', 'Q2', 'VSS',
			'Q1', 'CLK', 'RST', 'Q9', 'Q8', 'Q10', 'Q11', 'VDD'
		],
		blocks: [
			// It advances on the falling edge of its clock, and each stage on the
			// falling edge of the one before — which is the rising edge of that
			// stage's complement.
			{ kind: 'not', inputs: ['CLK'], output: 'clk_fall' },
			...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => ({
				kind: 'dff' as const,
				clock: n === 1 ? 'clk_fall' : `Q${n - 1}n`,
				data: `Q${n}n`,
				reset: 'RST',
				q: `Q${n}`,
				qn: `Q${n}n`
			}))
		]
	},

	// Shift registers.
	{
		id: '74164',
		role: 'shift-registers',
		description: '8-bit serial-in, parallel-out shift register',
		// Two serial inputs ANDed together, so one can gate the other; tie them
		// together to use it as one. Clear is asynchronous and active low.
		layout: [
			'A', 'B', 'QA', 'QB', 'QC', 'QD', 'GND', 'CLK',
			'CLR', 'QE', 'QF', 'QG', 'QH', 'VCC'
		],
		blocks: [
			{ kind: 'and', inputs: ['A', 'B'], output: 'serial' },
			{ kind: 'not', inputs: ['CLR'], output: 'clear' },
			...shiftChain(['QA', 'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH'], 'serial', 'CLK', () => ({
				reset: 'clear'
			}))
		]
	},
	{
		id: '74165',
		role: 'shift-registers',
		description: '8-bit parallel-in, serial-out shift register',
		// The 74164 backwards: load eight bits at once, clock them out of QH one at
		// a time. The usual way to read eight buttons over three wires.
		layout: [
			'SHLD', 'CLK', 'E', 'F', 'G', 'H', 'QHN', 'GND',
			'QH', 'SER', 'A', 'B', 'C', 'D', 'INH', 'VCC'
		],
		blocks: [
			// Shift/load low loads, and does not wait for the clock to do it.
			{ kind: 'not', inputs: ['SHLD'], output: 'load' },
			// Clock inhibit high holds the clock high, so nothing rises.
			{ kind: 'or', inputs: ['CLK', 'INH'], output: 'shift' },
			...(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const).flatMap((bit) =>
				asyncLoad(`ld${bit}`, 'load', bit)
			),
			...shiftChain(['qa', 'qb', 'qc', 'qd', 'qe', 'qf', 'qg'], 'SER', 'shift', (stage) => ({
				reset: `ld${stage[1].toUpperCase()}_rst`,
				preset: `ld${stage[1].toUpperCase()}_pre`
			})),
			// The last stage is the one on the legs, both ways up.
			{
				kind: 'dff',
				clock: 'shift',
				data: 'qg',
				reset: 'ldH_rst',
				preset: 'ldH_pre',
				q: 'QH',
				qn: 'QHN'
			}
		]
	},
	{
		id: '74194',
		role: 'shift-registers',
		description: '4-bit bidirectional universal shift register',
		// Two mode pins choose between hold, shift towards QD, shift towards QA and
		// load, all on the clock. Right is towards QD, which is the datasheet's word
		// for it and not necessarily the drawing's.
		layout: [
			'CLR', 'SR', 'A', 'B', 'C', 'D', 'SL', 'GND',
			'S0', 'S1', 'CLK', 'QD', 'QC', 'QB', 'QA', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['CLR'], output: 'clear' },
			{ kind: 'not', inputs: ['S0'], output: 's0n' },
			{ kind: 'not', inputs: ['S1'], output: 's1n' },
			{ kind: 'and', inputs: ['s1n', 's0n'], output: 'hold' },
			{ kind: 'and', inputs: ['s1n', 'S0'], output: 'right' },
			{ kind: 'and', inputs: ['S1', 's0n'], output: 'left' },
			{ kind: 'and', inputs: ['S1', 'S0'], output: 'load' },
			...(
				[
					// bit, what comes in shifting right, what comes in shifting left
					['A', 'SR', 'QB'],
					['B', 'QA', 'QC'],
					['C', 'QB', 'QD'],
					['D', 'QC', 'SL']
				] as const
			).flatMap(([bit, fromRight, fromLeft]) => [
				{ kind: 'and' as const, inputs: ['hold', `Q${bit}`], output: `${bit}_hold` },
				{ kind: 'and' as const, inputs: ['right', fromRight], output: `${bit}_right` },
				{ kind: 'and' as const, inputs: ['left', fromLeft], output: `${bit}_left` },
				{ kind: 'and' as const, inputs: ['load', bit], output: `${bit}_load` },
				{
					kind: 'or' as const,
					inputs: [`${bit}_hold`, `${bit}_right`, `${bit}_left`, `${bit}_load`],
					output: `${bit}_d`
				},
				{
					kind: 'dff' as const,
					clock: 'CLK',
					data: `${bit}_d`,
					reset: 'clear',
					q: `Q${bit}`,
					qn: `Q${bit}n`
				}
			])
		]
	},
	{
		id: '74595',
		role: 'shift-registers',
		description: '8-bit shift register with output latches, 3-state',
		// Shift eight bits in on SRCLK, then copy them to the outputs all at once
		// on RCLK: the outputs never show the bits passing through. QHS is the last
		// shift stage (QH′ on the datasheet), for chaining the next one.
		layout: [
			'QB', 'QC', 'QD', 'QE', 'QF', 'QG', 'QH', 'GND',
			'QHS', 'SRCLR', 'SRCLK', 'RCLK', 'OE', 'SER', 'QA', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['SRCLR'], output: 'clear' },
			{ kind: 'not', inputs: ['OE'], output: 'drive' },
			...shiftChain(['sa', 'sb', 'sc', 'sd', 'se', 'sf', 'sg', 'sh'], 'SER', 'SRCLK', () => ({
				reset: 'clear'
			})),
			{ kind: 'buffer', inputs: ['sh'], output: 'QHS' },
			...(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const).flatMap((bit) => {
				const stage = bit.toLowerCase();
				return [
					{
						kind: 'dff' as const,
						clock: 'RCLK',
						data: `s${stage}`,
						q: `r${stage}`,
						qn: `r${stage}n`
					},
					{
						kind: 'tristate' as const,
						inputs: [`r${stage}`],
						enable: 'drive',
						output: `Q${bit}`
					}
				];
			})
		]
	},

	// JK flip-flops that act on the falling edge.
	{
		id: '7473',
		role: 'flip-flops',
		description: 'Dual JK flip-flop with clear',
		// No preset, and the supply on pins 4 and 11 rather than the corners.
		layout: [
			'1CLK', '1CLR', '1K', 'VCC', '2CLK', '2CLR', '2J',
			'2QN', '2Q', '2K', 'GND', '1Q', '1QN', '1J'
		],
		blocks: [1, 2].flatMap((n) => fallingJk(n, { clear: `${n}CLR` })),
		caveat:
			'Modelled as the LS part, which acts on the falling edge. The original is master-slave and takes J and K while the clock is high.'
	},
	{
		id: '74107',
		role: 'flip-flops',
		description: 'Dual JK flip-flop with clear',
		// The 7473's flip-flops with the supply moved back to the corners.
		layout: [
			'1J', '1QN', '1Q', '1K', '2Q', '2QN', 'GND',
			'2J', '2CLK', '2CLR', '2K', '1CLK', '1CLR', 'VCC'
		],
		blocks: [1, 2].flatMap((n) => fallingJk(n, { clear: `${n}CLR` })),
		caveat:
			'Modelled as the LS part, which acts on the falling edge. The original is master-slave and takes J and K while the clock is high.'
	},
	{
		id: '74112',
		role: 'flip-flops',
		description: 'Dual JK flip-flop with preset and clear',
		layout: [
			'1CLK', '1K', '1J', '1PRE', '1Q', '1QN', '2QN', 'GND',
			'2Q', '2PRE', '2J', '2K', '2CLK', '2CLR', '1CLR', 'VCC'
		],
		blocks: [1, 2].flatMap((n) => fallingJk(n, { preset: `${n}PRE`, clear: `${n}CLR` }))
	},

	// Three-state buffers, latches and bus drivers: parts that can let go of an
	// output, so that several of them can share one wire.
	{
		id: '74125',
		role: 'bus',
		description: 'Quad buffer, 3-state, enable low',
		layout: ['1OE', '1A', '1Y', '2OE', '2A', '2Y', 'GND', '3Y', '3A', '3OE', '4Y', '4A', '4OE', 'VCC'],
		blocks: [1, 2, 3, 4].flatMap((n) => [
			{ kind: 'not' as const, inputs: [`${n}OE`], output: `${n}on` },
			{ kind: 'tristate' as const, inputs: [`${n}A`], enable: `${n}on`, output: `${n}Y` }
		])
	},
	{
		id: '74126',
		role: 'bus',
		description: 'Quad buffer, 3-state, enable high',
		// The 74125's legs with the enable the other way up.
		layout: ['1OE', '1A', '1Y', '2OE', '2A', '2Y', 'GND', '3Y', '3A', '3OE', '4Y', '4A', '4OE', 'VCC'],
		blocks: [1, 2, 3, 4].map((n) => ({
			kind: 'tristate' as const,
			inputs: [`${n}A`],
			enable: `${n}OE`,
			output: `${n}Y`
		}))
	},
	{
		id: '74244',
		role: 'bus',
		description: 'Octal buffer/line driver, 3-state',
		// Two banks of four, interleaved so that every input sits opposite its
		// output across the package — which makes the numbering look scrambled and
		// the board layout easy.
		layout: [
			'1OE', '1A1', '2Y4', '1A2', '2Y3', '1A3', '2Y2', '1A4', '2Y1', 'GND',
			'2A1', '1Y4', '2A2', '1Y3', '2A3', '1Y2', '2A4', '1Y1', '2OE', 'VCC'
		],
		blocks: [1, 2].flatMap((bank) => [
			{ kind: 'not' as const, inputs: [`${bank}OE`], output: `${bank}on` },
			...[1, 2, 3, 4].map((n) => ({
				kind: 'tristate' as const,
				inputs: [`${bank}A${n}`],
				enable: `${bank}on`,
				output: `${bank}Y${n}`
			}))
		])
	},
	{
		id: '74245',
		role: 'bus',
		description: 'Octal bus transceiver, 3-state',
		// Both sides are inputs and outputs: DIR picks which way the eight lines
		// carry, and OE high lets go of both sides at once.
		layout: [
			'DIR', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'GND',
			'B8', 'B7', 'B6', 'B5', 'B4', 'B3', 'B2', 'B1', 'OE', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['OE'], output: 'on' },
			{ kind: 'not', inputs: ['DIR'], output: 'dirn' },
			{ kind: 'and', inputs: ['on', 'DIR'], output: 'a_to_b' },
			{ kind: 'and', inputs: ['on', 'dirn'], output: 'b_to_a' },
			...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
				{ kind: 'tristate' as const, inputs: [`A${n}`], enable: 'a_to_b', output: `B${n}` },
				{ kind: 'tristate' as const, inputs: [`B${n}`], enable: 'b_to_a', output: `A${n}` }
			])
		]
	},
	{
		id: '74373',
		role: 'bus',
		description: 'Octal transparent D latch, 3-state',
		// Latch enable high lets the inputs straight through; low holds what was
		// there. The latches keep working while the outputs are off the bus.
		layout: [
			'OE', '1Q', '1D', '2D', '2Q', '3Q', '3D', '4D', '4Q', 'GND',
			'LE', '5Q', '5D', '6D', '6Q', '7Q', '7D', '8D', '8Q', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['OE'], output: 'drive' },
			...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
				...latch(`l${n}`, `${n}D`, 'LE', `l${n}q`),
				{ kind: 'tristate' as const, inputs: [`l${n}q`], enable: 'drive', output: `${n}Q` }
			])
		]
	},
	{
		id: '74374',
		role: 'bus',
		description: 'Octal D flip-flop, 3-state',
		// The 74373's legs with an edge in place of the latch: pin 11 is a clock,
		// and the outputs change only on its rising edge.
		layout: [
			'OE', '1Q', '1D', '2D', '2Q', '3Q', '3D', '4D', '4Q', 'GND',
			'CLK', '5Q', '5D', '6D', '6Q', '7Q', '7D', '8D', '8Q', 'VCC'
		],
		blocks: [
			{ kind: 'not', inputs: ['OE'], output: 'drive' },
			...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => [
				{
					kind: 'dff' as const,
					clock: 'CLK',
					data: `${n}D`,
					q: `f${n}q`,
					qn: `f${n}qn`
				},
				{ kind: 'tristate' as const, inputs: [`f${n}q`], enable: 'drive', output: `${n}Q` }
			])
		]
	}
];

export const CHIPS: readonly ChipDef[] = [...LOGIC_CHIPS, ...MEMORY_CHIPS, ...ANALOG_CHIPS];

const BY_ID = new Map(CHIPS.map((chip) => [chip.id, chip]));

export function chipById(id: string): ChipDef | undefined {
	return BY_ID.get(id);
}

/**
 * What is printed on the lid: `CD4027`, `SN7400`.
 *
 * The table keys the parts by the bare number because that is how they are
 * spoken of, but on a drawing `4027` reads as a value, not a part. The prefix is
 * the family's — RCA's CD for the 4000 series, TI's SN for the 74 — and the
 * family is what the first digit already says.
 */
export function chipName(chip: ChipDef): string {
	// Read off the whole number rather than its first digit: a 4N25 starts with
	// a 4 and is an optocoupler, and a part from neither family keeps the name
	// it came with rather than borrowing one.
	if (/^4[05]\d{2,3}$/.test(chip.id)) return 'CD' + chip.id;
	if (/^74\d{2,4}$/.test(chip.id)) return 'SN' + chip.id;
	return chip.id;
}

/**
 * A supply pin, whichever family's name it goes by.
 *
 * The 4000 series calls them VDD and VSS and it is not a synonym worth
 * flattening: somebody reading the drawing against a datasheet should see the
 * name their datasheet uses.
 */
export function isPower(pin: string): boolean {
	return pin === 'VCC' || pin === 'GND' || pin === 'VDD' || pin === 'VSS' || pin === 'VEE';
}

/** The leg a chip takes its positive supply on, if it has one. */
export function positiveSupply(chip: ChipDef): string | undefined {
	return chip.layout.find((pin) => pin === 'VCC' || pin === 'VDD');
}

/** The leg a chip takes its negative supply or ground on. */
export function negativeSupply(chip: ChipDef): string | undefined {
	return chip.layout.find((pin) => pin === 'GND' || pin === 'VSS' || pin === 'VEE');
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
