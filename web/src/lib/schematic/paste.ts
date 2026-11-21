/**
 * What a paste brings along, and what it must not do on landing.
 *
 * A paste is two drawings meeting: the one on the page and the one on the
 * clipboard. Each has its own nets, and landing one on the other must not join
 * a net of one to a net of the other where nobody drew a connection — a pin
 * coming down on a wire end, a pasted wire ending on a pin. A move refuses the
 * same thing; a paste used to do it silently, and pasting a circuit a few
 * times beside itself left one net with forty pins on it.
 */

import { blockOf, pointKey, SUBCIRCUIT_PREFIX, type BlockDef, type Schematic, type SubcircuitDef } from './model';
import { pinKey, type Connectivity } from './nets';

/**
 * The blocks and imported parts a set of parts needs, looking inside every
 * block it reaches. `lookup` holds the block definitions to look in.
 */
export function reachedDefinitions(
	kinds: Iterable<string>,
	lookup: Schematic
): { blocks: Set<string>; subcircuits: Set<string> } {
	const blocks = new Set<string>();
	const subcircuits = new Set<string>();
	const visit = (kind: string): void => {
		if (kind.startsWith(SUBCIRCUIT_PREFIX)) {
			subcircuits.add(kind.slice(SUBCIRCUIT_PREFIX.length));
			return;
		}
		const block = blockOf(lookup, kind);
		if (!block || blocks.has(block.id)) return;
		blocks.add(block.id);
		for (const inner of block.instances) visit(inner.kind);
	};
	for (const kind of kinds) visit(kind);
	return { blocks, subcircuits };
}

/**
 * The imported parts a paste adds to a drawing, and the ids it had to change.
 *
 * One the drawing already has under the same id and from the same source is
 * the same part. One it has under that id but from a different source is a
 * different part that happened to get the same id from its name — imported
 * into another document — and pasting it under that id would have quietly
 * turned the pasted copies into the drawing's part. It comes in under an id of
 * its own instead.
 */
export function mergeSubcircuits(
	wanted: readonly SubcircuitDef[],
	present: readonly SubcircuitDef[],
	freeId: (name: string, ...taken: ReadonlyArray<readonly SubcircuitDef[]>) => string
): { added: SubcircuitDef[]; renamed: Map<string, string> } {
	const added: SubcircuitDef[] = [];
	const renamed = new Map<string, string>();
	for (const sub of wanted) {
		const there = present.find((s) => s.id === sub.id);
		if (there && there.source === sub.source && there.name === sub.name) continue;
		const id = there ? freeId(sub.name, present, added) : sub.id;
		if (id !== sub.id) renamed.set(sub.id, id);
		added.push({ ...sub, ports: [...sub.ports], id });
	}
	return { added, renamed };
}

/**
 * A net of the drawing joined to a net of the pasted drawing by a paste,
 * named by a pin or point of each; or null when the paste joined nothing.
 *
 * `page` is the drawing before the paste, `clip` the pasted parts and wires
 * on their own, as they were copied; `after` is the drawing with the paste in.
 * `copyOf` maps a pasted part's id on the clipboard to its id on the page, and
 * `(dx, dy)` is how far the pasted wires were moved. Pins keep their identity
 * through all of it; a wire point does where it is still where it was.
 */
export function joinedByPaste(
	page: Connectivity,
	clip: Connectivity,
	after: Connectivity,
	copyOf: ReadonlyMap<string, string>,
	dx: number,
	dy: number
): [string, string] | null {
	const pasted = new Map<string, number>();
	for (const [key, index] of clip.netOfPin) {
		const cut = key.lastIndexOf(':');
		const copy = copyOf.get(key.slice(0, cut));
		if (copy) pasted.set(pinKey(copy, key.slice(cut + 1)), index);
	}
	for (const net of after.nets) {
		let side: { page?: string; clip?: string } = {};
		const pageNets = new Set<number>();
		const clipNets = new Set<number>();
		const see = (where: 'page' | 'clip', index: number | undefined, what: string) => {
			if (index === undefined) return;
			(where === 'page' ? pageNets : clipNets).add(index);
			side = { ...side, [where]: side[where] ?? what };
		};
		for (const ref of net.pins) {
			const key = pinKey(ref.instance.id, ref.pin.name);
			const what = `${ref.instance.name}.${ref.pin.name}`;
			see('page', page.netOfPin.get(key), what);
			see('clip', pasted.get(key), what);
		}
		for (const key of net.points) {
			const [x, y] = key.split(',').map(Number);
			const what = `the wire at ${x}, ${y}`;
			see('page', page.netOfPoint.get(key), what);
			see('clip', clip.netOfPoint.get(pointKey(x - dx, y - dy)), what);
		}
		// Two nets of either drawing becoming one is a join as well: the paste
		// is what put them together.
		if (pageNets.size > 1 || clipNets.size > 1 || (pageNets.size > 0 && clipNets.size > 0)) {
			if (side.page && side.clip) return [side.page, side.clip];
			const names = [...net.pins.map((ref) => `${ref.instance.name}.${ref.pin.name}`)];
			return [names[0] ?? side.page ?? side.clip ?? 'a wire', names[1] ?? 'another net'];
		}
	}
	return null;
}

/** Block definitions with the imported parts they place renamed, for the ids a paste had to change. */
export function renameSubcircuitKinds(blocks: readonly BlockDef[], renamed: ReadonlyMap<string, string>): BlockDef[] {
	if (renamed.size === 0) return [...blocks];
	return blocks.map((block) => ({
		...block,
		instances: block.instances.map((i) => {
			if (!i.kind.startsWith(SUBCIRCUIT_PREFIX)) return i;
			const to = renamed.get(i.kind.slice(SUBCIRCUIT_PREFIX.length));
			return to ? { ...i, kind: SUBCIRCUIT_PREFIX + to } : i;
		})
	}));
}
