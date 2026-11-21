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
	withKinds,
	wireSegments,
	type BlockDef,
	type BlockPort,
	type ComponentDef,
	type Instance,
	type Point,
	type Schematic,
	type Wire
} from './model';
import { buildConnectivity, liesWithin, pinKey, probePin, tidiedWires, type Connectivity } from './nets';
import { rerouteMoved, routeWire } from './route';
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
 * The part every block of a drawing is, as it is defined now.
 *
 * A block can hold another block, and the inner one has to be built before the
 * outer one — its pins are read off the parts inside, and the pins of a block
 * inside are the inner definition's. The list is in no particular order, so
 * this goes round until every one is built, each round seeing the definitions
 * the rounds before it made; a block whose contents it cannot resolve is left
 * out rather than allowed to throw. Nothing is registered.
 */
export function blockDefinitions(schematic: Schematic): ComponentDef[] {
	const blocks = schematic.blocks ?? [];
	const ours = new Set(blocks.map((block) => BLOCK_PREFIX + block.id));
	const built = new Map<string, ComponentDef>();
	// A block of this drawing counts as known once it is built here, not
	// because the catalog still holds an older version of it.
	const known = (kind: string) =>
		!kind.startsWith(BLOCK_PREFIX) || built.has(kind) || (!ours.has(kind) && isKnownKind(kind));
	let pending = [...blocks];
	while (pending.length > 0) {
		const ready = pending.filter((block) => block.instances.every((i) => known(i.kind)));
		if (ready.length === 0) break;
		withKinds([...built.values()], () => {
			for (const block of ready) {
				const def = blockDefinition(block, blockPorts(block));
				built.set(def.kind, def);
			}
		});
		pending = pending.filter((block) => !ready.includes(block));
	}
	return [...built.values()];
}

/**
 * Make a drawing's blocks available to everything that asks about a kind, on
 * the same terms as `registerSubcircuits`: before anything reads the instances.
 */
export function registerBlocks(schematic: Schematic): void {
	for (const def of blockDefinitions(schematic)) registerKind(def);
}

/** A level the editor left to open a block: the drawing it was, and the block opened. */
export interface OpenedFrom {
	schematic: Schematic;
	probes: string[];
	editing: BlockDef;
}

/** A level with the block opened from it written back in. */
export interface WrittenBack {
	schematic: Schematic;
	probes: string[];
	/**
	 * Every block of `schematic` as it is defined now, the edited one among
	 * them. The drawing was worked out with these; whoever keeps it decides
	 * whether the catalog gets them.
	 */
	definitions: ComponentDef[];
}

/**
 * The drawing a block was opened from, with the block's edited inside written
 * back into it: what leaving the block comes back to.
 *
 * Every placed copy of the block changes with the definition. Its pins may
 * have moved — a port renamed, added or taken away — so each copy's wires are
 * re-attached to where its pins are now; a pin that is gone takes its wire
 * with it.
 *
 * Neither argument is changed, nor is the catalog: the pins before are read
 * from it as it stands, the pins after from the new definitions, which are
 * handed back. The arguments must be plain data, not reactive state.
 */
export function writeBack(
	frame: OpenedFrom,
	edited: Schematic,
	nextId: () => string
): WrittenBack {
	const outer = structuredClone(frame.schematic);
	const inside = structuredClone(edited);
	// Boxing something up inside made a definition; it belongs to the
	// document as a whole, and so does a part imported in there.
	outer.blocks = inside.blocks ?? outer.blocks;
	outer.subcircuits = inside.subcircuits ?? outer.subcircuits;
	const target =
		(outer.blocks ?? []).find((b) => b.id === frame.editing.id) ?? structuredClone(frame.editing);
	const was = structuredClone(target);
	target.instances = inside.instances;
	target.wires = inside.wires;
	target.groups = inside.groups;
	const definitions = blockDefinitions(outer);
	// Every copy follows: the ones on the drawing being returned to, and the
	// ones placed inside the other blocks of the document, whose wires are as
	// much the circuit as the drawing's.
	reattachCopies(outer, target.id, was, target, definitions, nextId);
	for (const block of outer.blocks ?? []) {
		if (block.id === target.id) continue;
		const drawing = interior(block, outer);
		if (reattachCopies(drawing, target.id, was, target, definitions, nextId)) block.wires = drawing.wires;
	}
	return { schematic: outer, probes: followPorts(frame.probes, outer, target.id, was, target), definitions };
}

/**
 * Probes on the pins of block `id`'s copies in `drawing`, after its
 * definition went from `before` to `after`: a probe stays on the port it was
 * on when the port is renamed, and goes with a port that is gone.
 */
export function followPorts(
	probes: readonly string[],
	drawing: Schematic,
	id: string,
	before: BlockDef,
	after: BlockDef
): string[] {
	const now = new Map(blockPorts(after).map((p) => [p.instance, p.name]));
	const renamed = new Map<string, string | null>();
	for (const port of blockPorts(before)) renamed.set(port.name, now.get(port.instance) ?? null);
	const copies = new Set(drawing.instances.filter((i) => i.kind === BLOCK_PREFIX + id).map((i) => i.id));
	return probes.flatMap((handle) => {
		if (!handle.startsWith(PROBE_PIN)) return [handle];
		const rest = handle.slice(PROBE_PIN.length);
		const cut = rest.indexOf(':');
		const owner = rest.slice(0, cut);
		if (cut < 0 || !copies.has(owner)) return [handle];
		const to = renamed.get(rest.slice(cut + 1));
		if (to === undefined) return [handle];
		return to === null ? [] : [probePin(owner, to)];
	});
}

const PROBE_PIN = 'pin:';

/**
 * Re-attach the wires on every copy of block `id` placed in `drawing`, after
 * its definition went from `before` to `after`.
 *
 * Pins are followed by the port they are, not by name: a port renamed inside
 * is the same terminal, and the wire on it stays on it. Where each pin was is
 * read from the catalog as it stands; where it is now, from `definitions`.
 * `drawing.wires` is replaced, never edited in place. Returns whether there
 * was a copy to re-attach.
 */
export function reattachCopies(
	drawing: Schematic,
	id: string,
	before: BlockDef,
	after: BlockDef,
	definitions: readonly ComponentDef[],
	nextId: () => string
): boolean {
	const copies = drawing.instances.filter((i) => i.kind === BLOCK_PREFIX + id);
	if (copies.length === 0) return false;
	const wasPort = new Map(blockPorts(before).map((p) => [p.name, p.instance]));
	const was = new Map<string, Point>();
	for (const placed of copies) {
		for (const pin of definitionFor(placed).pins) {
			const port = wasPort.get(pin.name);
			if (port) was.set(`${placed.id}:${port}`, pinPosition(placed, pin));
		}
	}
	withKinds(definitions, () => {
		const moved = new Map<string, Point>();
		for (const placed of copies) {
			const pins = definitionFor(placed).pins;
			const still = new Set<string>();
			for (const port of blockPorts(after)) {
				const pin = pins.find((p) => p.name === port.name);
				const from = was.get(`${placed.id}:${port.instance}`);
				if (!pin || !from) continue;
				still.add(`${placed.id}:${port.instance}`);
				const now = pinPosition(placed, pin);
				if (from.x !== now.x || from.y !== now.y) moved.set(pointKey(from.x, from.y), now);
			}
			// A wire on a pin that is gone goes with it. Left hanging where the
			// pin was, it sat exactly where the pins that remain close up to,
			// and one of them landing on the loose end was a connection nobody
			// drew. The part at its far end is then unconnected, and says so.
			for (const [key, from] of was) {
				if (!key.startsWith(`${placed.id}:`) || still.has(key)) continue;
				const at = pointKey(from.x, from.y);
				drawing.wires = drawing.wires.filter((w) => {
					const ends = [w.points[0], w.points[w.points.length - 1]];
					return !ends.some((p) => pointKey(p.x, p.y) === at);
				});
			}
		}
		rerouteMoved(drawing, moved, (from, to, settling, prefer) =>
			routeWire(drawing, from, to, { grid: GRID, ignoreWires: settling, prefer })
		);
		if (moved.size > 0) drawing.wires = tidiedWires(drawing, nextId);
	});
	return true;
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
 * A block of the drawing that is placed inside itself, directly or further
 * down, by name; or null when none is. Such a drawing cannot be unfolded, so
 * it is refused at the door rather than discovered on the first compile.
 */
export function selfContained(schematic: Schematic): string | null {
	for (const block of schematic.blocks ?? []) {
		const inner = block.instances.map((i) => blockOf(schematic, i.kind)).filter((b) => b !== null);
		if (inner.some((child) => contains(schematic, child.id, block.id))) return block.name;
	}
	return null;
}

/**
 * Whether block `id` is `inside`, or is built out of something that is: the
 * blocks that must not be placed in `inside`, or it would contain itself.
 */
export function contains(
	schematic: Schematic,
	id: string,
	inside: string,
	seen: Set<string> = new Set()
): boolean {
	if (id === inside) return true;
	// A block met twice on the way down is a loop that does not lead to
	// `inside` — or it would have been found the first time.
	if (seen.has(id)) return false;
	seen.add(id);
	const block = schematic.blocks?.find((b) => b.id === id);
	if (!block) return false;
	return block.instances.some((i) => {
		const child = blockOf(schematic, i.kind);
		return child !== null && contains(schematic, child.id, inside, seen);
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
	/** The blocks found placed inside themselves, by name. Each was left closed. */
	cycles: string[];
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
	const cycles = new Set<string>();
	// The blocks being unfolded on the way down to the one at hand. A block
	// met again on its own way down contains itself, and unfolding it would
	// never end; it is left as a closed box and reported instead.
	const opening = new Set<string>();
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
		if (!block) return;
		if (opening.has(block.id)) {
			cycles.add(block.name);
			return;
		}
		opening.add(block.id);
		unfold(instance, block);
		opening.delete(block.id);
	};

	for (const instance of schematic.instances) take(instance);
	wires.push(...schematic.wires);

	return {
		schematic: { ...schematic, instances, wires },
		ties,
		portFlow,
		cycles: [...cycles]
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
