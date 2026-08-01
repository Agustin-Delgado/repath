/**
 * A stack of canvases sharing one coordinate space.
 *
 * Separating layers is what makes interaction cheap: dragging a selection
 * rectangle repaints only the overlay, leaving the schematic — which may hold
 * thousands of components — exactly where it was.
 */

export interface SurfaceSize {
	width: number;
	height: number;
}

export class LayeredSurface {
	readonly container: HTMLElement;
	readonly names: readonly string[];

	private canvases = new Map<string, HTMLCanvasElement>();
	private contexts = new Map<string, CanvasRenderingContext2D>();
	private observer: ResizeObserver | null = null;

	width = 0;
	height = 0;
	dpr = 1;

	/** Called after a resize, so the owner can repaint everything. */
	onResize: (() => void) | null = null;

	constructor(container: HTMLElement, names: readonly string[]) {
		this.container = container;
		this.names = names;

		if (getComputedStyle(container).position === 'static') {
			container.style.position = 'relative';
		}

		for (const name of names) {
			const canvas = document.createElement('canvas');
			canvas.dataset.layer = name;
			canvas.style.position = 'absolute';
			canvas.style.inset = '0';
			canvas.style.width = '100%';
			canvas.style.height = '100%';
			// Input is handled once, on the container, rather than per layer.
			canvas.style.pointerEvents = 'none';
			container.appendChild(canvas);

			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('this browser has no 2D canvas context');
			this.canvases.set(name, canvas);
			this.contexts.set(name, ctx);
		}

		this.measure();
		if (typeof ResizeObserver !== 'undefined') {
			this.observer = new ResizeObserver(() => {
				if (this.measure()) this.onResize?.();
			});
			this.observer.observe(container);
		}
	}

	context(name: string): CanvasRenderingContext2D {
		const ctx = this.contexts.get(name);
		if (!ctx) throw new Error(`no such layer: ${name}`);
		return ctx;
	}

	get size(): SurfaceSize {
		return { width: this.width, height: this.height };
	}

	/**
	 * Re-read the container size and resize the backing stores.
	 * Returns true if anything actually changed.
	 */
	measure(): boolean {
		const rect = this.container.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const width = Math.max(Math.round(rect.width), 0);
		const height = Math.max(Math.round(rect.height), 0);

		if (width === this.width && height === this.height && dpr === this.dpr) return false;

		this.width = width;
		this.height = height;
		this.dpr = dpr;

		for (const canvas of this.canvases.values()) {
			// Resizing the backing store also clears it, which is what we want.
			canvas.width = Math.max(Math.round(width * dpr), 1);
			canvas.height = Math.max(Math.round(height * dpr), 1);
		}
		return true;
	}

	clear(name: string): void {
		const ctx = this.context(name);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	}

	destroy(): void {
		this.observer?.disconnect();
		this.observer = null;
		for (const canvas of this.canvases.values()) canvas.remove();
		this.canvases.clear();
		this.contexts.clear();
	}
}
