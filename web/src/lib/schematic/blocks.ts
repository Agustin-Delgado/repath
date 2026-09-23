/**
 * Blocks: what a boxed-up circuit's terminals are, how one is planned around
 * a set of parts, and how the engine gets to see inside.
 *
 * A block's terminals are the port parts drawn inside it. That is the whole
 * definition: a wire from a pin to a port makes that pin reachable from
 * outside, under the port's name, on the side the port's flow says. Boxing
 * parts up plants a port on every net that reached them from outside and
 * wires it to the pin it stands for; opening the block up for editing shows
 * the ports as parts, to be moved, renamed, added or deleted like anything
 * else.
 *
 * The engine solves one flat circuit. Rather than teach the netlist builder
 * about hierarchy, the drawing is unfolded first: every placed block is
 * replaced by a copy of its insides, parked far off the page where nothing
 * can touch it, with each pin on the box tied to the port inside it. The
 * connectivity pass then sees one schematic, and everything it already does —
 * bridging analog to digital, warning about floating pins, naming nets —
 * happens to the inside of a block exactly as it would to the same parts
 * drawn in the open. The box itself stays in the unfolded drawing: its pins
 * are what the outside wires land on, and keeping them keeps every net the
 * drawing knows about at the same index in the unfolded one, so a probe or a
 * hover on the outer drawing still names the right net.
 */

import { pinFlows } from './flow';
import { groupFrame } from './groups';
import {
	BLOCK_PREFIX,
	blockDefinition,
	blockOf,
	definitionFor,
	GRID,
	isKnownKind,
	MARKERS,
	pinPosition,
	pointKey,
	portFlow,
	portOrder,
	registerKind,
	snap,
	wireSegments,
	type BlockDef,
	type BlockPort,
	type Instance,
	type Point,
	type Schematic,
	type Wire
} from './model';
import { buildConnectivity, liesWithin, pinKey, type Connectivity } from './nets';
import { routeWire } from './route';
import type { PortInjection } from '../spice';

/** The inside of a block as a drawing of its own, with the document's definitions along. */
export function interior(block: BlockDef, of: Schematic): Schematic {
	return {
		instances: block.instances,
		wires: block.wires,
		groups: block.groups,
		blocks: of.blocks,
		subcircuits: of.subcircuits
	};
}

/**
 * The terminals of a block, top to bottom on each side.
 *
 * Read off the port parts inside it. What a port is wired to decides what
 * the pin on the box is: analog if the net is, an output if something inside
 * drives it. The engine never reads these — it sees the inside — but the
 * drawing does, to know whether a net has become analog and which way a wire
 * should arrive.
 *
 * Top to bottom is where the ports sit inside, unless an order was set on
 * them from the box (`portOrder`): those come first, in that order, and any
 * port drawn in since goes after them.
 */
export function blockPorts(block: BlockDef): BlockPort[] {
	const ports = block.instances.filter((i) => i.kind === 'port');
	if (ports.length === 0) return [];
	const connectivity = buildConnectivity({ instances: block.instances, wires: block.wires });
	const rank = (port: Instance) => portOrder(port) ?? Number.MAX_SAFE_INTEGER;
	return ports
		.sort((a, b) => rank(a) - rank(b) || a.y - b.y || a.x - b.x)
		.map((port) => {
			const index = connectivity.netOfPin.get(pinKey(port.id, 'p'));
			const net = index === undefined ? undefined : connectivity.nets[index];
			const analog = net?.hasAnalog ?? false;
			const drives = net?.hasDigitalOutput ?? false;
			return {
				name: port.name,
				side: portFlow(port) === 'in' ? 'left' : 'right',
				instance: port.id,
				domain: analog ? 'analog' : 'digital',
				direction: analog ? 'inout' : drives ? 'out' : 'in'
			};
		});
}

/**
 * Make a drawing's blocks available to everything that asks about a kind, on
 * the same terms as `registerSubcircuits`: before anything reads the instances.
 *
 * A block can hold another block, and the inner one has to be known before the
 * outer one is built — its pins are read off the parts inside. The list is in
 * no particular order, so this goes round until every one is built, and a block
 * whose contents it cannot resolve is left out rather than allowed to throw.
 */
export function registerBlocks(schematic: Schematic): void {
	let pending = [...(schematic.blocks ?? [])];
	while (pending.length > 0) {
		const ready = pending.filter((block) =>
			block.instances.every((i) => !i.kind.startsWith(BLOCK_PREFIX) || isKnownKind(i.kind))
		);
		if (ready.length === 0) return;
		for (const block of ready) registerKind(blockDefinition(block, blockPorts(block)));
		pending = pending.filter((block) => !ready.includes(block));
	}
}

/**
 * Where the wires to a placed block may have been left by a narrower box.
 *
 * The body grew to fit the block's name. Before it did, it was sized for the
 * port names alone, and a drawing saved then has its wires ending where the
 * narrower box's pins were — inside the box, now, with the pin itself sitting
 * on the wire further out and the box drawn over the wire's last stretch. For
 * every placed copy whose pins were somewhere else under the old sizing, the
 * old position of each is mapped to the new, for the wires with an end there
 * to be re-routed. A drawing saved since maps nothing: no wire of its ends
 * where the narrower box's pins were.
 */
export function outgrownPins(schematic: Schematic): Map<string, Point> {
	const moved = new Map<string, Point>();
	for (const block of schematic.blocks ?? []) {
		const ports = blockPorts(block);
		// A block with no name is sized the way every block used to be.
		const narrow = blockDefinition({ ...block, name: '' }, ports).pins;
		const wide = blockDefinition(block, ports).pins;
		for (const placed of schematic.instances) {
			if (placed.kind !== BLOCK_PREFIX + block.id) continue;
			for (const pin of wide) {
				const before = narrow.find((p) => p.name === pin.name);
				if (!before) continue;
				const was = pinPosition(placed, before);
				const now = pinPosition(placed, pin);
				if (was.x !== now.x || was.y !== now.y) moved.set(pointKey(was.x, was.y), now);
			}
		}
	}
	return moved;
}

/** Whether a block's definition is placed anywhere: on the drawing or inside another block. */
export function blockInUse(schematic: Schematic, id: string): boolean {
	const kind = BLOCK_PREFIX + id;
	return (
		schematic.instances.some((i) => i.kind === kind) ||
		(schematic.blocks ?? []).some((b) => b.instances.some((i) => i.kind === kind))
	);
}

/**
 * Whether block `id` is `inside`, or is built out of something that is: the
 * blocks that must not be placed in `inside`, or it would contain itself.
 */
export function contains(schematic: Schematic, id: string, inside: string): boolean {
	if (id === inside) return true;
	const block = schematic.blocks?.find((b) => b.id === id);
	if (!block) return false;
	return block.instances.some((i) => {
		const child = blockOf(schematic, i.kind);
		return child !== null && contains(schematic, child.id, inside);
	});
}

// ---------------------------------------------------------------------------
// Unfolding, for the engine
// ---------------------------------------------------------------------------

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
	// What each definition's inside is wired as, worked out once however many
	// times it is placed.
	const insides = new Map<string, { ports: BlockPort[]; connectivity: Connectivity }>();
	const insideOf = (block: BlockDef) => {
		let entry = insides.get(block.id);
		if (!entry) {
			entry = {
				ports: blockPorts(block),
				connectivity: buildConnectivity({ instances: block.instances, wires: block.wires })
			};
			insides.set(block.id, entry);
		}
		return entry;
	};

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
		const { ports, connectivity } = insideOf(block);
		const outerPins = definitionFor(placed).pins;
		const injections: PortInjection[] = [];
		for (const port of ports) {
			const outerPin = outerPins.find((p) => p.name === port.name);
			const copy = copies.get(port.instance);
			if (!outerPin || !copy) continue;
			ties.push([pinPosition(placed, outerPin), { x: copy.x, y: copy.y }]);
			// The current at the box's pin is whatever flows into the parts on
			// the port's net inside, reported under their unfolded names.
			const index = connectivity.netOfPin.get(pinKey(port.instance, 'p'));
			const net = index === undefined ? undefined : connectivity.nets[index];
			for (const ref of net?.pins ?? []) {
				const inner = copies.get(ref.instance.id);
				if (!inner || MARKERS.has(inner.kind)) continue;
				for (const { element, sign } of pinInjections(inner, ref.pin.name, portFlow)) {
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

/** What the engine sees: every block unfolded, its ports tied to its pins. */
export function flatConnectivity(schematic: Schematic): Connectivity {
	const unfolded = unfoldBlocks(schematic);
	return buildConnectivity(unfolded.schematic, unfolded.ties);
}

/**
 * Two pins that boxing up, or opening a box, put on one net when they were
 * on two; or null.
 *
 * The drawing before is compared with the drawing after as the engine sees
 * both — every block unfolded, its ports tied to its pins — so a join
 * anywhere counts: a wire re-routed to the box landing on another, a pin of
 * the box coming down on a wire, a port planted inside on the wrong net.
 * The parts are the same parts under new ids; `sameAs` says which id in the
 * drawing before a pin's owner had, or null for a part that was not there —
 * a port, or the box itself.
 */
export function joinedByBoxing(
	before: Connectivity,
	after: Schematic,
	sameAs: (id: string) => string | null
): [string, string] | null {
	for (const net of flatConnectivity(after).nets) {
		let was: number | undefined;
		let first = '';
		for (const ref of net.pins) {
			if (ref.instance.kind === 'port') continue;
			const id = sameAs(ref.instance.id);
			if (id === null) continue;
			const index = before.netOfPin.get(pinKey(id, ref.pin.name));
			if (index === undefined) continue;
			const name = `${ref.instance.name}.${ref.pin.name}`;
			if (was === undefined) {
				was = index;
				first = name;
			} else if (index !== was) {
				return [first, name];
			}
		}
	}
	return null;
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
	return pinFlows(instance.kind, pin).map((flow) => ({
		element: `${instance.name}${flow.series ?? ''}`,
		sign: flow.sign
	}));
}

// ---------------------------------------------------------------------------
// Boxing up
// ---------------------------------------------------------------------------

/**
 * What boxing a set of parts up would come to, worked out without changing
 * anything: the inside of the block, where the box goes, and which wires
 * have to be re-attached to which of its pins.
 */
export interface BlockPlan {
	/** Where the box will sit: the middle of the parts, on the grid. */
	at: Point;
	/** The inside: the parts, their wires, and a port for each terminal, relative to `at`. */
	instances: Instance[];
	wires: Wire[];
	/** Ids of the drawing's wires that go inside, to be taken off it. */
	inside: Set<string>;
	/**
	 * Wires staying outside that touched the parts, each with the end that has
	 * to be moved to the box and the port it now belongs on.
	 */
	reattach: Array<{ wire: Wire; end: 0 | 1; port: string }>;
}

/** How far outside the parts' frame a port's pin is planted. */
const PORT_STANDOFF = 20;

/**
 * Take out of `wires` every one with an end that, once inside, would touch
 * nothing.
 *
 * A wire from a member's pin that ends on the side of a wire leaving the parts
 * comes inside — both ends are the parts' own — but the wire it joined stays
 * out, re-attached to the box, and the end that met it is left in mid-air: a
 * wire the editor refuses to draw, drawn by boxing. The port wired to that
 * pin is the join now, so the stub goes, and so does anything that reached
 * only it.
 */
function dropStubs(wires: Wire[], onMember: (p: Point) => boolean): void {
	for (let dropped = true; dropped; ) {
		dropped = false;
		for (const wire of wires) {
			const ends = [wire.points[0], wire.points[wire.points.length - 1]];
			const held = ends.every(
				(end) =>
					onMember(end) ||
					wires.some(
						(other) =>
							other !== wire &&
							(other.points.some((p) => p.x === end.x && p.y === end.y) ||
								wireSegments(other).some((s) => liesWithin(end.x, end.y, s.a, s.b)))
					)
			);
			if (held) continue;
			wires.splice(wires.indexOf(wire), 1);
			dropped = true;
			break;
		}
	}
}

/**
 * Plan a block around some of a drawing's parts.
 *
 * A port is planted for every *net* that reaches one of the parts and
 * something outside them, however many pins on either side it touches, and
 * wired to each of those pins. An output that nothing reads gets one as well:
 * a decoder's last gate is an output of the decoder whether or not anything
 * was wired to it yet. Each port is named for the pin it comes from — `clk`,
 * `q` — with a number when two would otherwise share a name, and faces the
 * way the signal suggests: a digital output out, an input in, an analog
 * terminal towards whichever side the outside is.
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

	// The inside, built up in the drawing's own coordinates and moved at the end.
	const instances: Instance[] = members.map((i) => ({ ...i, params: { ...i.params } }));
	const wires: Wire[] = schematic.wires
		.filter((w) => inside.has(w.id))
		.map((w) => ({ id: w.id, points: w.points.map((p) => ({ x: p.x, y: p.y })) }));
	dropStubs(wires, onMember);
	const taken = new Set(members.map((i) => i.name));
	const rows = { left: new Set<number>(), right: new Set<number>() };
	let minted = 0;
	// The columns the ports go in, clear of every wire coming inside. The
	// frame is the parts' frame, and a wire between two pins of one part can
	// swing round the outside of it — a flip-flop's output fed back to its
	// own clock did — so a port planted a fixed step past the frame landed
	// on that wire's leg, and every port down that side was on its net.
	let reach = { left: frame.x, right: frame.x + frame.w };
	for (const wire of wires) {
		for (const p of wire.points) {
			reach = { left: Math.min(reach.left, p.x), right: Math.max(reach.right, p.x) };
		}
	}
	/**
	 * The wires from ports to pins, routed only once every port is down. A
	 * wire routed before a later port was planted ran straight through the
	 * cell that port then landed on, and a pin sitting mid-wire is a junction:
	 * two terminals quietly became one net.
	 */
	const pending: Array<{ port: Instance; pins: Point[] }> = [];
	/** Put a port down beside the frame, level with `near`, to be wired to `pins`. */
	const plant = (name: string, flow: 'in' | 'out', near: Point, pins: Point[]): string => {
		let unique = name;
		for (let n = 2; taken.has(unique); n++) unique = `${name}${n}`;
		taken.add(unique);
		const side = flow === 'in' ? 'left' : 'right';
		const x = side === 'left' ? snap(reach.left) - PORT_STANDOFF : snap(reach.right) + PORT_STANDOFF;
		let y = snap(near.y);
		while (rows[side].has(y)) y += GRID * 2;
		rows[side].add(y);
		const port: Instance = {
			id: `port${++minted}`,
			kind: 'port',
			name: unique,
			x,
			y,
			rotation: 0,
			params: { flow }
		};
		instances.push(port);
		pending.push({ port, pins });
		return unique;
	};

	// How the parts are wired among themselves, so a port is wired to one
	// pin of each run it reaches rather than to every pin on the net: the
	// rest are already joined inside.
	const among = buildConnectivity({ instances: members, wires: wires.map((w) => ({ ...w })) });
	const oneOfEach = (refs: Array<{ instance: Instance; pin: { name: string }; x: number; y: number }>) => {
		const seen = new Set<number | undefined>();
		return refs.filter((ref) => {
			const run = among.netOfPin.get(pinKey(ref.instance.id, ref.pin.name));
			if (run !== undefined && seen.has(run)) return false;
			seen.add(run);
			return true;
		});
	};

	const portOfNet = new Map<number, string>();
	for (const net of connectivity.nets) {
		const mine = net.pins.filter((ref) => memberIds.has(ref.instance.id));
		if (mine.length === 0) continue;
		const outsidePoints = outsideOf.get(net.index);
		const ordered = [...mine].sort((a, b) => a.y - b.y || a.x - b.x);
		// Named for the pin that drives the net when one does, so a gate's
		// output feeding two inputs inside is `q` rather than `a`.
		const source = ordered.find((ref) => ref.pin.direction === 'out') ?? ordered[0];
		const analog = mine.some((ref) => ref.pin.domain === 'analog');
		if (!outsidePoints?.length) {
			// Nothing outside. An output that nothing reads is still an output,
			// and the block should say so; an input that nothing feeds is a
			// pin somebody left open, and stays open.
			const unread =
				!analog &&
				source.pin.direction === 'out' &&
				net.pins.length === 1 &&
				net.points.length < 2;
			if (unread) plant(source.pin.name, 'out', source, [{ x: source.x, y: source.y }]);
			continue;
		}
		let flow: 'in' | 'out';
		if (analog) {
			const meanX = outsidePoints.reduce((sum, p) => sum + p.x, 0) / outsidePoints.length;
			flow = meanX < at.x ? 'in' : 'out';
		} else {
			flow = source.pin.direction === 'out' ? 'out' : 'in';
		}
		const name = plant(
			source.pin.name,
			flow,
			source,
			oneOfEach(ordered).map((ref) => ({ x: ref.x, y: ref.y }))
		);
		portOfNet.set(net.index, name);
	}

	for (const { port, pins } of pending) {
		for (const [index, pin] of pins.entries()) {
			wires.push({
				id: `${port.id}w${index}`,
				points: routeWire({ instances, wires }, { x: port.x, y: port.y }, pin, { grid: GRID })
			});
		}
	}

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
		instances: instances.map((i) => ({ ...i, x: i.x - at.x, y: i.y - at.y })),
		wires: wires.map((w) => ({
			id: w.id,
			points: w.points.map((p) => ({ x: p.x - at.x, y: p.y - at.y }))
		})),
		inside,
		reattach
	};
}
