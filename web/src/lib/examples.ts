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
		wires: wires.map(([x1, y1, x2, y2]) => ({ id: nextId(), x1, y1, x2, y2 }))
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
						x: 340,
						y: 150,
						rotation: 90,
						params: { resistance: 470000 }
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
	}
];

export function exampleById(id: string): Example {
	return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
}
