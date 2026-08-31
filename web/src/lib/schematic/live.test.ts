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
import { EXAMPLES } from '../examples';
import { compileSchematic } from './netlist';
import { isFlowing } from './animate';
import { prepareFlow, sampleFlow, sampleIndexAt, type FlowFrame } from './flow';
import {
	defaultParams,
	registerSubcircuits,
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

	const context = prepareFlow(
		schematic,
		compiled.connectivity,
		compiled.names,
		run,
		undefined,
		compiled.portFlow
	);
	const frame = sampleFlow(context, run, sampleIndexAt(run.time, time));
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

	it('reads the transitions of the run it is handed, not the one it was planned on', () => {
		// A live run hands over a fresh snapshot on every acquired chunk, and the
		// context is planned once because the topology does not change mid-run. It
		// used to keep the transition lists it was planned with — which, at the moment
		// a run starts, are the seed at t = 0 and nothing else. So a clock wire sat at
		// the level it began on for the whole sweep and every driven net read as
		// high-impedance, while the scope beside it drew those very nets switching.
		// Analog never showed it: those samples come from the run passed in per frame,
		// which is exactly what this now does too.
		const clock = at('clock', 'CLK1', 120, 220);
		clock.params = { frequency: 1e6, duty: 0.5 };
		const schematic = drawing([clock], [[150, 220, 260, 220]]);
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);

		const live = new LiveRun(compiled.netlist, 5e-8);
		const capture = () =>
			new Capture(live.unknownNames, live.elementNames, live.netNames, live.nodeCount);
		const planned = capture();
		const carried = capture();
		const seed = live.first;
		planned.add(seed);
		carried.add(seed);
		carried.add(live.advance(4e-6));
		live.free();

		// Planned on the snapshot that has only the seed, sampled against the one that
		// has the whole sweep — the situation every live run is in.
		const context = prepareFlow(
			schematic,
			compiled.connectivity,
			compiled.names,
			planned.run(),
			undefined,
			compiled.portFlow
		);
		const run = carried.run();
		const net = compiled.connectivity.netOfPin.get(`${clock.id}:out`)!;

		const levels = new Set<number>();
		for (let t = 0; t <= 4e-6; t += 1e-7) {
			const frame = sampleFlow(context, run, sampleIndexAt(run.time, t));
			const volts = frame.netVoltage.get(net);
			if (volts !== undefined) levels.add(volts);
			expect(frame.netUndriven.has(net)).toBe(false);
		}
		// Four microseconds of a one megahertz clock: both levels, several times.
		expect([...levels].sort((a, b) => a - b)).toEqual([0, 5]);
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
		const context = prepareFlow(
		schematic,
		compiled.connectivity,
		compiled.names,
		run,
		undefined,
		compiled.portFlow
	);
		const at = (t: number) => sampleFlow(context, run, sampleIndexAt(run.time, t));
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

	it('clocks the D flip-flop example on the edge and not before it', () => {
		// The level is sitting on d from the first instant, and the flip-flop is
		// supposed to ignore it until the clock says so. Its own answer starts low,
		// deliberately — an unknown there could never resolve, because a toggle
		// flip-flop feeds qn back into d and the inverse of unknown is unknown.
		const schematic = EXAMPLES.find((e) => e.id === 'flip-flop')!.build();
		const { compiled, run } = simulate(schematic, 20e-6);
		const ff = schematic.instances.find((i) => i.name === 'FF1')!;
		const series = (pin: string) => {
			const net = compiled.connectivity.netOfPin.get(`${ff.id}:${pin}`)!;
			const label = compiled.names.get(net)!.digital!;
			return run.digital[run.netNames.indexOf(label)] ?? [];
		};
		const level = (pin: string, time: number) =>
			series(pin)
				.filter((event) => event.time <= time)
				.at(-1)?.state;

		// The clock is 1 MHz starting low, so its first rising edge is at half a
		// microsecond. Before it, low; after it, whatever d was holding.
		expect(level('q', 4e-7)).toBe('low');
		expect(level('q', 6e-7)).toBe('high');
		// And the two outputs are opposites at every instant, which is what the two
		// lamps are there to show.
		for (const t of [4e-7, 6e-7, 5e-6, 19e-6]) {
			expect(level('qn', t)).toBe(level('q', t) === 'high' ? 'low' : 'high');
		}
	});

	it('counts the ripple counter example from 0 to 15 and wraps', () => {
		// Four stages, each clocked by the one above rather than by the clock, so
		// this is as much a test of the chain as of the count: take qn to the next
		// stage and it counts up, take q and it counts down.
		const schematic = EXAMPLES.find((e) => e.id === 'ripple-counter')!.build();
		const { compiled, run } = simulate(schematic, 40e-6);
		const level = (name: string, time: number) => {
			const part = schematic.instances.find((i) => i.name === name)!;
			const net = compiled.connectivity.netOfPin.get(`${part.id}:q`)!;
			const label = compiled.names.get(net)!.digital!;
			const events = run.digital[run.netNames.indexOf(label)] ?? [];
			return events.filter((event) => event.time <= time).at(-1)?.state === 'high' ? 1 : 0;
		};

		// Read midway through each clock period, well clear of the ripple: the count
		// is briefly wrong while it travels up the chain, which is the whole point of
		// the name and not something to assert against.
		const counted: number[] = [];
		for (let n = 0; n < 17; n++) {
			const t = n * 1e-6 + 6e-7;
			counted.push(
				level('FF0', t) + 2 * level('FF1', t) + 4 * level('FF2', t) + 8 * level('FF3', t)
			);
		}
		expect(counted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);
	});

	it('lets the level-triggered latch through while it is enabled, and not after', () => {
		// The whole of the difference between a latch and a flip-flop, in one run:
		// while enable is high the output is D, and the instant enable goes low the
		// output stops being D and starts being what D was.
		const schematic = EXAMPLES.find((e) => e.id === 'd-latch')!.build();
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);

		const live = new LiveRun(compiled.netlist, 1e-8);
		const capture = new Capture(
			live.unknownNames,
			live.elementNames,
			live.netNames,
			live.nodeCount
		);
		// `advance` takes the time to run to, not a step to take.
		capture.add(live.first);
		capture.add(live.advance(1e-6));
		// Caught with enable still high, so it follows.
		expect(live.setLogic('D', 'low', live.time)).toBe(true);
		capture.add(live.advance(2e-6));
		// Shut, then D moves under it: this is the part that must not get through.
		expect(live.setLogic('EN', 'low', live.time)).toBe(true);
		capture.add(live.advance(3e-6));
		expect(live.setLogic('D', 'high', live.time)).toBe(true);
		capture.add(live.advance(4e-6));
		live.free();

		const run = capture.run();
		const level = (name: string, time: number) => {
			const part = schematic.instances.find((i) => i.name === name)!;
			const net = compiled.connectivity.netOfPin.get(`${part.id}:y`)!;
			const label = compiled.names.get(net)!.digital!;
			const events = run.digital[run.netNames.indexOf(label)] ?? [];
			return events.filter((event) => event.time <= time).at(-1)?.state;
		};

		expect(level('Q', 0.5e-6)).toBe('high');
		expect(level('Q', 1.5e-6)).toBe('low');
		// Enable is down and D has gone back up. The output must not have.
		expect(level('Q', 3.5e-6)).toBe('low');
		// And the pair is a pair at every instant, never both the same.
		for (const t of [0.5e-6, 1.5e-6, 3.5e-6]) {
			expect(level('QN', t)).toBe(level('Q', t) === 'high' ? 'low' : 'high');
		}
	});

	it('makes the edge-triggered pair wait for the edge', () => {
		// Two latches on opposite halves of the clock. The reason it is worth
		// drawing rather than reaching for the flip-flop part is that the edge is
		// not a feature of anything here: it falls out of the two never being
		// transparent at the same time.
		const schematic = EXAMPLES.find((e) => e.id === 'master-slave')!.build();
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);
		const { run } = simulate(schematic, 20e-6);

		const level = (name: string, time: number) => {
			const part = schematic.instances.find((i) => i.name === name)!;
			const net = compiled.connectivity.netOfPin.get(`${part.id}:y`)!;
			const label = compiled.names.get(net)!.digital!;
			const events = run.digital[run.netNames.indexOf(label)] ?? [];
			return events.filter((event) => event.time <= time).at(-1)?.state;
		};

		// D is high throughout and the clock is 1 MHz starting low, so the first
		// rising edge is at half a microsecond and the answer arrives a few gate
		// delays later.
		expect(level('SQ', 4e-7)).not.toBe('high');
		expect(level('SQ', 6e-7)).toBe('high');
		expect(level('SN', 6e-7)).toBe('low');

		// The master is the half that is allowed to be transparent, and only while
		// the clock is low. Between the edge and the next one, the output holds.
		const events = (name: string) => {
			const part = schematic.instances.find((i) => i.name === name)!;
			const net = compiled.connectivity.netOfPin.get(`${part.id}:y`)!;
			const label = compiled.names.get(net)!.digital!;
			return run.digital[run.netNames.indexOf(label)] ?? [];
		};
		// Settled by the first edge and never moving again: with D held high there
		// is nothing for later edges to change.
		expect(events('SQ').filter((event) => event.time > 1e-6)).toEqual([]);
	});

	it('never mixes the circuit before a change with the one after it', () => {
		// Reported from the half adder: flip an input while it is running, wait, and
		// for about a second both lamps sit at half brightness. A frame spans a
		// stretch of simulated time and its currents are the mean over it, so a frame
		// straddling the transition carried a share of the old circuit and a share of
		// the new one — 4.9 mA through one lamp and 3.0 mA through the other, adding
		// up to exactly one lit lamp, in a circuit that only ever solved for one or
		// the other. On a live run the playhead advances in steps far longer than a
		// frame, so that reading is held until it moves again.
		const schematic = EXAMPLES.find((e) => e.id === 'half-adder')!.build();
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);

		const live = new LiveRun(compiled.netlist, 1e-8);
		const capture = new Capture(
			live.unknownNames,
			live.elementNames,
			live.netNames,
			live.nodeCount
		);
		capture.add(live.first);
		// Operated partway through a frame rather than on its edge, which is where
		// the mean has both circuits to mix.
		capture.add(live.advance(1.12e-6));
		expect(live.setLogic('A', 'low', live.time)).toBe(true);
		capture.add(live.advance(3e-6));
		live.free();

		const run = capture.run();
		const context = prepareFlow(
			schematic,
			compiled.connectivity,
			compiled.names,
			run,
			undefined,
			compiled.portFlow
		);
		const byName = new Map(schematic.instances.map((i) => [i.name, i]));
		const sum = byName.get('D1')!.id;
		const carry = byName.get('D2')!.id;

		// Stepped the way the live overlay steps: a quarter of a microsecond of
		// simulated time per frame, each frame told where the previous one ended.
		const STEP = 2.5e-7;
		const mixed: string[] = [];
		let lit = 0;
		for (let t = STEP; t <= 4e-6; t += STEP) {
			const frame = sampleFlow(
				context,
				run,
				sampleIndexAt(run.time, t),
				sampleIndexAt(run.time, t - STEP)
			);
			const a = Math.abs(frame.instanceCurrent.get(sum) ?? 0);
			const b = Math.abs(frame.instanceCurrent.get(carry) ?? 0);
			if (a > 1e-3 || b > 1e-3) lit++;
			// A half adder answers 1+1 with a carry and 1+0 with a sum. Never both.
			if (a > 1e-3 && b > 1e-3) mixed.push(`${t.toExponential(2)}: ${a} / ${b}`);
		}
		expect(mixed).toEqual([]);
		// And it is not quiet throughout, which would satisfy the same assertion.
		expect(lit).toBeGreaterThan(10);
	});

	it('still catches a burst shorter than the frame that spans it', () => {
		// The mean over the span is not decoration, and this is what it is for: a
		// CMOS inverter conducts only while it switches, so reading one instant per
		// frame drew a dead circuit on almost every frame and the whole burst on the
		// occasional one. Sampling from the last change of state rather than from
		// where the previous frame ended keeps that, because the burst happens after
		// its transition, not before it.
		const schematic = EXAMPLES.find((e) => e.id === 'cmos-inverter')!.build();
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);
		const { run } = simulate(schematic, 4e-6);
		const context = prepareFlow(
			schematic,
			compiled.connectivity,
			compiled.names,
			run,
			undefined,
			compiled.portFlow
		);

		const STEP = 1e-7;
		const peak = (frame: FlowFrame) =>
			Math.max(...[...frame.instanceCurrent.values()].map((v) => Math.abs(v)));
		let spanned = 0;
		let instants = 0;
		for (let t = STEP; t <= 4e-6; t += STEP) {
			const index = sampleIndexAt(run.time, t);
			const from = sampleIndexAt(run.time, t - STEP);
			if (peak(sampleFlow(context, run, index, from)) > 1e-6) spanned++;
			if (peak(sampleFlow(context, run, index)) > 1e-6) instants++;
		}
		expect(spanned).toBeGreaterThan(instants);
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

/**
 * A part with three terminals, and the wires around it adding up.
 *
 * The reported case: a CMOS inverter, whose gates are charged through 25 pF on
 * every edge. That current is real, it comes out of a supply, and it has to
 * arrive somewhere — but the engine only reported a MOSFET's channel current, so
 * the drawing had milliamps leaving the supply and nothing reaching the
 * transistor. Half a circuit animated and the other half looked dead.
 */
describe('a MOSFET being switched', () => {
	function inverter(): Schematic {
		const vdd = at('vsource', 'VDD', 120, 200);
		vdd.params.waveform = 'dc';
		vdd.params.value = 5;
		const drive = at('vsource', 'V1', 120, 380);
		drive.params.waveform = 'pulse';
		drive.params.value = 5;
		drive.params.frequency = 10000;
		return drawing(
			[vdd, drive, at('nmos', 'M1', 400, 260), at('ground', 'GND1', 120, 470)],
			[
				// Supply to the drain.
				[120, 170, 410, 170],
				[410, 170, 410, 230],
				// Drive to the gate.
				[120, 350, 300, 350],
				[300, 350, 300, 260],
				[300, 260, 370, 260],
				// Returns. VDD's goes round the outside: straight down it would run
				// through V1's own terminals and short the drive out.
				[120, 230, 60, 230],
				[60, 230, 60, 460],
				[60, 460, 120, 460],
				[120, 410, 120, 460],
				[410, 290, 410, 460],
				[410, 460, 120, 460]
			]
		);
	}

	it('has the current arriving at the gate that the source is supplying', () => {
		const schematic = inverter();
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);

		const live = new LiveRun(compiled.netlist, 2e-8);
		const capture = new Capture(
			live.unknownNames,
			live.elementNames,
			live.netNames,
			live.nodeCount
		);
		capture.add(live.first);
		// Through the first edge, which is where the gate charge goes in.
		capture.add(live.advance(60e-6));
		live.free();

		const run = capture.run();
		const context = prepareFlow(
		schematic,
		compiled.connectivity,
		compiled.names,
		run,
		undefined,
		compiled.portFlow
	);

		// The instant the gate wire is busiest.
		const gateSeries = run.currents[run.elementNames.indexOf('M1:g')];
		let peak = 0;
		let index = 0;
		for (let i = 0; i < gateSeries.length; i++) {
			if (Math.abs(gateSeries[i]) > peak) {
				peak = Math.abs(gateSeries[i]);
				index = i;
			}
		}
		expect(peak).toBeGreaterThan(1e-5);

		const frame = sampleFlow(context, run, index);
		const gate = currentAt(schematic, frame, 300, 350);
		const source = currentAt(schematic, frame, 120, 350);
		// One wire, drawn in two legs: whatever leaves the source arrives at the
		// gate. Before the engine reported terminal currents this was `peak` at one
		// end and zero at the other.
		expect(gate).toBeCloseTo(peak, 9);
		expect(source).toBeCloseTo(peak, 9);
	});

	it('does not let one edge decide that nothing else is flowing', () => {
		// The scale is a high percentile of what is on screen rather than its peak.
		// Taken from the peak, a ten-nanosecond gate spike a thousand times the
		// steady current puts everything else below the threshold at which a dot
		// moves at all — a circuit drawn as carrying nothing while it works.
		const schematic = inverter();
		const compiled = compileSchematic(schematic);
		const live = new LiveRun(compiled.netlist, 2e-8);
		const capture = new Capture(
			live.unknownNames,
			live.elementNames,
			live.netNames,
			live.nodeCount
		);
		capture.add(live.first);
		capture.add(live.advance(60e-6));
		live.free();

		const run = capture.run();
		const context = prepareFlow(
		schematic,
		compiled.connectivity,
		compiled.names,
		run,
		undefined,
		compiled.portFlow
	);
		let biggest = 0;
		for (const series of run.currents) {
			for (const value of series) biggest = Math.max(biggest, Math.abs(value));
		}
		expect(context.currentScale).toBeLessThan(biggest);

		// And the steady current through the conducting device is still drawn as
		// flowing — sampled with the gate up, since a transistor that is off is
		// carrying nothing and *should* be drawn as still.
		const on = sampleFlow(context, run, sampleIndexAt(run.time, 25e-6));
		const through = Math.abs(on.instanceCurrent.get(schematic.instances[2].id) ?? 0);
		expect(through).toBeGreaterThan(1e-6);
		expect(isFlowing(through, context.currentScale)).toBe(true);
	});
});

describe('an imported subcircuit', () => {
	// A resistive divider written the way a vendor's file writes one. Simple on
	// purpose: what is being tested is that the drawing can find the current at a
	// terminal of a part the engine has no element for, not the part itself.
	const SOURCE = `
.SUBCKT DIV in out
R1 in out 1k
R2 out 0 1k
.ENDS
`;

	it('carries current at its terminals like any other part', () => {
		const sub = { id: 'div', name: 'DIV', ports: ['in', 'out'], source: SOURCE };
		registerSubcircuits({ instances: [], wires: [], subcircuits: [sub] });

		// Supply -> subcircuit input, with the divider's own R2 returning to ground
		// inside it. The wire into the part has to show the current it draws.
		const schematic: Schematic = {
			...drawing(
				[at('supply', 'PWR1', 100, 100), at('x:div', 'X1', 200, 200)],
				[
					[100, 110, 100, 200],
					[100, 200, 160, 200]
				]
			),
			subcircuits: [sub]
		};

		const { frame, compiled } = simulate(schematic, 1e-4);
		expect(compiled.portFlow.size).toBe(1);

		// 5 V across two kilohms in series is 2.5 mA, and that is what the wire
		// feeding the part carries. Before the planner knew how to reach inside a
		// flattened subcircuit there was nothing to accumulate here at all, and the
		// whole net animated as dead.
		const feeding = currentAt(schematic, frame, 100, 200);
		expect(feeding).toBeGreaterThan(1e-3);
		expect(feeding).toBeCloseTo(2.5e-3, 4);
	});
});
