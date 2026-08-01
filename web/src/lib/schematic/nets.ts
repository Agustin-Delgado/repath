/**
 * Turns drawn geometry into electrical connectivity.
 *
 * Two things touch if they share a grid point. Wires also connect to anything
 * landing in the middle of them, which is how a T-junction works — but two wires
 * merely *crossing*, with no endpoint at the intersection, stay separate. That is
 * the convention every schematic editor uses and the one every engineer expects.
 */

import { pinPosition, pointKey, type Instance, type PinDef, type Schematic } from './model';
import { definitionOf } from './model';

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

/** Does `(x, y)` land strictly inside an axis-aligned wire, not on its ends? */
function liesWithin(x: number, y: number, w: Schematic['wires'][number]): boolean {
	if (w.x1 === w.x2 && x === w.x1) {
		return y > Math.min(w.y1, w.y2) && y < Math.max(w.y1, w.y2);
	}
	if (w.y1 === w.y2 && y === w.y1) {
		return x > Math.min(w.x1, w.x2) && x < Math.max(w.x1, w.x2);
	}
	return false;
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

	for (const wire of schematic.wires) {
		const a = pointKey(wire.x1, wire.y1);
		const b = pointKey(wire.x2, wire.y2);
		set.union(a, b);
	}

	// Anything sitting mid-wire joins that wire: pins and other wires' endpoints.
	const junctions: Array<{ x: number; y: number }> = [
		...pins.map((p) => ({ x: p.x, y: p.y })),
		...schematic.wires.flatMap((w) => [
			{ x: w.x1, y: w.y1 },
			{ x: w.x2, y: w.y2 }
		])
	];
	for (const wire of schematic.wires) {
		for (const point of junctions) {
			if (liesWithin(point.x, point.y, wire)) {
				set.union(pointKey(point.x, point.y), pointKey(wire.x1, wire.y1));
			}
		}
	}

	// Collect the roots into nets.
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
		...schematic.wires.flatMap((w) => [pointKey(w.x1, w.y1), pointKey(w.x2, w.y2)])
	]);
	for (const key of allPoints) {
		const net = ensure(key);
		net.points.push(key);
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
 * Points where three or more wire ends meet, which is where a junction dot has
 * to be drawn. Without the dot a reader cannot tell a T-junction from a crossing.
 */
export function junctionDots(schematic: Schematic): Array<{ x: number; y: number }> {
	const counts = new Map<string, { x: number; y: number; n: number }>();
	const bump = (x: number, y: number) => {
		const key = pointKey(x, y);
		const entry = counts.get(key) ?? { x, y, n: 0 };
		entry.n += 1;
		counts.set(key, entry);
	};

	for (const w of schematic.wires) {
		bump(w.x1, w.y1);
		bump(w.x2, w.y2);
	}
	// A wire ending on another wire's interior is always a junction.
	const midwire = new Set<string>();
	for (const w of schematic.wires) {
		for (const other of schematic.wires) {
			if (other === w) continue;
			for (const [x, y] of [
				[other.x1, other.y1],
				[other.x2, other.y2]
			]) {
				if (liesWithin(x, y, w)) midwire.add(pointKey(x, y));
			}
		}
	}

	const dots: Array<{ x: number; y: number }> = [];
	for (const [key, entry] of counts) {
		if (entry.n >= 3 || midwire.has(key)) dots.push({ x: entry.x, y: entry.y });
	}
	return dots;
}
