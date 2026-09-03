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

/**
 * The 4000 family's own quad pinout, which is not the 74xx one.
 *
 * Both gates of a pair sit next to their output here, and the supply pins are
 * the other way round: VSS at 7 and VDD at 14 are the same corners as GND and
 * VCC, but everything in between moved.
 */
const CMOS_QUAD: readonly string[] = [
	'1Y',
	'1A',
	'1B',
	'2Y',
	'2A',
	'2B',
	'VSS',
	'3A',
	'3B',
	'3Y',
	'4A',
	'4B',
	'4Y',
	'VDD'
];

function cmosTriple3(kind: ChipBlock['kind']) {
	return {
		layout: ['1Y', '2Y', '2A', '2B', '2C', '3A', 'VSS', '3B', '3C', '3Y', '1A', '1B', '1C', 'VDD'],
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
function jk(n: number, async: { preset: string; reset: string }): ChipBlock[] {
	return [
		{ kind: 'not', inputs: [`${n}K`], output: `${n}kn` },
		{ kind: 'and', inputs: [`${n}J`, `${n}QN`], output: `${n}set_t` },
		{ kind: 'and', inputs: [`${n}kn`, `${n}Q`], output: `${n}hold_t` },
		{ kind: 'or', inputs: [`${n}set_t`, `${n}hold_t`], output: `${n}d` },
		{
			kind: 'dff',
			clock: `${n}CLK`,
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
function counterBit(bit: string, load: string, loadn: string, toggle: string): ChipBlock[] {
	const q = `Q${bit}`;
	return [
		{ kind: 'not', inputs: [q], output: `${bit}qn` },
		{ kind: 'not', inputs: [toggle], output: `${bit}hold` },
		// Loading beats counting, which is what makes it a load rather than a hint.
		{ kind: 'and', inputs: [load, bit], output: `${bit}from_pin` },
		{ kind: 'and', inputs: [loadn, toggle, `${bit}qn`], output: `${bit}flip` },
		{ kind: 'and', inputs: [loadn, `${bit}hold`, q], output: `${bit}stay` },
		{ kind: 'or', inputs: [`${bit}from_pin`, `${bit}flip`, `${bit}stay`], output: `${bit}d` },
		{
			kind: 'dff',
			clock: 'CLK',
			data: `${bit}d`,
			reset: 'clear',
			q,
			qn: `${bit}qn_out`
		}
	];
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
	},

	// The 4000 family. Same gates, different legs — and the legs are the reason
	// both families are here rather than one standing in for the other. A 4011 is
	// four NANDs like a 7400 and its pinout is nothing like it: swap the chip
	// without redrawing and every wire lands on the wrong pin.
	{ id: '4001', description: 'Quad 2-input NOR (CMOS)', ...quad2('nor', CMOS_QUAD) },
	{
		id: '4002',
		description: 'Dual 4-input NOR (CMOS)',
		layout: ['NC1', '1A', '1B', '1C', '1D', '1Y', 'VSS', '2Y', '2A', '2B', '2C', '2D', 'NC2', 'VDD'],
		blocks: [1, 2].map((n) => ({
			kind: 'nor' as const,
			inputs: [`${n}A`, `${n}B`, `${n}C`, `${n}D`],
			output: `${n}Y`
		}))
	},
	{ id: '4011', description: 'Quad 2-input NAND (CMOS)', ...quad2('nand', CMOS_QUAD) },
	{
		id: '4012',
		description: 'Dual 4-input NAND (CMOS)',
		layout: ['NC1', '1A', '1B', '1C', '1D', '1Y', 'VSS', '2Y', '2A', '2B', '2C', '2D', 'NC2', 'VDD'],
		blocks: [1, 2].map((n) => ({
			kind: 'nand' as const,
			inputs: [`${n}A`, `${n}B`, `${n}C`, `${n}D`],
			output: `${n}Y`
		}))
	},
	{ id: '4023', description: 'Triple 3-input NAND (CMOS)', ...cmosTriple3('nand') },
	{ id: '4025', description: 'Triple 3-input NOR (CMOS)', ...cmosTriple3('nor') },
	{
		id: '4069',
		description: 'Hex inverter (CMOS)',
		layout: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'VSS', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VDD'],
		blocks: [1, 2, 3, 4, 5, 6].map((n) => ({
			kind: 'not' as const,
			inputs: [`${n}A`],
			output: `${n}Y`
		}))
	},
	{ id: '4070', description: 'Quad 2-input XOR (CMOS)', ...quad2('xor', CMOS_QUAD) },
	{ id: '4071', description: 'Quad 2-input OR (CMOS)', ...quad2('or', CMOS_QUAD) },
	{ id: '4077', description: 'Quad 2-input XNOR (CMOS)', ...quad2('xnor', CMOS_QUAD) },
	{ id: '4081', description: 'Quad 2-input AND (CMOS)', ...quad2('and', CMOS_QUAD) },

	// Flip-flops. The D parts map straight onto the engine's; the JK ones are
	// built out of one, which is what `jk` below is for.
	{
		id: '7474',
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
			...counterBit('A', 'load', 'LOAD', 'count'),
			...counterBit('B', 'load', 'LOAD', 'tb'),
			...counterBit('C', 'load', 'LOAD', 'tc'),
			...counterBit('D', 'load', 'LOAD', 'td'),
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
		description: 'Dual JK flip-flop with set and reset (CMOS)',
		layout: [
			'1Q', '1QN', '1CLK', '1RST', '1K', '1J', '1SET', 'VSS',
			'2SET', '2J', '2K', '2RST', '2CLK', '2QN', '2Q', 'VDD'
		],
		blocks: [1, 2].flatMap((n) => jk(n, { preset: `${n}SET`, reset: `${n}RST` }))
	}
];

const BY_ID = new Map(CHIPS.map((chip) => [chip.id, chip]));

export function chipById(id: string): ChipDef | undefined {
	return BY_ID.get(id);
}

/**
 * A supply pin, whichever family's name it goes by.
 *
 * The 4000 series calls them VDD and VSS and it is not a synonym worth
 * flattening: somebody reading the drawing against a datasheet should see the
 * name their datasheet uses.
 */
export function isPower(pin: string): boolean {
	return pin === 'VCC' || pin === 'GND' || pin === 'VDD' || pin === 'VSS';
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
