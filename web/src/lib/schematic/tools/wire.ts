/**
 * Drawing a wire between two things that already exist.
 *
 * Wiring is mostly done without this: dragging off a pin draws a wire, which is
 * the gesture anyone reaches for after dropping a component. What that cannot do
 * is start from the middle of an existing wire to branch off it, and the attempt
 * to squeeze that into the select tool is what this replaces. There, pressing a
 * wire had to mean either "select and move this" or "start a branch here", and
 * the tool guessed by watching whether the pointer moved — so a wire someone
 * meant to drag ran away and became a new wire instead. Dragging a thing should
 * move the thing.
 *
 * So branching gets a tool, and the ambiguity goes away: with the select tool a
 * wire is a wire, and with this one every press is a connection.
 *
 * It stays active until dismissed, unlike placing a component. A component is
 * one press and it exists; a wire takes two ends, and the reason to reach for
 * this tool at all is a run of connections that pins alone cannot start.
 */

import { type Painter, type SnapTarget, type Tool, type ToolContext } from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { currentTheme } from '../draw';
import { elbow, routeWire } from '../route';
import type { Point } from '../model';
import { connectsAt, drawSnapHint } from './shared';

/** How far from the cursor a pin or wire may be and still be what was meant. */
const REACH = 1.4;

export function createWireTool(): Tool {
	let from: Point | null = null;
	let to: SnapTarget | null = null;
	/** Shift was held: skip the router and draw the plain elbow. */
	let handRouted = false;
	/** Where the cursor is when nothing is being drawn, for the hint. */
	let hover: SnapTarget | null = null;

	const path = (end: Point, ctx: ToolContext): Point[] => {
		if (!from) return [];
		return handRouted ? elbow(from, end) : routeWire(app.schematic, from, end, { grid: ctx.gridSize });
	};

	const reset = () => {
		from = null;
		to = null;
		handRouted = false;
	};

	return {
		name: 'wire',
		cursor: 'crosshair',

		deactivate(ctx) {
			reset();
			hover = null;
			ctx.invalidate('overlay');
		},

		pointerDown(pointer, ctx) {
			if (pointer.button !== 0) return;
			const at = ctx.snap.resolve(pointer.world, ctx.tolerance * REACH, ctx.gridSize);

			// Both ends have to hold on to something, and the first end is settled
			// here rather than on release: starting from nowhere can only end in a
			// wire that is refused. Nothing is said about it — the hint marks every
			// place a wire can start from, so an empty press has already told you.
			if (!connectsAt({ x: at.x, y: at.y })) {
				ctx.invalidate('overlay');
				return;
			}

			from = { x: at.x, y: at.y };
			to = at;
			handRouted = pointer.shift;
			ctx.invalidate('overlay');
		},

		pointerMove(pointer, ctx) {
			const at = ctx.snap.resolve(pointer.world, ctx.tolerance * REACH, ctx.gridSize);
			if (from) {
				handRouted = pointer.shift;
				to = at;
			} else {
				hover = connectsAt({ x: at.x, y: at.y }) ? at : null;
			}
			ctx.invalidate('overlay');
		},

		pointerUp(pointer, ctx) {
			if (!from) return;
			const at = ctx.snap.resolve(pointer.world, ctx.tolerance * REACH, ctx.gridSize);

			if (at.x === from.x && at.y === from.y) {
				// Pressed and released in the same place. Treated as thinking better of
				// it rather than as a wire of no length.
				reset();
				ctx.invalidate('overlay');
				return;
			}

			// Turned away in silence when it lands on nothing: the preview has been
			// red for the whole drag, which is the same thing said sooner.
			if (connectsAt({ x: at.x, y: at.y })) {
				app.addWirePath(path({ x: at.x, y: at.y }, ctx));
			}

			reset();
			ctx.invalidate('schematic', 'overlay');
		},

		pointerLeave(ctx) {
			hover = null;
			ctx.invalidate('overlay');
		},

		keyDown(event) {
			if (event.key !== 'Escape') return false;
			// One press to abandon a half-drawn wire, a second to put the tool down.
			if (from) reset();
			else app.tool = { mode: 'select' };
			return true;
		},

		drawOverlay(painter: Painter, ctx: ToolContext) {
			const theme = currentTheme();
			if (from && to) {
				painter.polyline(path({ x: to.x, y: to.y }, ctx), {
					color: connectsAt({ x: to.x, y: to.y }) ? theme.accent : theme.danger,
					width: 2,
					dash: [6, 4]
				});
				drawSnapHint(painter, ctx, to, theme.accent);
				return;
			}
			if (hover) drawSnapHint(painter, ctx, hover, theme.accent);
		}
	};
}
