/**
 * Where a group is on the drawing.
 *
 * A group is stored as a name over a list of parts and nothing else, so its
 * frame and its label are worked out from the parts every time they are
 * needed. Two things need them — the renderer, to draw them, and the select
 * tool, to know whether a press landed on the label — and they have to agree
 * to the pixel, so the geometry lives here and both ask for it.
 */

import type { Rect, Vec2 } from '$lib/canvas';
import type { Instance, PartGroup, Schematic } from './model';
import { instanceBounds } from './scene';

/** How far a group's frame stands off the parts inside it, in schematic units. */
export const GROUP_MARGIN = 14;

/** The gap between the frame's top edge and the baseline of the name, in pixels. */
export const GROUP_LABEL_GAP = 4;

/**
 * The name is drawn at a fixed pixel size, so its box in world units depends
 * on the zoom. The font is monospace, and this is the advance of one glyph
 * as a fraction of the size — close enough for a hit test, which is the only
 * thing that needs a width without a canvas to measure on.
 */
const GLYPH_ADVANCE = 0.62;

/** The label's pixel size at a given zoom, the same rule the value labels use. */
export function groupLabelSize(scale: number): number {
	return Math.min(11 * scale, 15);
}

/** The frame around a group's parts, or null when none of them exist. */
export function groupFrame(group: PartGroup, byId: ReadonlyMap<string, Instance>): Rect | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const id of group.members) {
		const instance = byId.get(id);
		if (!instance) continue;
		const b = instanceBounds(instance);
		minX = Math.min(minX, b.x);
		minY = Math.min(minY, b.y);
		maxX = Math.max(maxX, b.x + b.w);
		maxY = Math.max(maxY, b.y + b.h);
	}
	if (minX === Infinity) return null;
	return {
		x: minX - GROUP_MARGIN,
		y: minY - GROUP_MARGIN,
		w: maxX - minX + 2 * GROUP_MARGIN,
		h: maxY - minY + 2 * GROUP_MARGIN
	};
}

/**
 * The box the name occupies on screen, in pixels, given where the frame's
 * top-left corner lands. Padded a little on every side: a label is a small
 * target and the press that misses it by a pixel meant the label.
 */
export function groupLabelBox(corner: Vec2, name: string, scale: number): Rect {
	const size = groupLabelSize(scale);
	const pad = 3;
	return {
		x: corner.x - pad,
		y: corner.y - GROUP_LABEL_GAP - size - pad,
		w: name.length * size * GLYPH_ADVANCE + 2 * pad,
		h: size + 2 * pad
	};
}

export interface GroupPlacement {
	group: PartGroup;
	frame: Rect;
}

/** Every group that has parts on the drawing, with its frame. */
export function placeGroups(schematic: Schematic): GroupPlacement[] {
	const groups = schematic.groups;
	if (!groups?.length) return [];
	const byId = new Map(schematic.instances.map((i) => [i.id, i]));
	const out: GroupPlacement[] = [];
	for (const group of groups) {
		const frame = groupFrame(group, byId);
		if (frame) out.push({ group, frame });
	}
	return out;
}

/**
 * The group whose name is under a screen point, if any. Later groups are
 * drawn over earlier ones, so the last hit wins.
 */
export function groupLabelAt(
	schematic: Schematic,
	screen: Vec2,
	toScreen: (world: Vec2) => Vec2,
	scale: number
): PartGroup | null {
	let found: PartGroup | null = null;
	for (const { group, frame } of placeGroups(schematic)) {
		const box = groupLabelBox(toScreen({ x: frame.x, y: frame.y }), group.name, scale);
		if (
			screen.x >= box.x &&
			screen.x <= box.x + box.w &&
			screen.y >= box.y &&
			screen.y <= box.y + box.h
		) {
			found = group;
		}
	}
	return found;
}

/** Does a part's box lie wholly outside a frame? */
export function outside(instance: Instance, frame: Rect): boolean {
	const b = instanceBounds(instance);
	return b.x + b.w < frame.x || b.x > frame.x + frame.w || b.y + b.h < frame.y || b.y > frame.y + frame.h;
}
