/**
 * Turns drawn geometry into electrical connectivity.
 *
 * Two things touch if they share a grid point. Wires also connect to anything
 * landing in the middle of them, which is how a T-junction works — but two wires
 * merely *crossing*, with no endpoint at the intersection, stay separate. That is
 * the convention every schematic editor uses and the one every engineer expects.
 */

import {
	GRID,
	definitionOf,
	pinPosition,
	pointKey,
	simplifyPath,
	wireSegments,
	type Instance,
	type PinDef,
	type Point,
	type Schematic,
	type Wire,
	type WireSegment
} from './model';

class DisjointSet {
	private parent = new Map<string, string>();

	find(key: string): string {
		const seen: string[] = [];
		let current = key;
		while (this.parent.has(current) && this.parent.get(current) !== current) {
			seen.push(current);
			current = this.parent.get(current)!;
		}
		if (!this.parent.has(current)) this.parent.set(current, current);
		for (const k of seen) this.parent.set(k, current);
		return current;
	}

	union(a: string, b: string): void {
		const ra = this.find(a);
		const rb = this.find(b);
		if (ra !== rb) this.parent.set(ra, rb);
	}
}

export interface PinRef {
	instance: Instance;
	pin: PinDef;
	x: number;
	y: number;
}

export interface Net {
	index: number;
	points: string[];
	pins: PinRef[];
	/** Tied to a ground symbol. */
	isGround: boolean;
	/** Carries analog pins, so it needs a node in the MNA system. */
	hasAnalog: boolean;
	/** Some digital device reads this net. */
	hasDigitalInput: boolean;
	/** Some digital device drives this net. */
	hasDigitalOutput: boolean;
}

export interface Connectivity {
	nets: Net[];
	/** Grid point -> index into `nets`. */
	netOfPoint: Map<string, number>;
	/** `${instanceId}:${pinName}` -> index into `nets`. */
	netOfPin: Map<string, number>;
}

export function pinKey(instanceId: string, pinName: string): string {
	return `${instanceId}:${pinName}`;
}

/** Does `(x, y)` land strictly inside an axis-aligned segment, not on its ends? */
export function liesWithin(x: number, y: number, a: Point, b: Point): boolean {
	if (a.x === b.x && x === a.x) {
		return y > Math.min(a.y, b.y) && y < Math.max(a.y, b.y);
	}
	if (a.y === b.y && y === a.y) {
		return x > Math.min(a.x, b.x) && x < Math.max(a.x, b.x);
	}
	return false;
}

/** Every segment of every wire, tagged with the wire it belongs to. */
export function allSegments(schematic: Schematic): Array<WireSegment & { wire: Wire }> {
	return schematic.wires.flatMap((wire) => wireSegments(wire).map((s) => ({ ...s, wire })));
}

export function buildConnectivity(schematic: Schematic): Connectivity {
	const set = new DisjointSet();
	const pins: PinRef[] = [];

	for (const instance of schematic.instances) {
		for (const pin of definitionOf(instance.kind).pins) {
			const { x, y } = pinPosition(instance, pin);
			pins.push({ instance, pin, x, y });
			set.find(pointKey(x, y));
		}
	}

	// A wire is one conductor: every corner along it is the same net.
	const segments = allSegments(schematic);
	for (const segment of segments) {
		set.union(pointKey(segment.a.x, segment.a.y), pointKey(segment.b.x, segment.b.y));
	}

	// Anything sitting mid-wire joins that wire: pins and other wires' corners.
	const touchPoints: Point[] = [
		...pins.map((p) => ({ x: p.x, y: p.y })),
		...schematic.wires.flatMap((w) => w.points)
	];
	for (const segment of segments) {
		for (const point of touchPoints) {
			if (liesWithin(point.x, point.y, segment.a, segment.b)) {
				set.union(pointKey(point.x, point.y), pointKey(segment.a.x, segment.a.y));
			}
		}
	}

	const byRoot = new Map<string, Net>();
	const netOfPoint = new Map<string, number>();
	const netOfPin = new Map<string, number>();

	const ensure = (key: string): Net => {
		const root = set.find(key);
		let net = byRoot.get(root);
		if (!net) {
			net = {
				index: byRoot.size,
				points: [],
				pins: [],
				isGround: false,
				hasAnalog: false,
				hasDigitalInput: false,
				hasDigitalOutput: false
			};
			byRoot.set(root, net);
		}
		return net;
	};

	const allPoints = new Set<string>([
		...pins.map((p) => pointKey(p.x, p.y)),
		...schematic.wires.flatMap((w) => w.points.map((p) => pointKey(p.x, p.y)))
	]);
	for (const key of allPoints) {
		ensure(key).points.push(key);
	}

	for (const ref of pins) {
		const net = ensure(pointKey(ref.x, ref.y));
		net.pins.push(ref);
		if (ref.instance.kind === 'ground') net.isGround = true;
		else if (ref.pin.domain === 'analog') net.hasAnalog = true;
		else if (ref.pin.direction === 'out') net.hasDigitalOutput = true;
		else net.hasDigitalInput = true;
	}

	// A ground symbol makes the net analog by definition.
	for (const net of byRoot.values()) {
		if (net.isGround) net.hasAnalog = true;
	}

	const nets = [...byRoot.values()];
	nets.forEach((net, index) => {
		net.index = index;
		for (const key of net.points) netOfPoint.set(key, index);
		for (const ref of net.pins) netOfPin.set(pinKey(ref.instance.id, ref.pin.name), index);
	});

	return { nets, netOfPoint, netOfPin };
}

/**
 * Join wires that meet end to end with nothing else at the joint.
 *
 * Two wires touching at a bare point are one conductor drawn in two pieces, and
 * keeping them apart has a real cost: the joint becomes a fixed endpoint that
 * re-routing has to honour. Move a component and the wire is forced back to a
 * corner that no longer means anything, producing a detour that looks like the
 * router being stupid when it was only being obedient.
 *
 * Conservative on purpose — a point with a pin on it, or where three ends meet,
 * is a real junction and is left alone. The drawn shape never changes; only the
 * number of wires does.
 */
export function mergeWireChains(schematic: Schematic): Wire[] {
	const pins = new Set<string>();
	for (const instance of schematic.instances) {
		for (const pin of definitionOf(instance.kind).pins) {
			const at = pinPosition(instance, pin);
			pins.add(pointKey(at.x, at.y));
		}
	}

	const wires: Wire[] = schematic.wires.map((w) => ({
		id: w.id,
		points: w.points.map((p) => ({ x: p.x, y: p.y }))
	}));

	// Repeat until nothing more joins: a chain of four pieces takes three passes.
	for (let guard = 0; guard < wires.length + 1; guard++) {
		const ends = new Map<string, Array<{ index: number; atStart: boolean }>>();
		wires.forEach((wire, index) => {
			for (const atStart of [true, false]) {
				const p = atStart ? wire.points[0] : wire.points[wire.points.length - 1];
				const key = pointKey(p.x, p.y);
				const list = ends.get(key);
				if (list) list.push({ index, atStart });
				else ends.set(key, [{ index, atStart }]);
			}
		});

		let joined = false;
		for (const [key, list] of ends) {
			if (pins.has(key) || list.length !== 2) continue;
			const [a, b] = list;
			// A wire whose own two ends meet is a loop, not a chain.
			if (a.index === b.index) continue;

			const first = wires[a.index];
			const second = wires[b.index];
			// Orient both so the shared point is where they meet in the middle.
			const head = a.atStart ? [...first.points].reverse() : first.points;
			const tail = b.atStart ? second.points : [...second.points].reverse();
			const combined = simplifyPath([...head, ...tail.slice(1)]);

			wires[a.index] = { id: first.id, points: combined };
			wires.splice(b.index, 1);
			joined = true;
			break;
		}
		if (!joined) break;
	}

	return wires;
}

/**
 * Points where a dot has to be drawn, because otherwise a reader cannot tell a
 * junction from a crossing.
 *
 * Counted in segment-ends: a bend in one wire has two and is not a junction,
 * while a wire ending on another wire's corner has three and is.
 */
export function junctionDots(schematic: Schematic): Point[] {
	const counts = new Map<string, { point: Point; ends: number }>();
	const bump = (point: Point) => {
		const key = pointKey(point.x, point.y);
		const entry = counts.get(key) ?? { point, ends: 0 };
		entry.ends += 1;
		counts.set(key, entry);
	};

	const segments = allSegments(schematic);
	for (const segment of segments) {
		bump(segment.a);
		bump(segment.b);
	}

	// A wire that stops partway along another one is always a junction, however
	// few ends meet there.
	const midwire = new Set<string>();
	for (const segment of segments) {
		for (const wire of schematic.wires) {
			if (wire === segment.wire) continue;
			for (const point of wire.points) {
				if (liesWithin(point.x, point.y, segment.a, segment.b)) {
					midwire.add(pointKey(point.x, point.y));
				}
			}
		}
	}

	const dots: Point[] = [];
	for (const [key, entry] of counts) {
		if (entry.ends >= 3 || midwire.has(key)) dots.push(entry.point);
	}
	return dots;
}

/** Does `b` cover all of `a`? Both are axis-aligned, and collinear or not. */
function covers(a: WireSegment, b: WireSegment): boolean {
	const aVertical = a.a.x === a.b.x;
	const bVertical = b.a.x === b.b.x;
	if (aVertical !== bVertical) return false;

	if (aVertical) {
		if (a.a.x !== b.a.x) return false;
		return (
			Math.min(a.a.y, a.b.y) >= Math.min(b.a.y, b.b.y) &&
			Math.max(a.a.y, a.b.y) <= Math.max(b.a.y, b.b.y)
		);
	}
	if (a.a.y !== b.a.y) return false;
	return (
		Math.min(a.a.x, a.b.x) >= Math.min(b.a.x, b.b.x) &&
		Math.max(a.a.x, a.b.x) <= Math.max(b.a.x, b.b.x)
	);
}

/**
 * Cut back a wire that runs along another one at either end.
 *
 * Moving a wire whose end is pinned to something can leave it doubling back
 * along a neighbour to reach where it was plugged in — two conductors drawn on
 * the same line, which is exactly what the router spends its time avoiding, and
 * which reads as a mistake because it is one.
 *
 * The doubled part is redundant as well as ugly: the wire already meets its
 * neighbour at the far end of the overlap, so cutting to that point keeps the
 * connection.
 *
 * One cut at a time, each checked against the wires as they stand. Checking
 * every wire against the original set instead looks equivalent and is not: two
 * wires that cover each other would both be cut, and the connection they shared
 * would go with them. Measured, that lost twenty-nine connections across a sweep
 * of the examples — the exact failure this is supposed to prevent.
 *
 * Only whole end segments, and only against a single covering segment. Trimming
 * a partial overlap would move a corner rather than remove one, and changing the
 * drawn shape is not what this is for.
 */
export function trimOverlaps(schematic: Schematic): Wire[] {
	let wires = schematic.wires;

	for (let guard = 0; guard < wires.length * 8 + 16; guard++) {
		const cut = findCut(wires);
		if (!cut) break;

		wires = wires
			.map((wire, index) => (index === cut.index ? { ...wire, points: cut.points } : wire))
			.filter((wire) => wire.points.length >= 2);
	}

	return wires;
}

/** The next end segment that another wire already covers, if there is one. */
function findCut(wires: readonly Wire[]): { index: number; points: Point[] } | null {
	for (let index = 0; index < wires.length; index++) {
		const wire = wires[index];
		if (wire.points.length < 2) continue;

		const elsewhere = wires.filter((w) => w.id !== wire.id).flatMap((w) => wireSegments(w));
		const segments = wireSegments(wire);

		const last = segments[segments.length - 1];
		if (elsewhere.some((other) => covers(last, other))) {
			return { index, points: wire.points.slice(0, -1) };
		}

		const first = segments[0];
		if (elsewhere.some((other) => covers(first, other))) {
			return { index, points: wire.points.slice(1) };
		}
	}
	return null;
}

/**
 * Split a wire wherever something else meets it partway along.
 *
 * Two shapes of the same problem, and they are mirror images.
 *
 * A branch ending in the middle of a wire is a real junction, but as a bare point
 * on someone else's segment it is a fragile one: only the *ends* of a wire are
 * tracked as things that follow, so moving the host leaves the branch holding
 * nothing.
 *
 * A pin sitting in the middle of a wire has the same trouble from the other side.
 * The wire is not a follower of that pin, because following is decided by looking
 * at a wire's two ends — so move the part, or re-route the wire, and the pin is
 * left behind. That is how a circuit comes apart over a run of drags with every
 * pin still attached to something and no warning to show for it.
 *
 * Splitting turns both into wire ends meeting at a point, which is the case the
 * editor already handles: each of them anchors the others, and a pin at the end
 * of a wire is followed like any other. What is drawn never changes; only the
 * number of wires does.
 *
 * `mergeWireChains` will not undo this — it only folds a point where exactly two
 * ends meet, and it leaves anything with a pin on it alone.
 */
export function splitAtJunctions(schematic: Schematic, nextId: () => string): Wire[] {
	const ends = new Set<string>();
	for (const wire of schematic.wires) {
		for (const index of [0, wire.points.length - 1]) {
			ends.add(pointKey(wire.points[index].x, wire.points[index].y));
		}
	}
	for (const instance of schematic.instances) {
		for (const pin of definitionOf(instance.kind).pins) {
			const at = pinPosition(instance, pin);
			ends.add(pointKey(at.x, at.y));
		}
	}

	const out: Wire[] = [];
	for (const wire of schematic.wires) {
		let rest = wire;
		let first = true;

		for (;;) {
			const at = firstJunctionWithin(rest, ends);
			if (!at) break;

			out.push({ id: first ? wire.id : nextId(), points: at.before });
			rest = { id: nextId(), points: at.after };
			first = false;
		}

		out.push(first ? wire : rest);
	}
	return out;
}

/** Where another wire ends strictly inside this one, and the two halves it makes. */
function firstJunctionWithin(
	wire: Wire,
	ends: ReadonlySet<string>
): { before: Point[]; after: Point[] } | null {
	for (let i = 0; i < wire.points.length - 1; i++) {
		const a = wire.points[i];
		const b = wire.points[i + 1];

		// A corner counts. A branch can land on a bend as easily as on a straight,
		// and a bend is not an interior point of either segment that meets there —
		// so walking segments alone steps right over it.
		if (i > 0 && ends.has(pointKey(a.x, a.y))) {
			return { before: wire.points.slice(0, i + 1), after: wire.points.slice(i) };
		}

		const vertical = a.x === b.x;
		const from = vertical ? a.y : a.x;
		const to = vertical ? b.y : b.x;
		const step = Math.sign(to - from) * GRID;
		if (step === 0) continue;

		for (let v = from + step; step > 0 ? v < to : v > to; v += step) {
			const at = vertical ? { x: a.x, y: v } : { x: v, y: a.y };
			if (!ends.has(pointKey(at.x, at.y))) continue;
			return {
				before: [...wire.points.slice(0, i + 1), at],
				after: [at, ...wire.points.slice(i + 1)]
			};
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Making room for a part
// ---------------------------------------------------------------------------

/** Running distance to each corner of a polyline. Axis-aligned, so Manhattan. */
function lengthsOf(points: readonly Point[]): number[] {
	const out = [0];
	for (let i = 1; i < points.length; i++) {
		const step = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
		out.push(out[i - 1] + step);
	}
	return out;
}

/** How far along a wire a point sits, or null if it is not on it at all. */
function positionAlong(points: readonly Point[], p: Point): number | null {
	const lengths = lengthsOf(points);
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		if (p.x === a.x && p.y === a.y) return lengths[i - 1];
		if (liesWithin(p.x, p.y, a, points[i])) {
			return lengths[i - 1] + Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
		}
	}
	const last = points[points.length - 1];
	if (p.x === last.x && p.y === last.y) return lengths[lengths.length - 1];
	return null;
}

function pointAt(points: readonly Point[], distance: number): Point {
	const lengths = lengthsOf(points);
	for (let i = 1; i < points.length; i++) {
		if (distance > lengths[i]) continue;
		const a = points[i - 1];
		const b = points[i];
		const span = lengths[i] - lengths[i - 1];
		const t = span === 0 ? 0 : (distance - lengths[i - 1]) / span;
		return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t) };
	}
	return { ...points[points.length - 1] };
}

/** The stretch of a wire between two distances along it. */
function sliceAlong(points: readonly Point[], from: number, to: number): Point[] {
	if (to <= from) return [];
	const lengths = lengthsOf(points);
	const out: Point[] = [pointAt(points, from)];
	for (let i = 0; i < points.length; i++) {
		if (lengths[i] > from && lengths[i] < to) out.push({ ...points[i] });
	}
	out.push(pointAt(points, to));
	return out.filter((p, i) => i === 0 || p.x !== out[i - 1].x || p.y !== out[i - 1].y);
}

/**
 * Open a gap in any wire that a part now bridges, so it sits in series.
 *
 * Dropping a component onto a wire is how anyone puts one in a circuit, and it
 * is exactly what you get after deleting a part and letting the gap close behind
 * it. What it must never leave behind is the part standing on an unbroken wire:
 * that shorts it out, and the drawing gives nothing away, because a symbol on a
 * line with a pin touching at each end is what a series connection looks like.
 * The simulation is then right about a circuit nobody meant to draw.
 *
 * So a wire reaching two or more of the part's pins loses the run between the
 * outermost of them, and the pieces either side stay. What joins them now is the
 * part. A wire touching only one pin is left alone: that is a tap, and it is
 * what someone branching off a wire means.
 */
export function openForPins(
	schematic: Schematic,
	pins: readonly Point[],
	nextId: () => string
): Wire[] {
	const out: Wire[] = [];

	for (const wire of schematic.wires) {
		const hits = pins
			.map((p) => positionAlong(wire.points, p))
			.filter((d): d is number => d !== null)
			.sort((a, b) => a - b);

		const total = lengthsOf(wire.points).at(-1) ?? 0;
		if (hits.length < 2 || hits[hits.length - 1] <= hits[0]) {
			out.push(wire);
			continue;
		}

		let reusedId = false;
		for (const piece of [
			sliceAlong(wire.points, 0, hits[0]),
			sliceAlong(wire.points, hits[hits.length - 1], total)
		]) {
			if (piece.length < 2) continue;
			out.push({ id: reusedId ? nextId() : wire.id, points: piece });
			reusedId = true;
		}
	}

	return out;
}

/**
 * What to call a net on a scope trace or in a list.
 *
 * `n1` and `n2` are names the compiler invented, in the order it happened to
 * walk the drawing. They are stable and unique, which is all the engine needs
 * and none of what a person needs: shown two traces called `n1` and `n2`, there
 * is nothing to do but count nets by hand.
 *
 * So a net is named after what it joins. Its pins, most telling first — a
 * source's output says more than a resistor's leg — and at most two of them,
 * because a name longer than the trace it labels is not a name.
 */
export function netLabel(net: Net, fallback: string): string {
	if (net.isGround) return 'GND';
	if (net.pins.length === 0) return fallback;

	// A pin that drives says more about a net than one that merely sits on it.
	const rank = (ref: PinRef) => {
		const kind = ref.instance.kind;
		if (kind === 'vsource' || kind === 'isource') return 0;
		if (kind === 'clock') return 1;
		if (ref.pin.direction === 'out') return 1;
		return 2;
	};
	const named = [...net.pins]
		.sort((a, b) => rank(a) - rank(b) || a.instance.name.localeCompare(b.instance.name))
		.map((ref) => `${ref.instance.name}.${short(ref.pin.name)}`);

	// A middle dot, so the separator between two names is not the same character
	// as the one inside them: `V1.+-R1.a` reads as one thing, `V1.+ · R1.a` as two.
	const shown = named.slice(0, 2).join(' · ');
	return named.length > 2 ? `${shown}+${named.length - 2}` : shown;
}

/** Pin names as they read on a label rather than in the catalog. */
function short(pin: string): string {
	switch (pin) {
		case 'plus':
			return '+';
		case 'minus':
			return '-';
		case 'anode':
			return 'a';
		case 'cathode':
			return 'k';
		case 'collector':
			return 'c';
		case 'emitter':
			return 'e';
		case 'base':
			return 'b';
		case 'drain':
			return 'd';
		case 'source':
			return 's';
		case 'gate':
			return 'g';
		default:
			return pin;
	}
}
