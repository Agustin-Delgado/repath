/**
 * Boards: a microcontroller with everything it needs already around it.
 *
 * A student with an Uno thinks in its headers — pin 13, 5V, GND — not in a
 * DIP-28 that wants a supply, a crystal and a reset pull-up before it does
 * anything. A board is a chip row like any other, so it is the same engine
 * `mcu` device, the same program parameter and the same inspector as the bare
 * ATmega328P; what it adds is the board's own copper: legs named as printed,
 * the rails it holds from USB, and the parts on it that change what a sketch
 * does — the L LED on pin 13 and the reset pull-up.
 */

import type { AnalogBlock, ChipDef, OpAmpSpec } from './chips';
import { ARDUINO_NAMES } from './chips-mcu';

/**
 * The LMV358 that buffers the L LED on an Uno R3, typical values off the first
 * page of its datasheet. Rail-to-rail at the output, which is why the LED sees
 * nearly the whole 5 V.
 */
const LMV358: OpAmpSpec = {
	gain: 1e5,
	gbw: 1e6,
	slew: 1e6,
	rOut: 75,
	vOs: 1.7e-3,
	iBias: 15e-9,
	swing: [0.02, 0.05]
};

/** Ports B, C and D as the engine names them, each with the header pin it reaches. */
const UNO_PORT_PINS: Readonly<Record<string, string>> = ARDUINO_NAMES;

/**
 * The reset pull-up: the board's 10 kΩ in parallel with the chip's own,
 * whose middle is 45 kΩ. A button from RESET to ground works against both.
 */
const UNO_RESET_PULL_UP = 1 / (1 / 10e3 + 1 / 45e3);

/** Header pitch, a tenth of an inch, as a chip's legs are. */
const PITCH = 20;
/** Where the tips of the header pins are, above and below the board's centre. */
const EDGE = 210;

/**
 * The headers in the order the board has them, left to right with the USB
 * jack on the left: the digital row along the top, power and analog along the
 * bottom. An empty string is the gap between two headers; NC is the power
 * header's unconnected first pin, drawn and not wireable.
 *
 * The real gap between the two digital headers is 160 mil, the famous one
 * that is not a multiple of the pitch. Here it is one empty place: a pin off
 * the grid is a pin no wire can land on.
 */
const TOP: readonly string[] = [
	'SCL', 'SDA', 'AREF', 'GND3', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8', '',
	'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0'
];
const BOTTOM: readonly string[] = [
	'NC', 'IOREF', 'RESET', '3V3', '5V', 'GND', 'GND2', 'VIN', '',
	'A0', 'A1', 'A2', 'A3', 'A4', 'A5'
];
/** Where the first place of each row is. */
const TOP_START = -180;
const BOTTOM_START = -100;

const row = (names: readonly string[], start: number, y: number) =>
	names.flatMap((name, i) => (name === '' ? [] : [[name, { x: start + i * PITCH, y }] as const]));

const UNO_PINS: Readonly<Record<string, { x: number; y: number }>> = Object.fromEntries([
	...row(TOP, TOP_START, -EDGE),
	...row(BOTTOM, BOTTOM_START, EDGE)
]);

/** From a pin's tip to its hole in the header, which sits just inside the board's edge. */
const LEAD = 32;

/** The outline of each header: one box around each run of places with no gap in it. */
function headerBoxes(names: readonly string[], start: number, y: number): string[] {
	const boxes: string[] = [];
	let from = -1;
	for (let i = 0; i <= names.length; i++) {
		const gap = i === names.length || names[i] === '';
		if (!gap && from < 0) from = i;
		if (gap && from >= 0) {
			const left = start + from * PITCH - PITCH / 2;
			const width = (i - from) * PITCH;
			boxes.push(`M${left} ${y - 8} h${width} v16 h${-width} Z`);
			from = -1;
		}
	}
	return boxes;
}

/**
 * The board as seen from above, USB on the left: the outline with the corner
 * the real one has cut off by the digital header, the USB and barrel jacks
 * standing out past the edge, the reset button by them, the DIP chip under
 * the analog header, the ICSP header on the right and the four mounting
 * holes. No logo: what makes it recognisable is where things are.
 */
const UNO_ART = {
	strokes: [
		'M-244 -190 H236 L250 -176 V176 L236 190 H-244 A6 6 0 0 1 -250 184 V-184 A6 6 0 0 1 -244 -190 Z',
		...headerBoxes(TOP, TOP_START, -EDGE + LEAD),
		...headerBoxes(BOTTOM, BOTTOM_START, EDGE - LEAD),
		// USB-B, and the opening its plug goes into.
		'M-272 -160 H-200 V-100 H-272 Z',
		'M-272 -150 H-252 V-110 H-272',
		// The barrel jack.
		'M-276 90 H-196 V150 H-276 Z',
		'M-262 90 V150',
		// The reset button.
		'M-196 -86 H-172 V-62 H-196 Z',
		'M-177 -74 A7 7 0 0 0 -191 -74 A7 7 0 0 0 -177 -74',
		// The ATmega328P, notch to the left, fourteen legs a side.
		'M-30 60 H190 V112 H-30 Z',
		'M-30 78 A8 8 0 0 1 -30 94',
		Array.from({ length: 14 }, (_, i) => `M${-20 + i * 16} 60 V54 M${-20 + i * 16} 112 V118`).join(' '),
		// ICSP, two by three.
		'M212 -20 H240 V20 H212 Z',
		// Mounting holes.
		...[
			[-215, -165],
			[-160, 168],
			[232, 130],
			[232, -110]
		].map(([x, y]) => `M${x + 6} ${y} A6 6 0 0 0 ${x - 6} ${y} A6 6 0 0 0 ${x + 6} ${y}`)
	],
	fills: [220, 232].flatMap((x) =>
		[-12, 0, 12].map((y) => `M${x - 2.5} ${y - 2.5} h5 v5 h-5 Z`)
	),
	print: [
		{ x: -120, y: 10, text: 'UNO', size: 15 },
		{ x: 110, y: -144, text: 'DIGITAL (PWM ~)', size: 8 },
		{ x: -30, y: 144, text: 'POWER', size: 8 },
		{ x: 130, y: 144, text: 'ANALOG IN', size: 8 },
		{ x: 80, y: 86, text: 'ATmega328P', size: 10 },
		{ x: -184, y: -50, text: 'RESET', size: 7 },
		{ x: -236, y: -130, text: 'USB', size: 8 },
		{ x: 226, y: 32, text: 'ICSP', size: 7 }
	]
};

/** What the silkscreen prints by each header pin; the datasheet's name is the hover's. */
const UNO_SILKSCREEN: Readonly<Record<string, string>> = {
	SCL: 'SCL', SDA: 'SDA', AREF: 'AREF', GND3: 'GND',
	D13: '13', D12: '12', D11: '~11', D10: '~10', D9: '~9', D8: '8',
	D7: '7', D6: '~6', D5: '~5', D4: '4', D3: '~3', D2: '2', D1: 'TX→1', D0: 'RX←0',
	IOREF: 'IOREF', RESET: 'RESET', '3V3': '3V3', '5V': '5V', GND: 'GND', GND2: 'GND', VIN: 'VIN',
	A0: 'A0', A1: 'A1', A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5'
};

/**
 * The L LED, as an R3 wires it: pin 13 into one half of an LMV358 wired as a
 * follower, and the follower's output through 1 kΩ into the LED. The buffer is
 * the point of it: the LED takes its 3 mA from the op-amp, so pin 13 sees an
 * op-amp input and nothing else, and works as an input as well as on earlier
 * boards whose LED hung straight off the pin. The ON LED is 1 kΩ from 5 V.
 */
const UNO_ANALOG: readonly AnalogBlock[] = [
	{ kind: 'opamp', plus: 'D13', minus: 'L_buffer', out: 'L_buffer', spec: LMV358 },
	// What holds the buffer's input when nothing does. On the board that is the
	// pin's leakage and its protection diodes; with neither modelled, the input's
	// bias current alone ran the node to kilovolts. 10 MΩ is chosen, not
	// measured: half a microamp at 5 V is nothing to any pull-up or drive, and a
	// pin 13 left as an input reads low with L dark.
	{ kind: 'resistor', a: 'D13', b: 'GND', ohms: 10e6 },
	{ kind: 'resistor', a: 'L_buffer', b: 'L_anode', ohms: 1e3 },
	{ kind: 'led', anode: 'L_anode', cathode: 'GND', colour: 'amber', light: 'L' },
	{ kind: 'resistor', a: '5V', b: 'ON_anode', ohms: 1e3 },
	{ kind: 'led', anode: 'ON_anode', cathode: 'GND', colour: 'green', light: 'ON' }
];

/** Every header pin's other name: what the chip's datasheet calls it. */
const DATASHEET_NAMES: Readonly<Record<string, string>> = {
	...Object.fromEntries(Object.entries(ARDUINO_NAMES).map(([port, pin]) => [pin, port])),
	SDA: 'A4, PC4',
	SCL: 'A5, PC5',
	RESET: 'PC6'
};

export const ARDUINO_UNO: ChipDef = {
	id: 'ArduinoUno',
	name: 'Arduino Uno',
	role: 'microcontrollers',
	description: 'The whole board, powered from USB: headers as printed, its L LED and reset',
	aliases: ['arduino', 'uno', 'board', 'r3', 'genuino', 'dev board', 'sketch'],
	layout: [...TOP, ...BOTTOM].filter((name) => name !== ''),
	blocks: [
		{
			kind: 'mcu',
			model: 'atmega328p',
			ports: Object.keys(UNO_PORT_PINS),
			reset: 'RESET',
			legs: { ...UNO_PORT_PINS, AVCC: '5V', AGND: 'GND', AREF: 'AREF' },
			converter: {
				inputs: ['PC0', 'PC1', 'PC2', 'PC3', 'PC4', 'PC5'],
				aref: 'AREF',
				avcc: 'AVCC',
				agnd: 'AGND'
			},
			// VIN feeds the regulator a barrel jack would; on USB it does nothing.
			unmodelled: ['VIN']
		}
	],
	analog: UNO_ANALOG,
	pullUps: { RESET: UNO_RESET_PULL_UP },
	// Nothing on a board has to be wired for it to run: it powers itself, and
	// a header pin left empty is the usual state of most of them.
	optional: [...TOP, ...BOTTOM].filter((name) => name !== '' && name !== 'NC'),
	boardNames: DATASHEET_NAMES,
	joined: [
		['GND', 'GND2', 'GND3'],
		['5V', 'IOREF'],
		['A4', 'SDA'],
		['A5', 'SCL']
	],
	power: { rails: { '5V': 5, '3V3': 3.3 }, supply: '5V', ground: 'GND', ohms: 0.5 },
	board: {
		pins: UNO_PINS,
		lead: LEAD,
		silkscreen: UNO_SILKSCREEN,
		staggered: ['IOREF'],
		art: UNO_ART,
		body: { x: -276, y: -190, w: 526, h: 380 },
		lights: [
			{ name: 'L', x: -100, y: -122, colour: 'amber' },
			{ name: 'ON', x: 206, y: -62, colour: 'green' }
		]
	},
	caveat:
		"The board as it runs from a USB cable: 5V and 3V3 are held there, GND is the circuit's ground, and VIN does nothing. The 500 mA fuse on USB is not modelled, so a short across 5V is not stopped. Its ATmega328P runs a .hex exactly as the ATmega328P part does, and leaves out what that leaves out. The L LED follows pin 13 through the board's buffer; the TX and RX LEDs, and the USB-to-serial chip on pins 0 and 1 are not modelled."
};

export const BOARDS: readonly ChipDef[] = [ARDUINO_UNO];
