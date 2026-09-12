/**
 * The editor: layers, viewport gestures, the render loop, and the active tool.
 *
 * Rendering is pull-based and lazy. Nothing repaints until something calls
 * `invalidate`, and then only the layers named are redrawn on the next frame.
 * Dragging a marquee touches the overlay alone; the schematic underneath is not
 * re-rasterized at all.
 *
 * Panning and zooming are handled here rather than in a tool, because they must
 * work no matter what the user is in the middle of.
 */

import type { Rect, Vec2 } from './geometry';
import { Painter } from './painter';
import { Scene } from './scene';
import { SnapIndex } from './snap';
import { LayeredSurface } from './surface';
import type { EditorPointer, Tool, ToolContext } from './tool';
import { Viewport } from './viewport';

export type RenderFn = (painter: Painter, editor: CanvasEditor) => void;

export interface EditorOptions {
	layers: readonly string[];
	render: Record<string, RenderFn>;
	/** Name of the layer tools draw their feedback on. */
	overlayLayer?: string;
	/** Pick radius in screen pixels. */
	hitTolerance?: number;
	/** The same, for a finger, which cannot land on a pixel. */
	touchTolerance?: number;
	gridSize?: number;
	onViewportChange?: (viewport: Viewport) => void;
}

/** Screen pixels of movement before a click becomes a drag. */
const DRAG_THRESHOLD = 3;

/**
 * How far past the pick radius a press may be from a pin and still be
 * "on something" for a finger. Matches the reach the tools give a pin.
 */
const TOUCH_REACH = 1.4;

export class CanvasEditor {
	readonly viewport = new Viewport();
	readonly scene = new Scene();
	readonly snap = new SnapIndex();
	readonly surface: LayeredSurface;

	hitTolerance: number;
	touchTolerance: number;
	gridSize: number;

	private container: HTMLElement;
	private options: EditorOptions;
	private painters = new Map<string, Painter>();
	private dirty = new Set<string>();
	private frame: number | null = null;
	private disposed = false;

	/**
	 * Last known pointer position in world units, or null before the pointer has
	 * ever been over the canvas. Paste-at-cursor needs this, and there is no DOM
	 * element to ask.
	 */
	pointerWorld: Vec2 | null = null;

	private activeTool: Tool | null = null;
	/** Presses counted at roughly the same spot, so a tool can see a double-click. */
	private clickCount = 1;
	private lastPress: { time: number; x: number; y: number; count: number } | null = null;

	private gesture: {
		pointerId: number;
		origin: Vec2;
		last: Vec2;
		lastScreen: Vec2;
		dragging: boolean;
		panning: boolean;
		/**
		 * A finger on empty space, not yet handed to the tool.
		 *
		 * With a mouse, pressing on nothing starts a marquee; with a finger it is
		 * far more often the start of a pan, and there is no middle button to say
		 * so. So the press is held back until it either moves — a pan — or lifts
		 * where it landed, at which point the tool gets the tap it was owed.
		 */
		deferred: PointerEvent | null;
	} | null = null;

	/** Fingers on the canvas, by pointer id, in CSS pixels. */
	private touches = new Map<number, Vec2>();
	/** Two fingers down: the gesture is a pinch, whatever the tool wanted. */
	private pinch: { a: number; b: number } | null = null;
	/** Whether the last press was a finger, so tolerances can grow to fit one. */
	private touching = false;

	constructor(container: HTMLElement, options: EditorOptions) {
		this.container = container;
		this.options = options;
		this.hitTolerance = options.hitTolerance ?? 7;
		this.touchTolerance = options.touchTolerance ?? 14;
		this.gridSize = options.gridSize ?? 10;

		this.surface = new LayeredSurface(container, options.layers);
		for (const name of options.layers) {
			this.painters.set(name, new Painter(this.surface.context(name), this.viewport));
		}
		this.surface.onResize = () => this.invalidateAll();

		container.addEventListener('pointerdown', this.onPointerDown);
		container.addEventListener('pointermove', this.onPointerMove);
		container.addEventListener('pointerup', this.onPointerUp);
		container.addEventListener('pointercancel', this.onPointerUp);
		container.addEventListener('pointerleave', this.onPointerLeave);
		container.addEventListener('wheel', this.onWheel, { passive: false });
		container.addEventListener('contextmenu', this.onContextMenu);

		this.invalidateAll();
	}

	// -- tools --------------------------------------------------------------

	get tool(): Tool | null {
		return this.activeTool;
	}

	setTool(tool: Tool | null): void {
		if (this.activeTool === tool) return;
		this.activeTool?.deactivate?.(this.context);
		this.activeTool = tool;
		this.activeTool?.activate?.(this.context);
		this.setCursor(tool?.cursor ?? null);
		this.invalidate(this.overlay);
	}

	private get overlay(): string {
		return this.options.overlayLayer ?? this.options.layers[this.options.layers.length - 1];
	}

	get context(): ToolContext {
		return {
			viewport: this.viewport,
			scene: this.scene,
			snap: this.snap,
			size: this.surface.size,
			unit: this.viewport.pixel,
			tolerance: this.pickRadius * this.viewport.pixel,
			gridSize: this.gridSize,
			invalidate: (...layers: string[]) => this.invalidate(...layers),
			setCursor: (cursor) => this.setCursor(cursor)
		};
	}

	setCursor(cursor: string | null): void {
		this.container.style.cursor = cursor ?? 'default';
	}

	/** Pick radius in screen pixels for whatever is doing the pointing. */
	private get pickRadius(): number {
		return this.touching ? this.touchTolerance : this.hitTolerance;
	}

	// -- rendering ----------------------------------------------------------

	invalidate(...layers: string[]): void {
		if (this.disposed) return;
		const names = layers.length > 0 ? layers : this.options.layers;
		for (const name of names) this.dirty.add(name);
		this.schedule();
	}

	invalidateAll(): void {
		this.invalidate(...this.options.layers);
	}

	private schedule(): void {
		if (this.frame !== null || this.dirty.size === 0) return;
		this.frame = requestAnimationFrame(() => {
			this.frame = null;
			this.paint();
		});
	}

	private paint(): void {
		if (this.disposed || this.surface.width === 0) return;
		const layers = [...this.dirty];
		this.dirty.clear();

		for (const name of layers) {
			const painter = this.painters.get(name);
			if (!painter) continue;
			painter.begin(this.surface.dpr);
			this.options.render[name]?.(painter, this);
			if (name === this.overlay) {
				this.activeTool?.drawOverlay?.(painter, this.context);
			}
		}
	}

	/** World region currently visible, for culling. */
	get visibleBounds(): Rect {
		return this.viewport.visibleBounds(this.surface.size);
	}

	// -- viewport -----------------------------------------------------------

	fit(padding = 60, ceiling = 1): void {
		const bounds = this.scene.bounds();
		if (!bounds) return;
		this.viewport.fit(bounds, this.surface.size, padding, ceiling);
		this.afterViewportChange();
	}

	centreOn(world: Vec2): void {
		this.viewport.centreOn(world, this.surface.size);
		this.afterViewportChange();
	}

	private afterViewportChange(): void {
		this.options.onViewportChange?.(this.viewport);
		this.invalidateAll();
	}

	// -- input --------------------------------------------------------------

	private localPoint(event: PointerEvent | WheelEvent): Vec2 {
		const rect = this.container.getBoundingClientRect();
		return { x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	/**
	 * Pointer capture keeps a drag alive past the edge of the canvas. It throws
	 * if the pointer has already gone, and an exception here would abandon the
	 * rest of the handler mid-gesture.
	 */
	private capture(pointerId: number, on: boolean): void {
		try {
			if (on) this.container.setPointerCapture(pointerId);
			else this.container.releasePointerCapture(pointerId);
		} catch {
			// The gesture still works; it just stops tracking outside the element.
		}
	}

	private toPointer(event: PointerEvent, screen: Vec2): EditorPointer {
		const world = this.viewport.toWorld(screen);
		const gesture = this.gesture;
		return {
			world,
			screen,
			origin: gesture?.origin ?? world,
			delta: gesture ? { x: world.x - gesture.last.x, y: world.y - gesture.last.y } : { x: 0, y: 0 },
			button: event.button,
			buttons: event.buttons,
			shift: event.shiftKey,
			ctrl: event.ctrlKey,
			alt: event.altKey,
			meta: event.metaKey,
			pointerId: event.pointerId,
			detail: this.clickCount,
			dragging: gesture?.dragging ?? false,
			native: event
		};
	}

	/** Whether a press here lands on nothing a tool would want to hold. */
	private nothingUnder(world: Vec2): boolean {
		const tolerance = this.pickRadius * this.viewport.pixel;
		if (this.scene.top(world, tolerance)) return false;
		return this.snap.nearestPoint(world, tolerance * TOUCH_REACH) === null;
	}

	private onPointerDown = (event: PointerEvent) => {
		const screen = this.localPoint(event);
		const world = this.viewport.toWorld(screen);
		this.touching = event.pointerType === 'touch';

		if (this.touching) {
			this.touches.set(event.pointerId, screen);
			this.capture(event.pointerId, true);
			if (this.touches.size === 2) {
				// A second finger makes it a pinch. Whatever the first one had begun
				// is called off rather than finished, since no release is coming for
				// it that means anything.
				if (this.gesture && !this.gesture.panning && !this.gesture.deferred) {
					this.activeTool?.cancel?.(this.context);
				}
				this.gesture = null;
				const [a, b] = [...this.touches.keys()];
				this.pinch = { a, b };
				event.preventDefault();
				return;
			}
			if (this.touches.size > 2 || this.pinch) return;
		}

		// A double-click, counted from the presses rather than read off the event:
		// a `pointerdown` reports a click count of zero, and only the mouse events
		// that shadow it carry one. Same window and slop a browser uses, so it
		// agrees with what the rest of the page would call a double-click.
		const previous = this.lastPress;
		const quick = previous && event.timeStamp - previous.time < 400;
		const still =
			previous && Math.abs(screen.x - previous.x) < 6 && Math.abs(screen.y - previous.y) < 6;
		this.clickCount = quick && still ? previous.count + 1 : 1;
		this.lastPress = { time: event.timeStamp, x: screen.x, y: screen.y, count: this.clickCount };

		// Middle button or Alt always pans, whatever the tool is doing.
		const panning = event.button === 1 || (event.button === 0 && event.altKey);
		const deferred = this.touching && !panning && this.nothingUnder(world);
		this.gesture = {
			pointerId: event.pointerId,
			origin: world,
			last: world,
			lastScreen: screen,
			dragging: false,
			panning,
			deferred: deferred ? event : null
		};
		this.capture(event.pointerId, true);

		if (panning) {
			this.setCursor('grabbing');
			event.preventDefault();
			return;
		}
		if (deferred) return;
		this.activeTool?.pointerDown?.(this.toPointer(event, screen), this.context);
	};

	private onPointerMove = (event: PointerEvent) => {
		const screen = this.localPoint(event);
		this.pointerWorld = this.viewport.toWorld(screen);
		this.touching = event.pointerType === 'touch';
		const gesture = this.gesture;

		if (this.pinch) {
			const previous = this.touches.get(event.pointerId);
			const { a, b } = this.pinch;
			if (previous && (event.pointerId === a || event.pointerId === b)) {
				this.touches.set(event.pointerId, screen);
				const other = this.touches.get(event.pointerId === a ? b : a);
				if (other) {
					this.viewport.pinch([previous, other], [screen, other]);
					this.afterViewportChange();
				}
			}
			return;
		}
		if (this.touching) this.touches.set(event.pointerId, screen);

		if (gesture?.deferred) {
			const moved = Math.hypot(screen.x - gesture.lastScreen.x, screen.y - gesture.lastScreen.y);
			if (moved <= DRAG_THRESHOLD) return;
			// It went somewhere: a finger dragging empty space is moving the page.
			gesture.deferred = null;
			gesture.panning = true;
		}

		if (gesture?.panning) {
			this.viewport.panBy(screen.x - gesture.lastScreen.x, screen.y - gesture.lastScreen.y);
			gesture.lastScreen = screen;
			gesture.last = this.viewport.toWorld(screen);
			this.afterViewportChange();
			return;
		}

		if (gesture && !gesture.dragging) {
			const moved = Math.hypot(screen.x - gesture.lastScreen.x, screen.y - gesture.lastScreen.y);
			if (moved > DRAG_THRESHOLD) gesture.dragging = true;
		}

		const pointer = this.toPointer(event, screen);
		if (gesture) {
			gesture.last = pointer.world;
			gesture.lastScreen = screen;
		}
		this.activeTool?.pointerMove?.(pointer, this.context);
	};

	private onPointerUp = (event: PointerEvent) => {
		const screen = this.localPoint(event);
		const gesture = this.gesture;
		this.capture(event.pointerId, false);
		this.touches.delete(event.pointerId);

		if (this.pinch) {
			// The pinch ends when either finger lifts. The one still down is not
			// handed to the tool as a fresh press: it did not land where it is now.
			if (this.touches.size < 2) this.pinch = null;
			return;
		}
		// A finger left over from a pinch, or a third one, has no gesture.
		if (!gesture) return;

		if (gesture.deferred) {
			// Lifted where it landed: a tap, which the tool now gets as the press
			// and release it would have seen from a mouse.
			const down = gesture.deferred;
			gesture.deferred = null;
			this.activeTool?.pointerDown?.(this.toPointer(down, gesture.lastScreen), this.context);
		}
		const pointer = this.toPointer(event, screen);
		this.gesture = null;

		if (gesture.panning) {
			this.setCursor(this.activeTool?.cursor ?? null);
			return;
		}
		this.activeTool?.pointerUp?.(pointer, this.context);
	};

	private onPointerLeave = () => {
		if (this.gesture) return;
		this.activeTool?.pointerLeave?.(this.context);
	};

	private onWheel = (event: WheelEvent) => {
		event.preventDefault();
		const screen = this.localPoint(event);

		if (event.shiftKey && !event.ctrlKey) {
			this.viewport.panBy(-event.deltaY, 0);
		} else {
			// A circuit editor is not a document: the wheel zooms, as it does in
			// every schematic tool people already know.
			this.viewport.zoomAt(screen, Math.exp(-event.deltaY * 0.0015));
		}
		this.afterViewportChange();
	};

	private onContextMenu = (event: MouseEvent) => {
		event.preventDefault();
	};

	/** Wire this to a keydown listener. Returns true if the tool consumed it. */
	handleKeyDown(event: KeyboardEvent): boolean {
		return this.activeTool?.keyDown?.(event, this.context) === true;
	}

	// -- lifecycle ----------------------------------------------------------

	destroy(): void {
		this.disposed = true;
		if (this.frame !== null) cancelAnimationFrame(this.frame);
		this.frame = null;
		this.activeTool?.deactivate?.(this.context);
		this.activeTool = null;

		this.container.removeEventListener('pointerdown', this.onPointerDown);
		this.container.removeEventListener('pointermove', this.onPointerMove);
		this.container.removeEventListener('pointerup', this.onPointerUp);
		this.container.removeEventListener('pointercancel', this.onPointerUp);
		this.container.removeEventListener('pointerleave', this.onPointerLeave);
		this.container.removeEventListener('wheel', this.onWheel);
		this.container.removeEventListener('contextmenu', this.onContextMenu);

		this.surface.destroy();
		this.painters.clear();
	}
}
