/**
 * Turns drawn geometry into electrical connectivity.
 *
 * Two things touch if they share a grid point. Wires also connect to anything
 * landing in the middle of them, which is how a T-junction works — but two wires
 * merely *crossing*, with no endpoint at the intersection, stay separate. That is
 * the convention every schematic editor uses and the one every engineer expects.
 */

import {
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
