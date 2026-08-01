/**
 * Select, move, and marquee.
 *
 * The gesture is decided on press: something under the cursor means a move,
 * empty space means a rubber band. Nothing is committed to history until the
 * selection has actually moved, so a plain click never leaves an undo step
 * behind.
 */

import {
	rectFromPoints,
	snapPoint,
	type EditorPointer,
	type Painter,
	type Rect,
	type Tool,
	type ToolContext,
	type Vec2
} from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { currentTheme } from '../draw';
import type { SchematicItem } from '../scene';
import { netAt } from './shared';

type Mode = 'idle' | 'move' | 'marquee';

export function createSelectTool(): Tool {
	let mode: Mode = 'idle';
	let marquee: Rect | null = null;
	let anchor: Vec2 = { x: 0, y: 0 };
	let movedDuringDrag = false;
	let pressedId: string | null = null;
	let pressedWasSelected = false;

	function updateHover(pointer: EditorPointer, ctx: ToolContext): boolean {
		const net = netAt(pointer.world, ctx);
		if (net === app.hoverNet) return false;
		app.hoverNet = net;
		return true;
	}

	return {
		name: 'select',
		cursor: 'default',

		deactivate(ctx) {
			mode = 'idle';
			marquee = null;
			if (app.hoverNet !== null) {
				app.hoverNet = null;
				ctx.invalidate('schematic');
			}
		},

		pointerDown(pointer, ctx) {
			if (pointer.button !== 0) return;
			const item = ctx.scene.top(pointer.world, ctx.tolerance);

			if (item) {
				pressedId = item.id;
				pressedWasSelected = app.selection.includes(item.id);

				if (pointer.shift) {
					app.selection = pressedWasSelected
						? app.selection.filter((id) => id !== item.id)
						: [...app.selection, item.id];
				} else if (!pressedWasSelected) {
					app.selection = [item.id];
				}

				mode = 'move';
				anchor = snapPoint(pointer.world, ctx.gridSize);
				movedDuringDrag = false;
				ctx.setCursor('grabbing');
			} else {
				pressedId = null;
				if (!pointer.shift) app.selection = [];
				mode = 'marquee';
				marquee = rectFromPoints(pointer.world, pointer.world);
			}
			ctx.invalidate('schematic', 'overlay');
		},

		pointerMove(pointer, ctx) {
			if (mode === 'move') {
				const now = snapPoint(pointer.world, ctx.gridSize);
				const dx = now.x - anchor.x;
				const dy = now.y - anchor.y;
				if (dx || dy) {
					// One history entry for the whole drag, taken on the first movement.
					app.moveSelection(dx, dy, !movedDuringDrag);
					anchor = now;
					movedDuringDrag = true;
					ctx.invalidate('schematic', 'overlay');
				}
				return;
			}

			if (mode === 'marquee') {
				marquee = rectFromPoints(pointer.origin, pointer.world);
				ctx.invalidate('overlay');
				return;
			}

			if (updateHover(pointer, ctx)) ctx.invalidate('schematic');
			const over = ctx.scene.top(pointer.world, ctx.tolerance);
			ctx.setCursor(over ? 'pointer' : 'default');
		},

		pointerUp(pointer, ctx) {
			if (mode === 'marquee' && marquee) {
				if (marquee.w > 2 || marquee.h > 2) {
					const hits = ctx.scene.enclosed(marquee).map((item) => item.id);
					app.selection = pointer.shift ? [...new Set([...app.selection, ...hits])] : hits;
				}
			} else if (mode === 'move' && !movedDuringDrag && pressedId && pressedWasSelected) {
				// A click on an already-selected item, with no drag, narrows the
				// selection to just it — otherwise there is no way to pick one
				// component out of a group without deselecting everything first.
				if (!pointer.shift) app.selection = [pressedId];
			}

			mode = 'idle';
			marquee = null;
			pressedId = null;
			ctx.setCursor('default');
			ctx.invalidate('schematic', 'overlay');
		},

		pointerLeave(ctx) {
			if (app.hoverNet !== null) {
				app.hoverNet = null;
				ctx.invalidate('schematic');
			}
		},

		keyDown(event, ctx) {
			switch (event.key) {
				case 'Delete':
				case 'Backspace':
					app.deleteSelection();
					ctx.invalidate();
					return true;
				case 'r':
				case 'R':
					app.rotateSelection();
					ctx.invalidate();
					return true;
				case 'a':
				case 'A':
					if (event.ctrlKey || event.metaKey) {
						app.selection = ctx.scene.all().map((item) => item.id);
						ctx.invalidate();
						return true;
					}
					return false;
				case 'Escape':
					app.selection = [];
					ctx.invalidate();
					return true;
			}
			return false;
		},

		drawOverlay(painter: Painter) {
			if (!marquee) return;
			const theme = currentTheme();
			painter.rect(
				marquee,
				{ color: theme.accent, alpha: 0.12 },
				{ color: theme.accent, width: 1, dash: [4, 3] }
			);
		}
	};
}

/** Exposed for tests: the item a click at `point` would select. */
export function selectionCandidate(
	ctx: ToolContext,
	point: Vec2
): SchematicItem | undefined {
	return ctx.scene.top(point, ctx.tolerance)?.data as SchematicItem | undefined;
}
