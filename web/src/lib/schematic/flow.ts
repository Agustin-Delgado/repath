/**
 * Working out what to animate.
 *
 * A net has one voltage, so colouring wires by it is exact. Current is harder:
 * the engine knows the current through each *device*, but a wire is just a
 * connection, and a net with several branches does not assign a current to each
 * segment on its own.
 *
 * It does once you look at the topology. Cut any wire in a tree-shaped net and
 * the net falls into two halves; the current in that wire must be the total
 * injected by everything on one side. So: build a spanning tree of each net,
 * hang the device currents on it, and accumulate from the leaves inward. That is
 * exact for trees, which is what nets almost always are. Wires that close a loop
 * are genuinely ambiguous — ideal wires in parallel share current in no defined
 * ratio — and are left at zero rather than guessed at.
 *
 * The topology is fixed for a run, so all of that is planned once and each
 * animation frame only re-runs the accumulation.
 */

import type { TransientRun } from '$lib/engine';
import { definitionOf, pointKey, wireSegments, type Point, type Schematic } from './model';
import type { Connectivity } from './nets';
import type { NetNames } from './netlist';
import { instancePins } from './scene';

/**
 * Which pins carry a device's current, and in which direction.
 *
 * The engine reports current flowing *into* an element at its first terminal, so
 * that pin drains the net (−1) and the return pin feeds it (+1). Terminals not
 * listed carry no current worth animating: a MOSFET gate draws exactly none in
 * this model, and a BJT base draws a few microamps against milliamps elsewhere.
 */
const PIN_FLOW: Record<string, Array<[pin: string, sign: number]>> = {
	resistor: [['a', -1], ['b', 1]],
	capacitor: [['a', -1], ['b', 1]],
	inductor: [['a', -1], ['b', 1]],
	// A closed switch is a 50 mΩ resistor and carries every amp the loop does.
	// Missing from this table it was invisible here, and the effect was not that
	// the switch drew no current — it was that the *wire feeding it* drew none,
	// because a net whose only part is unknown to the planner has nothing to
	// accumulate. Half a working circuit animated and the other half looked dead.
	switch: [['a', -1], ['b', 1]],
	vsource: [['plus', -1], ['minus', 1]],
	// One pin, like an op-amp output: the return is the ground the symbol means
	// rather than a terminal on the drawing.
	supply: [['v', -1]],
	isource: [['plus', -1], ['minus', 1]],
	diode: [['anode', -1], ['cathode', 1]],
	led: [['anode', -1], ['cathode', 1]],
	nmos: [['drain', -1], ['source', 1]],
	pmos: [['drain', -1], ['source', 1]],
	npn: [['collector', -1], ['emitter', 1]],
	pnp: [['collector', -1], ['emitter', 1]],
	opamp: [['out', -1]]
};

/** One leg of one wire, as the flow graph sees it. */
interface NetSegment {
	id: string;
	a: Point;
	b: Point;
}

interface Injection {
	/** Index into the run's element arrays. */
	element: number;
	sign: number;
}

interface PlanStep {
	point: string;
	parent: string | null;
	/** Addresses one leg of one wire: `wireId#segmentIndex`. */
	segmentId: string | null;
	/** True when the segment runs parent -> point, so the sign has to flip. */
	reversed: boolean;
}

interface NetPlan {
	/** Leaves first, so a node's children are always summed before it. */
	steps: PlanStep[];
	injections: Map<string, Injection[]>;
}

export interface FlowContext {
	run: TransientRun;
	plans: NetPlan[];
	/** Net index -> index of its voltage in the solution, or -1 for ground. */
	netSignal: Map<number, number>;
	/** Instance id -> element index in the run. */
	instanceElement: Map<string, number>;
	/** Instance id -> the two pins its current flows between. */
	instanceFlow: Map<string, { from: string; to: string }>;
	voltageRange: { lo: number; hi: number };
	/** Reference for scaling animation speed: the largest current in the run. */
	currentScale: number;
}

export interface FlowFrame {
	/** Net index -> volts. */
	netVoltage: Map<number, number>;
	/** `wireId#segmentIndex` -> amps, positive along the segment's own direction. */
	wireCurrent: Map<string, number>;
	/** Instance id -> amps through its main conduction path. */
	instanceCurrent: Map<string, number>;
}

/** Plan the accumulation for every net. Call once per run, not per frame. */
export function prepareFlow(
	schematic: Schematic,
	connectivity: Connectivity,
	names: ReadonlyMap<number, NetNames>,
	run: TransientRun
): FlowContext {
	const elementByName = new Map(run.elementNames.map((name, index) => [name, index] as const));

	const instanceElement = new Map<string, number>();
	const instanceFlow = new Map<string, { from: string; to: string }>();
	for (const instance of schematic.instances) {
		const index = elementByName.get(instance.name);
		if (index === undefined) continue;
		instanceElement.set(instance.id, index);
		const flow = PIN_FLOW[instance.kind];
		if (flow && flow.length === 2) {
			instanceFlow.set(instance.id, { from: flow[0][0], to: flow[1][0] });
		}
	}

	const netSignal = new Map<number, number>();
	for (const [netIndex, entry] of names) {
		if (!entry.analog) continue;
		netSignal.set(netIndex, entry.analog === 'gnd' ? -1 : run.unknownNames.indexOf(`v(${entry.analog})`));
	}

	// Group wire segments and injections by net.
	const segmentsByNet = new Map<number, NetSegment[]>();
	for (const wire of schematic.wires) {
		for (const segment of wireSegments(wire)) {
			const net = connectivity.netOfPoint.get(pointKey(segment.a.x, segment.a.y));
			if (net === undefined) continue;
			const entry: NetSegment = {
				id: `${wire.id}#${segment.index}`,
				a: segment.a,
				b: segment.b
			};
			const list = segmentsByNet.get(net);
			if (list) list.push(entry);
			else segmentsByNet.set(net, [entry]);
		}
	}

	const injectionsByNet = new Map<number, Map<string, Injection[]>>();
	for (const instance of schematic.instances) {
		const element = instanceElement.get(instance.id);
		if (element === undefined) continue;
		const flow = PIN_FLOW[instance.kind];
		if (!flow) continue;

		for (const { pin, at } of instancePins(instance)) {
			const entry = flow.find(([name]) => name === pin.name);
			if (!entry) continue;
			const net = connectivity.netOfPoint.get(pointKey(at.x, at.y));
			if (net === undefined) continue;

			let perNet = injectionsByNet.get(net);
			if (!perNet) injectionsByNet.set(net, (perNet = new Map()));
			const key = pointKey(at.x, at.y);
			const list = perNet.get(key);
			const injection = { element, sign: entry[1] };
			if (list) list.push(injection);
			else perNet.set(key, [injection]);
		}
	}

	const plans: NetPlan[] = [];
	for (const [netIndex, segments] of segmentsByNet) {
		const injections = injectionsByNet.get(netIndex) ?? new Map();
		const steps = planNet(segments, injections, netIndex, connectivity, schematic);
		if (steps.length > 0) plans.push({ steps, injections });
	}

	return {
		run,
		plans,
		netSignal,
		instanceElement,
		instanceFlow,
		voltageRange: voltageRange(run),
		currentScale: currentScale(run)
	};
}

/**
 * Breadth-first spanning tree of one net's wires, returned leaves-first.
 *
 * Rooted at a ground pin where there is one: ground is where any imbalance
 * belongs, since it is the return path the rest of the circuit is measured
 * against.
 */
function planNet(
	segments: NetSegment[],
	injections: Map<string, Injection[]>,
	netIndex: number,
	connectivity: Connectivity,
	schematic: Schematic
): PlanStep[] {
	const adjacency = new Map<string, Array<{ to: string; segmentId: string; forward: boolean }>>();
	const link = (from: string, to: string, segmentId: string, forward: boolean) => {
		const list = adjacency.get(from);
		const edge = { to, segmentId, forward };
		if (list) list.push(edge);
		else adjacency.set(from, [edge]);
	};

	for (const segment of segments) {
		const a = pointKey(segment.a.x, segment.a.y);
		const b = pointKey(segment.b.x, segment.b.y);
		if (a === b) continue;
		link(a, b, segment.id, true);
		link(b, a, segment.id, false);
	}
	if (adjacency.size === 0) return [];

	let root: string | null = null;
	for (const instance of schematic.instances) {
		if (instance.kind !== 'ground') continue;
		for (const { at } of instancePins(instance)) {
			const key = pointKey(at.x, at.y);
			if (connectivity.netOfPoint.get(key) === netIndex && adjacency.has(key)) {
				root = key;
				break;
			}
		}
		if (root) break;
	}
	root ??= adjacency.keys().next().value ?? null;
	if (!root) return [];

	const order: PlanStep[] = [];
	const seen = new Set<string>([root]);
	const queue: PlanStep[] = [{ point: root, parent: null, segmentId: null, reversed: false }];

	while (queue.length > 0) {
		const step = queue.shift()!;
		order.push(step);
		for (const edge of adjacency.get(step.point) ?? []) {
			if (seen.has(edge.to)) continue;
			seen.add(edge.to);
			// `forward` means the wire runs step.point -> edge.to. Current flowing
			// from the child up to the parent therefore runs against it.
			queue.push({
				point: edge.to,
				parent: step.point,
				segmentId: edge.segmentId,
				reversed: edge.forward
			});
		}
	}

	// Any point that only carries injections still needs to exist in the plan.
	for (const key of injections.keys()) {
		if (!seen.has(key) && adjacency.has(key)) {
			order.push({ point: key, parent: null, segmentId: null, reversed: false });
		}
	}

	return order.reverse();
}

function voltageRange(run: TransientRun): { lo: number; hi: number } {
	// Starts at zero on both sides so the midpoint of the diverging scale always
	// means something: no potential difference from ground.
	let lo = 0;
	let hi = 0;
	for (let i = 0; i < run.nodeCount; i++) {
		const samples = run.signalsByIndex[i];
		if (!samples) continue;
		for (const v of samples) {
			if (v < lo) lo = v;
			if (v > hi) hi = v;
		}
	}
	if (hi - lo < 1e-9) return { lo: -1, hi: 1 };
	return { lo, hi };
}

function currentScale(run: TransientRun): number {
	let max = 0;
	for (const series of run.currents) {
		for (const i of series) {
			const magnitude = Math.abs(i);
			if (magnitude > max && Number.isFinite(magnitude)) max = magnitude;
		}
	}
	return max > 0 ? max : 1;
}

/** Index of the sample at or just before `time`. Binary search on a sorted axis. */
export function sampleIndexAt(times: ArrayLike<number>, time: number): number {
	let lo = 0;
	let hi = times.length - 1;
	if (hi < 0) return 0;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (times[mid] <= time) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** Evaluate one timepoint. Cheap enough to call every frame. */
export function sampleFlow(context: FlowContext, index: number): FlowFrame {
	const { run } = context;
	const at = Math.min(Math.max(index, 0), Math.max(run.time.length - 1, 0));
	const currentOf = (element: number) => run.currents[element]?.[at] ?? 0;

	const netVoltage = new Map<number, number>();
	for (const [net, signal] of context.netSignal) {
		netVoltage.set(net, signal < 0 ? 0 : (run.signalsByIndex[signal]?.[at] ?? 0));
	}

	const instanceCurrent = new Map<string, number>();
	for (const [id, element] of context.instanceElement) {
		instanceCurrent.set(id, currentOf(element));
	}

	const wireCurrent = new Map<string, number>();
	for (const plan of context.plans) {
		// Running total flowing up from each point toward the root.
		const accumulated = new Map<string, number>();
		for (const step of plan.steps) {
			let total = accumulated.get(step.point) ?? 0;
			for (const injection of plan.injections.get(step.point) ?? []) {
				total += injection.sign * currentOf(injection.element);
			}
			if (step.segmentId && step.parent) {
				wireCurrent.set(step.segmentId, step.reversed ? -total : total);
				accumulated.set(step.parent, (accumulated.get(step.parent) ?? 0) + total);
			}
		}
	}

	return { netVoltage, wireCurrent, instanceCurrent };
}
