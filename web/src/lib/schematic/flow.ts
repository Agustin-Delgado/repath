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
import type { PortInjection } from '../spice';
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
	 * Net index -> which of the run's digital nets it is, for nets with no node.
	 *
	 * A purely digital net has no voltage in the solution at all — the engine
	 * works in states there and only puts a number on it where the two domains
	 * meet. Drawn from the analog side alone, half a logic circuit came out with
	 * no colour, no reading and no visible answer to a click: the part moved, the
	 * gate obeyed, and the wire between them looked exactly the same either way.
	 *
	 * So the level is turned into the volts the family would actually put on that
	 * wire, and from there it is a voltage like any other.
	 *
	 * Held as *where to look* rather than as the transitions themselves. A live
	 * run hands over a fresh list on every acquired chunk, and a context built
	 * once at the start kept the list it was handed then — which, at the start, is
	 * the seed at t = 0 and nothing else. The clock wire stayed at the level it
	 * began on and every driven net read as high-impedance for the whole run,
	 * while the scope beside it drew those very nets switching.
	 */
	netLogic: Map<number, number>;
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
	family: LogicFamily = logicFamily(DEFAULT_FAMILY),
	/**
	 * Per placed subcircuit, which reported series arrives at each of its
	 * terminals. Empty for a drawing with none, which is most of them.
	 */
	portFlow: ReadonlyMap<string, PortInjection[]> = new Map()
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
	const netLogic = new Map<number, number>();
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
		if (index >= 0) netLogic.set(netIndex, index);
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
	const inject = (at: Point, element: number, sign: number) => {
		const net = connectivity.netOfPoint.get(pointKey(at.x, at.y));
		if (net === undefined) return;
		let perNet = injectionsByNet.get(net);
		if (!perNet) injectionsByNet.set(net, (perNet = new Map()));
		const key = pointKey(at.x, at.y);
		const list = perNet.get(key);
		const injection = { element, sign };
		if (list) list.push(injection);
		else perNet.set(key, [injection]);
	};

	// A flattened subcircuit has no element of its own to point at, so its pins
	// are fed from the pieces it was built out of. Several series can arrive at
	// one terminal — a `.subckt` is free to hang three things off a port — and
	// they simply add.
	for (const instance of schematic.instances) {
		const ports = portFlow.get(instance.id);
		if (!ports) continue;
		const pins = new Map(instancePins(instance).map(({ pin, at }) => [pin.name, at] as const));
		for (const { port, element, sign } of ports) {
			const at = pins.get(port);
			const index = elementByName.get(element);
			if (at && index !== undefined) inject(at, index, sign);
		}
	}

	for (const instance of schematic.instances) {
		const element = instanceElement.get(instance.id);
		if (element === undefined) continue;
		const flow = PIN_FLOW[instance.kind];
		if (!flow) continue;

		for (const { pin, at } of instancePins(instance)) {
			const entry = flow.find(([name]) => name === pin.name);
			if (!entry) continue;
			// A terminal with a series of its own, or the element's own current.
			const source = entry[2] ? elementByName.get(`${instance.name}${entry[2]}`) : element;
			if (source === undefined) continue;
			inject(at, source, entry[1]);
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

	// Current: one figure per part — the mean of its magnitude over the window —
	// and then a high percentile across the parts.
	//
	// Averaged, not sampled at its peak, and that distinction is the whole
	// difference between a drawing that flows and one that flashes. A switching
	// circuit spends a thousandth of its time conducting: scaled to the peak of
	// the burst, everything the circuit does for the rest of the time normalises
	// to a thousandth of full speed, which is a stationary dot. Scaled to what
	// the part carries on average, a wire moves at a rate that means something —
	// how much charge is really going past — and the burst is a lurch on top.
	// Weighted by time, not by sample. The step controller crowds its samples
	// into the microsecond where something happens and takes one long step across
	// the fifty microseconds where nothing does, so counting samples equally
	// reports the burst as though the circuit were doing it all the time — which
	// put the reference three hundred times above what the wire really carries,
	// and left every dot on the drawing standing still.
	const stride = Math.max(1, Math.floor((hi - lo + 1) / SCALE_ROWS));
	const averages: number[] = [];
	for (const series of run.currents) {
		let charge = 0;
		let elapsed = 0;
		for (let k = lo; k + stride <= hi; k += stride) {
			const magnitude = Math.abs(series[k]);
			if (!Number.isFinite(magnitude)) continue;
			const width = run.time[k + stride] - run.time[k];
			charge += magnitude * width;
			elapsed += width;
		}
		if (elapsed > 0 && charge > 0) averages.push(charge / elapsed);
	}
	if (averages.length === 0) {
		context.currentScale = 1;
		return;
	}
	averages.sort((a, b) => a - b);
	context.currentScale = averages[Math.floor((averages.length - 1) * SCALE_PERCENTILE)];
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
const SCALE_ROWS = 512;

/**
 * Where among the parts the animation's full speed sits.
 *
 * Not the busiest one. A tenth of the circuit being drawn faster than full speed
 * is a far smaller lie than nine tenths of it being drawn as carrying nothing.
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
 * Evaluate what to draw for one frame.
 *
 * `since` is where the previous frame left off. Currents come back as the *mean*
 * over that interval rather than as the sample at its end, and that is the whole
 * difference between a flow and a flicker.
 *
 * A frame covers a stretch of simulated time — a couple of microseconds at an
 * ordinary timebase — and a switching circuit does its conducting in bursts far
 * shorter than that. Reading one instant per frame, the drawing missed almost
 * every burst and caught the occasional one whole: over a hundred and fifty
 * frames of a CMOS inverter, two of them showed any current at all and the rest
 * showed a dead circuit. The mean cannot miss anything: it is the charge that
 * moved, divided by the time it took, so a burst always contributes exactly
 * what it carried and the dots advance by the charge that went past them.
 *
 * Voltages stay instantaneous. A voltage is a level, not a flow, and averaging
 * it would only blur an edge that the scope beside it draws sharp.
 *
 * What the mean must never be taken across is a change to the circuit itself.
 * Averaging over one of those mixes two different circuits into a reading that
 * belongs to neither: flip an input of the half adder and the frame the playhead
 * crosses the transition on came back with a share of the old current in one
 * branch and a share of the new one in another — both lamps at half brightness,
 * a state the engine never solved. On a live run that frame is held for about a
 * second, because the playhead advances in steps far longer than a frame, so it
 * reads as the drawing being wrong rather than as a blur. The caller passes
 * `since === index` over such a frame, and gets the instant.
 */
export function sampleFlow(
	context: FlowContext,
	run: TransientRun,
	index: number,
	since = index
): FlowFrame {
	const last = Math.max(run.time.length - 1, 0);
	const at = Math.min(Math.max(index, 0), last);
	const from = latestChangeAt(run, Math.min(Math.max(since, 0), at), at);
	const span = (run.time[at] ?? 0) - (run.time[from] ?? 0);

	const currentOf = (element: number) => {
		const series = run.currents[element];
		if (!series) return 0;
		if (from >= at || span <= 0) return series[at] ?? 0;
		// Trapezoidal, on the solver's own grid: the samples are not evenly
		// spaced, and the gap around a burst is exactly where the step control
		// puts its shortest steps.
		let charge = 0;
		for (let k = from; k < at; k++) {
			charge += 0.5 * ((series[k] ?? 0) + (series[k + 1] ?? 0)) * (run.time[k + 1] - run.time[k]);
		}
		return charge / span;
	};

	const netVoltage = new Map<number, number>();
	for (const [net, signal] of context.netSignal) {
		netVoltage.set(net, signal < 0 ? 0 : (run.signalsByIndex[signal]?.[at] ?? 0));
	}

	// The digital side, in volts. The events carry the instant they happened at
	// rather than a sample index — the digital domain does not step on the
	// solver's grid — so this is a search by time, not a lookup.
	const netUndriven = new Set<number>();
	const now = run.time[at] ?? 0;
	for (const [net, index] of context.netLogic) {
		// From the run handed over for this frame, not from the one the context was
		// built against: on a live run those are different objects, and the older one
		// stopped at the seed transition.
		const state = stateAt(run.digital[index] ?? [], now);
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

/**
 * Where the circuit now on screen began, within a frame's span.
 *
 * The mean over a whole span is what keeps a burst shorter than a frame visible,
 * but taken across a change of state it mixes two different circuits into a
 * reading that belongs to neither. Flip an input of the half adder and the frame
 * the playhead crosses the transition on came back with a share of the old
 * current in one branch and a share of the new one in another — both lamps at
 * half brightness, a state the engine never solved, held for about a second
 * because a live run advances the playhead in steps far longer than a frame.
 *
 * The last digital transition inside the span is that boundary, so the mean is
 * taken from there rather than from where the previous frame ended. It is not a
 * threshold on the current itself, which would have to guess: a burst and a
 * change of level look alike in a single number, and only the event says which
 * it was. The switching burst of a CMOS inverter still counts in full, because
 * it happens *after* its transition, not before it.
 *
 * Detecting the operation instead is not enough, and that was the first attempt:
 * a gate takes its propagation delay to answer, so the electrical change lands
 * frames after the toggle the playhead has already crossed.
 */
function latestChangeAt(run: TransientRun, from: number, at: number): number {
	if (from >= at) return from;
	const lower = run.time[from] ?? 0;
	const upper = run.time[at] ?? 0;
	let latest = lower;
	for (const transitions of run.digital) {
		if (!transitions) continue;
		for (let k = transitions.length - 1; k >= 0; k--) {
			const time = transitions[k].time;
			if (time <= latest) break;
			if (time <= upper) {
				latest = time;
				break;
			}
		}
	}
	return latest > lower ? Math.min(sampleIndexAt(run.time, latest), at) : from;
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
