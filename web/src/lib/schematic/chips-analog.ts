/**
 * The chips that are not all logic: a timer, op-amp packages, comparators, an
 * analog switch, drivers, and the Schmitt-trigger gates.
 *
 * Nothing here is a new kind of device either. A 555 is three resistors, two
 * comparators, a latch and three switches, written the way a 7400 is written
 * as four gates; see `AnalogBlock` in `chips.ts` for the pieces and for how
 * they cross between the two halves of the simulator.
 *
 * The supply is a node like any other. An amplifier's output stops short of
 * whatever its supply legs are at, moment by moment, and a Schmitt input's
 * thresholds are shares of the supply across its legs — so a 5 V part run
 * from a sagging battery sags with it.
 */

import type { AnalogBlock, ChipBlock, ChipDef, OpAmpSpec } from './chips';

/**
 * A comparator inside a package that feeds logic: fast, and swinging between
 * fixed levels that the logic reads cleanly, whatever the chip is powered from.
 */
const INTERNAL_COMPARATOR: OpAmpSpec = {
	gain: 1e5,
	gbw: 1e7,
	slew: 5e7,
	rOut: 100,
	vOs: 0,
	iBias: 0,
	swing: { fixed: [0, 5] }
};

/** The LM358 and LM324: single supply, output down to the negative rail. */
const LM358: OpAmpSpec = {
	gain: 1e5,
	gbw: 1e6,
	slew: 0.3e6,
	rOut: 75,
	vOs: 2e-3,
	iBias: 45e-9,
	// Down to within millivolts of ground, and a volt and a half short of the
	// top: the reason it is the single-supply part, and the reason a 5 V one
	// cannot give a 5 V output.
	swing: [0.005, 1.5]
};

/** The TL072 and TL074: JFET inputs, so almost no bias current, and fast. */
const TL072: OpAmpSpec = {
	gain: 2e5,
	gbw: 3e6,
	slew: 13e6,
	rOut: 75,
	vOs: 3e-3,
	iBias: 65e-12,
	swing: [1.5, 1.5]
};

const LM741: OpAmpSpec = {
	gain: 2e5,
	gbw: 1e6,
	slew: 0.5e6,
	rOut: 75,
	vOs: 1e-3,
	iBias: 80e-9,
	swing: [1, 1]
};

/** One amplifier of a package, on pins numbered for it: `1IN+`, `1IN-`, `1OUT`. */
const amplifier = (n: number, spec: OpAmpSpec): AnalogBlock => ({
	kind: 'opamp',
	plus: `${n}IN+`,
	minus: `${n}IN-`,
	out: `${n}OUT`,
	spec
});

/** The eight legs every dual op-amp and dual comparator shares. */
const DUAL: readonly string[] = ['1OUT', '1IN-', '1IN+', 'GND', '2IN+', '2IN-', '2OUT', 'VCC'];

/** And the fourteen of every quad: the supply in the middle of each side. */
const QUAD: readonly string[] = [
	'1OUT', '1IN-', '1IN+', 'VCC', '2IN+', '2IN-', '2OUT',
	'3OUT', '3IN-', '3IN+', 'GND', '4IN+', '4IN-', '4OUT'
];

const withNegative = (layout: readonly string[]) =>
	layout.map((pin) => (pin === 'GND' ? 'VEE' : pin));

/**
 * One open-collector comparator: an amplifier whose output turns on a
 * transistor to the ground leg, so the output can only pull down.
 *
 * Its inputs are wired the other way round from an op-amp's on purpose: the
 * transistor conducts, pulling the output low, when the inverting input is the
 * higher one — which leaves the output high, through whatever pull-up the
 * drawing gives it, when IN+ is above IN-.
 */
function openCollector(n: number): AnalogBlock[] {
	return [
		{ kind: 'opamp', plus: `${n}IN-`, minus: `${n}IN+`, out: `${n}cmp`, spec: INTERNAL_COMPARATOR },
		{ kind: 'resistor', a: `${n}cmp`, b: `${n}base`, ohms: 10e3 },
		{ kind: 'npn', collector: `${n}OUT`, base: `${n}base`, emitter: 'GND' }
	];
}

/**
 * A Schmitt input: the leg read against two thresholds, as fractions of the
 * supply, onto a logic net of its own.
 */
const schmitt = (pin: string, net: string, rising: number, falling: number): AnalogBlock => ({
	kind: 'sense',
	node: pin,
	net,
	rising: { supply: rising },
	falling: { supply: falling }
});

/** Ground, as opposed to whatever the chip's own ground leg is on. */
const EARTH = '0';

export const ANALOG_CHIPS: readonly ChipDef[] = [
	{
		id: 'NE555',
		role: 'timers',
		description: 'Timer: astable, monostable, and everything in between',
		aliases: ['555', 'lm555', 'timer'],
		layout: ['GND', 'TRIG', 'OUT', 'RESET', 'CONT', 'THR', 'DIS', 'VCC'],
		blocks: [
			// The latch. Trigger wins over threshold when both are asserted, which
			// is what the part does: pull TRIG low and the output goes high whatever
			// THR says.
			{ kind: 'not', inputs: ['under'], output: 'not_under' },
			{ kind: 'and', inputs: ['over', 'not_under'], output: 'clear' },
			{ kind: 'nor', inputs: ['clear', 'qn'], output: 'q' },
			{ kind: 'nor', inputs: ['under', 'q'], output: 'qn' },
			// Reset, active low, beats both.
			{ kind: 'and', inputs: ['q', 'running'], output: 'high' },
			{ kind: 'not', inputs: ['high'], output: 'low' }
		],
		analog: [
			// Three equal resistors from the supply to ground, which put CONT at two
			// thirds of it and the trigger reference at one third. That ratio is why
			// the timing does not depend on the supply voltage.
			{ kind: 'resistor', a: 'VCC', b: 'CONT', ohms: 5e3 },
			{ kind: 'resistor', a: 'CONT', b: 'third', ohms: 5e3 },
			{ kind: 'resistor', a: 'third', b: 'GND', ohms: 5e3 },
			{ kind: 'opamp', plus: 'THR', minus: 'CONT', out: 'thr_cmp', spec: INTERNAL_COMPARATOR },
			{ kind: 'opamp', plus: 'third', minus: 'TRIG', out: 'trig_cmp', spec: INTERNAL_COMPARATOR },
			{ kind: 'sense', node: 'thr_cmp', net: 'over' },
			{ kind: 'sense', node: 'trig_cmp', net: 'under' },
			// Reset reads low below about 0.7 V, as on the part.
			{ kind: 'sense', node: 'RESET', net: 'running', rising: 1, falling: 0.4 },
			// The output stage: one switch to the supply, one to ground, and the
			// discharge transistor as a third that closes with the lower one.
			{ kind: 'drive', net: 'high', node: 'up' },
			{ kind: 'drive', net: 'low', node: 'down' },
			{ kind: 'switch', a: 'VCC', b: 'OUT', control: 'up', reference: EARTH, on: 2.4, off: 1, ron: 10 },
			{ kind: 'switch', a: 'OUT', b: 'GND', control: 'down', reference: EARTH, on: 2.4, off: 1, ron: 10 },
			{ kind: 'switch', a: 'DIS', b: 'GND', control: 'down', reference: EARTH, on: 2.4, off: 1, ron: 10 }
		],
		caveat:
			'The output swings all the way to the supply through 10 Ω; a bipolar 555 stops about 1.7 V short of it.'
	},

	// Op-amps. The pin names are the datasheets', and so is the shape: one
	// package, several amplifiers, one supply for all of them.
	{
		id: 'LM358',
		role: 'amplifiers',
		description: 'Dual op-amp, single supply',
		aliases: ['358', 'lm2904', 'op amp', 'opamp'],
		layout: DUAL,
		blocks: [],
		analog: [amplifier(1, LM358), amplifier(2, LM358)],
	},
	{
		id: 'LM324',
		role: 'amplifiers',
		description: 'Quad op-amp, single supply',
		aliases: ['324', 'op amp', 'opamp'],
		layout: QUAD,
		blocks: [],
		analog: [1, 2, 3, 4].map((n) => amplifier(n, LM358)),
	},
	{
		id: 'TL072',
		role: 'amplifiers',
		description: 'Dual JFET-input op-amp, low noise',
		aliases: ['072', 'tl082', 'op amp', 'opamp', 'jfet'],
		layout: withNegative(DUAL),
		blocks: [],
		analog: [amplifier(1, TL072), amplifier(2, TL072)],
	},
	{
		id: 'TL074',
		role: 'amplifiers',
		description: 'Quad JFET-input op-amp, low noise',
		aliases: ['074', 'tl084', 'op amp', 'opamp', 'jfet'],
		layout: withNegative(QUAD),
		blocks: [],
		analog: [1, 2, 3, 4].map((n) => amplifier(n, TL072)),
	},
	{
		id: 'LM741',
		role: 'amplifiers',
		description: 'Single op-amp, the classic',
		aliases: ['741', 'ua741', 'op amp', 'opamp'],
		// Pins 1 and 5 are offset null on the real part, for trimming the offset
		// with a potentiometer; they are not modelled, so they are drawn as not
		// connected. Pin 8 really is not connected.
		layout: ['NC1', 'IN-', 'IN+', 'VEE', 'NC2', 'OUT', 'VCC', 'NC3'],
		blocks: [],
		analog: [{ kind: 'opamp', plus: 'IN+', minus: 'IN-', out: 'OUT', spec: LM741 }],
		caveat: 'The offset-null pins (1 and 5) are not modelled.'
	},

	// Comparators: open collector, so the output needs a pull-up to go high.
	{
		id: 'LM393',
		role: 'amplifiers',
		description: 'Dual comparator, open collector',
		aliases: ['393', 'lm2903', 'comparator'],
		layout: DUAL,
		blocks: [],
		analog: [...openCollector(1), ...openCollector(2)],
		caveat: 'Each output only pulls down: it needs a pull-up resistor to read high.'
	},
	{
		id: 'LM339',
		role: 'amplifiers',
		description: 'Quad comparator, open collector',
		aliases: ['339', 'lm2901', 'comparator'],
		// Not the op-amp quad's pinout: the supply is on pin 3 and the outputs
		// come first, two and one in that order.
		layout: [
			'2OUT', '1OUT', 'VCC', '1IN-', '1IN+', '2IN-', '2IN+',
			'3IN-', '3IN+', '4IN-', '4IN+', 'GND', '4OUT', '3OUT'
		],
		blocks: [],
		analog: [1, 2, 3, 4].flatMap(openCollector),
		caveat: 'Each output only pulls down: it needs a pull-up resistor to read high.'
	},

	// Schmitt-trigger gates. Each input is read against two thresholds, rising
	// and falling, so a slow edge or a noisy one gives one clean transition —
	// and an RC on the input makes an oscillator out of one gate.
	{
		id: '7414',
		role: 'gates',
		description: 'Hex Schmitt-trigger inverter',
		aliases: ['74hc14', 'schmitt'],
		layout: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'GND', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VCC'],
		blocks: [1, 2, 3, 4, 5, 6].map(
			(n): ChipBlock => ({ kind: 'not', inputs: [`${n}in`], output: `${n}Y` })
		),
		analog: [1, 2, 3, 4, 5, 6].map((n) => schmitt(`${n}A`, `${n}in`, 0.55, 0.36)),
		caveat:
			'The thresholds are those of the 74HC14, as fractions of the supply; the TTL part switches lower, at about 1.6 V and 0.8 V.'
	},
	{
		id: '74132',
		role: 'gates',
		description: 'Quad 2-input Schmitt-trigger NAND',
		aliases: ['74hc132', 'schmitt'],
		layout: ['1A', '1B', '1Y', '2A', '2B', '2Y', 'GND', '3Y', '3A', '3B', '4Y', '4A', '4B', 'VCC'],
		blocks: [1, 2, 3, 4].map(
			(n): ChipBlock => ({ kind: 'nand', inputs: [`${n}a`, `${n}b`], output: `${n}Y` })
		),
		analog: [1, 2, 3, 4].flatMap((n) => [
			schmitt(`${n}A`, `${n}a`, 0.55, 0.36),
			schmitt(`${n}B`, `${n}b`, 0.55, 0.36)
		]),
		caveat: 'The thresholds are those of the 74HC132, as fractions of the supply.'
	},
	{
		id: '40106',
		role: 'gates',
		description: 'Hex Schmitt-trigger inverter (CMOS)',
		aliases: ['cd40106', 'schmitt', '4584'],
		layout: ['1A', '1Y', '2A', '2Y', '3A', '3Y', 'VSS', '4Y', '4A', '5Y', '5A', '6Y', '6A', 'VDD'],
		blocks: [1, 2, 3, 4, 5, 6].map(
			(n): ChipBlock => ({ kind: 'not', inputs: [`${n}in`], output: `${n}Y` })
		),
		analog: [1, 2, 3, 4, 5, 6].map((n) => schmitt(`${n}A`, `${n}in`, 0.58, 0.38))
	},
	{
		id: '4093',
		role: 'gates',
		description: 'Quad 2-input Schmitt-trigger NAND (CMOS)',
		aliases: ['cd4093', 'schmitt'],
		layout: ['1A', '1B', '1Y', '2Y', '2A', '2B', 'VSS', '3A', '3B', '3Y', '4Y', '4A', '4B', 'VDD'],
		blocks: [1, 2, 3, 4].map(
			(n): ChipBlock => ({ kind: 'nand', inputs: [`${n}a`, `${n}b`], output: `${n}Y` })
		),
		analog: [1, 2, 3, 4].flatMap((n) => [
			schmitt(`${n}A`, `${n}a`, 0.58, 0.38),
			schmitt(`${n}B`, `${n}b`, 0.58, 0.38)
		])
	},

	// Switches and drivers.
	{
		id: '4066',
		role: 'analog',
		description: 'Quad bilateral analog switch (CMOS)',
		aliases: ['cd4066', '4016', 'analog switch', 'transmission gate'],
		// Each switch is A to B, either way round, closed while its C is high.
		layout: ['1A', '1B', '2B', '2A', '2C', '3C', 'VSS', '3A', '3B', '4B', '4A', '4C', '1C', 'VDD'],
		blocks: [],
		analog: [1, 2, 3, 4].map(
			(n): AnalogBlock => ({
				kind: 'switch',
				a: `${n}A`,
				b: `${n}B`,
				control: `${n}C`,
				reference: 'VSS',
				on: { supply: 0.7 },
				off: { supply: 0.3 },
				ron: 125,
				roff: 1e10
			})
		),
		caveat:
			'The on-resistance is a fixed 125 Ω; on the real part it rises as the signal nears either supply, and more so at low supply voltages. The control thresholds are read off the supply once, when the run starts.'
	},
	{
		id: 'L293D',
		role: 'analog',
		description: 'Quadruple half-H driver with clamp diodes, for motors and relays',
		aliases: ['l293', 'h-bridge', 'h bridge', 'motor driver', 'sn754410'],
		// Two supplies: VCC for the logic on pin 16 and VCC2 for the load on pin 8.
		// The four ground legs in the middle are the heat sink as well as the
		// ground, and are one node inside.
		layout: [
			'12EN', '1A', '1Y', 'GND', 'GND2', '2Y', '2A', 'VCC2',
			'34EN', '3A', '3Y', 'GND3', 'GND4', '4Y', '4A', 'VCC'
		],
		blocks: [1, 2, 3, 4].flatMap((n): ChipBlock[] => {
			const enable = n <= 2 ? '12EN' : '34EN';
			return [
				// Enabled, each output follows its input to one supply or the other;
				// disabled, it lets go of both.
				{ kind: 'and', inputs: [`${n}A`, enable], output: `${n}high` },
				{ kind: 'not', inputs: [`${n}A`], output: `${n}an` },
				{ kind: 'and', inputs: [`${n}an`, enable], output: `${n}low` }
			];
		}),
		analog: [
			{ kind: 'resistor', a: 'GND2', b: 'GND', ohms: 0.01 },
			{ kind: 'resistor', a: 'GND3', b: 'GND', ohms: 0.01 },
			{ kind: 'resistor', a: 'GND4', b: 'GND', ohms: 0.01 },
			...[1, 2, 3, 4].flatMap((n): AnalogBlock[] => [
				{ kind: 'drive', net: `${n}high`, node: `${n}up` },
				{ kind: 'drive', net: `${n}low`, node: `${n}down` },
				{ kind: 'switch', a: 'VCC2', b: `${n}Y`, control: `${n}up`, reference: EARTH, on: 2.4, off: 1, ron: 1.5 },
				{ kind: 'switch', a: `${n}Y`, b: 'GND', control: `${n}down`, reference: EARTH, on: 2.4, off: 1, ron: 1.5 },
				// The clamps that make it the D: a motor's back-EMF has somewhere to go.
				{ kind: 'diode', anode: `${n}Y`, cathode: 'VCC2' },
				{ kind: 'diode', anode: 'GND', cathode: `${n}Y` }
			])
		],
		caveat:
			'Each output switches through 1.5 Ω; the real part drops about 1.4 V on the high side and 1.2 V on the low at an amp, so a motor gets rather less than VCC2.'
	},
	{
		id: 'ULN2003',
		role: 'analog',
		description: 'Seven Darlington drivers, open collector, with flyback diodes',
		aliases: ['uln2003a', 'darlington', 'relay driver', 'stepper'],
		// No supply pin: the inputs are driven from logic and the outputs sink
		// current from whatever the load is on. COM is the common cathode of the
		// flyback diodes, wired to the load's supply when the loads are coils.
		layout: [
			'1B', '2B', '3B', '4B', '5B', '6B', '7B', 'GND',
			'COM', '7C', '6C', '5C', '4C', '3C', '2C', '1C'
		],
		blocks: [],
		analog: [1, 2, 3, 4, 5, 6, 7].flatMap((n): AnalogBlock[] => [
			{ kind: 'resistor', a: `${n}B`, b: `${n}base`, ohms: 2.7e3 },
			{ kind: 'resistor', a: `${n}base`, b: 'GND', ohms: 7.2e3 },
			{ kind: 'npn', collector: `${n}C`, base: `${n}base`, emitter: `${n}mid` },
			{ kind: 'resistor', a: `${n}mid`, b: 'GND', ohms: 3e3 },
			{ kind: 'npn', collector: `${n}C`, base: `${n}mid`, emitter: 'GND' },
			{ kind: 'diode', anode: `${n}C`, cathode: 'COM' }
		])
	}
];
