/**
 * Editor state.
 *
 * Connectivity and the compiled netlist are derived, never stored. Anything that
 * caches them has to remember to invalidate, and the moment that goes wrong the
 * simulator quietly runs the circuit you drew a minute ago.
 */

import { runFrequencySweep, runTransient, type FrequencyRun, type TransientRun } from './engine';
import { EXAMPLES, exampleById } from './examples';
import { sampleIndexAt } from './schematic/flow';
import { Trace, wireRef, type Step } from './trace';
import { findBurnouts, type Burnout } from './schematic/led';
import {
	GRID,
	defaultParams,
	definitionOf,
	migrateInstance,
	nextName,
	normaliseWire,
	pinPosition,
	pointKey,
	rotatePoint,
	simplifyPath,
	snap,
	validateParam,
	type Instance,
	type Point,
	type Rotation,
	type Schematic,
	type Wire
} from './schematic/model';
import { elbow } from './schematic/route';
import { compileSchematic } from './schematic/netlist';
import {
	buildConnectivity,
	mergeWireChains,
	openForPins,
	splitAtJunctions,
	trimOverlaps
} from './schematic/nets';

/**
 * Wiring used to be a mode of its own. It is not any more: dragging off a pin or
 * off an existing wire draws one, which is the gesture people reached for
 * anyway, and a wire has to land on something at both ends regardless — so a
 * mode whose whole job was drawing freely had nothing left to do.
 */
export type Tool = { mode: 'select' } | { mode: 'place'; kind: string } | { mode: 'wire' };

export interface ProbeInfo {
	/** Stable handle: a grid point the net passes through. */
	key: string;
	netIndex: number;
	analog?: string;
	digital?: string;
	label: string;
	colour: string;
}

/** Distinguishable at a glance, and readable on a dark background. */
export const TRACE_COLOURS = [
	'#4ea8ff',
	'#ffb454',
	'#5ddc9a',
	'#ff7b9c',
	'#c58bff',
	'#5ad4e6',
	'#ffe066',
	'#ff9b6a'
];

let idCounter = 0;
const freshId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/**
 * How a tool asks for a path between two points.
 *
 * `settling` is every wire whose shape this same operation is about to change.
 * All of them are excluded as obstacles, not just the one being routed: a gesture
 * recomputes wires one at a time, so the ones not reached yet are still sitting
 * where they used to be. Treating those as obstacles makes a route dodge a wire
 * that is about to move — a detour around a state that never appears on screen.
 */
export type RouteBetween = (
	from: Point,
	to: Point,
	settling: ReadonlySet<string>,
	/** The shape this wire already had, which the route is charged for leaving. */
	prefer?: readonly Point[]
) => Point[];

/** Everything a drag needs to recompute itself from scratch on each frame. */
interface MoveOrigin {
	instances: Map<string, Point>;
	wires: Map<string, Point[]>;
	/** Wires left in place, with the end indices riding along with the selection. */
	followers: Map<string, Set<number>>;
	/** Wires being dragged, with the end indices that must stay plugged in. */
	anchors: Map<string, Set<number>>;
	/**
	 * Pairs of pins sitting on the same point with only one of them moving.
	 *
	 * Two pins that touch are joined, with no wire to show for it. Pulling them
	 * apart would silently disconnect the parts — while the same drag on the same
	 * two parts joined by a visible wire keeps them connected, because a wire
	 * follows what it is plugged into. Same picture, opposite outcome, decided by
	 * history the drawing does not record.
	 *
	 * So a wire is drawn as they separate. The id is claimed up front because
	 * `applyMove` runs on every frame of the drag: a fresh one each time would
	 * leave a trail of wires behind the cursor.
	 */
	bonds: Bond[];
	/** The redo stack as it was, so cancelling the drag can hand it back. */
	future: HistoryEntry[];
}

/** A pin-to-pin joint that a drag is about to pull apart. */
interface Bond {
	/** Where both pins are while they are still touching. */
	at: Point;
	/** Id for the wire this becomes, held steady across the frames of the drag. */
	wireId: string;
}

/** A point on the undo stack: the drawing, and what was selected at the time. */
interface HistoryEntry {
	document: string;
	selection: string[];
}

const HISTORY_LIMIT = 100;
/**
 * Ceiling on the serialized undo stack.
 *
 * A hundred snapshots of a large schematic is tens of megabytes held for the
 * whole session. Eight is generous for any circuit that fits on a screen and
 * still bounds the worst case; the oldest entries are the first to go, being the
 * ones least likely to be wanted.
 */
const HISTORY_BYTES = 8 * 1024 * 1024;

class AppState {
	schematic = $state<Schematic>(EXAMPLES[0].build());
	tool = $state<Tool>({ mode: 'select' });
	selection = $state<string[]>([]);
	probes = $state<string[]>([]);
	stopTime = $state(EXAMPLES[0].stopTime);
	exampleId = $state(EXAMPLES[0].id);

	constructor() {
		// The circuit the app opens with is assigned to the field above, which is
		// the one way into the editor that skipped this. Loading an example, opening
		// a file and following a link all tidy first; the default did not, so the
		// schematic everybody sees on arrival was the only one still carrying wires
		// drawn in pieces — and a bare corner where two of them meet is a fixed
		// point that any re-route has to honour, which is what made dragging a part
		// send its wire up and over for no visible reason.
		this.tidyWires();
	}

	/** Net under the cursor, highlighted across every wire that carries it. */
	hoverNet = $state<number | null>(null);

	/**
	 * What has been done to this editor, in replayable form.
	 *
	 * Always on. The cost is a line of text per operation, and the alternative is
	 * what this project has been doing until now: reconstructing someone's path
	 * from a screenshot and a description, which has been wrong more often than it
	 * has been right.
	 */
	trace = new Trace();

	/** How a trace names the current selection: parts by name, wires by their ends. */
	private selectionRef(): { parts: string[]; wires: string[] } {
		const chosen = new Set(this.selection);
		return {
			parts: this.schematic.instances.filter((i) => chosen.has(i.id)).map((i) => i.name),
			wires: this.schematic.wires.filter((w) => chosen.has(w.id)).map((w) => wireRef(w.points))
		};
	}

	running = $state(false);
	result = $state<TransientRun | null>(null);
	error = $state<string | null>(null);
	/**
	 * Whether results are being kept up to date with the circuit.
	 *
	 * Set by pressing Run and cleared by anything that replaces the whole drawing.
	 * Nothing simulates before that: opening the app on a circuit that is already
	 * running gives no moment to look at it before it moves, and the first thing
	 * anyone does is change something anyway.
	 */
	live = $state(false);
	/**
	 * Something the user needs to know that is not a simulation failure — a share
	 * link that could not be read, a file that would not open.
	 *
	 * Separate from `error` because a run clears that one on success, which is
	 * right for "could not simulate" and quietly wrong for "the link you followed
	 * was broken": the default circuit would load, simulate happily, wipe the
	 * message, and leave someone looking at a circuit that is not the one they
	 * were sent.
	 */
	notice = $state<string | null>(null);

	/** Which analysis the Run button performs. */
	analysis = $state<'transient' | 'frequency'>('transient');
	/** Playback belongs to the transient result; stop it when leaving that mode. */
	setAnalysis(mode: 'transient' | 'frequency'): void {
		this.trace.record({ op: 'analysis', mode });
		if (mode === 'frequency') this.playing = false;
		this.analysis = mode;
	}
	acStart = $state(1);
	acStop = $state(1e6);
	acResult = $state<FrequencyRun | null>(null);

	/** Whether any source is set up to drive the frequency sweep. */
	hasAcDrive = $derived(
		this.schematic.instances.some(
			(i) => (i.kind === 'vsource' || i.kind === 'isource') && Number(i.params.ac) > 0
		)
	);

	// -- playback ---------------------------------------------------------

	playing = $state(false);
	/** Where in simulated time the live overlay is showing. */
	playbackTime = $state(0);
	/** How many times faster or slower than the default four-second replay. */
	playbackSpeed = $state(1);
	showVoltage = $state(true);
	showCurrent = $state(true);
	showLight = $state(true);
	/**
	 * Numbers on the drawing: what each net sits at, and what each part carries.
	 *
	 * Off by default. Colour and motion say *roughly* at a glance, which is what
	 * you want while watching something move; a number says exactly, which is what
	 * you want when you have stopped to check one. Showing both at once on every
	 * net buries the circuit under its own readout.
	 */
	showValues = $state(false);

	/**
	 * Which LEDs did not survive the run, and when each one went.
	 *
	 * The engine decides this during the run, not here — a failed part is open for
	 * the rest of it, so the waveforms already account for it. All this does is
	 * match the names back to the instances on the canvas.
	 */
	burnouts = $derived.by((): Burnout[] => {
		const run = this.result;
		if (!run || this.analysis !== 'transient') return [];
		return findBurnouts(this.schematic, run);
	});

	/**
	 * Current through a component at the instant playback is showing.
	 *
	 * What a probe on the schematic would read. Null when nothing has been run, or
	 * when the part is not in the result — a component added since the last run has
	 * no answer yet, and inventing a zero for it would read as "no current here"
	 * rather than "nobody asked".
	 */
	currentThrough(name: string): number | null {
		const run = this.result;
		if (!run || this.analysis !== 'transient') return null;
		const element = run.elementNames.indexOf(name);
		const series = element < 0 ? undefined : run.currents[element];
		if (!series) return null;
		return series[sampleIndexAt(run.time, this.playbackTime)] ?? null;
	}

	/** Simulated seconds per real second at the current speed setting. */
	get playbackRate(): number {
		return (this.stopTime / 4) * this.playbackSpeed;
	}

	/**
	 * Stop simulating and put the drawing back the way it was.
	 *
	 * Not the same as pausing playback, which freezes the overlay at an instant so
	 * it can be read. This clears the overlay off the schematic entirely — no
	 * voltage colours, no current, no lit LEDs — because the button that does it
	 * is the one that started the whole thing, and the opposite of running should
	 * be not running rather than running very slowly.
	 *
	 * The results themselves are kept: the scope still holds the traces, which are
	 * the record of the run and not something anyone asked to throw away.
	 */
	stop(): void {
		this.playing = false;
		this.live = false;
	}

	togglePlay(): void {
		if (!this.result) return;
		// Restarting from the end rather than sitting there doing nothing.
		if (!this.playing && this.playbackTime >= this.stopTime) this.playbackTime = 0;
		this.playing = !this.playing;
	}

	seek(time: number): void {
		this.playbackTime = Math.min(Math.max(time, 0), this.stopTime);
	}

	private past: HistoryEntry[] = [];
	private future: HistoryEntry[] = [];
	/** Running total of the serialized history, so it can be capped by size. */
	private historyBytes = 0;
	private clipboard: { instances: Instance[]; wires: Wire[] } | null = null;
	/** Snapshot taken at the start of a drag; null when nothing is being dragged. */
	private moveOrigin: MoveOrigin | null = null;
	private dragStarted = false;
	/**
	 * The gesture in flight, for the trace.
	 *
	 * A drag is recomputed from its starting snapshot on every frame, so only the
	 * offset it ends on decides the result. That is what gets written down, once,
	 * when the gesture is released — rather than a line per frame saying the same
	 * thing sixty times.
	 */
	private gesture: Step | null = null;

	compiled = $derived(compileSchematic(this.schematic));

	activeProbes = $derived.by((): ProbeInfo[] => {
		const compiled = this.compiled;
		const out: ProbeInfo[] = [];
		for (const key of this.probes) {
			const netIndex = this.netForProbe(key);
			if (netIndex === undefined) continue;
			const names = compiled.names.get(netIndex);
			const label = names?.analog ?? names?.digital;
			if (!label) continue;
			out.push({
				key,
				netIndex,
				analog: names?.analog,
				digital: names?.digital,
				label,
				colour: TRACE_COLOURS[out.length % TRACE_COLOURS.length]
			});
		}
		return out;
	});

	selectedInstances = $derived(
		this.schematic.instances.filter((i) => this.selection.includes(i.id))
	);

	canUndo = $derived(this.past.length > 0);

	// -- history ----------------------------------------------------------

	private snapshot(): HistoryEntry {
		return {
			document: JSON.stringify($state.snapshot(this.schematic)),
			selection: [...this.selection]
		};
	}

	/** Call immediately *before* mutating the schematic. */
	private checkpoint(): void {
		const entry = this.snapshot();
		// An operation that changed nothing should not cost an undo press.
		if (this.past[this.past.length - 1]?.document === entry.document) return;

		this.past.push(entry);
		this.historyBytes += entry.document.length;
		// Capped by size as well as by count: a hundred snapshots of a large
		// schematic is megabytes, and the oldest of them are worth the least.
		while (
			this.past.length > HISTORY_LIMIT ||
			(this.historyBytes > HISTORY_BYTES && this.past.length > 1)
		) {
			const dropped = this.past.shift();
			if (!dropped) break;
			this.historyBytes -= dropped.document.length;
		}
		this.future.length = 0;
	}

	/** Ids that still exist, so a restored selection cannot point at nothing. */
	private stillPresent(ids: readonly string[]): string[] {
		const present = new Set([
			...this.schematic.instances.map((i) => i.id),
			...this.schematic.wires.map((w) => w.id)
		]);
		return ids.filter((id) => present.has(id));
	}

	undo(): void {
		this.trace.record({ op: 'undo' });
		const previous = this.past.pop();
		if (!previous) return;
		this.historyBytes -= previous.document.length;
		this.future.push(this.snapshot());
		this.schematic = JSON.parse(previous.document) as Schematic;
		// Put the selection back too: undoing a nudge and finding nothing selected
		// means re-picking the thing you were working on every single time.
		this.selection = this.stillPresent(previous.selection);
	}

	redo(): void {
		this.trace.record({ op: 'redo' });
		const next = this.future.pop();
		if (!next) return;
		this.past.push(this.snapshot());
		this.historyBytes += this.past[this.past.length - 1].document.length;
		this.schematic = JSON.parse(next.document) as Schematic;
		this.selection = this.stillPresent(next.selection);
	}

	// -- editing ----------------------------------------------------------

	place(kind: string, x: number, y: number, rotation: Rotation = 0): Instance {
		this.checkpoint();
		const instance: Instance = {
			id: freshId(),
			kind,
			name: nextName(this.schematic.instances, kind),
			x,
			y,
			rotation,
			params: defaultParams(kind)
		};
		this.trace.record({ op: 'place', kind, x, y, rotation });
		this.schematic.instances.push(instance);
		this.makeRoomFor(instance);
		this.selection = [instance.id];
		return instance;
	}

	/**
	 * Break any wire the part is now standing on, so it goes in series.
	 *
	 * Dropping a component onto a wire is how one gets put in a circuit, and it is
	 * what deleting a part and letting the gap heal leaves you set up to do. Left
	 * alone the wire runs straight past the new part and shorts it out, which is
	 * invisible on the canvas — a symbol on a line with a pin touching at either
	 * end is exactly what a series connection looks like.
	 */
	private makeRoomFor(instance: Instance): void {
		const pins = definitionOf(instance.kind).pins.map((pin) => pinPosition(instance, pin));
		this.schematic.wires = openForPins(this.schematic, pins, freshId);
	}

	addWire(x1: number, y1: number, x2: number, y2: number): void {
		this.addWirePath([
			{ x: x1, y: y1 },
			{ x: x2, y: y2 }
		]);
	}

	/**
	 * Commit a routed path as one wire.
	 *
	 * One wire, not one per segment: it is one thing the user drew, and it should
	 * be one thing they can select, move and delete. The routing decision belongs
	 * to the tool that drew it, so the preview and the committed geometry cannot
	 * disagree.
	 */
	addWirePath(points: ReadonlyArray<Point>): void {
		const path = simplifyPath(points);
		if (path.length < 2) return;
		this.trace.record({ op: 'wire', points: path.map((q) => ({ x: q.x, y: q.y })) });
		this.checkpoint();
		this.schematic.wires.push({ id: freshId(), points: path });
		this.tidyWires();
	}

	/**
	 * Fold wires that meet end to end back into single runs.
	 *
	 * Called after anything that changes wire structure. Never during a drag: the
	 * shape does not change, but the identities do, and the gesture is holding a
	 * snapshot keyed by them.
	 */
	private tidyWires(): void {
		const original = this.schematic.wires;
		let wires = original;
		const step = (next: Wire[]) => {
			wires = next;
		};

		// A wire whose ends have arrived at the same point is not a wire any more.
		// Dragging a component until one of its pins touches another is a supported
		// way to connect two parts, and when a wire already ran between those two
		// pins it collapses to nothing: the connection is now the pins themselves.
		// Left in the document it is invisible but real — selectable, saved to file,
		// carried in a share link.
		step(wires.filter((w) => w.points.length >= 2));
		step(mergeWireChains({ ...this.schematic, wires }));

		// A wire that ends up running along another one is two conductors on the
		// same line — the thing the router pays most to avoid. Moving a wire whose
		// end is pinned somewhere can produce exactly that, doubling back along a
		// neighbour to reach where it was plugged in.
		step(trimOverlaps({ ...this.schematic, wires }));
		// Trimming can leave two wires meeting end to end, which is a joint worth
		// folding away for the same reasons as any other.
		step(mergeWireChains({ ...this.schematic, wires }));

		// Last, because trimming is what creates most of these: a wire cut back to
		// where it meets another one now ends partway along it, and a branch resting
		// on someone else's segment is not carried when that segment moves.
		step(splitAtJunctions({ ...this.schematic, wires }, freshId));

		// Tidying rearranges wires without ever meaning to change what is joined to
		// what. Each step argues it cannot; between them the arguments have failed
		// before, and a silent disconnection is the worst thing this editor can do.
		// So the claim is checked rather than trusted, and a tidy that would break
		// the circuit is dropped instead — the drawing stays untidy, which is a far
		// smaller problem than a wire that stopped conducting without saying so.
		const before = buildConnectivity(this.schematic).nets.length;
		const after = buildConnectivity({ ...this.schematic, wires }).nets.length;
		this.schematic.wires = after > before ? original : wires;
	}

	/**
	 * Delete the selection, closing the gap where that is unambiguous.
	 *
	 * Pulling a resistor out of a series chain used to leave two wires reaching
	 * for a component that no longer existed — two loose ends and a broken net,
	 * where the obvious reading is "join what it was between". So a two-pin part
	 * with wires on both pins is healed with a route across the gap. Anything with
	 * three or more pins is left alone: there is no one right answer for which of
	 * them should be joined to which.
	 */
	deleteSelection(route?: RouteBetween): void {
		if (this.selection.length === 0) return;
		this.trace.record({ op: 'delete', ...this.selectionRef() });
		this.checkpoint();
		const doomed = new Set(this.selection);

		const survivingWires = this.schematic.wires.filter((w) => !doomed.has(w.id));
		const wireEnds = new Set<string>();
		for (const wire of survivingWires) {
			for (const index of [0, wire.points.length - 1]) {
				wireEnds.add(pointKey(wire.points[index].x, wire.points[index].y));
			}
		}

		const gaps: Array<[Point, Point]> = [];
		for (const instance of this.schematic.instances) {
			if (!doomed.has(instance.id)) continue;
			const pins = definitionOf(instance.kind).pins;
			if (pins.length !== 2) continue;
			const [a, b] = pins.map((pin) => pinPosition(instance, pin));
			if (wireEnds.has(pointKey(a.x, a.y)) && wireEnds.has(pointKey(b.x, b.y))) gaps.push([a, b]);
		}

		this.schematic.instances = this.schematic.instances.filter((i) => !doomed.has(i.id));
		this.schematic.wires = survivingWires;
		this.selection = [];

		const healing = new Set(gaps.map(() => freshId()));
		const ids = [...healing];
		gaps.forEach(([a, b], index) => {
			// Routed after the removal, so the path may run through where the
			// component used to be — which is exactly where it should go.
			const id = ids[index];
			const path = simplifyPath(route ? route(a, b, healing) : elbow(a, b));
			if (path.length >= 2) this.schematic.wires.push({ id, points: path });
		});

		// Removing a component can leave two wires meeting at a bare point.
		this.tidyWires();
	}

	/**
	 * Turn the selection a quarter turn, bringing its wires along.
	 *
	 * The whole selection orbits its own centre, rather than each part spinning
	 * where it stands: turning a sub-circuit should turn the *arrangement*, not
	 * scramble it in place. For a single component the centre is its own origin,
	 * so a lone part still rotates on the spot.
	 *
	 * Rotation moves pins just as surely as dragging does, so it honours the same
	 * rule: a wire plugged into a pin stays plugged into it. Unlike a drag, every
	 * pin moves somewhere different, so the mapping is per pin rather than one
	 * shared offset.
	 */
	rotateSelection(route?: RouteBetween): void {
		if (this.selection.length === 0) return;
		const chosen = new Set(this.selection);
		const rotating = this.schematic.instances.filter((i) => chosen.has(i.id));
		const turning = this.schematic.wires.filter((w) => chosen.has(w.id));
		if (rotating.length === 0 && turning.length === 0) return;

		this.trace.record({ op: 'rotate', ...this.selectionRef() });
		this.checkpoint();

		// Snapped, so an odd-sized group still lands on the lattice.
		const xs = [...rotating.map((i) => i.x), ...turning.flatMap((w) => w.points.map((p) => p.x))];
		const ys = [...rotating.map((i) => i.y), ...turning.flatMap((w) => w.points.map((p) => p.y))];
		const pivot = {
			x: snap((Math.min(...xs) + Math.max(...xs)) / 2),
			y: snap((Math.min(...ys) + Math.max(...ys)) / 2)
		};
		/** A quarter turn about the pivot, matching `rotatePoint`'s direction. */
		const orbit = (p: Point): Point => ({
			x: pivot.x - (p.y - pivot.y),
			y: pivot.y + (p.x - pivot.x)
		});

		const stationaryPins = new Set<string>();
		for (const instance of this.schematic.instances) {
			if (chosen.has(instance.id)) continue;
			for (const pin of definitionOf(instance.kind).pins) {
				const at = pinPosition(instance, pin);
				stationaryPins.add(pointKey(at.x, at.y));
			}
		}

		// Where each pin was, and where it is about to be.
		const moved = new Map<string, Point>();
		for (const instance of rotating) {
			const before = definitionOf(instance.kind).pins.map((pin) => pinPosition(instance, pin));
			const at = orbit({ x: instance.x, y: instance.y });
			instance.x = at.x;
			instance.y = at.y;
			instance.rotation = ((instance.rotation + 90) % 360) as Rotation;
			const after = definitionOf(instance.kind).pins.map((pin) => pinPosition(instance, pin));
			before.forEach((from, index) => {
				const key = pointKey(from.x, from.y);
				// A point also held by something stationary keeps its wire.
				if (!stationaryPins.has(key)) moved.set(key, after[index]);
			});
		}

		// Wires in the selection turn with it, keeping the group's shape.
		for (const wire of turning) wire.points = simplifyPath(wire.points.map(orbit));

		// Worked out in full before any of it is routed, so each wire is routed
		// against where everything is going rather than where half of it was.
		const pending: Array<{ wire: Wire; from: Point; to: Point }> = [];
		for (const wire of this.schematic.wires) {
			if (chosen.has(wire.id)) continue;
			const ends = [0, wire.points.length - 1];
			let changed = false;
			const points = wire.points.map((p) => ({ x: p.x, y: p.y }));

			for (const index of ends) {
				const target = moved.get(pointKey(points[index].x, points[index].y));
				if (!target) continue;
				points[index] = { x: target.x, y: target.y };
				changed = true;
			}
			if (changed) pending.push({ wire, from: points[0], to: points[points.length - 1] });
		}

		const settling = new Set([...turning.map((w) => w.id), ...pending.map((p) => p.wire.id)]);
		for (const { wire, from, to } of pending) {
			wire.points = route ? simplifyPath(route(from, to, settling)) : simplifyPath(elbow(from, to));
		}

		this.tidyWires();
	}

	/**
	 * Snapshot everything a drag will touch, before it moves.
	 *
	 * The whole gesture is then a pure function of how far the pointer has
	 * travelled, recomputed from this snapshot each frame. That is what makes
	 * dragging and releasing behave identically: there is only one code path, so
	 * the shape under the cursor is the shape that lands.
	 */
	beginMove(): void {
		const chosen = new Set(this.selection);

		// Pins are what hold a wire end in place. Kept apart from wire ends on
		// purpose: two wires meeting on the same moving pin should both follow it,
		// so they must not count as anchoring each other.
		const stationaryPins = new Set<string>();
		const movingPins = new Set<string>();

		for (const instance of this.schematic.instances) {
			const moving = chosen.has(instance.id);
			for (const pin of definitionOf(instance.kind).pins) {
				const at = pinPosition(instance, pin);
				(moving ? movingPins : stationaryPins).add(pointKey(at.x, at.y));
			}
		}

		// A wire being dragged also stays plugged into other wires it meets.
		const stationaryWireEnds = new Set<string>();
		for (const wire of this.schematic.wires) {
			if (chosen.has(wire.id)) continue;
			for (const index of [0, wire.points.length - 1]) {
				const p = wire.points[index];
				stationaryWireEnds.add(pointKey(p.x, p.y));
			}
		}

		const followers = new Map<string, Set<number>>();
		const anchors = new Map<string, Set<number>>();

		for (const wire of this.schematic.wires) {
			const ends = [0, wire.points.length - 1];
			if (chosen.has(wire.id)) {
				// A wire being dragged keeps hold of whatever it is plugged into.
				const held = new Set<number>();
				for (const index of ends) {
					const key = pointKey(wire.points[index].x, wire.points[index].y);
					if (stationaryPins.has(key) || stationaryWireEnds.has(key)) held.add(index);
				}
				if (held.size > 0) anchors.set(wire.id, held);
				continue;
			}

			const following = new Set<number>();
			for (const index of ends) {
				const key = pointKey(wire.points[index].x, wire.points[index].y);
				// Follows only if the point is leaving entirely. A point shared with a
				// stationary pin stays put, or moving one of two parts joined
				// pin-to-pin would take the wire off the one left behind.
				if (movingPins.has(key) && !stationaryPins.has(key)) following.add(index);
			}
			if (following.size > 0) followers.set(wire.id, following);
		}

		// A joint made of two touching pins, one of them about to leave. Only when
		// no wire already ends there: if one does it will follow the moving pin by
		// itself, and adding a second would double the connection.
		const wireEnds = new Set<string>();
		for (const wire of this.schematic.wires) {
			for (const index of [0, wire.points.length - 1]) {
				wireEnds.add(pointKey(wire.points[index].x, wire.points[index].y));
			}
		}
		const bonds: Bond[] = [];
		for (const key of movingPins) {
			if (!stationaryPins.has(key) || wireEnds.has(key)) continue;
			const [x, y] = key.split(',').map(Number);
			bonds.push({ at: { x, y }, wireId: freshId() });
		}

		this.moveOrigin = {
			instances: new Map(
				this.schematic.instances
					.filter((i) => chosen.has(i.id))
					.map((i) => [i.id, { x: i.x, y: i.y }] as const)
			),
			wires: new Map(
				this.schematic.wires
					.filter((w) => chosen.has(w.id) || followers.has(w.id))
					.map((w) => [w.id, w.points.map((p) => ({ x: p.x, y: p.y }))] as const)
			),
			followers,
			anchors,
			bonds,
			future: [...this.future]
		};
		this.dragStarted = false;
	}

	/**
	 * Place the selection at `dx, dy` from where the drag began.
	 *
	 * Absolute rather than incremental: recomputing from the snapshot means the
	 * result cannot drift over a long gesture, and the same call with the final
	 * offset is what commits — so there is no "it tidied itself up on release".
	 */
	applyMove(dx: number, dy: number, route: RouteBetween): void {
		const origin = this.moveOrigin;
		if (!origin) return;
		if (dx === 0 && dy === 0 && !this.dragStarted) return;

		this.gesture = { op: 'move', ...this.selectionRef(), dx, dy };

		if (!this.dragStarted) {
			// One history entry per gesture, taken on the first actual movement.
			this.checkpoint();
			this.dragStarted = true;
		}

		for (const instance of this.schematic.instances) {
			const from = origin.instances.get(instance.id);
			if (!from) continue;
			instance.x = from.x + dx;
			instance.y = from.y + dy;
		}

		// Every wire this move rewrites. None of them is an obstacle for the
		// others: their positions are all in mid-air until the pass finishes.
		const settling = new Set([...origin.wires.keys(), ...origin.bonds.map((b) => b.wireId)]);

		// Pins that were touching and are not any more: the joint becomes a wire.
		// Torn down and rebuilt from the snapshot on every frame like everything
		// else here, so dragging back until they touch again removes it, and what
		// the preview shows is what lands.
		const separated = dx !== 0 || dy !== 0;
		this.schematic.wires = this.schematic.wires.filter(
			(w) => !origin.bonds.some((b) => b.wireId === w.id)
		);
		if (separated) {
			for (const bond of origin.bonds) {
				const moved = { x: bond.at.x + dx, y: bond.at.y + dy };
				this.schematic.wires.push({
					id: bond.wireId,
					points: simplifyPath(route(bond.at, moved, settling))
				});
			}
		}

		for (const wire of this.schematic.wires) {
			const from = origin.wires.get(wire.id);
			if (!from) continue;

			const held = origin.anchors.get(wire.id);
			const following = origin.followers.get(wire.id);

			if (held) {
				// A dragged wire: the body moves, plugged-in ends stay, and the wire
				// grows a leg to reach back to them.
				let path = from.map((p) => ({ x: p.x + dx, y: p.y + dy }));
				if (held.has(from.length - 1)) {
					const anchor = from[from.length - 1];
					path = [...path, ...elbow(path[path.length - 1], anchor).slice(1)];
				}
				if (held.has(0)) {
					const anchor = from[0];
					path = [...elbow(anchor, path[0]).slice(0, -1), ...path];
				}
				wire.points = simplifyPath(path);
				continue;
			}

			if (following) {
				const moved = new Set(following);
				if (moved.size === 2) {
					// Both ends riding along: the whole thing travels, shape intact.
					wire.points = from.map((p) => ({ x: p.x + dx, y: p.y + dy }));
					continue;
				}

				/*
				 * One end riding along.
				 *
				 * There used to be two answers here — stretch the end and keep the old
				 * drawing, or re-route and redraw it — with a growing list of yes/no
				 * tests to pick between them: does it cross a body, is it more than one
				 * bend worse, does it double back on itself. Every reported case was one
				 * where neither candidate was what anyone wanted, and each fix added
				 * another test to the list.
				 *
				 * The question those tests were groping at is not *keep or redraw* but
				 * *how much of what was drawn is still worth keeping*, which is a matter
				 * of degree and belongs in the router's cost function. So: one route,
				 * handed the shape the wire already had. Departing from it costs, and
				 * everything the old rules were reaching for falls out of that — the
				 * rail under a lowered ground stays because moving all of it costs more
				 * than a stub, the feed under a part dragged sideways slides because
				 * moving a little of it costs less than a corner, and a stale detour is
				 * dropped because keeping it no longer pays for its own length.
				 */
				const last = from.length - 1;
				const ends = {
					start: moved.has(0) ? { x: from[0].x + dx, y: from[0].y + dy } : from[0],
					end: moved.has(last) ? { x: from[last].x + dx, y: from[last].y + dy } : from[last]
				};
				wire.points = simplifyPath(route(ends.start, ends.end, settling, from));
				continue;
			}

			wire.points = from.map((p) => ({ x: p.x + dx, y: p.y + dy }));
		}
	}

	/**
	 * Drag one leg of a wire, leaving the rest of it where it is.
	 *
	 * This is how a wire's shape gets edited. Dragging a two-point wire moves the
	 * whole thing, because the whole thing *is* one leg — so the old behaviour is
	 * the degenerate case of this one, and a wire with corners becomes editable
	 * without a second gesture to learn.
	 *
	 * A leg only moves across itself: sliding it along its own axis would shuffle
	 * its corners and change nothing anyone can see.
	 */
	applySegmentMove(wireId: string, index: number, dx: number, dy: number): void {
		const origin = this.moveOrigin;
		if (!origin) return;
		const from = origin.wires.get(wireId);
		if (!from || index < 0 || index + 1 >= from.length) return;
		if (dx === 0 && dy === 0 && !this.dragStarted) return;

		if (!this.dragStarted) {
			this.checkpoint();
			this.dragStarted = true;
		}

		const wire = this.schematic.wires.find((w) => w.id === wireId);
		if (!wire) return;

		this.gesture = { op: 'segment', wire: wireRef(from), index, dx, dy };

		const held = origin.anchors.get(wireId);
		if (!held || held.size === 0) {
			// Plugged into nothing, so there is no shape to preserve: it all slides.
			wire.points = from.map((p) => ({ x: p.x + dx, y: p.y + dy }));
			return;
		}

		const last = from.length - 1;
		const horizontal = from[index].y === from[index + 1].y;
		const shift = horizontal ? { x: 0, y: dy } : { x: dx, y: 0 };

		const points = from.map((p) => ({ x: p.x, y: p.y }));
		points[index] = { x: from[index].x + shift.x, y: from[index].y + shift.y };
		points[index + 1] = { x: from[index + 1].x + shift.x, y: from[index + 1].y + shift.y };

		// An end that is plugged in stays plugged in: the wire grows a corner
		// rather than pulling off the pin. Dragging the same leg back straightens
		// it out again, since `simplifyPath` drops the corner once it is collinear.
		if (index === 0 && held.has(0)) points.unshift({ x: from[0].x, y: from[0].y });
		if (index + 1 === last && held.has(last)) points.push({ x: from[last].x, y: from[last].y });

		wire.points = simplifyPath(points);
	}

	/**
	 * Abandon the drag and put everything back where it started.
	 *
	 * Escape means cancel, everywhere. Without this the gesture carried on to
	 * completion with the selection torn out from under it, so the parts landed
	 * wherever the pointer happened to stop and nothing was left selected to undo
	 * it with — the one outcome nobody wants from pressing Escape.
	 */
	cancelMove(): void {
		const origin = this.moveOrigin;
		if (!origin) return;

		for (const instance of this.schematic.instances) {
			const from = origin.instances.get(instance.id);
			if (!from) continue;
			instance.x = from.x;
			instance.y = from.y;
		}
		for (const wire of this.schematic.wires) {
			const from = origin.wires.get(wire.id);
			if (from) wire.points = from.map((p) => ({ x: p.x, y: p.y }));
		}
		// Putting things back is not enough on its own: a drag can *add* a wire, by
		// separating two pins that were touching. Restoring only the ones that
		// existed would leave that one behind, still drawn between two parts now
		// sitting on top of each other again.
		if (origin.bonds.length > 0) {
			this.schematic.wires = this.schematic.wires.filter(
				(w) => !origin.bonds.some((b) => b.wireId === w.id)
			);
		}

		if (this.dragStarted) {
			// The checkpoint was taken on the first movement. There is nothing left to
			// undo, so it goes, and the redo stack it cleared comes back.
			const dropped = this.past.pop();
			if (dropped) this.historyBytes -= dropped.document.length;
			this.future = origin.future;
		}

		this.moveOrigin = null;
		this.dragStarted = false;
		this.gesture = null;
	}

	/** Release the snapshot. The geometry is already final. */
	endMove(): void {
		const changed = this.dragStarted;
		if (changed && this.gesture) this.trace.record(this.gesture);
		this.gesture = null;
		this.moveOrigin = null;
		this.dragStarted = false;
		// Deliberately *not* opening wires for what was dragged, though dropping a
		// part onto one means the same thing as placing it there. Measured over a
		// thousand random drags it tripled the number that came apart: a part
		// shuffled a few units often ends with a pin grazing some unrelated wire,
		// and cutting that wire rewires a circuit nobody asked to rewire. Placing
		// is unambiguous — you chose that spot for a part that was not there before
		// — and a drag is not. The short-circuit warning covers what is left.
		//
		// Merging only ever removes a joint, never moves a point, so nothing on
		// screen shifts when this runs.
		if (changed) this.tidyWires();
	}

	/** Pin positions of the components a drag is carrying, at a given offset. */
	movingPinsAt(dx: number, dy: number): Point[] {
		const origin = this.moveOrigin;
		if (!origin) return [];
		const out: Point[] = [];
		for (const instance of this.schematic.instances) {
			const from = origin.instances.get(instance.id);
			if (!from) continue;
			for (const pin of definitionOf(instance.kind).pins) {
				const at = rotatePoint(pin.x, pin.y, instance.rotation);
				out.push({ x: from.x + dx + at.x, y: from.y + dy + at.y });
			}
		}
		return out;
	}

	get isMoving(): boolean {
		return this.moveOrigin !== null;
	}

	/**
	 * Set a parameter. Returns why it was refused, or null on success.
	 *
	 * Refusing rather than clamping, and saying so rather than not: a zero
	 * resistance used to become 1 nΩ and a negative one its own magnitude, both
	 * silently, so the circuit that ran was not the circuit on screen.
	 */
	setParam(id: string, key: string, value: number | string): string | null {
		const instance = this.schematic.instances.find((i) => i.id === id);
		if (!instance) return null;

		const param = definitionOf(instance.kind).params.find((p) => p.key === key);
		const refusal = param ? validateParam(param, value) : null;
		if (refusal) return refusal;

		if (instance.params[key] === value) return null;
		this.trace.record({ op: 'param', part: instance.name, key, value });
		this.checkpoint();
		instance.params[key] = value;
		return null;
	}

	/** Rename a component. Returns why it was refused, or null on success. */
	rename(id: string, name: string): string | null {
		const trimmed = name.trim();
		const instance = this.schematic.instances.find((i) => i.id === id);
		if (!instance) return null;
		if (!trimmed) return 'A component needs a name.';
		if (this.schematic.instances.some((i) => i.id !== id && i.name === trimmed)) {
			return `${trimmed} is already taken.`;
		}
		this.trace.record({ op: 'rename', part: instance.name, to: trimmed });
		if (instance.name === trimmed) return null;
		this.checkpoint();
		instance.name = trimmed;
		return null;
	}

	clear(): void {
		this.trace.record({ op: 'clear' });
		this.checkpoint();
		this.schematic = { instances: [], wires: [] };
		this.selection = [];
		this.probes = [];
		this.result = null;
	}

	// -- clipboard --------------------------------------------------------

	/** Copy the selection. Returns false when there was nothing to copy. */
	copySelection(): boolean {
		const chosen = new Set(this.selection);
		if (chosen.size === 0) return false;

		this.clipboard = {
			instances: this.schematic.instances
				.filter((i) => chosen.has(i.id))
				.map((i) => structuredClone($state.snapshot(i)) as Instance),
			wires: this.schematic.wires
				.filter((w) => chosen.has(w.id))
				.map((w) => structuredClone($state.snapshot(w)) as Wire)
		};
		return true;
	}

	get hasClipboard(): boolean {
		return this.clipboard !== null;
	}

	/**
	 * Paste the clipboard. With `at`, the copied group's top-left corner lands
	 * there; without, it is nudged clear of the original so the two do not sit
	 * exactly on top of each other and look like one.
	 */
	paste(at?: { x: number; y: number }): void {
		if (!this.clipboard) return;
		const { instances, wires } = this.clipboard;
		if (instances.length === 0 && wires.length === 0) return;

		const xs = [...instances.map((i) => i.x), ...wires.flatMap((w) => w.points.map((p) => p.x))];
		const ys = [...instances.map((i) => i.y), ...wires.flatMap((w) => w.points.map((p) => p.y))];
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		const dx = at ? snap(at.x) - snap(minX) : GRID * 3;
		const dy = at ? snap(at.y) - snap(minY) : GRID * 3;

		this.checkpoint();
		const existing = [...this.schematic.instances];
		const fresh: string[] = [];

		for (const source of instances) {
			// Names have to be regenerated as we go, or pasting three resistors
			// would produce three of whatever R-number was free at the start.
			const copy: Instance = {
				...structuredClone(source),
				id: freshId(),
				name: nextName(existing, source.kind),
				x: source.x + dx,
				y: source.y + dy
			};
			existing.push(copy);
			this.schematic.instances.push(copy);
			fresh.push(copy.id);
		}

		for (const source of wires) {
			const copy: Wire = {
				id: freshId(),
				points: source.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
			};
			this.schematic.wires.push(copy);
			fresh.push(copy.id);
		}

		this.selection = fresh;
	}

	duplicateSelection(): void {
		if (!this.copySelection()) return;
		this.paste();
	}

	// -- probes -----------------------------------------------------------

	/**
	 * Resolve a probe handle to a net.
	 *
	 * Handles come in two forms. A pin — `pin:<instance>:<name>` — survives being
	 * moved, rotated or re-routed, which a bare coordinate does not: drag a whole
	 * circuit across the canvas and every point-keyed probe silently stops
	 * matching anything. A coordinate is the fallback for a net with no pins on it.
	 */
	private netForProbe(key: string): number | undefined {
		if (key.startsWith('pin:')) {
			return this.compiled.connectivity.netOfPin.get(key.slice(4));
		}
		return this.compiled.connectivity.netOfPoint.get(key);
	}

	/** The most durable handle for the net at a grid point. */
	private probeHandle(pointKeyValue: string): string | null {
		const netIndex = this.compiled.connectivity.netOfPoint.get(pointKeyValue);
		if (netIndex === undefined) return null;
		const net = this.compiled.connectivity.nets[netIndex];
		const pin = net?.pins[0];
		return pin ? `pin:${pin.instance.id}:${pin.pin.name}` : pointKeyValue;
	}

	toggleProbe(key: string): void {
		const netIndex = this.compiled.connectivity.netOfPoint.get(key);
		if (netIndex === undefined) return;
		// Probe the net, not the point: clicking anywhere on the same wire toggles
		// the same trace.
		const existing = this.probes.find((k) => this.netForProbe(k) === netIndex);
		if (existing) {
			this.probes = this.probes.filter((k) => k !== existing);
			return;
		}
		const handle = this.probeHandle(key);
		if (handle) this.probes = [...this.probes, handle];
	}

	isProbed(netIndex: number): boolean {
		return this.activeProbes.some((p) => p.netIndex === netIndex);
	}

	/** Pick a few interesting nets so a freshly loaded circuit plots something. */
	autoProbe(): void {
		const compiled = compileSchematic(this.schematic);
		const chosen: string[] = [];
		for (const net of compiled.connectivity.nets) {
			if (chosen.length >= 4) break;
			if (net.isGround) continue;
			const names = compiled.names.get(net.index);
			if (!names?.analog && !names?.digital) continue;
			// Prefer nets with a wire on them; a lone pin is rarely what you want.
			if (net.points.length < 2) continue;
			const pin = net.pins[0];
			chosen.push(pin ? `pin:${pin.instance.id}:${pin.pin.name}` : net.points[0]);
		}
		this.probes = chosen;
	}

	// -- examples ---------------------------------------------------------

	loadExample(id: string): void {
		const example = exampleById(id);
		this.trace.record({ op: 'example', id: example.id });
		this.past.length = 0;
		this.future.length = 0;
		this.schematic = example.build();
		this.tidyWires();
		this.stopTime = example.stopTime;
		this.exampleId = example.id;
		// Each example arrives in whichever analysis actually shows it off — a
		// resonant filter has nothing to say in the time domain.
		this.analysis = example.analysis ?? 'transient';
		if (example.frequencyRange) {
			this.acStart = example.frequencyRange.start;
			this.acStop = example.frequencyRange.stop;
		}
		this.selection = [];
		this.result = null;
		this.acResult = null;
		this.error = null;
		this.notice = null;
		this.live = false;
		this.playing = false;
		this.autoProbe();
	}

	/** Adopt a circuit that arrived in a link. */
	loadShared(circuit: { schematic: Schematic; stopTime: number }): void {
		this.past.length = 0;
		this.future.length = 0;
		this.schematic = circuit.schematic;
		this.tidyWires();
		this.stopTime = circuit.stopTime;
		this.exampleId = '';
		this.selection = [];
		this.result = null;
		this.error = null;
		this.notice = null;
		this.live = false;
		this.playing = false;
		this.autoProbe();
	}

	// -- persistence ------------------------------------------------------

	toJSON(): string {
		return JSON.stringify(
			{ version: 1, schematic: this.schematic, stopTime: this.stopTime, probes: this.probes },
			null,
			2
		);
	}

	fromJSON(text: string): void {
		const parsed = JSON.parse(text) as {
			schematic?: Schematic;
			stopTime?: number;
			probes?: string[];
		};
		if (!parsed.schematic?.instances) throw new Error('That file is not a repath schematic.');
		// Re-key everything so a pasted circuit cannot collide with what is open.
		const remap = new Map<string, string>();
		const instances = parsed.schematic.instances.map((instance) => {
			const id = freshId();
			remap.set(instance.id, id);
			const migrated = migrateInstance({ ...instance, id });
			definitionOf(migrated.kind); // throws early on an unknown component
			return migrated;
		});
		// Files written before wires became polylines still load: the two-point
		// form is upgraded rather than rejected.
		const wires = (parsed.schematic.wires ?? [])
			.map((wire) => normaliseWire(wire, freshId()))
			.filter((wire): wire is Wire => wire !== null);

		this.past.length = 0;
		this.future.length = 0;
		this.schematic = { instances, wires };
		this.tidyWires();
		this.stopTime = parsed.stopTime ?? 1e-3;
		this.probes = parsed.probes ?? [];
		this.selection = [];
		this.result = null;
		this.error = null;
		this.notice = null;
		this.live = false;
		this.playing = false;
	}

	/** Change the length of a run, and write it down. */
	setStopTime(seconds: number): void {
		if (!(seconds > 0) || seconds === this.stopTime) return;
		this.trace.record({ op: 'stop', seconds });
		this.stopTime = seconds;
	}

	/**
	 * Re-perform a recorded trace, from wherever the editor is now.
	 *
	 * `route` is passed in rather than reached for, so a replay routes exactly the
	 * way the select tool does — a replay that used a different router would be
	 * reproducing a different editor.
	 *
	 * Stops at the first step it cannot carry out and says which. That failure is
	 * information, not an inconvenience: a step referring to a part or a wire that
	 * is not there means the replay had already diverged from the recording before
	 * whatever anyone was trying to look at.
	 */
	replay(steps: readonly Step[], route: RouteBetween): { done: number; failed?: string } {
		const partId = (name: string) => this.schematic.instances.find((i) => i.name === name)?.id;
		const wireId = (ref: string) =>
			this.schematic.wires.find((w) => wireRef(w.points) === ref)?.id;

		for (const [index, step] of steps.entries()) {
			const stop = (why: string) => ({ done: index, failed: `step ${index + 1} (${step.op}): ${why}` });
			switch (step.op) {
				case 'example':
					this.loadExample(step.id);
					break;
				case 'clear':
					this.clear();
					break;
				case 'place':
					this.place(step.kind, step.x, step.y, step.rotation);
					break;
				case 'wire':
					this.addWirePath(step.points);
					break;
				case 'undo':
					this.undo();
					break;
				case 'redo':
					this.redo();
					break;
				case 'run':
					// Left to the caller: a replay is about the drawing, and awaiting the
					// engine here would make every step of it asynchronous.
					break;
				case 'analysis':
					this.setAnalysis(step.mode === 'frequency' ? 'frequency' : 'transient');
					break;
				case 'stop':
					this.setStopTime(step.seconds);
					break;
				case 'rename': {
					const id = partId(step.part);
					if (!id) return stop(`no component named ${step.part}`);
					this.rename(id, step.to);
					break;
				}
				case 'param': {
					const id = partId(step.part);
					if (!id) return stop(`no component named ${step.part}`);
					this.setParam(id, step.key, step.value);
					break;
				}
				case 'segment': {
					const id = wireId(step.wire);
					if (!id) return stop(`no wire running ${step.wire}`);
					this.selection = [id];
					this.beginMove();
					this.applySegmentMove(id, step.index, step.dx, step.dy);
					this.endMove();
					break;
				}
				case 'delete':
				case 'rotate':
				case 'move': {
					const ids: string[] = [];
					for (const name of step.parts) {
						const id = partId(name);
						if (!id) return stop(`no component named ${name}`);
						ids.push(id);
					}
					for (const ref of step.wires) {
						const id = wireId(ref);
						if (!id) return stop(`no wire running ${ref}`);
						ids.push(id);
					}
					this.selection = ids;
					if (step.op === 'delete') this.deleteSelection(route);
					else if (step.op === 'rotate') this.rotateSelection(route);
					else {
						this.beginMove();
						this.applyMove(step.dx, step.dy, route);
						this.endMove();
					}
					break;
				}
			}
		}
		return { done: steps.length };
	}

	// -- simulation -------------------------------------------------------

	/**
	 * A fingerprint of what the engine would actually be given.
	 *
	 * Only the netlist, so moving a part around does not count as a change: the
	 * drawing shifts on every frame of a drag, and re-simulating for that would be
	 * a lot of work to arrive at the same answer.
	 */
	get netlistSignature(): string {
		const compiled = this.compiled;
		if (!compiled.netlist) return `error:${compiled.errors.join('|')}`;
		return JSON.stringify([compiled.netlist, this.stopTime, this.analysis, this.acStart, this.acStop]);
	}

	/**
	 * Simulate.
	 *
	 * `keepPlayback` is for a re-run that follows an edit rather than a press:
	 * restarting the animation every time a value moves would make the overlay
	 * unwatchable while you are turning a knob.
	 */
	async run(options: { keepPlayback?: boolean } = {}): Promise<void> {
		// Only a deliberate press. A live re-run after an edit follows from the edit
		// that is already written down, and logging it would double every line.
		if (!options.keepPlayback) this.trace.record({ op: 'run' });
		const compiled = this.compiled;
		if (!compiled.netlist) {
			this.error = compiled.errors.join(' ');
			this.result = null;
			return;
		}
		this.running = true;
		this.error = null;
		this.live = true;
		try {
			if (this.analysis === 'frequency') {
				if (!this.hasAcDrive) {
					throw new Error(
						'No source is driving the sweep. Set a voltage source’s AC drive to 1 to make it the input.'
					);
				}
				this.acResult = await runFrequencySweep(compiled.netlist, this.acStart, this.acStop);
				if (this.probes.length === 0) this.autoProbe();
			} else {
				// At least a few hundred points, so a flat trace still looks like a
				// line rather than two dots joined up.
				const was = { time: this.playbackTime, playing: this.playing };
				this.result = await runTransient(compiled.netlist, this.stopTime, this.stopTime / 400);
				if (this.probes.length === 0) this.autoProbe();
				if (options.keepPlayback) {
					this.playbackTime = Math.min(was.time, this.stopTime);
					this.playing = was.playing;
				} else {
					this.playbackTime = 0;
					this.playing = true;
				}
			}
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
			if (this.analysis === 'frequency') this.acResult = null;
			else this.result = null;
		} finally {
			this.running = false;
		}
	}
}

export const app = new AppState();
export { pointKey };

// The whole editor hangs off this one object, so a hot reload that swaps the
// module leaves the running page holding the old instance — old rules, old bugs,
// with the source on disk saying otherwise. That turns "I fixed it" into "it
// still does it", which is a miserable thing to debug. Reload the page instead.
if (import.meta.hot) {
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
