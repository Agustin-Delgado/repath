/**
 * The tool protocol.
 *
 * A tool is a small state machine that owns one interaction — selecting,
 * drawing a wire, dropping a component. Keeping them separate is what stops the
 * editor turning into one giant pointer handler full of mode flags, which is
 * exactly what the first version of this canvas was.
 *
 * Tools never touch the DOM and never draw outside `drawOverlay`, so a tool can
 * be driven from a test with synthetic pointer data and asserted on.
 */

import type { Vec2 } from './geometry';
import type { Painter } from './painter';
import type { Scene } from './scene';
import type { SnapIndex } from './snap';
import type { SurfaceSize } from './surface';
import type { Viewport } from './viewport';

export interface EditorPointer {
	/** Position in world units. */
	world: Vec2;
	/** Position in CSS pixels relative to the canvas. */
	screen: Vec2;
	/** Where this gesture started, in world units. */
	origin: Vec2;
	/** Movement since the previous event, in world units. */
	delta: Vec2;
	button: number;
	buttons: number;
	shift: boolean;
	ctrl: boolean;
	alt: boolean;
	meta: boolean;
	pointerId: number;
	/**
	 * Click count: 2 on the second press of a double-click.
	 *
	 * Counted here rather than taken from the event. `PointerEvent.detail` is 0 in
	 * Chromium — only `mousedown` and `dblclick` carry a click count — so a tool
	 * that trusted it would never see a second click at all.
	 */
	detail: number;
	/** True once the pointer has moved beyond the drag threshold. */
	dragging: boolean;
	native: PointerEvent;
}

export interface ToolContext {
	viewport: Viewport;
	scene: Scene;
	snap: SnapIndex;
	size: SurfaceSize;
	/** World units per screen pixel — multiply screen tolerances by this. */
	unit: number;
	/** Hit tolerance in world units, derived from the editor's pixel setting. */
	tolerance: number;
	gridSize: number;
	invalidate(...layers: string[]): void;
	setCursor(cursor: string | null): void;
}

export interface Tool {
	readonly name: string;
	/** CSS cursor while this tool is active. */
	readonly cursor?: string;

	activate?(ctx: ToolContext): void;
	deactivate?(ctx: ToolContext): void;

	pointerDown?(pointer: EditorPointer, ctx: ToolContext): void;
	pointerMove?(pointer: EditorPointer, ctx: ToolContext): void;
	pointerUp?(pointer: EditorPointer, ctx: ToolContext): void;
	pointerLeave?(ctx: ToolContext): void;

	/** Return true to mark the key as handled. */
	keyDown?(event: KeyboardEvent, ctx: ToolContext): boolean | void;

	/** Draw feedback on the overlay layer: rubber bands, marquees, hints. */
	drawOverlay?(painter: Painter, ctx: ToolContext): void;
}
