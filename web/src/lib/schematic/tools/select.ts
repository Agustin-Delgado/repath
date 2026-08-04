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
	distanceToSegment,
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
import { wireSegments, type Point } from '../model';
import { elbow, routeWire } from '../route';
import type { SchematicItem } from '../scene';
import { connectsAt, drawSnapHint, netAt } from './shared';

type Mode = 'idle' | 'move' | 'marquee' | 'wire';

/** How close to a pin the cursor has to be for a drag to mean "start a wire". */
const PIN_REACH = 1.1;

/**
 * The same, for a part that is already selected.
 *
 * Tighter rather than nothing at all. A selected part is also the thing you are
 * about to move, and a small symbol has most of its body inside the ordinary
 * reach — a ground is twenty units tall with its pin on the top edge — so at the
 * full reach it could never be dragged. Refusing the pin outright fixed that at
 * the price of making a selected component impossible to wire from, which is the
 * worse trade: the part you have just placed is the one still selected, and
 * connecting it is the very next thing anyone does.
 *
 * At this reach the terminal itself starts a wire and the rest of the symbol
 * moves it, which is what the two look like.
 */
const SELECTED_PIN_REACH = 0.5;

/**
 * Explored-cell cap for a route computed mid-drag.
 *
 * Enough for any route on a page-sized schematic — a normal one explores a few
 * hundred cells — while bounding the pathological case to something that fits in
 * a frame. Beyond it the route falls back to an elbow.
 */
const DRAG_EFFORT = 4000;

/** Milliseconds of routing a single drag frame may spend across all its wires. */
const FRAME_ROUTING_MS = 8;

export function createSelectTool(): Tool {
	let mode: Mode = 'idle';
	let marquee: Rect | null = null;
	/** Where the drag started, in world units. Offsets are measured from here. */
	let origin: Vec2 = { x: 0, y: 0 };
	let moved = false;
	let pressedId: string | null = null;
	let pressedWasSelected = false;
	/** Which leg of a wire the press landed on, when the press was on a wire. */
	let pressedSegment: { wireId: string; index: number } | null = null;
	/** Pin pairs the current offset would join, for the overlay to show. */
	let pendingJoin: Vec2 | null = null;

	/** Pin under the cursor, if any — the thing a drag would wire from. */
	let hoveredPin: SnapTarget | null = null;
	/** In-flight wire started by dragging off a pin or an existing wire. */
	let wireFrom: Point | null = null;
	/** Shift was held: skip the router and draw the plain elbow. */
	let handRouted = false;
	let wireTo: SnapTarget | null = null;

	/**
	 * The leg of a wire nearest the cursor.
	 *
	 * Dragging edits *that* leg rather than sliding the whole wire. For a straight
	 * two-point wire the leg is the wire, so the familiar behaviour is the
	 * degenerate case — which means a wire with corners becomes reshapeable
	 * without any new gesture to discover.
	 */
	function segmentUnder(id: string, at: Vec2): { wireId: string; index: number } | null {
		const wire = app.schematic.wires.find((w) => w.id === id);
		if (!wire) return null;
		let best: { wireId: string; index: number } | null = null;
		let closest = Infinity;
		for (const segment of wireSegments(wire)) {
			const d = distanceToSegment(at, segment.a, segment.b);
			if (d < closest) {
				closest = d;
				best = { wireId: id, index: segment.index };
			}
		}
		return best;
	}

	function pinUnder(pointer: EditorPointer, ctx: ToolContext): SnapTarget | null {
		const found = ctx.snap.nearestPoint(pointer.world, ctx.tolerance * PIN_REACH);
		if (!found || found.kind !== 'pin') return null;
		if (found.ownerId && app.selection.includes(found.ownerId)) {
			const near = ctx.snap.nearestPoint(pointer.world, ctx.tolerance * SELECTED_PIN_REACH);
			if (!near || near.kind !== 'pin' || near.label !== found.label) return null;
		}
		return found;
	}

	/**
	 * The path a new wire would take. Shift falls back to a plain elbow, for when
	 * the router's idea of tidy is not yours.
	 */
	function wirePath(to: Point, ctx: ToolContext): Point[] {
		if (!wireFrom) return [];
		if (handRouted) return elbow(wireFrom, to);
		return routeWire(app.schematic, wireFrom, to, { grid: ctx.gridSize });
	}

	/**
	 * The offset a drag should actually apply.
	 *
	 * If the raw offset would bring a moving pin near a stationary one, it is
	 * nudged so they land on top of each other exactly. Dragging a part until it
	 * touches another is how people connect two things without a wire, and it has
	 * to snap or it never quite lines up.
	 */
	function joinAdjusted(raw: Vec2, ctx: ToolContext): { dx: number; dy: number } {
		const moving = new Set(app.selection);
		let best: { dx: number; dy: number; distance: number } | null = null;
		// The offset is quantised to the grid before it gets here, so the nearest a
		// drag can come without landing exactly is one whole grid step. A radius
		// smaller than that can only ever catch the case that needed no help, which
		// is why this used to look like it did nothing at all.
		const radius = Math.max(ctx.tolerance * 1.2, ctx.gridSize * 1.6);

		for (const pin of app.movingPinsAt(raw.x, raw.y)) {
			const target = ctx.snap.nearestPoint(pin, radius, (p) =>
				p.kind !== 'pin' || (p.ownerId !== undefined && moving.has(p.ownerId))
			);
			if (!target) continue;
			const distance = Math.hypot(target.x - pin.x, target.y - pin.y);
			if (!best || distance < best.distance) {
				best = { dx: raw.x + (target.x - pin.x), dy: raw.y + (target.y - pin.y), distance };
			}
		}

		if (!best) {
			pendingJoin = null;
			return { dx: raw.x, dy: raw.y };
		}
		// Remember where the join will happen so the overlay can point at it.
		const joined = app.movingPinsAt(best.dx, best.dy);
		pendingJoin = joined.length > 0 ? joined[0] : null;
		for (const pin of joined) {
			const target = ctx.snap.nearestPoint(pin, 0.5, (p) =>
				p.kind !== 'pin' || (p.ownerId !== undefined && moving.has(p.ownerId))
			);
			if (target) {
				pendingJoin = { x: target.x, y: target.y };
				break;
			}
		}
		return { dx: best.dx, dy: best.dy };
	}

	/** Routing used both while dragging and on release — there is only one. */
	function routeDragged(ctx: ToolContext) {
		// A hard backstop on the frame, for the case the per-route cap does not
		// cover: dragging a part with a dozen wires on a crowded page. Past it the
		// remaining wires take the plain elbow, which is instant. Releasing does not
		// re-route — `endMove` keeps the geometry the last frame produced — so this
		// cannot make the committed shape differ from the previewed one.
		const deadline = performance.now() + FRAME_ROUTING_MS;
		return (from: Point, to: Point, settling: ReadonlySet<string>, prefer?: readonly Point[]) => {
			if (performance.now() > deadline) return elbow(from, to);
			return routeWire(app.schematic, from, to, {
				grid: ctx.gridSize,
				// What the wire looked like before this drag. Leaving it costs, which
				// is how a shape someone arranged on purpose survives a move without a
				// separate rule saying when to keep it.
				prefer,
				// The parts on the move stay obstacles, contrary to what one might
				// expect. Exempting them was meant to stop a route detouring around
				// the pin it is heading for — but obstacle boxes are inset by half a
				// cell precisely so a pin is always reachable without paying the body
				// cost, so there was nothing to protect against. What the exemption
				// did instead was let a wire chasing a part's pin drive straight
				// through the middle of that part to reach it.
				ignoreWires: settling,
				// Deliberately below the default. A drag routes every frame, and a
				// bound that depends only on the geometry keeps each frame's result
				// identical to the last — a time-based one would let the same shape
				// flicker between routed and fallback as the machine breathes.
				effort: DRAG_EFFORT
			});
		};
	}

	return {
		name: 'select',
		cursor: 'default',

		deactivate(ctx) {
			// Switching tools with the pointer still down: settle the drag where it
			// is rather than walking away from it. The geometry on screen is already
			// final, so committing is what the user last saw — and leaving the
			// snapshot held would strand it, since no pointer-up is coming.
			if (mode === 'move') app.endMove();
			mode = 'idle';
			marquee = null;
			pressedId = null;
			pressedSegment = null;
			pendingJoin = null;
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
				handRouted = pointer.shift;
				ctx.invalidate('overlay');
				return;
			}

			const item = ctx.scene.top(pointer.world, ctx.tolerance);

			// A second click on a part opens its name for editing, where the name
			// is: chasing the same field down in the inspector to change R1 to RB is
			// a detour past the thing you were already pointing at.
			if (pointer.detail === 2 && item && app.schematic.instances.some((i) => i.id === item.id)) {
				app.selection = [item.id];
				app.renaming = item.id;
				ctx.invalidate('overlay');
				return;
			}

			// Pressing a wire used to be ambiguous — a click to select it, or the
			// start of a branch off it — resolved by watching what the pointer did
			// next. It reads as a wire that runs away when you try to move it, which
			// is the opposite of what dragging anything else does. Branching now has
			// a tool of its own; here, a wire is a wire.

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
				// Only when the wire is the whole selection: dragging a group that
				// happens to contain wires should translate it, not reshape one leg.
				pressedSegment =
					app.selection.length === 1 && app.selection[0] === item.id
						? segmentUnder(item.id, pointer.world)
						: null;
				origin = snapPoint(pointer.world, ctx.gridSize);
				moved = false;
				pendingJoin = null;
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
				handRouted = pointer.shift;
				wireTo = ctx.snap.resolve(pointer.world, ctx.tolerance * 1.4, ctx.gridSize);
				ctx.invalidate('overlay');
				return;
			}

			if (mode === 'move') {
				const now = snapPoint(pointer.world, ctx.gridSize);
				const raw = { x: now.x - origin.x, y: now.y - origin.y };
				if (pressedSegment) {
					// Reshaping one wire: no join snapping, since no pin is travelling.
					if (raw.x || raw.y) moved = true;
					app.applySegmentMove(pressedSegment.wireId, pressedSegment.index, raw.x, raw.y);
					ctx.invalidate('schematic', 'overlay');
					return;
				}
				const offset = joinAdjusted(raw, ctx);
				if (offset.dx || offset.dy) moved = true;
				// Recomputed from the snapshot with the real router, so what is on
				// screen mid-drag is exactly what releasing will leave behind.
				app.applyMove(offset.dx, offset.dy, routeDragged(ctx));
				ctx.invalidate('schematic', 'overlay');
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
					// Dragged from a pin, so the far end is the one that can be adrift.
					// Refused in silence: the preview has been red the whole way, which
					// says it better than a banner that then has to be dismissed.
					if (connectsAt({ x: to.x, y: to.y })) {
						app.addWirePath(wirePath({ x: to.x, y: to.y }, ctx));
					}
				}
				wireFrom = null;
				wireTo = null;
				handRouted = false;
			} else if (mode === 'move') {
				// Nothing to settle: the geometry on screen is already the answer.
				app.endMove();
				pendingJoin = null;
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
			pressedSegment = null;
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
					// Routed, so pulling a part out of a series chain closes the gap
					// along a sensible path rather than a bare diagonal-free guess.
					app.deleteSelection(routeDragged(ctx));
					ctx.invalidate();
					return true;
				case 'r':
				case 'R':
					// Rotation moves pins, so the wires plugged into them re-route
					// through the same router a drag would use.
					app.rotateSelection(routeDragged(ctx));
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
					// Escape belongs to whatever gesture is in flight, and only falls
					// through to clearing the selection when nothing is.
					if (mode === 'wire') {
						mode = 'idle';
						wireFrom = null;
						ctx.invalidate('overlay');
						return true;
					}
					if (mode === 'move') {
						app.cancelMove();
						mode = 'idle';
						pressedId = null;
						pressedSegment = null;
						pendingJoin = null;
						moved = false;
						ctx.setCursor('default');
						ctx.invalidate();
						return true;
					}
					if (mode === 'marquee') {
						mode = 'idle';
						marquee = null;
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

			if (pendingJoin) {
				// Ring the pin the drag is about to land on, so the join is deliberate
				// rather than a surprise.
				painter.dot(pendingJoin, 8, { color: theme.accent, alpha: 0.25 });
				painter.dot(pendingJoin, 3.5, { color: theme.accent });
			}

			if (mode === 'wire' && wireFrom && wireTo) {
				// Same feedback as the wire tool: a run that would end on nothing is
				// shown as one that will not be accepted.
				const adrift = !connectsAt({ x: wireTo.x, y: wireTo.y });
				const colour = adrift ? theme.danger : theme.accent;
				painter.polyline(wirePath({ x: wireTo.x, y: wireTo.y }, ctx), {
					color: colour,
					width: 2,
					dash: adrift ? [6, 4] : undefined
				});
				drawSnapHint(painter, ctx, wireTo, colour);
			} else if (hoveredPin) {
				// Idle over a pin: show that dragging from here would draw a wire.
				drawSnapHint(painter, ctx, hoveredPin, theme.accent);
			}
		}
	};
}

/** Exposed for tests: the item a click at `point` would select. */
export function selectionCandidate(ctx: ToolContext, point: Vec2): SchematicItem | undefined {
	return ctx.scene.top(point, ctx.tolerance)?.data as SchematicItem | undefined;
}
