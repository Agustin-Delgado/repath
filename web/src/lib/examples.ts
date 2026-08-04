/**
 * Circuits that ship with the app.
 *
 * The first thing a simulator has to do is show you something working. An empty
 * canvas asks you to already know how to use it.
 */

import type { Schematic } from './schematic/model';
import { defaultParams } from './schematic/model';

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
					[240, 180, 270, 180],
					// q brought out somewhere easy to probe.
					[330, 180, 420, 180]
				]
			)
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
			'One MOSFET of each kind, gates tied together. Whichever way the input goes one device is on and the other is off, so the output reaches both rails and neither transistor passes any current once it has settled.',
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
