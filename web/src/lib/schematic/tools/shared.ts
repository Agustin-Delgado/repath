/**
 * Helpers shared between tools.
 */

import { distance, type Painter, type SnapTarget, type ToolContext, type Vec2 } from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { definitionOf, pinPosition, pointKey, wireSegments, wireStart } from '../model';
import type { SchematicItem } from '../scene';
import { instancePins } from '../scene';

/**
 * Which net is at a world point, for hover highlighting.
 *
 * Checks pins before wires: near a pin, the interesting thing is the pin, and
 * the wire running into it belongs to the same net anyway.
 */
export function netAt(point: Vec2, ctx: ToolContext): number | null {
	const netOfPoint = app.compiled.connectivity.netOfPoint;
	const item = ctx.scene.top(point, ctx.tolerance);
	if (!item) return null;

	const data = item.data as SchematicItem;
	if (data.type === 'wire') {
		const start = wireStart(data.wire);
		return netOfPoint.get(pointKey(start.x, start.y)) ?? null;
	}

	let nearest: { at: Vec2; d: number } | null = null;
	for (const { at } of instancePins(data.instance)) {
		const d = distance(point, at);
		if (!nearest || d < nearest.d) nearest = { at, d };
	}
	if (!nearest || nearest.d > ctx.tolerance * 2.5) return null;
	return netOfPoint.get(pointKey(nearest.at.x, nearest.at.y)) ?? null;
}

/**
 * Route between two points as an L, staying axis-aligned.
 *
 * Returns the corner as well as the ends so the preview and the committed
 * geometry cannot disagree about where the bend goes.
 */
export function routeL(from: Vec2, to: Vec2, verticalFirst = false): Vec2[] {
	if (from.x === to.x || from.y === to.y) return [from, to];
	const corner = verticalFirst ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
	return [from, corner, to];
}

/** Constrain to whichever axis the pointer has travelled furthest along. */
export function constrainToAxis(from: Vec2, to: Vec2): Vec2 {
	return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
		? { x: to.x, y: from.y }
		: { x: from.x, y: to.y };
}

/**
 * Is there anything at this point for a wire end to hold on to?
 *
 * A pin, or any existing wire — including partway along one, which is how a
 * junction is made. Used to turn away a wire that would be left hanging in
 * space: in a simulator a free end conducts nothing, so drawing one is never
 * what was meant, and it is worth saying so at the moment it happens rather
 * than leaving it to be found later in a list of warnings.
 *
 * Deliberately a tool-level check, not a rule in the model. Files, shared links
 * and older saves have to be able to carry whatever geometry they carry; it is
 * the editor that should decline to make a mess in the first place.
 */
export function connectsAt(at: Vec2): boolean {
	for (const instance of app.schematic.instances) {
		for (const pin of definitionOf(instance.kind).pins) {
			const p = pinPosition(instance, pin);
			if (p.x === at.x && p.y === at.y) return true;
		}
	}

	for (const wire of app.schematic.wires) {
		for (const segment of wireSegments(wire)) {
			// Axis-aligned, so "on the segment" is two range checks.
			const withinX = at.x >= Math.min(segment.a.x, segment.b.x) && at.x <= Math.max(segment.a.x, segment.b.x);
			const withinY = at.y >= Math.min(segment.a.y, segment.b.y) && at.y <= Math.max(segment.a.y, segment.b.y);
			if (withinX && withinY) return true;
		}
	}

	return false;
}

/**
 * Show what an endpoint would attach to.
 *
 * The same hint whether the endpoint is being dragged or merely hovered — the
 * feedback should not change depending on how you got there.
 */
export function drawSnapHint(
	painter: Painter,
	ctx: ToolContext,
	target: SnapTarget,
	colour: string
): void {
	const at: Vec2 = { x: target.x, y: target.y };
	if (target.kind === 'pin' || target.kind === 'junction') {
		painter.dot(at, 7, { color: colour, alpha: 0.22 });
		painter.dot(at, 3.5, { color: colour });
		if (target.label) {
			painter.text(
				target.label,
				{ x: at.x, y: at.y - 14 * ctx.unit },
				{ size: 11, color: colour, align: 'center', baseline: 'bottom' }
			);
		}
	} else if (target.kind === 'wire') {
		painter.dot(at, 4, { color: colour });
	} else {
		painter.dot(at, 2.5, { color: colour, alpha: 0.7 });
	}
}
