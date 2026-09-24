/**
 * The world-to-screen transform, and the gestures that change it.
 *
 * `scale` is screen pixels per world unit. Everything else in the editor works
 * in world units and asks the viewport when it needs pixels.
 */

import { clamp, rectFromBounds, type Rect, type Vec2 } from './geometry';

export interface ViewportState {
	/** Screen position, in CSS pixels, of the world origin. */
	x: number;
	y: number;
	scale: number;
}

export interface ViewportLimits {
	minScale: number;
	maxScale: number;
}

export class Viewport {
	x = 0;
	y = 0;
	scale = 1;
	limits: ViewportLimits = { minScale: 0.1, maxScale: 8 };

	toWorld(screen: Vec2): Vec2 {
		return { x: (screen.x - this.x) / this.scale, y: (screen.y - this.y) / this.scale };
	}

	toScreen(world: Vec2): Vec2 {
		return { x: world.x * this.scale + this.x, y: world.y * this.scale + this.y };
	}

	/** How many world units a screen pixel spans. Handy for tolerances. */
	get pixel(): number {
		return 1 / this.scale;
	}

	/** Convert a length in screen pixels to world units. */
	toWorldLength(pixels: number): number {
		return pixels / this.scale;
	}

	/** The region of world space currently on screen. */
	visibleBounds(size: { width: number; height: number }): Rect {
		const topLeft = this.toWorld({ x: 0, y: 0 });
		const bottomRight = this.toWorld({ x: size.width, y: size.height });
		return rectFromBounds(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y);
	}

	/** Zoom by `factor`, keeping the world point under `anchor` where it is. */
	zoomAt(anchor: Vec2, factor: number): void {
		const next = clamp(this.scale * factor, this.limits.minScale, this.limits.maxScale);
		if (next === this.scale) return;
		this.x = anchor.x - ((anchor.x - this.x) * next) / this.scale;
		this.y = anchor.y - ((anchor.y - this.y) * next) / this.scale;
		this.scale = next;
	}

	/** Pan by a screen-space delta. */
	panBy(dx: number, dy: number): void {
		this.x += dx;
		this.y += dy;
	}

	/**
	 * Follow two fingers: what was under each of them stays under it.
	 *
	 * The midpoint carries the pan and the spread carries the zoom, which is what
	 * a pinch is once it is written down. The zoom is anchored on the new midpoint
	 * so the two do not fight — panning first and then zooming about the old
	 * centre would pull the page back the way it came.
	 */
	pinch(before: readonly [Vec2, Vec2], after: readonly [Vec2, Vec2]): void {
		const centre = (pair: readonly [Vec2, Vec2]): Vec2 => ({
			x: (pair[0].x + pair[1].x) / 2,
			y: (pair[0].y + pair[1].y) / 2
		});
		const spread = (pair: readonly [Vec2, Vec2]) =>
			Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);

		const from = centre(before);
		const to = centre(after);
		this.panBy(to.x - from.x, to.y - from.y);

		const was = spread(before);
		// Two fingers on the same pixel have no spread to compare against.
		if (was > 0) this.zoomAt(to, spread(after) / was);
	}

	/**
	 * Centre `bounds` in a viewport of `size`, zooming to fit with a margin.
	 *
	 * `ceiling` caps how far it will zoom *in*. Without one, opening a three
	 * component circuit in a large window blows it up to fill the screen, which
	 * looks broken even though it is technically a perfect fit.
	 */
	fit(
		bounds: Rect,
		size: { width: number; height: number },
		padding = 48,
		ceiling = Infinity
	): void {
		if (size.width <= 0 || size.height <= 0) return;

		// Never more than a tenth of the shorter side: a fixed margin on a phone
		// held sideways, with a drawing a hundred pixels tall, left it nothing.
		const margin = Math.min(padding, Math.min(size.width, size.height) * 0.1);
		const availableW = Math.max(size.width - margin * 2, 1);
		const availableH = Math.max(size.height - margin * 2, 1);
		// A single component has zero extent in one axis; do not divide by it.
		const scale =
			bounds.w > 0 && bounds.h > 0
				? Math.min(availableW / bounds.w, availableH / bounds.h)
				: this.scale;

		this.scale = clamp(Math.min(scale, ceiling), this.limits.minScale, this.limits.maxScale);
		this.centreOn({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }, size);
	}

	centreOn(world: Vec2, size: { width: number; height: number }): void {
		this.x = size.width / 2 - world.x * this.scale;
		this.y = size.height / 2 - world.y * this.scale;
	}

	snapshot(): ViewportState {
		return { x: this.x, y: this.y, scale: this.scale };
	}

	restore(state: ViewportState): void {
		this.x = state.x;
		this.y = state.y;
		this.scale = clamp(state.scale, this.limits.minScale, this.limits.maxScale);
	}

	equals(state: ViewportState): boolean {
		return this.x === state.x && this.y === state.y && this.scale === state.scale;
	}
}
