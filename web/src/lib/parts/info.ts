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
	varcap: {
		description: 'Capacitance set between a minimum and a maximum',
		keywords: ['variable capacitor', 'trimmer', 'tuning capacitor', 'varicap', 'air variable', 'radio', 'tank']
	},
	transformer: {
		description: 'Two coupled windings with a turns ratio; steps AC up or down',
		keywords: ['coupled inductors', 'mutual inductance', 'mains', 'isolation', 'step down', 'step up', 'winding', 'ratio', 'k']
	},
	fuse: {
		description: 'Opens permanently on sustained overcurrent',
		keywords: ['f', 'protection', 'overcurrent', 'blow', 'i2t', 'slow blow', 'fast acting', 'polyfuse']
	},
	switch: {
		description: 'SPST contacts, clicked or timed, with bounce',
		keywords: ['s', 'spst', 'button', 'push-button', 'momentary', 'contact', 'bounce']
	},
	pushbutton: {
		description: 'Momentary contacts: they change while held',
		keywords: ['button', 'push button', 'momentary', 'tactile', 'tact switch', 'no', 'nc', 'press']
	},
	potentiometer: {
		description: 'Resistance track with a wiper: an adjustable divider',
		keywords: ['pot', 'trimmer', 'trimpot', 'rheostat', 'variable resistor', 'wiper', 'volume', 'divider', 'knob']
	},
	crystal: {
		description: 'Quartz resonator, modelled as its motional arm and holder capacitance',
		keywords: ['xtal', 'quartz', 'resonator', 'oscillator', 'clock', '16mhz', '32.768khz', 'watch crystal']
	},
	spdt: {
		description: 'Changeover contacts: common to NC at rest, to NO when thrown',
		keywords: ['switch', 'changeover', 'change-over', 'toggle switch', 'selector', 'no', 'nc', 'two way']
	},
	relay: {
		description: 'Coil with changeover contacts',
		keywords: ['coil', 'electromechanical', 'contactor', 'spdt', 'no', 'nc', 'flyback', 'k']
	},
	lamp: {
		description: 'Filament bulb rated in volts and watts',
		keywords: ['bulb', 'light', 'incandescent', 'filament', 'indicator', 'torch']
	},
	buzzer: {
		description: 'Passive piezo: sounds at its drive frequency (tone())',
		keywords: ['piezo', 'buzzer', 'speaker', 'beeper', 'sound', 'tone', 'notone', 'melody', 'audio', 'beep', 'transducer']
	},
	port: {
		description: 'Block terminal: each port is a pin on the box',
		keywords: ['terminal', 'pin', 'io', 'label', 'net']
	},
	probe: {
		description: 'Names a net so the scope can plot it',
		keywords: ['measure', 'label', 'scope', 'net', 'test point', 'marker']
	},
	ground: {
		description: '0 V reference for all voltages',
		keywords: ['gnd', '0v', 'earth', 'common', 'reference']
	},
	supply: {
		description: 'Fixed voltage rail (VCC, +5 V)',
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
	cccs: {
		description: 'SPICE F: current = gain × current in a voltage source',
		keywords: ['f', 'cccs', 'dependent', 'controlled', 'current mirror', 'current gain', 'beta', 'macromodel']
	},
	ccvs: {
		description: 'SPICE H: voltage = transresistance × current in a voltage source',
		keywords: ['h', 'ccvs', 'dependent', 'controlled', 'transresistance', 'transimpedance', 'macromodel']
	},
	battery: {
		description: 'Cell or stack, with internal resistance',
		keywords: ['cell', 'bt', '9v', 'aa', 'aaa', 'lipo', 'alkaline', 'coin cell', 'power']
	},
	diode: {
		description: 'Conducts one way; rectifier, Schottky and Zener presets',
		keywords: ['d', 'rectifier', 'zener', 'schottky', '1n4148', '1n4007', '1n5819', '1n4733', 'clamp', 'regulator']
	},
	led: {
		description: 'Lights with its current; burns out above its rating',
		keywords: ['light', 'indicator', 'lamp', 'diode', 'red', 'green', 'blue']
	},
	display7: {
		description: 'Seven LED segments and a decimal point, common anode or cathode',
		keywords: ['seven segment', '7seg', 'digit', 'display', 'number', 'readout']
	},
	display7x4: {
		description: 'Four multiplexed digits on shared segment pins',
		keywords: ['seven segment', '7seg', 'multiplexed', 'multiplex', 'clock', 'four digit', '4 digit', 'display', 'readout']
	},
	bargraph: {
		description: 'Ten LEDs in a row, every anode and cathode brought out',
		keywords: ['bar graph', 'led bar', 'level meter', 'vu', 'ladder', 'display', 'indicator']
	},
	lcd1602: {
		description: '16×2 characters on an I²C backpack: GND, VCC, SDA, SCL',
		keywords: [
			'lcd', '1602', '16x2', 'i2c lcd', 'lcd i2c', 'pcf8574', 'hd44780', 'liquidcrystal',
			'liquidcrystal_i2c', 'character display', 'display', 'text', 'screen'
		]
	},
	max7219: {
		description: '8×8 red LEDs over SPI: VCC, GND, DIN, CS, CLK. DOUT chains the next.',
		keywords: [
			'max7219', 'led matrix', 'matrix', '8x8', 'dot matrix', 'spi', 'ledcontrol', '1088as',
			'display', 'max7221'
		]
	},
	servo: {
		description: 'Hobby servo (SG90): 544–2400 µs pulses on SIG set 0–180°',
		keywords: ['servo', 'sg90', 'mg90', 'motor', 'rc servo', 'hobby servo', 'pwm', 'angle', 'horn', 'actuator']
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
		keywords: ['op amp', 'amplifier', 'comparator', 'integrator']
	},
	regulator: {
		description: 'Linear regulator: 78xx, 79xx, LM317',
		keywords: ['7805', '7809', '7812', '7815', '7905', '7912', '7915', 'lm317', 'lm7805', 'negative', 'linear', 'power supply', 'vreg']
	},
	and: { description: 'Output high only when every input is high', keywords: ['gate', '&'] },
	nand: { description: 'Output low only when every input is high', keywords: ['gate', 'not and'] },
	or: { description: 'Output high when any input is high', keywords: ['gate', '≥1'] },
	nor: { description: 'Output high only when every input is low', keywords: ['gate', 'not or'] },
	xor: { description: 'Output high when the inputs differ', keywords: ['gate', 'exclusive or', 'parity'] },
	xnor: { description: 'Output high when the inputs agree', keywords: ['gate', 'equality', 'parity'] },
	buffer: { description: 'Passes its input through, with a delay', keywords: ['gate', 'driver', 'repeater'] },
	tristate: {
		description: 'Buffer; output is high-Z when not enabled',
		keywords: ['gate', 'three-state', 'enable', 'bus', 'high-z']
	},
	not: { description: 'Inverts its input', keywords: ['gate', 'inverter'] },
	dff: {
		description: 'Edge-triggered D flip-flop with set and reset',
		keywords: ['flip-flop', 'flipflop', 'register', 'latch', 'memory', 'clocked']
	},
	clock: {
		description: 'Logic-level square wave',
		keywords: ['oscillator', 'clk', 'square', 'timer', 'pulse']
	},
	toggle: {
		description: 'Logic level; click to flip',
		keywords: ['switch', 'input', 'button', 'high', 'low', 'level']
	}
};
