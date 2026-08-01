/**
 * Select, move, marquee — and start a wire from a pin.
 *
 * That last one matters more than it sounds. Having to switch tools between
 * dropping a component and connecting it is most of what made adding something
 * to a circuit feel like work: you place a resistor, and the obvious next
 * gesture is to drag from its pin to whatever it should join. So that gesture
 * does exactly that, and the tool switch stops being something you have to
 * remember.
 *
 * Moving keeps connections. Wire ends stuck to a component's pins travel with
 * it and re-route, rather than being left behind holding nothing.
 */

import {
	rectFromPoints,
	snapPoint,
	type EditorPointer,
	type Painter,
	type Rect,
	type SnapTarget,
	type Tool,
	type ToolContext,
	type Vec2
} from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { currentTheme } from '../draw';
import { wireEnd, wireStart, type Point, type Wire } from '../model';
import { routeWire } from '../route';
import type { SchematicItem } from '../scene';
import { netAt } from './shared';
import { drawSnapHint } from './wire';

type Mode = 'idle' | 'move' | 'marquee' | 'wire';

/** How close to a pin the cursor has to be for a drag to mean "start a wire". */
const PIN_REACH = 1.1;

export function createSelectTool(): Tool {
	let mode: Mode = 'idle';
	let marquee: Rect | null = null;
	let anchor: Vec2 = { x: 0, y: 0 };
	let moved = false;
	let pressedId: string | null = null;
	let pressedWasSelected = false;

	/** Pin under the cursor, if any — the thing a drag would wire from. */
	let hoveredPin: SnapTarget | null = null;
	/** In-flight wire started by dragging off a pin. */
	let wireFrom: Point | null = null;
	let wireTo: SnapTarget | null = null;

	function pinUnder(pointer: EditorPointer, ctx: ToolContext): SnapTarget | null {
		const found = ctx.snap.nearestPoint(pointer.world, ctx.tolerance * PIN_REACH);
		return found && found.kind === 'pin' ? found : null;
	}

	function wirePath(to: Point, ctx: ToolContext): Point[] {
		if (!wireFrom) return [];
		return routeWire(app.schematic, wireFrom, to, { grid: ctx.gridSize });
	}

	return {
		name: 'select',
		cursor: 'default',

		deactivate(ctx) {
			mode = 'idle';
			marquee = null;
			hoveredPin = null;
			wireFrom = null;
			if (app.hoverNet !== null) {
				app.hoverNet = null;
				ctx.invalidate('schematic');
			}
		},

		pointerDown(pointer, ctx) {
			if (pointer.button !== 0) return;

			// A pin under the cursor means the gesture is a connection, not a move.
			const pin = pinUnder(pointer, ctx);
			if (pin) {
				mode = 'wire';
				wireFrom = { x: pin.x, y: pin.y };
				wireTo = pin;
				ctx.invalidate('overlay');
				return;
			}

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
				moved = false;
				app.beginMove();
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
			if (mode === 'wire') {
				wireTo = ctx.snap.resolve(pointer.world, ctx.tolerance * 1.4, ctx.gridSize);
				ctx.invalidate('overlay');
				return;
			}

			if (mode === 'move') {
				const now = snapPoint(pointer.world, ctx.gridSize);
				const dx = now.x - anchor.x;
				const dy = now.y - anchor.y;
				if (dx || dy) {
					app.moveSelection(dx, dy);
					anchor = now;
					moved = true;
					ctx.invalidate('schematic', 'overlay');
				}
				return;
			}

			if (mode === 'marquee') {
				marquee = rectFromPoints(pointer.origin, pointer.world);
				ctx.invalidate('overlay');
				return;
			}

			// Idle: track what the cursor is over.
			const pin = pinUnder(pointer, ctx);
			const pinChanged = (pin?.label ?? null) !== (hoveredPin?.label ?? null);
			hoveredPin = pin;

			const net = netAt(pointer.world, ctx);
			const netChanged = net !== app.hoverNet;
			app.hoverNet = net;

			ctx.setCursor(pin ? 'crosshair' : ctx.scene.top(pointer.world, ctx.tolerance) ? 'pointer' : 'default');
			if (pinChanged) ctx.invalidate('overlay');
			if (netChanged) ctx.invalidate('schematic');
		},

		pointerUp(pointer, ctx) {
			if (mode === 'wire' && wireFrom) {
				const to = ctx.snap.resolve(pointer.world, ctx.tolerance * 1.4, ctx.gridSize);
				if (to.x !== wireFrom.x || to.y !== wireFrom.y) {
					app.addWirePath(wirePath({ x: to.x, y: to.y }, ctx));
				}
				wireFrom = null;
				wireTo = null;
			} else if (mode === 'move') {
				// Re-route what came along for the ride, now that it has stopped.
				app.endMove((wire) => reroute(wire, ctx));
				if (!moved && pressedId && pressedWasSelected && !pointer.shift) {
					// A click on an already-selected item narrows the selection to it,
					// so one component can be picked out of a group.
					app.selection = [pressedId];
				}
			} else if (mode === 'marquee' && marquee) {
				if (marquee.w > 2 || marquee.h > 2) {
					const hits = ctx.scene.enclosed(marquee).map((item) => item.id);
					app.selection = pointer.shift ? [...new Set([...app.selection, ...hits])] : hits;
				}
			}

			mode = 'idle';
			marquee = null;
			pressedId = null;
			ctx.setCursor('default');
			ctx.invalidate('schematic', 'overlay');
		},

		pointerLeave(ctx) {
			hoveredPin = null;
			if (app.hoverNet !== null) {
				app.hoverNet = null;
				ctx.invalidate('schematic');
			}
			ctx.invalidate('overlay');
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
					if (mode === 'wire') {
						mode = 'idle';
						wireFrom = null;
						ctx.invalidate('overlay');
						return true;
					}
					app.selection = [];
					ctx.invalidate();
					return true;
			}
			return false;
		},

		drawOverlay(painter: Painter, ctx: ToolContext) {
			const theme = currentTheme();

			if (marquee) {
				painter.rect(
					marquee,
					{ color: theme.accent, alpha: 0.12 },
					{ color: theme.accent, width: 1, dash: [4, 3] }
				);
			}

			if (mode === 'wire' && wireFrom && wireTo) {
				painter.polyline(wirePath({ x: wireTo.x, y: wireTo.y }, ctx), {
					color: theme.accent,
					width: 2
				});
				drawSnapHint(painter, ctx, wireTo, theme.accent);
			} else if (hoveredPin) {
				// Idle over a pin: show that dragging from here would draw a wire.
				drawSnapHint(painter, ctx, hoveredPin, theme.accent);
			}
		}
	};
}

/**
 * Re-route a wire that was dragged along with a component.
 *
 * Only the end that moved is rebuilt; the fixed end stays put, which is what
 * keeps the rest of the circuit from rearranging itself around one nudge.
 */
function reroute(wire: Wire, ctx: ToolContext): Point[] | null {
	const from = wireStart(wire);
	const to = wireEnd(wire);
	if (from.x === to.x && from.y === to.y) return null;
	return routeWire(app.schematic, from, to, {
		grid: ctx.gridSize,
		ignoreWires: new Set([wire.id])
	});
}

/** Exposed for tests: the item a click at `point` would select. */
export function selectionCandidate(ctx: ToolContext, point: Vec2): SchematicItem | undefined {
	return ctx.scene.top(point, ctx.tolerance)?.data as SchematicItem | undefined;
}
