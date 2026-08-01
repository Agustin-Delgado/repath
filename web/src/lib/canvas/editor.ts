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
	gridSize?: number;
	onViewportChange?: (viewport: Viewport) => void;
}

/** Screen pixels of movement before a click becomes a drag. */
const DRAG_THRESHOLD = 3;

export class CanvasEditor {
	readonly viewport = new Viewport();
	readonly scene = new Scene();
	readonly snap = new SnapIndex();
	readonly surface: LayeredSurface;

	hitTolerance: number;
	gridSize: number;

	private container: HTMLElement;
	private options: EditorOptions;
	private painters = new Map<string, Painter>();
	private dirty = new Set<string>();
	private frame: number | null = null;
	private disposed = false;

	private activeTool: Tool | null = null;
	private gesture: {
		pointerId: number;
		origin: Vec2;
		last: Vec2;
		lastScreen: Vec2;
		dragging: boolean;
		panning: boolean;
	} | null = null;

	constructor(container: HTMLElement, options: EditorOptions) {
		this.container = container;
		this.options = options;
		this.hitTolerance = options.hitTolerance ?? 7;
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
			tolerance: this.hitTolerance * this.viewport.pixel,
			gridSize: this.gridSize,
			invalidate: (...layers: string[]) => this.invalidate(...layers),
			setCursor: (cursor) => this.setCursor(cursor)
		};
	}

	setCursor(cursor: string | null): void {
		this.container.style.cursor = cursor ?? 'default';
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
			dragging: gesture?.dragging ?? false,
			native: event
		};
	}

	private onPointerDown = (event: PointerEvent) => {
		const screen = this.localPoint(event);
		const world = this.viewport.toWorld(screen);

		// Middle button or Alt always pans, whatever the tool is doing.
		const panning = event.button === 1 || (event.button === 0 && event.altKey);
		this.gesture = {
			pointerId: event.pointerId,
			origin: world,
			last: world,
			lastScreen: screen,
			dragging: false,
			panning
		};
		this.capture(event.pointerId, true);

		if (panning) {
			this.setCursor('grabbing');
			event.preventDefault();
			return;
		}
		this.activeTool?.pointerDown?.(this.toPointer(event, screen), this.context);
	};

	private onPointerMove = (event: PointerEvent) => {
		const screen = this.localPoint(event);
		const gesture = this.gesture;

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
		const pointer = this.toPointer(event, screen);

		this.capture(event.pointerId, false);
		this.gesture = null;

		if (gesture?.panning) {
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
