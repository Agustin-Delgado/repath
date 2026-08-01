/**
 * Dropping components.
 *
 * The ghost under the cursor is the real symbol, not a box, so you can see
 * which way round a transistor is going before you commit. `R` turns it, and
 * the rotation carries over to the next one you place — laying out a row of
 * vertical resistors should not mean rotating each one afterwards.
 */

import { snapPoint, type Painter, type Tool, type ToolContext, type Vec2 } from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { currentTheme, symbolPaths } from '../draw';
import { definitionOf, rotatePoint, type Rotation } from '../model';

/**
 * Orientation carried between placements.
 *
 * Deliberately a plain module variable rather than reactive state: the tool is
 * constructed inside a reactive effect, and reading a rune there would make
 * rotating the ghost rebuild the tool — throwing away the very state being
 * rotated. Nothing in the UI needs to observe this, so nothing should.
 */
let stickyRotation: Rotation = 0;

export function createPlaceTool(kind: string): Tool {
	let at: Vec2 | null = null;
	let rotation: Rotation = stickyRotation;

	return {
		name: `place:${kind}`,
		cursor: 'crosshair',

		activate() {
			rotation = stickyRotation;
		},

		deactivate(ctx) {
			at = null;
			ctx.invalidate('overlay');
		},

		pointerMove(pointer, ctx) {
			at = snapPoint(pointer.world, ctx.gridSize);
			ctx.invalidate('overlay');
		},

		pointerDown(pointer, ctx) {
			if (pointer.button !== 0) return;
			const where = snapPoint(pointer.world, ctx.gridSize);
			app.place(kind, where.x, where.y, rotation);
			at = where;
			ctx.invalidate();
		},

		pointerLeave(ctx) {
			at = null;
			ctx.invalidate('overlay');
		},

		keyDown(event, ctx) {
			if (event.key === 'Escape') {
				app.tool = { mode: 'select' };
				return true;
			}
			if (event.key === 'r' || event.key === 'R') {
				rotation = ((rotation + 90) % 360) as Rotation;
				stickyRotation = rotation;
				ctx.invalidate('overlay');
				return true;
			}
			return false;
		},

		drawOverlay(painter: Painter) {
			if (!at) return;
			const theme = currentTheme();
			const paths = symbolPaths(kind, {});

			painter.transformed(at, rotation, () => {
				painter.strokePath(paths.stroke, { color: theme.accent, width: 2, alpha: 0.75 });
				if (paths.hasFill) painter.fillPath(paths.fill, { color: theme.accent, alpha: 0.75 });
			});

			// Show where the pins will land, so it is obvious what will connect.
			for (const pin of definitionOf(kind).pins) {
				const offset = rotatePoint(pin.x, pin.y, rotation);
				painter.dot({ x: at.x + offset.x, y: at.y + offset.y }, 3, {
					color: theme.accent,
					alpha: 0.9
				});
			}
		}
	};
}
