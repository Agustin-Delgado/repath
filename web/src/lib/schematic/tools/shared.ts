/**
 * Helpers shared between tools.
 */

import { distance, type ToolContext, type Vec2 } from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { pointKey } from '../model';
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
		return netOfPoint.get(pointKey(data.wire.x1, data.wire.y1)) ?? null;
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
