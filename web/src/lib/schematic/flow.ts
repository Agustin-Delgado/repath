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

import type { DigitalTransition, LogicState, TransientRun } from '$lib/engine';
import { definitionOf, pointKey, wireSegments, type Point, type Schematic } from './model';
import { DEFAULT_FAMILY, logicFamily, type LogicFamily } from './logic';
import type { Connectivity } from './nets';
import type { NetNames } from './netlist';
import { instancePins } from './scene';

/**
 * Which pins carry a device's current, and in which direction.
 *
 * The engine reports current flowing *into* an element at its first terminal, so
 * that pin drains the net (−1) and the return pin feeds it (+1).
 *
 * A three-terminal device cannot be described that way, and pretending otherwise
 * is what made a CMOS inverter look broken: the supply poured milliamps into a
 * transistor whose channel was carrying nothing, because all of it was going
 * into the gate capacitance and the gate was not in this table. The engine now
 * reports each terminal separately, under `M1:g` and `M1:s`, and the third
 * column here names that series. The three add to zero, so the net adds up.
 */
const PIN_FLOW: Record<string, Array<[pin: string, sign: number, series?: string]>> = {
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
	// Every terminal reported into the device, so every one of them drains its
	// net. Drain and source stay first, in that order: they are the path the
	// dots are drawn along inside the symbol.
	nmos: [['drain', -1], ['source', -1, ':s'], ['gate', -1, ':g']],
	pmos: [['drain', -1], ['source', -1, ':s'], ['gate', -1, ':g']],
	npn: [['collector', -1], ['emitter', -1, ':e'], ['base', -1, ':b']],
	pnp: [['collector', -1], ['emitter', -1, ':e'], ['base', -1, ':b']],
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
	/**
	 * Net index -> the transitions of its digital net, for nets with no node.
	 *
	 * A purely digital net has no voltage in the solution at all — the engine
	 * works in states there and only puts a number on it where the two domains
	 * meet. Drawn from the analog side alone, half a logic circuit came out with
	 * no colour, no reading and no visible answer to a click: the part moved, the
	 * gate obeyed, and the wire between them looked exactly the same either way.
	 *
	 * So the level is turned into the volts the family would actually put on that
	 * wire, and from there it is a voltage like any other.
	 */
	netLogic: Map<number, DigitalTransition[]>;
	/** What a one and a zero are worth on this drawing, in volts. */
	logicLevels: { low: number; high: number };
	/** Instance id -> element index in the run. */
	instanceElement: Map<string, number>;
	/** Instance id -> the two pins its current flows between. */
	instanceFlow: Map<string, { from: string; to: string }>;
	/**
	 * What the colour ramp is stretched over. Grows to fit what has been seen and
	 * never shrinks, so a wire does not change colour because something else left
	 * the screen.
	 */
	voltageRange: { lo: number; hi: number };
	/**
	 * Reference for scaling animation speed.
	 *
	 * Not the largest current — that is one number away from ruining the whole
	 * animation. A gate edge charging 25 pF draws milliamps for ten nanoseconds
	 * while the circuit around it carries microamps; scaled to the spike,
	 * everything else sits below the threshold at which a dot moves at all, and
	 * the drawing reports a circuit with no current in it. This is a high
	 * percentile over what is on screen instead: the spike is still the fastest
	 * thing drawn, and everything else is still visible.
	 */
	currentScale: number;
}

export interface FlowFrame {
	/** Net index -> volts. */
	netVoltage: Map<number, number>;
	/**
	 * Digital nets sitting at neither level at this instant.
	 *
	 * Unknown or high-impedance: nothing is driving them, or two things are
	 * driving them differently. There is no voltage to print, and the wire keeps
	 * its plain colour rather than being coloured by a number nobody decided —
	 * the same treatment a floating analog node gets, for the same reason.
	 */
	netUndriven: Set<number>;
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
	run: TransientRun,
	family: LogicFamily = logicFamily(DEFAULT_FAMILY)
): FlowContext {
	const elementByName = new Map(run.elementNames.map((name, index) => [name, index] as const));

	const instanceElement = new Map<string, number>();
	const instanceFlow = new Map<string, { from: string; to: string }>();
	for (const instance of schematic.instances) {
		const index = elementByName.get(instance.name);
		if (index === undefined) continue;
		instanceElement.set(instance.id, index);
		const flow = PIN_FLOW[instance.kind];
		// The first two are the conduction path — drain to source, collector to
		// emitter — whatever else the device reports.
		if (flow && flow.length >= 2) {
			instanceFlow.set(instance.id, { from: flow[0][0], to: flow[1][0] });
		}
	}

	const netSignal = new Map<number, number>();
	const netLogic = new Map<number, DigitalTransition[]>();
	for (const [netIndex, entry] of names) {
		if (entry.analog) {
			netSignal.set(
				netIndex,
				entry.analog === 'gnd' ? -1 : run.unknownNames.indexOf(`v(${entry.analog})`)
			);
			// A bridged net has both, and the node is the better answer: it is what
			// the wire is really at, including a driver sagging under load.
			continue;
		}
		if (!entry.digital) continue;
		const index = run.netNames.indexOf(entry.digital);
		if (index >= 0) netLogic.set(netIndex, run.digital[index] ?? []);
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
			// A terminal with a series of its own, or the element's own current.
			const source = entry[2] ? elementByName.get(`${instance.name}${entry[2]}`) : element;
			if (source === undefined) continue;

			let perNet = injectionsByNet.get(net);
			if (!perNet) injectionsByNet.set(net, (perNet = new Map()));
			const key = pointKey(at.x, at.y);
			const list = perNet.get(key);
			const injection = { element: source, sign: entry[1] };
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

	const levels = { low: family.v_low, high: family.v_high };
	const context: FlowContext = {
		run,
		plans,
		netSignal,
		netLogic,
		logicLevels: levels,
		instanceElement,
		instanceFlow,
		// A circuit with no analog side at all would otherwise scale its colours to
		// a range of ±1 V and paint every logic high the same saturated end of it.
		voltageRange: netLogic.size > 0 ? { lo: Math.min(0, levels.low), hi: levels.high } : { lo: 0, hi: 0 },
		currentScale: 1
	};
	rescale(context, run, 0, run.time.length - 1);
	return context;
}

/**
 * Fit the colour ramp and the animation speed to a stretch of the run.
 *
 * Called every frame with whatever is on screen, because a run that is still
 * going has no final answer to scale against — and because the interesting
 * currents move by orders of magnitude as a circuit switches.
 */
export function rescale(context: FlowContext, run: TransientRun, from: number, to: number): void {
	const lo = Math.max(Math.min(from, to), 0);
	const hi = Math.min(Math.max(from, to), run.time.length - 1);
	if (hi < lo) return;

	// Voltage: the range only ever grows. Colours that re-scaled every frame
	// would have a steady rail changing colour because something else spiked.
	let low = context.voltageRange.lo;
	let high = context.voltageRange.hi;
	for (let i = 0; i < run.nodeCount; i++) {
		const samples = run.signalsByIndex[i];
		if (!samples) continue;
		for (let k = lo; k <= hi; k++) {
			const v = samples[k];
			if (v < low) low = v;
			if (v > high) high = v;
		}
	}
	context.voltageRange = high - low < 1e-9 ? { lo: -1, hi: 1 } : { lo: low, hi: high };

	// Current: a high percentile of what is on screen, sampled rather than read
	// in full — the answer is a scale for an animation, and a hundred rows say
	// the same thing as ten thousand at a fraction of the frame budget.
	const stride = Math.max(1, Math.floor((hi - lo + 1) / SCALE_ROWS));
	const magnitudes: number[] = [];
	for (const series of run.currents) {
		for (let k = lo; k <= hi; k += stride) {
			const magnitude = Math.abs(series[k]);
			if (magnitude > 0 && Number.isFinite(magnitude)) magnitudes.push(magnitude);
		}
	}
	if (magnitudes.length === 0) {
		context.currentScale = 1;
		return;
	}
	magnitudes.sort((a, b) => a - b);
	const percentile = magnitudes[Math.floor((magnitudes.length - 1) * SCALE_PERCENTILE)];
	context.currentScale = percentile > 0 ? percentile : magnitudes[magnitudes.length - 1];
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

/** Rows sampled when working out the current scale. */
const SCALE_ROWS = 128;

/**
 * Where in the spread of currents the animation's full speed sits.
 *
 * Not the top. A tenth of the samples being drawn faster than full speed is a
 * far smaller lie than nine tenths of them being drawn as no flow at all.
 */
const SCALE_PERCENTILE = 0.9;

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

/**
 * Evaluate one timepoint. Cheap enough to call every frame.
 *
 * The run is passed in rather than read off the context: with a live capture the
 * samples are still arriving, and the context was built when the run started.
 */
export function sampleFlow(context: FlowContext, run: TransientRun, index: number): FlowFrame {
	const at = Math.min(Math.max(index, 0), Math.max(run.time.length - 1, 0));
	const currentOf = (element: number) => run.currents[element]?.[at] ?? 0;

	const netVoltage = new Map<number, number>();
	for (const [net, signal] of context.netSignal) {
		netVoltage.set(net, signal < 0 ? 0 : (run.signalsByIndex[signal]?.[at] ?? 0));
	}

	// The digital side, in volts. The events carry the instant they happened at
	// rather than a sample index — the digital domain does not step on the
	// solver's grid — so this is a search by time, not a lookup.
	const netUndriven = new Set<number>();
	const now = run.time[at] ?? 0;
	for (const [net, transitions] of context.netLogic) {
		const state = stateAt(transitions, now);
		if (state === 'high') netVoltage.set(net, context.logicLevels.high);
		else if (state === 'low') netVoltage.set(net, context.logicLevels.low);
		else netUndriven.add(net);
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

	return { netVoltage, netUndriven, wireCurrent, instanceCurrent };
}

/** The state a digital net had settled on at an instant. */
function stateAt(transitions: readonly DigitalTransition[], time: number): LogicState {
	let state: LogicState = 'unknown';
	for (const transition of transitions) {
		if (transition.time > time) break;
		state = transition.state;
	}
	return state;
}
