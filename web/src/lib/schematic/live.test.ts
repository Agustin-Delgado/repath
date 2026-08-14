/**
 * What the screen actually shows, end to end: draw, compile, simulate, animate.
 *
 * Every other suite in this directory stops at the netlist — it checks that the
 * compiler emitted a `switch` with the right fields and calls that the switch
 * working. It is not. Between the netlist and the picture there is the engine,
 * and then there is `prepareFlow`, which decides which wires have current in
 * them; a component the flow planner has never heard of compiles perfectly,
 * simulates correctly and draws no current at all. Nothing above this file could
 * see that, which is why it shipped.
 *
 * So these tests assert on the three things a person looks at: the voltage on a
 * net, the current in each leg of wire, and the current through each part.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Simulation } from '../wasm/repath.js';
import { LiveRun } from '$lib/engine';
import { Capture } from '$lib/capture';
import { compileSchematic } from './netlist';
import { isFlowing } from './animate';
import { prepareFlow, sampleFlow, sampleIndexAt, type FlowFrame } from './flow';
import {
	defaultParams,
	pointKey,
	type Instance,
	type Rotation,
	type Schematic
} from './model';
import type { TransientRun } from '$lib/engine';

/**
 * The engine, booted from bytes rather than fetched.
 *
 * `init()` on its own goes looking for a URL, which works in a browser and not
 * here. Handing it the file is all it takes to make the real engine testable
 * outside one — and the alternative, a hand-written stand-in, would agree with
 * whatever this file assumed and prove nothing.
 */
beforeAll(async () => {
	const wasm = fileURLToPath(new URL('../wasm/repath_bg.wasm', import.meta.url));
	await init({ module_or_path: readFileSync(wasm) });
});

let counter = 0;

function at(kind: string, name: string, x: number, y: number, rotation: Rotation = 0): Instance {
	return { id: `i${++counter}`, kind, name, x, y, rotation, params: defaultParams(kind) };
}

function drawing(instances: Instance[], runs: Array<[number, number, number, number]>): Schematic {
	return {
		instances,
		wires: runs.map(([x1, y1, x2, y2]) => ({
			id: `w${++counter}`,
			points: [
				{ x: x1, y: y1 },
				{ x: x2, y: y2 }
			]
		}))
	};
}

/** Run a drawing the way the app does, and read the frame at `time`. */
function simulate(schematic: Schematic, stop = 1e-3, time = stop) {
	const compiled = compileSchematic(schematic);
	expect(compiled.errors).toEqual([]);

	const simulation = new Simulation(JSON.stringify(compiled.netlist));
	let run: TransientRun;
	try {
		const meta = JSON.parse(simulation.runTransient(stop, stop / 400)) as {
			unknown_names: string[];
			node_count: number;
			element_names: string[];
			net_names: string[];
			digital: Array<Array<{ time: number; state: string }>>;
		};
		const signals = new Map<string, Float64Array>();
		const signalsByIndex = meta.unknown_names.map((name, index) => {
			const samples = simulation.signal(index);
			signals.set(name, samples);
			return samples;
		});
		run = {
			time: simulation.time(),
			signals,
			signalsByIndex,
			unknownNames: meta.unknown_names,
			nodeCount: meta.node_count,
			elementNames: meta.element_names,
			currents: meta.element_names.map((_, index) => simulation.current(index)),
			netNames: meta.net_names,
			digital: meta.digital as TransientRun['digital'],
			failures: [],
			stats: { accepted_steps: 0, rejected_steps: 0, newton_iterations: 0, digital_events: 0 },
			elapsedMs: 0
		};
	} finally {
		simulation.free();
	}

	const context = prepareFlow(schematic, compiled.connectivity, compiled.names, run);
	const frame = sampleFlow(context, sampleIndexAt(run.time, time));
	return { compiled, run, context, frame };
}

/** What the drawing shows on the wire through a point, in amps. */
function currentAt(schematic: Schematic, frame: FlowFrame, x: number, y: number): number {
	const key = pointKey(x, y);
	for (const wire of schematic.wires) {
		for (let i = 0; i < wire.points.length - 1; i++) {
			const a = wire.points[i];
			const b = wire.points[i + 1];
			if (pointKey(a.x, a.y) !== key && pointKey(b.x, b.y) !== key) continue;
			return Math.abs(frame.wireCurrent.get(`${wire.id}#${i}`) ?? 0);
		}
	}
	throw new Error(`no wire through ${key}`);
}

/** Volts on the net through a point. */
function voltsAt(
	schematic: Schematic,
	compiled: ReturnType<typeof compileSchematic>,
	frame: FlowFrame,
	x: number,
	y: number
): number {
	const net = compiled.connectivity.netOfPoint.get(pointKey(x, y));
	if (net === undefined) throw new Error(`nothing at ${x},${y}`);
	return frame.netVoltage.get(net) ?? 0;
}

/**
 * The circuit anybody draws first: a supply, a switch, a resistor, a ground.
 *
 * Every wire in it carries the same current, because it is one series loop. That
 * is the whole assertion — not that the netlist mentions a switch, but that the
 * current the drawing shows is the current flowing.
 */
function lamp(start: 'open' | 'closed'): Schematic {
	const supply = at('supply', 'PWR1', 100, 190);
	const s1 = at('switch', 'S1', 200, 200);
	s1.params.start = start;
	return drawing(
		[supply, s1, at('resistor', 'R1', 320, 200), at('ground', 'GND1', 420, 210)],
		[
			[100, 200, 170, 200],
			[230, 200, 290, 200],
			[350, 200, 420, 200]
		]
	);
}

describe('a switch in a series loop', () => {
	it('puts the same current in every leg of wire when it is closed', () => {
		const schematic = lamp('closed');
		const { compiled, frame } = simulate(schematic);

		// 5 V across 1 kΩ, give or take the contact.
		const expected = 5 / 1000.05;
		expect(frame.instanceCurrent.get(schematic.instances[2].id)).toBeCloseTo(expected, 6);

		// One loop, so all three legs carry it: the one feeding the switch, the one
		// between switch and resistor, and the return. A leg reading zero in a
		// circuit that is passing 5 mA is the animation saying nothing flows here.
		expect(currentAt(schematic, frame, 100, 200)).toBeCloseTo(expected, 6);
		expect(currentAt(schematic, frame, 230, 200)).toBeCloseTo(expected, 6);
		expect(currentAt(schematic, frame, 350, 200)).toBeCloseTo(expected, 6);

		// And the supply is at its voltage, with the closed contact dropping ~nothing.
		expect(voltsAt(schematic, compiled, frame, 100, 200)).toBeCloseTo(5, 6);
		expect(voltsAt(schematic, compiled, frame, 290, 200)).toBeCloseTo(5, 3);
	});

	it('stops the current, and the node it feeds, when it is open', () => {
		const schematic = lamp('open');
		const { compiled, frame } = simulate(schematic);

		expect(currentAt(schematic, frame, 100, 200)).toBeLessThan(1e-6);
		expect(currentAt(schematic, frame, 350, 200)).toBeLessThan(1e-6);

		// The far side is pulled to ground by the resistor. Reading 5 V here is the
		// complaint that started this: an open switch that looks closed.
		expect(voltsAt(schematic, compiled, frame, 290, 200)).toBeLessThan(0.01);
		expect(voltsAt(schematic, compiled, frame, 100, 200)).toBeCloseTo(5, 6);
	});

	it('does not animate its own leakage as a flow when it is open', () => {
		// Everything about the animation is relative to the biggest current in the
		// run, and in a circuit that never conducts the biggest current is the
		// leakage through the open contact. Normalised to itself, that drew dots at
		// full speed through a switch nobody had closed.
		const dark = lamp('open');
		const open = simulate(dark);
		expect(isFlowing(currentAt(dark, open.frame, 100, 200), open.context.currentScale)).toBe(false);

		// And the working circuit is unaffected: 5 mA is still a flow.
		const lit = lamp('closed');
		const closed = simulate(lit);
		expect(isFlowing(currentAt(lit, closed.frame, 100, 200), closed.context.currentScale)).toBe(
			true
		);
	});

	it('shows the current through the switch itself, not only around it', () => {
		const schematic = lamp('closed');
		const { context, frame } = simulate(schematic);
		const s1 = schematic.instances[1];

		// Without this the dots stop at one blade and start again at the other.
		expect(context.instanceFlow.get(s1.id)).toEqual({ from: 'a', to: 'b' });
		expect(frame.instanceCurrent.get(s1.id) ?? 0).toBeCloseTo(5 / 1000.05, 6);
	});
});

describe('a supply terminal', () => {
	it('carries the loop current like the source it is', () => {
		const schematic = lamp('closed');
		const { context, frame } = simulate(schematic);
		const pwr = schematic.instances[0];

		expect(context.instanceElement.has(pwr.id)).toBe(true);
		expect(Math.abs(frame.instanceCurrent.get(pwr.id) ?? 0)).toBeCloseTo(5 / 1000.05, 6);
	});
});

/**
 * A switch feeding a logic input, with a pull-down holding it low when the
 * switch is open. This is the correct way to wire a button to a gate, and it has
 * to work: the reading on the gate's input net must follow the contact.
 */
function button(start: 'open' | 'closed'): Schematic {
	const s1 = at('switch', 'S1', 200, 200);
	s1.params.start = start;
	const pulldown = at('resistor', 'R1', 300, 300, 90);
	pulldown.params.resistance = 10000;
	return drawing(
		[at('supply', 'PWR1', 100, 190), s1, pulldown, at('not', 'U1', 400, 200), at('ground', 'GND1', 300, 340)],
		[
			[100, 200, 170, 200],
			[230, 200, 370, 200],
			[300, 200, 300, 270]
		]
	);
}

describe('a button on a gate input', () => {
	it('is not called floating when a pull-down holds it', () => {
		const { compiled } = simulate(button('open'));
		expect(compiled.warnings.filter((w) => w.includes('no path to either rail'))).toEqual([]);
		expect(compiled.floatingAt(new Set()).size).toBe(0);
	});

	it('reads low with the switch open and high with it closed', () => {
		const open = button('open');
		const closed = button('closed');

		const low = simulate(open);
		expect(voltsAt(open, low.compiled, low.frame, 370, 200)).toBeLessThan(0.5);

		const high = simulate(closed);
		expect(voltsAt(closed, high.compiled, high.frame, 370, 200)).toBeGreaterThan(4.5);
	});

	it('still drives the gate when there is no pull-down and the button is pressed', () => {
		// The reported circuit, and the one the old compile-time verdict killed: no
		// pull-down, so the input floats *while the switch is open*. That is a real
		// complaint and it gets a warning — but it is not a reason to leave the gate
		// unbridged, because then closing the contact changes nothing either.
		const schematic = drawing(
			[
				at('supply', 'PWR1', 100, 190),
				(() => {
					const s = at('switch', 'S2', 200, 200);
					s.params.start = 'closed';
					return s;
				})(),
				at('not', 'U2', 400, 200),
				at('ground', 'GND2', 600, 210)
			],
			[
				[100, 200, 170, 200],
				[230, 200, 370, 200]
			]
		);
		const { compiled, run, frame } = simulate(schematic);

		expect(compiled.warnings.some((w) => w.includes('while a switch is closed'))).toBe(true);
		expect(voltsAt(schematic, compiled, frame, 370, 200)).toBeGreaterThan(4.5);
		expect((run.digital.at(-1) ?? []).at(-1)?.state).toBe('low');

		// And the node is reported as held while the contact is, rather than being
		// labelled "floating" over five volts.
		const s2 = schematic.instances[1];
		expect(compiled.floatingAt(new Set([s2.id]))).toEqual(new Set());
		expect(compiled.floatingAt(new Set()).size).toBe(1);
	});

	it('inverts what the button does, which is what the gate is for', () => {
		for (const [start, expected] of [
			['open', 'high'],
			['closed', 'low']
		] as const) {
			const schematic = button(start);
			const { run } = simulate(schematic);
			const transitions = run.digital.at(-1) ?? [];
			expect(transitions.at(-1)?.state, `U1 output with the switch ${start}`).toBe(expected);
		}
	});
});

/**
 * The logic toggle: the part that exists so the pull-down does not have to.
 *
 * A switch answers "what does this circuit do when the contact opens", which is
 * a question about a contact. A toggle answers "what does this circuit do with A
 * high and B low", which is a question about the logic — and for that a rail, a
 * contact and a resistor are three parts standing in for one.
 */
describe('a logic toggle', () => {
	function gated(a: 'low' | 'high', b: 'low' | 'high'): Schematic {
		const t1 = at('toggle', 'T1', 200, 190);
		const t2 = at('toggle', 'T2', 200, 290);
		t1.params.state = a;
		t2.params.state = b;
		return drawing(
			[t1, t2, at('and', 'U1', 400, 240)],
			[
				[230, 190, 370, 190],
				[370, 190, 370, 230],
				[230, 290, 370, 290],
				[370, 290, 370, 250]
			]
		);
	}

	it('drives its net in both positions, so nothing has to pull it', () => {
		for (const state of ['low', 'high'] as const) {
			const compiled = compileSchematic(gated(state, state));
			expect(compiled.errors).toEqual([]);
			// No rail, no ground symbol, no pull-down — and no complaint, because
			// there is no instant at which anything is left adrift.
			expect(compiled.warnings.filter((w) => w.includes('pull-down'))).toEqual([]);
			expect(compiled.floatingAt(new Set()).size).toBe(0);
		}
	});

	it('needs no analog side at all', () => {
		// The whole reason the resistor was needed is that a switch drags the net
		// into the analog domain, where a node with no path to anywhere has no
		// voltage. This never leaves the digital domain: no nodes, no bridges.
		const netlist = compileSchematic(gated('high', 'low')).netlist as {
			components: unknown[];
			bridges: unknown[];
			devices: Array<Record<string, unknown>>;
		};
		expect(netlist.components).toEqual([]);
		expect(netlist.bridges).toEqual([]);
		expect(netlist.devices.filter((d) => d.type === 'logic_source')).toHaveLength(2);
	});

	it('feeds the gate the level it is set to', () => {
		for (const [a, b, expected] of [
			['low', 'low', 'low'],
			['high', 'low', 'low'],
			['low', 'high', 'low'],
			['high', 'high', 'high']
		] as const) {
			const { run } = simulate(gated(a, b));
			const out = (run.digital.at(-1) ?? []).at(-1)?.state;
			expect(out, `AND with ${a} and ${b}`).toBe(expected);
		}
	});

	it('holds its level for the whole run rather than only at the start', () => {
		const schematic = gated('high', 'high');
		const { compiled, run } = simulate(schematic, 1e-3);

		// T1's own net, by name, rather than whichever one happens to be last.
		const net = compiled.connectivity.netOfPin.get(`${schematic.instances[0].id}:y`)!;
		const label = compiled.names.get(net)!.digital!;
		const transitions = run.digital[run.netNames.indexOf(label)] ?? [];

		// It settles once and stays. A source that re-triggered itself — the way a
		// clock does, by listening to its own output — would fill the run with
		// events all saying the same thing.
		expect(transitions.at(-1)?.state).toBe('high');
		expect(transitions.filter((t) => t.state === 'high')).toHaveLength(1);
		expect(transitions.length).toBeLessThan(3);
	});

	it('shows the level on the drawing, in the volts the family puts out', () => {
		// The complaint that started this: a logic net has no node, so the drawing
		// had no voltage for it — no colour, no reading, and no visible difference
		// between a one and a zero on a wire somebody had just clicked.
		const schematic = gated('high', 'low');
		const { compiled, frame } = simulate(schematic, 1e-3);
		expect(voltsAt(schematic, compiled, frame, 230, 190)).toBeCloseTo(5, 6);
		expect(voltsAt(schematic, compiled, frame, 230, 290)).toBeCloseTo(0, 6);
		expect(frame.netUndriven.size).toBe(0);
	});

	it('steps at the moment it was operated, with the run carrying on through it', () => {
		// The whole model, end to end: the run is going, somebody moves a toggle
		// partway through, and the engine carries on from where it was. Everything
		// solved before the click keeps whatever it had — nothing is recomputed —
		// and the edge lands at the instant of the click rather than at zero.
		const schematic = gated('low', 'high');
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);

		const live = new LiveRun(compiled.netlist, 5e-6);
		const capture = new Capture(
			live.unknownNames,
			live.elementNames,
			live.netNames,
			live.nodeCount
		);
		capture.add(live.first);
		capture.add(live.advance(4e-4));
		expect(live.setLogic('T1', 'high', live.time)).toBe(true);
		capture.add(live.advance(1e-3));
		live.free();

		const run = capture.run();
		const context = prepareFlow(schematic, compiled.connectivity, compiled.names, run);
		const at = (t: number) => sampleFlow(context, sampleIndexAt(run.time, t));
		expect(voltsAt(schematic, compiled, at(2e-4), 230, 190)).toBeCloseTo(0, 6);
		expect(voltsAt(schematic, compiled, at(8e-4), 230, 190)).toBeCloseTo(5, 6);

		// And the gate followed it, which is the answer the click was asking for.
		const out = compiled.connectivity.netOfPin.get(`${schematic.instances[2].id}:y`)!;
		const label = compiled.names.get(out)!.digital!;
		const transitions = run.digital[run.netNames.indexOf(label)] ?? [];
		const stateAt = (t: number) => transitions.filter((event) => event.time <= t).at(-1)?.state;
		expect(stateAt(2e-4)).toBe('low');
		expect(stateAt(8e-4)).toBe('high');
		expect(transitions.some((t) => t.time > 3e-4 && t.time < 5e-4)).toBe(true);
	});

	it('keeps the samples it had, so the past is not re-solved', () => {
		// A recording would have been rewritten from zero by that click. This is the
		// evidence it was not: the timepoints before the operation are the same
		// numbers, sample for sample, as a run nobody touched.
		const schematic = gated('low', 'high');
		const compiled = compileSchematic(schematic);

		const sweep = (operate: boolean) => {
			const live = new LiveRun(compiled.netlist, 5e-6);
			const capture = new Capture(
				live.unknownNames,
				live.elementNames,
				live.netNames,
				live.nodeCount
			);
			capture.add(live.first);
			capture.add(live.advance(4e-4));
			if (operate) live.setLogic('T1', 'high', live.time);
			capture.add(live.advance(1e-3));
			live.free();
			return capture.run();
		};

		const untouched = sweep(false);
		const operated = sweep(true);
		const upto = Array.from(untouched.time).filter((t) => t <= 4e-4).length;
		expect(upto).toBeGreaterThan(10);
		for (let i = 0; i < upto; i++) {
			expect(operated.time[i]).toBeCloseTo(untouched.time[i], 12);
		}
	});
});
