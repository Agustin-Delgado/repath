/**
 * Drawing wires.
 *
 * Supports both habits people already have: drag from one point to another, or
 * click once to start and click again for each corner. A run ends when you land
 * on a pin — which is almost always where you were headed — or on Escape.
 *
 * Every endpoint goes through the snap index first, so wires land on pins and on
 * existing wires exactly rather than nearly. That is the single thing that makes
 * schematic drawing feel solid instead of fiddly.
 */

import {
	snapPoint,
	type EditorPointer,
	type Painter,
	type SnapTarget,
	type Tool,
	type ToolContext,
	type Vec2
} from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { currentTheme } from '../draw';
import { constrainToAxis, routeL } from './shared';

/** Slightly more generous than picking: you aim at pins deliberately. */
const SNAP_FACTOR = 1.4;

export function createWireTool(): Tool {
	let from: Vec2 | null = null;
	let target: SnapTarget | null = null;
	let verticalFirst = false;
	let dragStarted = false;

	function resolve(pointer: EditorPointer, ctx: ToolContext): SnapTarget {
		const snapped = ctx.snap.resolve(pointer.world, ctx.tolerance * SNAP_FACTOR, ctx.gridSize);
		if (!from || !pointer.shift) return snapped;
		// Shift constrains to a single straight run.
		const axis = constrainToAxis(from, snapped);
		return { ...axis, kind: 'grid' };
	}

	function route(to: Vec2): Vec2[] {
		return from ? routeL(from, to, verticalFirst) : [];
	}

	function finish(ctx: ToolContext): void {
		from = null;
		dragStarted = false;
		verticalFirst = false;
		ctx.invalidate('schematic', 'overlay');
	}

	return {
		name: 'wire',
		cursor: 'crosshair',

		deactivate(ctx) {
			finish(ctx);
		},

		pointerDown(pointer, ctx) {
			if (pointer.button !== 0) return;
			const snapped = resolve(pointer, ctx);
			target = snapped;

			if (!from) {
				from = { x: snapped.x, y: snapped.y };
				dragStarted = false;
				ctx.invalidate('overlay');
				return;
			}

			// A second click commits the run so far and carries on from there.
			app.addWirePath(route(snapped));
			from = { x: snapped.x, y: snapped.y };
			if (snapped.kind === 'pin') finish(ctx);
			else ctx.invalidate('schematic', 'overlay');
		},

		pointerMove(pointer, ctx) {
			target = resolve(pointer, ctx);
			if (from && pointer.dragging) dragStarted = true;
			ctx.invalidate('overlay');
		},

		pointerUp(pointer, ctx) {
			if (!from) return;
			// Only a genuine drag commits on release; a click starts a chained run.
			if (!dragStarted) return;

			const snapped = resolve(pointer, ctx);
			if (snapped.x !== from.x || snapped.y !== from.y) {
				app.addWirePath(route(snapped));
			}
			finish(ctx);
		},

		keyDown(event, ctx) {
			if (event.key === 'Escape') {
				finish(ctx);
				return true;
			}
			// Flip which axis the bend takes first — the schematic equivalent of
			// deciding whether to go along the corridor or up the stairs.
			if (event.key === ' ' || event.key === 'Tab') {
				verticalFirst = !verticalFirst;
				ctx.invalidate('overlay');
				return true;
			}
			return false;
		},

		drawOverlay(painter: Painter, ctx: ToolContext) {
			const theme = currentTheme();

			if (from && target) {
				const points = route(target);
				painter.polyline(points, { color: theme.accent, width: 2 });
				for (const corner of points.slice(1, -1)) {
					painter.dot(corner, 2.5, { color: theme.accent });
				}
			}

			if (!target) return;

			// Show what the endpoint would attach to. A ring on a pin, a smaller
			// mark on a wire, nothing special for a plain grid point.
			const at = { x: target.x, y: target.y };
			if (target.kind === 'pin' || target.kind === 'junction') {
				painter.dot(at, 6, { color: theme.accent, alpha: 0.25 });
				painter.dot(at, 3.5, { color: theme.accent });
				if (target.label) {
					painter.text(
						target.label,
						{ x: at.x, y: at.y - 12 * ctx.unit },
						{ size: 11, color: theme.accent, align: 'center', baseline: 'bottom' }
					);
				}
			} else if (target.kind === 'wire') {
				painter.dot(at, 4, { color: theme.accent });
			} else {
				painter.dot(at, 2.5, { color: theme.accent, alpha: 0.7 });
			}
		}
	};
}

/** Where a wire would land, given a pointer position. Exposed for tests. */
export function wireEndpoint(ctx: ToolContext, at: Vec2): SnapTarget {
	return ctx.snap.resolve(at, ctx.tolerance * SNAP_FACTOR, ctx.gridSize);
}

export { snapPoint };
