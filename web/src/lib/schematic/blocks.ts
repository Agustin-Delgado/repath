/**
 * Unfolding blocks for the engine.
 *
 * A block is a drawing inside a part, and the engine solves one flat circuit.
 * Rather than teach the netlist builder about hierarchy, the drawing is
 * unfolded first: every placed block is replaced by a copy of its insides,
 * parked far off the page where nothing can touch it, with each port pin tied
 * to the inner pins it stands for. The connectivity pass then sees one
 * schematic, and everything it already does — bridging analog to digital,
 * warning about floating pins, naming nets — happens to the inside of a block
 * exactly as it would have to the same parts drawn in the open.
 *
 * The box itself stays in the unfolded drawing. Its pins are what the outside
 * wires land on, and keeping them keeps every net the drawing knows about at
 * the same index in the unfolded one, so a probe or a hover on the outer
 * drawing still names the right net.
 */

import { pinFlow } from './flow';
import { groupFrame } from './groups';
import {
	blockOf,
	definitionFor,
	pinPosition,
	pointKey,
	snap,
	type BlockPort,
	type BlockDef,
	type Instance,
	type Point,
	type Schematic,
	type Wire
} from './model';
import { buildConnectivity } from './nets';
import type { PortInjection } from '../spice';

/**
 * Where the insides are parked: a long way from any drawing, and far enough
 * apart from each other that two unfolded blocks cannot share a grid line.
 */
const PARK = 1e7;
const SPAN = 1e6;

/** A pair of points that are one conductor even though no wire joins them. */
export type Tie = [Point, Point];

export interface Unfolded {
	schematic: Schematic;
	ties: Tie[];
	/**
	 * Per placed block, which reported currents arrive at each of its pins —
	 * the currents of the inner parts on that port, under the names they were
	 * unfolded as.
	 */
	portFlow: Map<string, PortInjection[]>;
}

/** The name an inner part is built under: `B1.R1`, and `B1.B2.R1` further in. */
export function innerName(outer: Instance, inner: Instance): string {
	return `${outer.name}.${inner.name}`;
}

/** A drawing with every block replaced by what is inside it. */
export function unfoldBlocks(schematic: Schematic): Unfolded {
	const instances: Instance[] = [];
	const wires: Wire[] = [];
	const ties: Tie[] = [];
	const portFlow = new Map<string, PortInjection[]>();
	let parked = 0;

	const unfold = (placed: Instance, block: BlockDef): void => {
		const origin = { x: PARK + SPAN * parked++, y: PARK };
		const copies = new Map<string, Instance>();
		for (const inner of block.instances) {
			const copy: Instance = {
				...inner,
				id: `${placed.id}/${inner.id}`,
				name: innerName(placed, inner),
				x: origin.x + inner.x,
				y: origin.y + inner.y,
				params: { ...inner.params }
			};
			copies.set(inner.id, copy);
			take(copy);
		}
		for (const wire of block.wires) {
			wires.push({
				id: `${placed.id}/${wire.id}`,
				points: wire.points.map((p) => ({ x: origin.x + p.x, y: origin.y + p.y }))
			});
		}
		const outerPins = definitionFor(placed).pins;
		const injections: PortInjection[] = [];
		for (const port of block.ports) {
			const outerPin = outerPins.find((p) => p.name === port.name);
			if (!outerPin) continue;
			const at = pinPosition(placed, outerPin);
			for (const { instance, pin } of port.pins) {
				const copy = copies.get(instance);
				const innerPin = copy && definitionFor(copy).pins.find((p) => p.name === pin);
				if (!copy || !innerPin) continue;
				ties.push([at, pinPosition(copy, innerPin)]);
				for (const { element, sign } of pinInjections(copy, pin, portFlow)) {
					injections.push({ port: port.name, element, sign });
				}
			}
		}
		portFlow.set(placed.id, injections);
	};

	const take = (instance: Instance): void => {
		instances.push(instance);
		const block = blockOf(schematic, instance.kind);
		if (block) unfold(instance, block);
	};

	for (const instance of schematic.instances) take(instance);
	wires.push(...schematic.wires);

	return {
		schematic: { ...schematic, instances, wires },
		ties,
		portFlow
	};
}

/**
 * What boxing up a set of parts would come to, worked out without changing
 * anything: the definition, where the box goes, and which wires have to be
 * re-attached to which of its pins.
 */
export interface BlockPlan {
	/** Where the box will sit: the middle of the parts, on the grid. */
	at: Point;
	/** The parts and wires that go inside, with positions relative to `at`. */
	instances: Instance[];
	wires: Wire[];
	ports: BlockPort[];
	/** Ids of the wires that go inside, to be taken off the drawing. */
	inside: Set<string>;
	/**
	 * Wires staying outside that touched the parts, each with the end that has
	 * to be moved to the box and the port it now belongs on.
	 */
	reattach: Array<{ wire: Wire; end: 0 | 1; port: string }>;
}

/**
 * Plan a block around some of a drawing's parts.
 *
 * A port is a *net*, not a pin: every net that touches one of the parts and
 * something outside them gets one terminal on the box, however many pins on
 * either side it reaches. Its name is the name of the pin it comes from —
 * `clk`, `q` — with a number when two nets would otherwise share one, and it
 * goes on the side the signal suggests: a digital output on the right, an
 * input on the left, an analog terminal on whichever side the outside is.
 *
 * A wire goes inside if it belongs to the parts: both ends on their pins, or
 * loose ends that lie within their frame and on nobody else's pin. Anything
 * else stays out and is re-attached to the box.
 */
export function planBlock(schematic: Schematic, memberIds: ReadonlySet<string>): BlockPlan | null {
	const byId = new Map(schematic.instances.map((i) => [i.id, i]));
	const members = schematic.instances.filter((i) => memberIds.has(i.id));
	if (members.length === 0) return null;
	const frame = groupFrame({ id: '', name: '', members: members.map((i) => i.id) }, byId);
	if (!frame) return null;
	const at = { x: snap(frame.x + frame.w / 2), y: snap(frame.y + frame.h / 2) };

	// Every pin on the drawing, by where it is, and whose it is.
	const pinsAt = new Map<string, Array<{ instance: Instance; pin: string; member: boolean }>>();
	for (const instance of schematic.instances) {
		for (const pin of definitionFor(instance).pins) {
			const p = pinPosition(instance, pin);
			const key = pointKey(p.x, p.y);
			const list = pinsAt.get(key) ?? [];
			list.push({ instance, pin: pin.name, member: memberIds.has(instance.id) });
			pinsAt.set(key, list);
		}
	}
	const onMember = (p: Point) => pinsAt.get(pointKey(p.x, p.y))?.some((e) => e.member) ?? false;
	const onOther = (p: Point) => pinsAt.get(pointKey(p.x, p.y))?.some((e) => !e.member) ?? false;
	const within = (p: Point) =>
		p.x >= frame.x && p.x <= frame.x + frame.w && p.y >= frame.y && p.y <= frame.y + frame.h;

	const inside = new Set<string>();
	for (const wire of schematic.wires) {
		const ends = [wire.points[0], wire.points[wire.points.length - 1]];
		if (ends.every((p) => onMember(p) || (!onOther(p) && within(p)))) inside.add(wire.id);
	}

	// A net is a port when it reaches a member pin and also something that is
	// staying outside: another part's pin, or a wire that is not coming in.
	const connectivity = buildConnectivity(schematic);
	const outsideOf = new Map<number, Point[]>();
	for (const wire of schematic.wires) {
		if (inside.has(wire.id)) continue;
		const net = connectivity.netOfPoint.get(pointKey(wire.points[0].x, wire.points[0].y));
		if (net === undefined) continue;
		const list = outsideOf.get(net) ?? [];
		list.push(...wire.points);
		outsideOf.set(net, list);
	}
	for (const net of connectivity.nets) {
		for (const ref of net.pins) {
			if (memberIds.has(ref.instance.id)) continue;
			const list = outsideOf.get(net.index) ?? [];
			list.push({ x: ref.x, y: ref.y });
			outsideOf.set(net.index, list);
		}
	}

	const taken = new Set<string>();
	const found: Array<BlockPort & { y: number; x: number }> = [];
	const portOfNet = new Map<number, string>();
	for (const net of connectivity.nets) {
		const mine = net.pins.filter((ref) => memberIds.has(ref.instance.id));
		if (mine.length === 0) continue;
		const outsidePoints = outsideOf.get(net.index);
		if (!outsidePoints?.length) continue;

		// Named for the pin that drives the net when one does, so a gate's
		// output feeding two inputs inside is `q` rather than `a`.
		const ordered = [...mine].sort((a, b) => a.y - b.y || a.x - b.x);
		const source = ordered.find((ref) => ref.pin.direction === 'out') ?? ordered[0];
		let name = source.pin.name;
		for (let n = 2; taken.has(name); n++) name = `${source.pin.name}${n}`;
		taken.add(name);

		const analog = mine.some((ref) => ref.pin.domain === 'analog');
		let side: 'left' | 'right';
		if (analog) {
			const meanX = outsidePoints.reduce((sum, p) => sum + p.x, 0) / outsidePoints.length;
			side = meanX < at.x ? 'left' : 'right';
		} else {
			side = source.pin.direction === 'out' ? 'right' : 'left';
		}
		found.push({
			name,
			side,
			pins: ordered.map((ref) => ({ instance: ref.instance.id, pin: ref.pin.name })),
			x: source.x,
			y: source.y
		});
		portOfNet.set(net.index, name);
	}
	found.sort((a, b) => a.y - b.y || a.x - b.x);
	const ports: BlockPort[] = found.map(({ name, side, pins }) => ({ name, side, pins }));

	const reattach: BlockPlan['reattach'] = [];
	for (const wire of schematic.wires) {
		if (inside.has(wire.id)) continue;
		const net = connectivity.netOfPoint.get(pointKey(wire.points[0].x, wire.points[0].y));
		const port = net === undefined ? undefined : portOfNet.get(net);
		if (!port) continue;
		const last = wire.points.length - 1;
		// The end that was on a part going inside, or failing that the end that
		// sits within the frame and is about to be left touching nothing.
		const candidates: Array<0 | 1> = [0, 1];
		const end =
			candidates.find((e) => onMember(wire.points[e === 0 ? 0 : last])) ??
			candidates.find((e) => {
				const p = wire.points[e === 0 ? 0 : last];
				return within(p) && !onOther(p);
			});
		if (end !== undefined) reattach.push({ wire, end, port });
	}

	return {
		at,
		instances: members.map((i) => ({ ...i, x: i.x - at.x, y: i.y - at.y, params: { ...i.params } })),
		wires: schematic.wires
			.filter((w) => inside.has(w.id))
			.map((w) => ({ id: w.id, points: w.points.map((p) => ({ x: p.x - at.x, y: p.y - at.y })) })),
		ports,
		inside,
		reattach
	};
}

/** Whether a block's definition is placed anywhere: on the drawing or inside another block. */
export function blockInUse(schematic: Schematic, id: string): boolean {
	const kind = `b:${id}`;
	return (
		schematic.instances.some((i) => i.kind === kind) ||
		(schematic.blocks ?? []).some((b) => b.instances.some((i) => i.kind === kind))
	);
}

/**
 * The currents the engine reports at one pin of an unfolded part. A plain part
 * reports its own; a block inside a block reports whatever its own port was
 * given, which is why the inner blocks are unfolded before the outer one asks.
 */
function pinInjections(
	instance: Instance,
	pin: string,
	portFlow: ReadonlyMap<string, PortInjection[]>
): Array<{ element: string; sign: number }> {
	const nested = portFlow.get(instance.id);
	if (nested) return nested.filter((entry) => entry.port === pin);
	const flow = pinFlow(instance.kind, pin);
	return flow ? [{ element: `${instance.name}${flow.series ?? ''}`, sign: flow.sign }] : [];
}
