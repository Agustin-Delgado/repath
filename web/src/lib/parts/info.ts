/**
 * What a person needs to find a part, kept apart from what the engine needs
 * to simulate it.
 *
 * The catalog in `schematic/model.ts` says what a part *is*: pins, geometry,
 * parameters. This says what it is *called*: one line to recognise it by, and
 * the words somebody might type when they do not know our name for it — "pot"
 * is not a resistor to us yet, but "pull-up" and "ohm" are.
 */
export interface PartInfo {
	description: string;
	keywords: readonly string[];
}

export const PART_INFO: Readonly<Record<string, PartInfo>> = {
	resistor: {
		description: 'Fixed resistance, with tolerance and temperature drift',
		keywords: ['r', 'ohm', 'resistance', 'pull-up', 'pull-down', 'load', 'divider']
	},
	capacitor: {
		description: 'Stores charge; blocks DC, passes AC',
		keywords: ['c', 'cap', 'farad', 'filter', 'decoupling', 'bypass', 'timing']
	},
	inductor: {
		description: 'Stores energy in a magnetic field; resists changes in current',
		keywords: ['l', 'coil', 'henry', 'choke', 'filter']
	},
	switch: {
		description: 'Contacts you flip by clicking, or on a schedule, with bounce',
		keywords: ['s', 'spst', 'button', 'push-button', 'momentary', 'contact', 'bounce']
	},
	port: {
		description: 'A terminal of a block: wire a pin to it and the box gets a pin',
		keywords: ['terminal', 'pin', 'io', 'label', 'net']
	},
	probe: {
		description: 'Names a net so the scope can plot it',
		keywords: ['measure', 'label', 'scope', 'net', 'test point', 'marker']
	},
	ground: {
		description: 'The reference node every voltage is measured from',
		keywords: ['gnd', '0v', 'earth', 'common', 'reference']
	},
	supply: {
		description: 'A fixed rail to connect anywhere, like VCC or +5 V',
		keywords: ['vcc', 'vdd', 'rail', 'power', 'battery', 'dc', '+5v']
	},
	vsource: {
		description: 'DC, sine, square or pulse voltage, with an AC magnitude for sweeps',
		keywords: ['v', 'battery', 'signal', 'generator', 'sine', 'square', 'pulse', 'ac', 'dc', 'function generator']
	},
	isource: {
		description: 'DC, sine, square or pulse current',
		keywords: ['i', 'current', 'bias', 'constant current', 'generator']
	},
	diode: {
		description: 'Conducts one way; rectifier, Schottky and Zener presets',
		keywords: ['d', 'rectifier', 'zener', 'schottky', '1n4148', '1n4001', 'clamp']
	},
	led: {
		description: 'Lights up with the current through it',
		keywords: ['light', 'indicator', 'lamp', 'diode', 'red', 'green', 'blue']
	},
	display7: {
		description: 'Seven LED segments and a decimal point, common anode or cathode',
		keywords: ['seven segment', '7seg', 'digit', 'display', 'number', 'readout']
	},
	nmos: {
		description: 'N-channel MOSFET, Shichman-Hodges',
		keywords: ['mosfet', 'fet', 'transistor', 'n-channel', 'switch', '2n7000']
	},
	pmos: {
		description: 'P-channel MOSFET, Shichman-Hodges',
		keywords: ['mosfet', 'fet', 'transistor', 'p-channel', 'high side']
	},
	npn: {
		description: 'NPN bipolar transistor, Gummel-Poon',
		keywords: ['bjt', 'transistor', '2n2222', '2n3904', 'bc547', 'amplifier']
	},
	pnp: {
		description: 'PNP bipolar transistor, Gummel-Poon',
		keywords: ['bjt', 'transistor', '2n3906', 'bc557', 'high side']
	},
	opamp: {
		description: 'Operational amplifier with finite gain, bandwidth and slew rate',
		keywords: ['op amp', 'amplifier', 'comparator', 'lm741', 'lm358', 'tl072', 'integrator']
	},
	and: { description: 'Output high only when every input is high', keywords: ['gate', '&'] },
	nand: { description: 'Output low only when every input is high', keywords: ['gate', 'not and'] },
	or: { description: 'Output high when any input is high', keywords: ['gate', '≥1'] },
	nor: { description: 'Output high only when every input is low', keywords: ['gate', 'not or'] },
	xor: { description: 'Output high when the inputs differ', keywords: ['gate', 'exclusive or', 'parity'] },
	xnor: { description: 'Output high when the inputs agree', keywords: ['gate', 'equality', 'parity'] },
	buffer: { description: 'Passes its input through, with a delay', keywords: ['gate', 'driver', 'repeater'] },
	tristate: {
		description: 'A buffer that lets go of its output when not enabled',
		keywords: ['gate', 'three-state', 'enable', 'bus', 'high-z']
	},
	not: { description: 'Inverts its input', keywords: ['gate', 'inverter'] },
	dff: {
		description: 'Edge-triggered D flip-flop with set and reset',
		keywords: ['flip-flop', 'flipflop', 'register', 'latch', 'memory', 'clocked']
	},
	clock: {
		description: 'A square wave at a logic level',
		keywords: ['oscillator', 'clk', 'square', 'timer', 'pulse']
	},
	toggle: {
		description: 'A logic level you flip by clicking it',
		keywords: ['switch', 'input', 'button', 'high', 'low', 'level']
	}
};
