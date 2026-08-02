/**
 * Drawing wires.
 *
 * Supports both habits people already have: drag from one point to another, or
 * click once to start and click again for each corner. A run ends when you land
 * on a pin — which is almost always where you were headed — or on Escape.
 *
 * Every endpoint goes through the snap index first, so wires land on pins and on
 * existing wires exactly rather than nearly. Between the ends, the router picks
 * an orthogonal path that steers around components and other wires. Holding
 * Shift falls back to a plain elbow when the router's idea of tidy is not yours.
 */

import {
	type EditorPointer,
	type Painter,
	type SnapTarget,
	type Tool,
	type ToolContext,
	type Vec2
} from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { currentTheme } from '../draw';
import type { Point } from '../model';
import { elbow, onGrid, routeWire } from '../route';
import { connectsAt, constrainToAxis, DANGLING_NOTICE } from './shared';

/** Slightly more generous than picking: you aim at pins deliberately. */
const SNAP_FACTOR = 1.4;

export function createWireTool(): Tool {
	let anchor: Point | null = null;
	/** Corners committed so far in a click-click run. */
	let corners: Point[] = [];
	let target: SnapTarget | null = null;
	let manual = false;
	let dragStarted = false;

	function resolve(pointer: EditorPointer, ctx: ToolContext): SnapTarget {
		const snapped = ctx.snap.resolve(pointer.world, ctx.tolerance * SNAP_FACTOR, ctx.gridSize);
		if (!anchor || !pointer.shift) return snapped;
		// Shift constrains to a single straight run from the anchor.
		const axis = constrainToAxis(anchor, snapped);
		return { ...onGrid(axis, ctx.gridSize), kind: 'grid' };
	}

	/** The path from the anchor to `to`, routed or hand-drawn. */
	function leg(to: Point, ctx: ToolContext): Point[] {
		if (!anchor) return [];
		if (manual) return elbow(anchor, to);
		return routeWire(app.schematic, anchor, to, {
			grid: ctx.gridSize,
			// The corners already committed are ours, not obstacles to dodge.
			allow: new Set(corners.map((p) => `${Math.round(p.x / ctx.gridSize)},${Math.round(p.y / ctx.gridSize)}`))
		});
	}

	/**
	 * Commit a run, unless it would leave an end in mid-air.
	 *
	 * Checked here rather than in the model: a file or a shared link has to be able
	 * to carry whatever it carries, but the editor should decline to draw a wire
	 * that conducts nothing. The message matters as much as the refusal — a
	 * gesture that silently does nothing reads as the app being broken.
	 */
	function commit(path: Point[]): boolean {
		if (path.length < 2) return false;
		const ends = [path[0], path[path.length - 1]];
		if (!ends.every(connectsAt)) {
			app.notice = DANGLING_NOTICE;
			return false;
		}
		app.notice = null;
		app.addWirePath(path);
		return true;
	}

	function finish(ctx: ToolContext): void {
		anchor = null;
		corners = [];
		dragStarted = false;
		manual = false;
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
			const at: Point = { x: snapped.x, y: snapped.y };

			if (!anchor) {
				anchor = at;
				corners = [at];
				dragStarted = false;
				ctx.invalidate('overlay');
				return;
			}

			// A second click fixes the run so far and carries on from there.
			corners = [...corners.slice(0, -1), ...leg(at, ctx)];
			anchor = at;
			if (snapped.kind === 'pin') {
				commit(corners);
				finish(ctx);
			} else {
				ctx.invalidate('overlay');
			}
		},

		pointerMove(pointer, ctx) {
			manual = pointer.shift;
			target = resolve(pointer, ctx);
			if (anchor && pointer.dragging) dragStarted = true;
			ctx.invalidate('overlay');
		},

		pointerUp(pointer, ctx) {
			if (!anchor || !dragStarted) return;

			const snapped = resolve(pointer, ctx);
			const at: Point = { x: snapped.x, y: snapped.y };
			if (at.x !== anchor.x || at.y !== anchor.y) {
				commit([...corners.slice(0, -1), ...leg(at, ctx)]);
			}
			finish(ctx);
		},

		keyDown(event, ctx) {
			if (event.key === 'Escape') {
				finish(ctx);
				return true;
			}
			if (event.key === 'Enter' && anchor && corners.length >= 2) {
				// Finish a chained run where it stands, rather than on a pin.
				commit(corners);
				finish(ctx);
				return true;
			}
			return false;
		},

		drawOverlay(painter: Painter, ctx: ToolContext) {
			const theme = currentTheme();

			if (anchor && target) {
				const path = [...corners.slice(0, -1), ...leg({ x: target.x, y: target.y }, ctx)];
				// Drawn in the refusal colour while the far end is on nothing, so the
				// answer is visible before releasing rather than after.
				const adrift = !connectsAt({ x: target.x, y: target.y });
				const colour = adrift ? theme.danger : theme.accent;
				painter.polyline(path, { color: colour, width: 2, dash: adrift ? [6, 4] : undefined });
				for (const corner of path.slice(1, -1)) {
					painter.dot(corner, 2.5, { color: colour });
				}
			}

			if (!target) return;
			drawSnapHint(painter, ctx, target, connectsAt({ x: target.x, y: target.y }) ? theme.accent : theme.danger);
		}
	};
}

/**
 * Show what an endpoint would attach to.
 *
 * Shared with the select tool, which draws the same hint while hovering a pin —
 * the feedback should not change depending on how you got there.
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

/** Where a wire would land, given a pointer position. Exposed for tests. */
export function wireEndpoint(ctx: ToolContext, at: Vec2): SnapTarget {
	return ctx.snap.resolve(at, ctx.tolerance * SNAP_FACTOR, ctx.gridSize);
}
