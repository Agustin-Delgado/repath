/**
 * Circuits that ship with the app.
 *
 * The first thing a simulator has to do is show you something working. An empty
 * canvas asks you to already know how to use it.
 */

import type { Schematic } from './schematic/model';
import { defaultParams } from './schematic/model';
import { SEGMENTS } from './schematic/led';

export interface Example {
	id: string;
	name: string;
	description: string;
	stopTime: number;
	/** Which analysis shows this circuit off. Defaults to transient. */
	analysis?: 'transient' | 'frequency';
	/** Sweep range, for the ones meant to be looked at in the frequency domain. */
	frequencyRange?: { start: number; stop: number };
	build: () => Schematic;
}

let counter = 0;
const nextId = () => `x${++counter}`;

interface Placed {
	kind: string;
	name: string;
	x: number;
	y: number;
	rotation?: 0 | 90 | 180 | 270;
	params?: Record<string, number | string>;
}

function build(parts: Placed[], wires: Array<[number, number, number, number]>): Schematic {
	return {
		instances: parts.map((p) => ({
			id: nextId(),
			kind: p.kind,
			name: p.name,
			x: p.x,
			y: p.y,
			rotation: p.rotation ?? 0,
			params: { ...defaultParams(p.kind), ...(p.params ?? {}) }
		})),
		// Written as plain runs and stored as short polylines; connectivity joins
		// them where their ends meet, exactly as if they had been drawn that way.
		wires: wires.map(([x1, y1, x2, y2]) => ({
			id: nextId(),
			points: [
				{ x: x1, y: y1 },
				{ x: x2, y: y2 }
			]
		}))
	};
}

export const EXAMPLES: Example[] = [
	{
		id: 'rc-lowpass',
		name: 'RC low-pass',
		description: 'A square wave through a first-order filter, and the exponential it charges along.',
		stopTime: 5e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 500, duty: 0.5 }
					},
					{ kind: 'resistor', name: 'R1', x: 200, y: 170 },
					{
						kind: 'capacitor',
						name: 'C1',
						x: 300,
						y: 230,
						rotation: 90,
						params: { capacitance: 1e-6 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 170, 170],
					[230, 170, 300, 170],
					[300, 170, 300, 200],
					[300, 260, 300, 290],
					[100, 290, 300, 290],
					[100, 230, 100, 290]
				]
			)
	},
	{
		id: 'rectifier',
		name: 'Half-wave rectifier',
		description:
			'A diode and a smoothing capacitor turning AC into lumpy DC — a nonlinear circuit that has to converge on every step.',
		stopTime: 60e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 10, offset: 0, frequency: 50 }
					},
					{ kind: 'diode', name: 'D1', x: 200, y: 170 },
					{
						kind: 'capacitor',
						name: 'C1',
						x: 300,
						y: 230,
						rotation: 90,
						params: { capacitance: 100e-6 }
					},
					{
						kind: 'resistor',
						name: 'R1',
						x: 390,
						y: 230,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 170, 170],
					[230, 170, 390, 170],
					[300, 170, 300, 200],
					[390, 170, 390, 200],
					[300, 260, 300, 290],
					[390, 260, 390, 290],
					[100, 290, 390, 290],
					[100, 230, 100, 290]
				]
			)
	},
	{
		id: 'led-driver',
		name: 'LED driver',
		description:
			'Two LEDs across the same 5 V. One through 330 Ω lights and stays lit; one through 33 Ω — a decimal point in the wrong place — lights brighter and lasts about a third of a millisecond.',
		stopTime: 2e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'dc', value: 5 }
					},
					{ kind: 'resistor', name: 'R1', x: 260, y: 220, rotation: 90, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 260, y: 300, rotation: 90, params: { colour: 'red' } },
					{ kind: 'resistor', name: 'R2', x: 400, y: 220, rotation: 90, params: { resistance: 33 } },
					{ kind: 'led', name: 'D2', x: 400, y: 300, rotation: 90, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND1', x: 100, y: 340 }
				],
				[
					[100, 170, 260, 170],
					[260, 170, 400, 170],
					[260, 170, 260, 190],
					[400, 170, 400, 190],
					[260, 250, 260, 270],
					[400, 250, 400, 270],
					[260, 330, 400, 330],
					[100, 330, 260, 330],
					[100, 230, 100, 330]
				]
			)
	},
	{
		id: 'common-emitter',
		name: 'Common-emitter amplifier',
		description:
			'A BJT biased into its active region by RB, amplifying and inverting a 10 mV signal coupled in through C1.',
		stopTime: 5e-3,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'V1', x: 60, y: 120, params: { waveform: 'dc', value: 12 } },
					{
						kind: 'vsource',
						name: 'V2',
						x: 120,
						y: 250,
						params: { waveform: 'sine', value: 0.01, offset: 0, frequency: 1000 }
					},
					{ kind: 'capacitor', name: 'C1', x: 220, y: 220, params: { capacitance: 1e-6 } },
					{
						kind: 'resistor',
						name: 'RB',
						// Sized so the collector rests near half the supply. At 470 k it
						// sat at 1.4 V, which leaves 1.4 V of room below and 10 V above:
						// the stage described here as amplifying a 10 mV signal wants
						// ±2 V, so it was clipping flat against ground on every negative
						// half cycle. An amplifier example that visibly distorts teaches
						// the wrong thing twice over.
						x: 340,
						y: 150,
						rotation: 90,
						params: { resistance: 820000 }
					},
					{
						kind: 'resistor',
						name: 'RC',
						x: 440,
						y: 150,
						rotation: 90,
						params: { resistance: 2200 }
					},
					{ kind: 'npn', name: 'Q1', x: 430, y: 250 },
					{ kind: 'ground', name: 'GND1', x: 120, y: 350 },
					{ kind: 'ground', name: 'GND2', x: 440, y: 350 }
				],
				[
					// Supply rail across the top.
					[60, 90, 440, 90],
					[340, 90, 340, 120],
					[440, 90, 440, 120],
					// Bias resistor down to the base.
					[340, 180, 340, 250],
					[340, 250, 400, 250],
					// Collector load.
					[440, 180, 440, 220],
					// Emitter to ground.
					[440, 280, 440, 340],
					// Signal in through the coupling capacitor.
					[120, 220, 190, 220],
					[250, 220, 300, 220],
					[300, 220, 300, 250],
					[300, 250, 340, 250],
					// Returns.
					[120, 280, 120, 340],
					[60, 150, 60, 340],
					[60, 340, 120, 340]
				]
			)
	},
	{
		id: 'mixed-signal',
		name: 'Analog into logic',
		description:
			'A sine crosses the logic thresholds, drives a NOT gate, and comes back out into an RC load. The analog-digital bridges are inserted for you.',
		stopTime: 400e-6,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 90,
						y: 220,
						params: { waveform: 'sine', value: 2.4, offset: 2.5, frequency: 10000 }
					},
					{ kind: 'not', name: 'U1', x: 250, y: 190 },
					{
						kind: 'resistor',
						name: 'R1',
						x: 400,
						y: 250,
						rotation: 90,
						params: { resistance: 10000 }
					},
					{
						kind: 'capacitor',
						name: 'C1',
						x: 480,
						y: 250,
						rotation: 90,
						params: { capacitance: 1e-9 }
					},
					{ kind: 'ground', name: 'GND1', x: 90, y: 320 },
					{ kind: 'ground', name: 'GND2', x: 440, y: 330 }
				],
				[
					[90, 190, 220, 190],
					[280, 190, 480, 190],
					[400, 190, 400, 220],
					[480, 190, 480, 220],
					[400, 280, 400, 310],
					[480, 280, 480, 310],
					[400, 310, 480, 310],
					[440, 310, 440, 320],
					[90, 250, 90, 310]
				]
			)
	},
	{
		id: 'rlc-bandpass',
		name: 'RLC band-pass',
		description:
			'A series resonant circuit, meant to be looked at in the frequency domain. V1 carries the AC drive, so the sweep measures the response from it.',
		stopTime: 2e-3,
		analysis: 'frequency',
		frequencyRange: { start: 10, stop: 1e6 },
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 1, offset: 0, frequency: 1590, ac: 1 }
					},
					{ kind: 'resistor', name: 'R1', x: 200, y: 170, params: { resistance: 50 } },
					{ kind: 'inductor', name: 'L1', x: 320, y: 170, params: { inductance: 10e-3 } },
					{
						kind: 'capacitor',
						name: 'C1',
						x: 420,
						y: 230,
						rotation: 90,
						params: { capacitance: 1e-6 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 170, 170],
					[230, 170, 290, 170],
					[350, 170, 420, 170],
					[420, 170, 420, 200],
					[420, 260, 420, 290],
					[100, 290, 420, 290],
					[100, 230, 100, 290]
				]
			)
	},
	{
		id: 'bcd-display',
		name: 'BCD to a digit',
		description:
			'Four switches, a 4511 and a seven-segment digit: the chain every counter ends in. The switches spell a number in binary, the decoder turns four bits into seven bars, and the display is the bars. It arrives showing 5. The resistors are not optional even though the 4511 is called a driver — it drives, it does not limit — and the three control pins are held at the levels that mean "no latch, no blanking, no lamp test", because on a real board they cannot be left in the air.',
		stopTime: 20e-6,
		build: () => {
			/** Where the decoder sits; its sixteen legs are 20 apart down each side. */
			const DEC_X = 500;
			const DEC_Y = 300;
			/** And the digit, whose eight are 10 apart. */
			const DIGIT_X = 1100;
			const DIGIT_Y = 300;

			// Pin 16 is VDD and the seven segment outputs run down from pin 15.
			const OUT_Y: Record<string, number> = {
				f: DEC_Y - 50,
				g: DEC_Y - 30,
				a: DEC_Y - 10,
				b: DEC_Y + 10,
				c: DEC_Y + 30,
				d: DEC_Y + 50,
				e: DEC_Y + 70
			};
			// The digit takes them in alphabetical order, which is not the order they
			// leave the decoder in — so each run steps across in a column of its own.
			const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
			const inY = (seg: string) => DIGIT_Y + (SEGMENTS.indexOf(seg) - 3.5) * 10;

			const parts: Placed[] = [
				{ kind: 'ic:4511', name: 'U1', x: DEC_X, y: DEC_Y },
				{ kind: 'display7', name: 'DS1', x: DIGIT_X, y: DIGIT_Y, params: { colour: 'red' } },
				{ kind: 'supply', name: 'PWR1', x: 300, y: 150, params: { voltage: 5 } },
				{ kind: 'supply', name: 'PWR2', x: 700, y: 220, params: { voltage: 5 } },
				{ kind: 'ground', name: 'GND1', x: 400, y: 440 },
				{ kind: 'ground', name: 'GND2', x: DIGIT_X, y: 420 }
			];
			const wires: Array<[number, number, number, number]> = [
				// Lamp test and blanking are active low, so both sit high: nothing to
				// test and nothing to blank.
				[300, 160, 300, 290],
				[300, 270, 440, 270],
				[300, 290, 440, 290],
				// Latch enable is active high, and held down the latches stay open.
				[340, 310, 440, 310],
				[340, 310, 340, 430],
				[340, 430, 400, 430],
				// VSS, on the same ground.
				[400, 370, 440, 370],
				[400, 370, 400, 430],
				// VDD, above the segment outputs.
				[560, 230, 700, 230],
				// The digit's common pin is its cathode: this one lights on a high.
				[DIGIT_X, DIGIT_Y + 62, DIGIT_X, 410]
			];

			// The four data bits. 0101 is a 5, which uses six of the seven bars and
			// leaves one off — a digit where a wrong equation would show.
			const BITS: Array<[string, number, 'high' | 'low']> = [
				['B', DEC_Y - 70, 'low'],
				['C', DEC_Y - 50, 'high'],
				['D', DEC_Y + 30, 'low'],
				['A', DEC_Y + 50, 'high']
			];
			for (const [pin, y, state] of BITS) {
				parts.push({ kind: 'toggle', name: pin, x: 150, y, params: { state } });
				wires.push([180, y, 440, y]);
			}

			// One resistor per segment, then across to the digit. The decoder drives
			// the bars; nothing in it limits what they draw.
			for (const [i, seg] of SEGMENTS.entries()) {
				const from = OUT_Y[seg];
				const to = inY(seg);
				const column = 880 + i * 15;
				parts.push({
					kind: 'resistor',
					name: `R${i + 1}`,
					x: 800,
					y: from,
					params: { resistance: 330 }
				});
				wires.push(
					[560, from, 770, from],
					[830, from, column, from],
					[column, from, column, to],
					[column, to, DIGIT_X - 50, to]
				);
			}

			return build(parts, wires);
		}
	},

	{
		id: 'cd4027',
		name: 'CD4027 divider',
		description:
			'Half a CD4027 wired the way its datasheet says to make a divide-by-two: J and K both high, set and reset held down, and the output changes on every rising edge and on no other. The chip is the part rather than the gates inside it, so it has two legs it cannot do without — leave VDD or VSS unwired and the drawing tells you — and a whole second flip-flop nobody is using, whose inputs are tied to ground rather than left in the air. That is not tidiness: a CMOS input floating between the rails turns the stage into an amplifier and it draws current and oscillates. The buffer before the lamp is not decoration either, since Q feeds back into the flip-flop and a lamp hung straight on it stops the pair settling.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'clock', name: 'CLK1', x: 300, y: 270, params: { frequency: 1e6, duty: 0.5 } },
					// J and K tied high is the toggle: the identity behind a JK reduces to
					// D = Q-bar, and a flip-flop told to become what it is not divides.
					{ kind: 'supply', name: 'PWR1', x: 400, y: 180, params: { voltage: 5 } },
					{ kind: 'ic:4027', name: 'U1', x: 600, y: 300 },
					{ kind: 'supply', name: 'PWR2', x: 760, y: 220, params: { voltage: 5 } },
					{ kind: 'ground', name: 'GND1', x: 470, y: 470 },
					// Q is an input of the flip-flop as well as its output, and a lamp on a
					// net inside a loop leaves the pair unable to settle. The buffer is what
					// a board would have anyway.
					{ kind: 'buffer', name: 'B1', x: 690, y: 120 },
					{ kind: 'resistor', name: 'R1', x: 890, y: 120, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 990, y: 120, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND2', x: 1060, y: 180 },
					{ kind: 'ground', name: 'GND3', x: 720, y: 510 }
				],
				[
					// The clock, into pin 3.
					[330, 270, 540, 270],
					// The supply rail down to J and K.
					[400, 190, 400, 330],
					[400, 310, 540, 310],
					[400, 330, 540, 330],
					// Set and reset held down, and VSS on the same ground.
					[470, 290, 540, 290],
					[470, 350, 540, 350],
					[470, 370, 540, 370],
					[470, 290, 470, 460],
					// VDD, on pin 16.
					[660, 230, 760, 230],
					// Q up and over to the lamp, through a buffer.
					[510, 230, 540, 230],
					[510, 120, 510, 230],
					[510, 120, 660, 120],
					[720, 120, 860, 120],
					[920, 120, 960, 120],
					[1020, 120, 1060, 120],
					[1060, 120, 1060, 170],
					// The half of the chip nobody is using: every input of it held down.
					// An unused CMOS input left floating sits between the rails, which
					// turns the stage into an amplifier that draws current and oscillates.
					[660, 290, 720, 290],
					[660, 310, 720, 310],
					[660, 330, 720, 330],
					[660, 350, 720, 350],
					[660, 370, 720, 370],
					[720, 290, 720, 500]
				]
			)
	},

	{
		id: 'seven-segment',
		name: 'Seven-segment digit',
		description:
			'Eight LEDs in the shape of a number, a switch each, and a resistor per segment because they are still LEDs. It arrives showing 4 — b, c, f and g — and every other digit is a matter of which switches are down. The common pin goes to ground, which is what common-cathode means: a segment lights when its own switch drives it high. One resistor on the common pin instead of eight would have been cheaper and wrong: the digit would dim as more bars came on.',
		stopTime: 20e-6,
		build: () => {
			// b, c, f and g lit is a 4.
			const lit = new Set(['b', 'c', 'f', 'g']);
			/** Where the digit sits; its eight pins are 20 apart down the left of it. */
			const DIGIT_X = 900;
			const DIGIT_Y = 190;

			const parts: Placed[] = [
				{ kind: 'display7', name: 'DS1', x: DIGIT_X, y: DIGIT_Y, params: { colour: 'red' } },
				{ kind: 'ground', name: 'GND1', x: DIGIT_X, y: 340 }
			];
			const wires: Array<[number, number, number, number]> = [
				[DIGIT_X, DIGIT_Y + 62, DIGIT_X, 330]
			];

			for (const [i, segment] of SEGMENTS.entries()) {
				// The switches need room the digit's own pins do not, so each run steps
				// across in its own column on the way in. Crossing the others costs
				// nothing; landing on one would be another matter.
				const y = 100 + i * 60;
				const pin = DIGIT_Y + (i - 3.5) * 10;
				const column = 620 + i * 10;
				parts.push(
					{
						kind: 'toggle',
						name: segment.toUpperCase(),
						x: 120,
						y,
						params: { state: lit.has(segment) ? 'high' : 'low' }
					},
					// One per segment, and not shared.
					{ kind: 'resistor', name: `R${i + 1}`, x: 380, y, params: { resistance: 330 } }
				);
				wires.push(
					[150, y, 350, y],
					[410, y, column, y],
					[column, y, column, pin],
					[column, pin, DIGIT_X - 50, pin]
				);
			}

			return build(parts, wires);
		}
	},

	{
		id: 'd-latch',
		name: 'D latch, level-triggered',
		description:
			'Four NAND gates and no flip-flop part in sight, because a flip-flop is not a part — it is a pair of gates each holding the other up. While Enable is high the output follows D straight through, which is what level-triggered means. Drop Enable and it keeps whatever D was at that moment, however much D moves afterwards, and that keeping is the whole of the memory. Compare it with the edge-triggered one, which is two of these back to back.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'toggle', name: 'D', x: 100, y: 120, params: { state: 'high' } },
					{ kind: 'toggle', name: 'EN', x: 100, y: 400, params: { state: 'high' } },
					// The input pair. With Enable low both of these sit high, which is the
					// combination the cross-coupled pair reads as "hold whatever you have".
					{ kind: 'nand', name: 'U1', x: 350, y: 170 },
					{ kind: 'nand', name: 'U2', x: 350, y: 310 },
					// And the pair that remembers.
					{ kind: 'nand', name: 'Q', x: 600, y: 150 },
					{ kind: 'nand', name: 'QN', x: 600, y: 330 },
					// The lamps hang off buffers rather than off the loop itself. A gate
					// output feeding a lamp is 8 mA out of something built to drive other
					// gates, and here it is worse than untidy: an LED on a net that is also
					// an input of the loop leaves the pair unable to settle at all.
					{ kind: 'buffer', name: 'B1', x: 760, y: 150 },
					{ kind: 'buffer', name: 'B2', x: 760, y: 330 },
					{ kind: 'resistor', name: 'R1', x: 900, y: 150, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 1000, y: 150, params: { colour: 'green' } },
					{ kind: 'resistor', name: 'R2', x: 900, y: 330, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 1000, y: 330, params: { colour: 'red' } },
					{ kind: 'ground', name: 'GND1', x: 1070, y: 400 }
				],
				[
					// D reaches the first gate only.
					[130, 120, 200, 120],
					[200, 120, 200, 160],
					[200, 160, 320, 160],
					// Enable reaches both, which is what makes it the gate on the whole
					// thing rather than an input like any other.
					[130, 400, 230, 400],
					[230, 180, 230, 400],
					[230, 180, 320, 180],
					[230, 320, 320, 320],
					[380, 170, 420, 170],
					[420, 170, 420, 300],
					[420, 300, 320, 300],
					[420, 140, 570, 140],
					[420, 140, 420, 170],
					[380, 310, 450, 310],
					[450, 310, 450, 320],
					[450, 320, 570, 320],
					// The cross-coupling: each output is an input of the other, and that is
					// the entire mechanism.
					[630, 150, 680, 150],
					[680, 150, 680, 220],
					[500, 220, 680, 220],
					[500, 220, 500, 340],
					[500, 340, 570, 340],
					[630, 330, 710, 330],
					[710, 260, 710, 330],
					[540, 260, 710, 260],
					[540, 160, 540, 260],
					[540, 160, 570, 160],
					// Out through the buffers to the lamps.
					[680, 150, 730, 150],
					[790, 150, 870, 150],
					[930, 150, 970, 150],
					[1030, 150, 1070, 150],
					[710, 330, 730, 330],
					[790, 330, 870, 330],
					[930, 330, 970, 330],
					[1030, 330, 1070, 330],
					[1070, 150, 1070, 390]
				]
			)
	},

	{
		id: 'master-slave',
		name: 'D flip-flop, edge-triggered',
		description:
			'Two of the level-triggered latches back to back on opposite halves of the clock, which is where the edge comes from. While the clock is low the first one follows D and the second holds; when the clock rises the first stops listening and the second copies what it caught. The two are never transparent at the same time, so a change on D can never run straight through to the output — and that, rather than any part called a flip-flop, is what edge-triggered means.',
		stopTime: 20e-6,
		build: () => {
			// Both latches sit at the same height, so the cascade is one straight wire
			// and the two enable rails stay clear of everything else.
			const Y = 120;
			const MASTER = 360;
			const SLAVE = 1060;
			/** Where each latch takes its enable from, to the left of its own gates. */
			const MASTER_EN = 320;
			const SLAVE_EN = 1020;

			const parts: Placed[] = [
				{ kind: 'toggle', name: 'D', x: 100, y: 120, params: { state: 'high' } },
				{ kind: 'clock', name: 'CLK1', x: 100, y: 640, params: { frequency: 1e6, duty: 0.5 } },
				// The master listens while the clock is low and the slave while it is
				// high. One inverter is the entire difference between this and two
				// latches wired in series, which would just be transparent twice over.
				{ kind: 'not', name: 'INV', x: 260, y: 640 },
				{ kind: 'buffer', name: 'B1', x: 1740, y: Y + 30 },
				{ kind: 'buffer', name: 'B2', x: 1740, y: Y + 210 },
				{ kind: 'resistor', name: 'R1', x: 1880, y: Y + 30, params: { resistance: 330 } },
				{ kind: 'led', name: 'D1', x: 1980, y: Y + 30, params: { colour: 'green' } },
				{ kind: 'resistor', name: 'R2', x: 1880, y: Y + 210, params: { resistance: 330 } },
				{ kind: 'led', name: 'D2', x: 1980, y: Y + 210, params: { colour: 'red' } },
				{ kind: 'ground', name: 'GND1', x: 2050, y: Y + 300 }
			];
			const wires: Array<[number, number, number, number]> = [];

			/**
			 * One four-NAND latch, the same drawing as the level-triggered example.
			 *
			 * Returns the points its d input is reached at and its two outputs leave
			 * from, because the second latch is wired to the first.
			 */
			const latch = (tag: string, x: number, enable: number) => {
				parts.push(
					{ kind: 'nand', name: `${tag}1`, x: x + 250, y: Y + 50 },
					{ kind: 'nand', name: `${tag}2`, x: x + 250, y: Y + 190 },
					{ kind: 'nand', name: `${tag}Q`, x: x + 500, y: Y + 30 },
					{ kind: 'nand', name: `${tag}N`, x: x + 500, y: Y + 210 }
				);
				wires.push(
					// Enable to both input gates, which is what makes it the gate on the
					// whole latch rather than an input like any other.
					[enable, Y + 60, x + 220, Y + 60],
					[enable, Y + 200, x + 220, Y + 200],
					// The first gate feeds the second as well as the pair, so an enable of
					// low leaves both of them high and the pair holds what it has.
					[x + 280, Y + 50, x + 320, Y + 50],
					[x + 320, Y + 50, x + 320, Y + 180],
					[x + 220, Y + 180, x + 320, Y + 180],
					[x + 320, Y + 20, x + 320, Y + 50],
					[x + 320, Y + 20, x + 470, Y + 20],
					[x + 280, Y + 190, x + 350, Y + 190],
					[x + 350, Y + 190, x + 350, Y + 200],
					[x + 350, Y + 200, x + 470, Y + 200],
					// Cross-coupled, which is the part that remembers.
					[x + 530, Y + 30, x + 580, Y + 30],
					[x + 580, Y + 30, x + 580, Y + 100],
					[x + 400, Y + 100, x + 580, Y + 100],
					[x + 400, Y + 100, x + 400, Y + 220],
					[x + 400, Y + 220, x + 470, Y + 220],
					[x + 530, Y + 210, x + 610, Y + 210],
					[x + 610, Y + 140, x + 610, Y + 210],
					[x + 440, Y + 140, x + 610, Y + 140],
					[x + 440, Y + 40, x + 440, Y + 140],
					[x + 440, Y + 40, x + 470, Y + 40]
				);
				return { d: x + 220, q: x + 580, qn: x + 610 };
			};

			const master = latch('M', MASTER, MASTER_EN);
			const slave = latch('S', SLAVE, SLAVE_EN);

			wires.push(
				// D into the master, above the enable rail rather than across it.
				[130, 120, 200, 120],
				[200, 120, 200, Y + 40],
				[200, Y + 40, master.d, Y + 40],
				// The clock into the inverter, and on to the slave's rail the long way
				// round, under everything.
				[130, 640, 230, 640],
				[180, 640, 180, 940],
				[180, 940, SLAVE_EN, 940],
				[SLAVE_EN, Y + 60, SLAVE_EN, 940],
				// The inverted clock up to the master's rail.
				[290, 640, MASTER_EN, 640],
				[MASTER_EN, Y + 60, MASTER_EN, 640],
				// The cascade: the master's q is the slave's d, on one straight line.
				[master.q, Y + 30, 980, Y + 30],
				[980, Y + 30, 980, Y + 40],
				[980, Y + 40, slave.d, Y + 40],
				// And the slave's outputs are the flip-flop's, out through the buffers.
				[slave.q, Y + 30, 1710, Y + 30],
				[slave.qn, Y + 210, 1710, Y + 210],
				[1770, Y + 30, 1850, Y + 30],
				[1910, Y + 30, 1950, Y + 30],
				[2010, Y + 30, 2050, Y + 30],
				[1770, Y + 210, 1850, Y + 210],
				[1910, Y + 210, 1950, Y + 210],
				[2010, Y + 210, 2050, Y + 210],
				[2050, Y + 30, 2050, Y + 290]
			);

			return build(parts, wires);
		}
	},

	{
		id: 'flip-flop',
		name: 'D flip-flop',
		description:
			'A latch that only listens on the edge of a clock. Flip the input while it is running and nothing happens until the next rising edge, which is the point of it: everything on the board changes at the same instant instead of whenever its own gates finish. The two lamps are Q and its opposite.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'toggle', name: 'IN', x: 100, y: 120, params: { state: 'high' } },
					{ kind: 'clock', name: 'CLK1', x: 100, y: 220, params: { frequency: 1e6, duty: 0.5 } },
					{ kind: 'dff', name: 'FF1', x: 330, y: 200 },
					{ kind: 'resistor', name: 'R1', x: 470, y: 120, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 570, y: 120, params: { colour: 'green' } },
					{ kind: 'resistor', name: 'R2', x: 470, y: 280, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 570, y: 280, params: { colour: 'red' } },
					{ kind: 'ground', name: 'GND1', x: 640, y: 350 }
				],
				[
					// The level waiting at d, and the clock that decides when it is taken.
					[130, 120, 180, 120],
					[180, 120, 180, 180],
					[180, 180, 300, 180],
					[130, 220, 300, 220],
					// q up and qn down, far enough apart that their readings do not sit on
					// each other.
					[360, 180, 420, 180],
					[420, 120, 420, 180],
					[420, 120, 440, 120],
					[500, 120, 540, 120],
					[600, 120, 640, 120],
					[360, 220, 420, 220],
					[420, 220, 420, 280],
					[420, 280, 440, 280],
					[500, 280, 540, 280],
					[600, 280, 640, 280],
					[640, 120, 640, 340]
				]
			)
	},

	{
		id: 'divider',
		name: 'Clock divider',
		description:
			'A toggle flip-flop halving a clock. Purely digital, so it runs on the event queue with no matrix at all.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'clock', name: 'CLK1', x: 120, y: 220, params: { frequency: 1e6, duty: 0.5 } },
					{ kind: 'dff', name: 'FF1', x: 300, y: 200 }
				],
				[
					// Clock into the flip-flop.
					[150, 220, 270, 220],
					// qn wrapped back around to d, which is what makes it toggle.
					[330, 220, 380, 220],
					[380, 140, 380, 220],
					[240, 140, 380, 140],
					[240, 140, 240, 180],
					[240, 180, 270, 180]
				]
			)
	},

	{
		id: 'ripple-counter',
		name: '4-bit ripple counter',
		description:
			'Four toggle flip-flops in a row, each clocked by the one above it, counting 0 to 15 in binary on the lamps. Ripple, because nothing here shares a clock: each stage waits for the one before it to fall, so the count arrives at the top a few gate delays after it arrives at the bottom and the number is briefly wrong on the way past.',
		stopTime: 40e-6,
		build: () => {
			// Bit 0 on top, halving the clock; each one below halves again.
			const PITCH = 190;
			const parts: Placed[] = [
				{ kind: 'clock', name: 'CLK1', x: 100, y: 160, params: { frequency: 1e6, duty: 0.5 } },
				{ kind: 'ground', name: 'GND1', x: 900, y: 760 }
			];
			const wires: Array<[number, number, number, number]> = [
				// The clock, into the first stage only.
				[130, 160, 270, 160],
				// One return rail for all four lamps.
				[900, 120, 900, 750]
			];

			for (let k = 0; k < 4; k++) {
				const y = 140 + k * PITCH;
				parts.push(
					{ kind: 'dff', name: `FF${k}`, x: 300, y },
					{ kind: 'resistor', name: `R${k}`, x: 730, y: y - 20, params: { resistance: 330 } },
					{ kind: 'led', name: `D${k}`, x: 830, y: y - 20, params: { colour: 'red' } }
				);
				wires.push(
					// qn back around to d, which is what makes a D flip-flop toggle: it is
					// told to become whatever it is not.
					[330, y + 20, 380, y + 20],
					[380, y + 20, 380, y + 80],
					[250, y + 80, 380, y + 80],
					[250, y - 20, 250, y + 80],
					[250, y - 20, 270, y - 20],
					// q out to its lamp, clear of the rail carrying qn back.
					[330, y - 20, 700, y - 20],
					[760, y - 20, 800, y - 20],
					[860, y - 20, 900, y - 20]
				);
				if (k < 3) {
					// And qn on down to clock the next stage. Taken from qn rather than q
					// so the stage above ticks as this one falls, which is what counts up
					// rather than down.
					wires.push(
						[380, y + 80, 380, y + 130],
						[210, y + 130, 380, y + 130],
						[210, y + 130, 210, y + PITCH + 20],
						[210, y + PITCH + 20, 270, y + PITCH + 20]
					);
				}
			}

			return build(parts, wires);
		}
	},

	{
		id: 'switch-bounce',
		name: 'Switch and contact bounce',
		description:
			'A supply, a switch and an RC. The switch closes at two milliseconds and the contacts chatter for one more before they settle — which is why anything counting edges has to be debounced. The 100 kΩ is not decoration: without a path to ground the capacitor would charge through the open switch.',
		stopTime: 10e-3,
		build: () =>
			build(
				[
					{ kind: 'supply', name: 'PWR1', x: 200, y: 100, params: { voltage: 5 } },
					{
						kind: 'switch',
						name: 'S1',
						x: 200,
						y: 170,
						rotation: 90,
						params: { action: 'toggle', start: 'open', at: 2e-3, bounce: 1e-3 }
					},
					{ kind: 'resistor', name: 'R1', x: 200, y: 260, rotation: 90, params: { resistance: 1000 } },
					{
						kind: 'resistor',
						name: 'R2',
						x: 200,
						y: 350,
						rotation: 90,
						params: { resistance: 100000 }
					},
					{ kind: 'capacitor', name: 'C1', x: 320, y: 350, rotation: 90, params: { capacitance: 1e-6 } },
					{ kind: 'probe', name: 'P1', x: 400, y: 290, params: { label: 'out' } },
					{ kind: 'ground', name: 'GND1', x: 200, y: 440 }
				],
				[
					[200, 110, 200, 140],
					[200, 200, 200, 230],
					[200, 290, 200, 320],
					[200, 290, 320, 290],
					[320, 290, 320, 320],
					[320, 290, 400, 290],
					[200, 380, 200, 430],
					[200, 410, 320, 410],
					[320, 380, 320, 410]
				]
			)
	},

	{
		id: 'half-adder',
		name: 'Half adder',
		description:
			'Two bits in, two bits out: the XOR is the sum and the AND is the carry. Half, because it has no way to accept a carry from the column to its right — that is the one thing the full adder adds. Both switches start high, so the sum is zero and the carry is one. Click either to flip it.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					// Logic toggles, not switches. A switch is a contact: it joins a net to
					// something or leaves it joined to nothing, and nothing is not a logic
					// level, so feeding a gate from one needs a resistor holding the input
					// down while the contact is open. These drive the net in both positions.
					{ kind: 'toggle', name: 'A', x: 100, y: 140, params: { state: 'high' } },
					{ kind: 'toggle', name: 'B', x: 100, y: 300, params: { state: 'high' } },
					{ kind: 'xor', name: 'SUM', x: 330, y: 150 },
					{ kind: 'and', name: 'CARRY', x: 330, y: 250 },
					// Each answer ends on a lamp. A gate output has to drive something —
					// a wire trailing off into space is not a load, and the compiler says so
					// — and a lit LED is the reading, without going to the scope for it.
					{ kind: 'resistor', name: 'R1', x: 470, y: 150, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 570, y: 150, params: { colour: 'red' } },
					{ kind: 'resistor', name: 'R2', x: 470, y: 250, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 570, y: 250, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND1', x: 640, y: 320 }
				],
				[
					// A down its own rail, tapped at both gates.
					[130, 140, 170, 140],
					[170, 140, 170, 240],
					[170, 140, 300, 140],
					[170, 240, 300, 240],
					// B likewise, one rail further right. Where the two cross, nothing
					// happens: wires only join where one of them has a corner on the other.
					[130, 300, 200, 300],
					[200, 160, 200, 300],
					[200, 160, 300, 160],
					[200, 260, 300, 260],
					// Sum, then carry, each through its own resistor and lamp.
					[360, 150, 440, 150],
					[500, 150, 540, 150],
					[600, 150, 640, 150],
					[360, 250, 440, 250],
					[500, 250, 540, 250],
					[600, 250, 640, 250],
					// One return rail down to the single ground symbol.
					[640, 150, 640, 310]
				]
			)
	},

	{
		id: 'full-adder',
		name: 'Full adder',
		description:
			'The circuit inside every processor, three gates wide. Sum is the parity of the three inputs, so it is one XOR with three inputs rather than two in a row; the carry is the majority of them. All three switches arrive high — one and one and one is three, which is a one and a carry — and both lamps are lit. Click any of them to work through the other seven combinations.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					// A, B and the carry in, each one set by hand. Logic toggles rather than
					// switches: a switch is a contact, and an open contact leaves a gate input
					// on nothing at all, which is not a logic level and needs a resistor to
					// hold it. These drive the net in both positions.
					{ kind: 'toggle', name: 'A', x: 100, y: 100, params: { state: 'high' } },
					{ kind: 'toggle', name: 'B', x: 100, y: 180, params: { state: 'high' } },
					{ kind: 'toggle', name: 'CIN', x: 100, y: 260, params: { state: 'high' } },
					// Sum. Parity of three, which is one decision and one delay.
					{ kind: 'xor', name: 'U1', x: 330, y: 120, params: { inputs: 3 } },
					// Carry out: any two of the three.
					{ kind: 'and', name: 'U2', x: 330, y: 220 },
					{ kind: 'and', name: 'U3', x: 330, y: 290 },
					{ kind: 'and', name: 'U4', x: 330, y: 360 },
					{ kind: 'or', name: 'U5', x: 470, y: 290, params: { inputs: 3 } },
					// Sum and carry each end on a lamp. A gate output has to drive something:
					// a wire trailing off into space is not a load, and the compiler says so.
					{ kind: 'resistor', name: 'R1', x: 560, y: 120, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 660, y: 120, params: { colour: 'red' } },
					{ kind: 'resistor', name: 'R2', x: 560, y: 290, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 660, y: 290, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND1', x: 730, y: 360 }
				],
				[
					// Three vertical rails down the left, tapped where each gate needs
					// them, and each one stopping at its last tap. Crossing one costs
					// nothing: two wires only join where one of them has a corner on the
					// other.
					[130, 100, 170, 100],
					[170, 100, 170, 350],
					[130, 180, 190, 180],
					[190, 120, 190, 280],
					[130, 260, 210, 260],
					[210, 140, 210, 370],
					// A
					[170, 100, 300, 100],
					[170, 210, 300, 210],
					[170, 350, 300, 350],
					// B
					[190, 120, 300, 120],
					[190, 230, 300, 230],
					[190, 280, 300, 280],
					// Cin
					[210, 140, 300, 140],
					[210, 300, 300, 300],
					[210, 370, 300, 370],
					// The three partial carries into the OR.
					[360, 220, 400, 220],
					[400, 220, 400, 270],
					[400, 270, 440, 270],
					[360, 290, 440, 290],
					[360, 360, 410, 360],
					[410, 310, 410, 360],
					[410, 310, 440, 310],
					// Sum and carry, each through its own resistor and lamp.
					[360, 120, 530, 120],
					[590, 120, 630, 120],
					[690, 120, 730, 120],
					[500, 290, 530, 290],
					[590, 290, 630, 290],
					[690, 290, 730, 290],
					// One return rail down to the single ground symbol.
					[730, 120, 730, 350]
				]
			)
	},

	{
		id: 'adder-4bit',
		name: '4-bit adder',
		description:
			'Four columns of an addition, each handing its carry down to the next. The first column has nothing carried into it, so it is a half adder; the other three are full adders written as propagate and generate. A and B start at 7 and 3, which makes the carry ripple through three stages before it dies — flip any switch on the left and watch where it stops.',
		stopTime: 20e-6,
		build: () => {
			// Bit 0 on top, so the carry runs downwards and every stage looks the same.
			const a = ['high', 'high', 'high', 'low'];
			const b = ['high', 'high', 'low', 'low'];
			/** Vertical distance between one bit and the next. */
			const PITCH = 190;

			const parts: Placed[] = [];
			const wires: Array<[number, number, number, number]> = [];

			/**
			 * One bit of the answer, on a lamp.
			 *
			 * A gate output has to drive something. A wire trailing off into space is
			 * not a load — the compiler says so, and rightly — and five lit or unlit
			 * lamps are the answer read straight off the drawing.
			 */
			const lamp = (bit: number, from: number, y: number) => {
				parts.push(
					{ kind: 'resistor', name: `R${bit}`, x: 730, y, params: { resistance: 330 } },
					{
						kind: 'led',
						name: `D${bit}`,
						x: 830,
						y,
						// The carry out is the fifth bit and a different kind of answer, so it
						// gets a different colour.
						params: { colour: bit === 4 ? 'green' : 'red' }
					}
				);
				wires.push([from, y, 700, y], [760, y, 800, y], [860, y, 900, y]);
			};

			for (let k = 0; k < 4; k++) {
				const y = 120 + k * PITCH;
				parts.push(
					{ kind: 'toggle', name: `A${k}`, x: 100, y: y - 10, params: { state: a[k] } },
					{ kind: 'toggle', name: `B${k}`, x: 100, y: y + 90, params: { state: b[k] } },
					// Propagate and generate: what this column knows on its own, before
					// anything arrives from the one above it.
					{ kind: 'xor', name: `P${k}`, x: 300, y },
					{ kind: 'and', name: `G${k}`, x: 300, y: y + 70 }
				);
				wires.push(
					// A down its own rail, tapped at both gates.
					[130, y - 10, 170, y - 10],
					[170, y - 10, 170, y + 60],
					[170, y - 10, 270, y - 10],
					[170, y + 60, 270, y + 60],
					// B likewise, one rail further right.
					[130, y + 90, 200, y + 90],
					[200, y + 10, 200, y + 90],
					[200, y + 10, 270, y + 10],
					[200, y + 80, 270, y + 80]
				);

				if (k === 0) {
					// Nothing carries into the first column, so P0 is already the sum and G0
					// is already the carry. That is a half adder, and this is the only column
					// where one is enough.
					lamp(0, 330, y);
					wires.push([330, y + 70, 395, y + 70], [395, y + 70, 395, y + PITCH - 10]);
					continue;
				}

				parts.push(
					{ kind: 'xor', name: `S${k}`, x: 450, y: y - 20 },
					{ kind: 'and', name: `PC${k}`, x: 450, y: y + 40 },
					{ kind: 'or', name: `CO${k}`, x: 600, y: y + 50 }
				);
				wires.push(
					// P reaches over the carry rail to the sum and under it to the AND, so
					// the two rails run side by side without ever crossing.
					[330, y, 370, y],
					[370, y - 30, 370, y + 50],
					[370, y - 30, 420, y - 30],
					[370, y + 50, 420, y + 50],
					// The carry that arrived from the bit above.
					[395, y - 10, 395, y + 30],
					[395, y - 10, 420, y - 10],
					[395, y + 30, 420, y + 30],
					// Carry out: either this column generated one, or it propagated the one
					// it was given.
					[480, y + 40, 570, y + 40],
					[330, y + 70, 540, y + 70],
					[540, y + 60, 540, y + 70],
					[540, y + 60, 570, y + 60]
				);
				// Every sum bit ends on the same column, so the answer reads down the
				// right-hand edge in the order it is written.
				lamp(k, 480, y - 20);

				if (k < 3) {
					// Down the right and back to the next bit's carry rail.
					wires.push(
						[630, y + 50, 660, y + 50],
						[660, y + 50, 660, y + 130],
						[395, y + 130, 660, y + 130],
						[395, y + 130, 395, y + PITCH - 10]
					);
				} else {
					// The carry out of the last column is the fifth bit of the answer,
					// dropped clear of the sum above it so the two readings do not overlap.
					wires.push([630, y + 50, 660, y + 50], [660, y + 50, 660, y + 120]);
					lamp(4, 660, y + 120);
				}
			}

			// One return rail for all five lamps, and one ground symbol on it.
			parts.push({ kind: 'ground', name: 'GND1', x: 900, y: 860 });
			wires.push([900, 120, 900, 850]);

			return build(parts, wires);
		}
	},

	{
		id: 'voltage-divider',
		name: 'Voltage divider',
		description:
			'Two resistors and nothing else. 12 V across 2 kΩ and 1 kΩ puts exactly 4 V on the join — the simplest circuit whose answer you can check in your head.',
		stopTime: 1e-3,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'V1', x: 100, y: 200, params: { waveform: 'dc', value: 12 } },
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 2000 } },
					{
						kind: 'resistor',
						name: 'R2',
						x: 350,
						y: 230,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'rc-highpass',
		name: 'RC high-pass',
		description:
			'The low-pass turned around: the capacitor is in the way, so an edge gets through and a steady level does not. The output jumps with each transition and decays over one RC.',
		stopTime: 5e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 500, duty: 0.5 }
					},
					{ kind: 'capacitor', name: 'C1', x: 250, y: 170, params: { capacitance: 1e-6 } },
					{
						kind: 'resistor',
						name: 'R1',
						x: 350,
						y: 230,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'rl-step',
		name: 'RL step',
		description:
			'Current through an inductor cannot change instantly. It climbs towards V/R along an exponential of time constant L/R — 100 µs here, against a 250 µs half-period, so it very nearly gets there.',
		stopTime: 1e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 2000, duty: 0.5 }
					},
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 100 } },
					{
						kind: 'inductor',
						name: 'L1',
						x: 350,
						y: 230,
						rotation: 90,
						params: { inductance: 10e-3 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'diode-clipper',
		name: 'Diode clipper',
		description:
			'Two diodes back to back across the output. Anything past a forward drop in either direction finds a path to ground, so a 5 V sine comes out flattened at about ±0.7 V.',
		stopTime: 3e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 5, offset: 0, frequency: 1000 }
					},
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 1000 } },
					{ kind: 'diode', name: 'D1', x: 350, y: 230, rotation: 90 },
					// Turned the other way, so the pair covers both halves of the swing.
					{ kind: 'diode', name: 'D2', x: 430, y: 230, rotation: 270 },
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 430, 170],
					[350, 170, 350, 200],
					[430, 170, 430, 200],
					[350, 260, 350, 290],
					[430, 260, 430, 290],
					[100, 290, 430, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'zener-shunt',
		name: 'Zener regulator',
		description:
			'A zener across the load, cathode to the positive side, fed through a resistor. Past its breakdown voltage it conducts backwards and pins the rail there, however the supply wanders above it.',
		stopTime: 2e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 3, offset: 12, frequency: 1000 }
					},
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 470 } },
					{
						kind: 'diode',
						name: 'D1',
						x: 350,
						y: 230,
						rotation: 270,
						params: { model: 'zener', breakdown: 5.1 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'opamp-inverting',
		name: 'Inverting amplifier',
		description:
			'The feedback resistor over the input resistor sets the gain and nothing else does: 47 kΩ over 10 kΩ is −4.7, upside down. The op-amp only has to be good enough to hold its two inputs together.',
		stopTime: 3e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 240,
						params: { waveform: 'sine', value: 0.5, offset: 0, frequency: 1000 }
					},
					{ kind: 'resistor', name: 'RIN', x: 250, y: 210, params: { resistance: 10000 } },
					{ kind: 'resistor', name: 'RF', x: 400, y: 100, params: { resistance: 47000 } },
					{ kind: 'opamp', name: 'U1', x: 400, y: 200 },
					{ kind: 'ground', name: 'GND1', x: 100, y: 340 },
					{ kind: 'ground', name: 'GND2', x: 320, y: 200 }
				],
				[
					[100, 210, 220, 210],
					[280, 210, 330, 210],
					[330, 210, 370, 210],
					[330, 100, 330, 210],
					[330, 100, 370, 100],
					[430, 100, 470, 100],
					[470, 100, 470, 200],
					[430, 200, 470, 200],
					[320, 190, 370, 190],
					[100, 270, 100, 330]
				]
			)
	},

	{
		id: 'emitter-follower',
		name: 'Emitter follower',
		description:
			'No voltage gain at all — the emitter sits a diode drop below the base and copies whatever it does. What it buys is current: a stiff output from a source that could not have driven the load itself.',
		stopTime: 3e-3,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'VCC', x: 120, y: 150, params: { waveform: 'dc', value: 10 } },
					{
						kind: 'vsource',
						name: 'V1',
						x: 200,
						y: 330,
						params: { waveform: 'sine', value: 2, offset: 5, frequency: 1000 }
					},
					{ kind: 'npn', name: 'Q1', x: 400, y: 250 },
					{
						kind: 'resistor',
						name: 'RE',
						x: 410,
						y: 340,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 120, y: 410 }
				],
				[
					[120, 120, 410, 120],
					[410, 120, 410, 220],
					[200, 300, 370, 300],
					[370, 250, 370, 300],
					[410, 280, 410, 310],
					[410, 370, 410, 400],
					[120, 400, 410, 400],
					[120, 180, 120, 400],
					[200, 360, 200, 400]
				]
			)
	},

	{
		id: 'cmos-inverter',
		name: 'CMOS inverter',
		description:
			'One MOSFET of each kind, gates tied together. Whichever way the input goes one device is on and the other is off, so the output reaches both rails and neither transistor passes any current once it has settled. Watch the spike on each edge: the gate is coupled to the drain through its own capacitance, and with nothing loading the output that charge pushes it past the supply until the body diodes catch it.',
		stopTime: 4e-4,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'VDD', x: 120, y: 150, params: { waveform: 'dc', value: 5 } },
					{
						kind: 'vsource',
						name: 'V1',
						x: 200,
						y: 330,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 10000, duty: 0.5 }
					},
					{ kind: 'pmos', name: 'M1', x: 400, y: 180 },
					{ kind: 'nmos', name: 'M2', x: 400, y: 320 },
					{ kind: 'ground', name: 'GND1', x: 120, y: 410 }
				],
				[
					[120, 120, 410, 120],
					[410, 120, 410, 150],
					[410, 210, 410, 290],
					[410, 350, 410, 400],
					[120, 400, 410, 400],
					[120, 180, 120, 400],
					[200, 360, 200, 400],
					[200, 300, 300, 300],
					[300, 180, 300, 320],
					[300, 180, 370, 180],
					[300, 320, 370, 320]
				]
			)
	}
];

export function exampleById(id: string): Example {
	return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
}
