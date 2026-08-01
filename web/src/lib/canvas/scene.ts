/**
 * The spatial index.
 *
 * Every query the editor makes — what is on screen, what is under the cursor,
 * what falls inside the marquee — is a spatial one, and doing them by scanning
 * the whole document is what makes a canvas editor feel sluggish once a drawing
 * gets real. A uniform grid hash keeps them proportional to the answer rather
 * than to the document.
 */

import {
	rectContains,
	rectIntersects,
	rectUnion,
	type Rect,
	type Vec2
} from './geometry';

export interface SceneItem<T = unknown> {
	id: string;
	/** Coarse type, so callers can filter without inspecting `data`. */
	kind: string;
	/** World-space axis-aligned bounds, used for culling and broad-phase picks. */
	bounds: Rect;
	/** Higher draws and picks first. */
	z: number;
	data: T;
	/**
	 * Precise hit test, in world units. Without one an item is treated as its
	 * bounding box, which is wrong for anything long and thin — a diagonal wire
	 * would be pickable across its whole rectangle.
	 */
	hit?: (point: Vec2, tolerance: number) => boolean;
}

/** Default hash cell, in world units. Roughly a few components across. */
const DEFAULT_CELL = 128;

export class Scene {
	private items = new Map<string, SceneItem>();
	private buckets = new Map<number, Set<string>>();
	private order = new Map<string, number>();
	private sequence = 0;
	private cell: number;

	constructor(cellSize = DEFAULT_CELL) {
		this.cell = cellSize;
	}

	get size(): number {
		return this.items.size;
	}

	/** Pack two cell coordinates into one number, avoiding string keys. */
	private key(cx: number, cy: number): number {
		// Both halves are offset into the non-negative range before packing.
		return ((cx + 0x8000) << 16) | ((cy + 0x8000) & 0xffff);
	}

	private *cellsOf(bounds: Rect): Generator<number> {
		const x0 = Math.floor(bounds.x / this.cell);
		const y0 = Math.floor(bounds.y / this.cell);
		const x1 = Math.floor((bounds.x + bounds.w) / this.cell);
		const y1 = Math.floor((bounds.y + bounds.h) / this.cell);
		for (let cx = x0; cx <= x1; cx++) {
			for (let cy = y0; cy <= y1; cy++) yield this.key(cx, cy);
		}
	}

	add(item: SceneItem): void {
		if (this.items.has(item.id)) this.remove(item.id);
		this.items.set(item.id, item);
		this.order.set(item.id, this.sequence++);
		for (const key of this.cellsOf(item.bounds)) {
			let bucket = this.buckets.get(key);
			if (!bucket) this.buckets.set(key, (bucket = new Set()));
			bucket.add(item.id);
		}
	}

	remove(id: string): void {
		const item = this.items.get(id);
		if (!item) return;
		for (const key of this.cellsOf(item.bounds)) {
			const bucket = this.buckets.get(key);
			if (!bucket) continue;
			bucket.delete(id);
			if (bucket.size === 0) this.buckets.delete(key);
		}
		this.items.delete(id);
		this.order.delete(id);
	}

	clear(): void {
		this.items.clear();
		this.buckets.clear();
		this.order.clear();
		this.sequence = 0;
	}

	replaceAll(items: readonly SceneItem[]): void {
		this.clear();
		for (const item of items) this.add(item);
	}

	get(id: string): SceneItem | undefined {
		return this.items.get(id);
	}

	all(): SceneItem[] {
		return [...this.items.values()];
	}

	/** Every item whose bounds overlap `region`, in draw order. */
	query(region: Rect): SceneItem[] {
		const seen = new Set<string>();
		const found: SceneItem[] = [];
		for (const key of this.cellsOf(region)) {
			const bucket = this.buckets.get(key);
			if (!bucket) continue;
			for (const id of bucket) {
				if (seen.has(id)) continue;
				seen.add(id);
				const item = this.items.get(id)!;
				if (rectIntersects(item.bounds, region)) found.push(item);
			}
		}
		return this.sorted(found);
	}

	/** Items under `point`, nearest the front first. `tolerance` is world units. */
	pick(point: Vec2, tolerance = 0): SceneItem[] {
		const region: Rect = {
			x: point.x - tolerance,
			y: point.y - tolerance,
			w: tolerance * 2,
			h: tolerance * 2
		};
		const candidates = this.query(region).filter((item) =>
			item.hit ? item.hit(point, tolerance) : rectContains(item.bounds, point, tolerance)
		);
		return candidates.reverse();
	}

	/** The frontmost item under `point`, optionally filtered. */
	top(
		point: Vec2,
		tolerance = 0,
		filter?: (item: SceneItem) => boolean
	): SceneItem | undefined {
		for (const item of this.pick(point, tolerance)) {
			if (!filter || filter(item)) return item;
		}
		return undefined;
	}

	/** Items entirely inside `region` — marquee selection semantics. */
	enclosed(region: Rect): SceneItem[] {
		return this.query(region).filter(
			(item) =>
				item.bounds.x >= region.x &&
				item.bounds.y >= region.y &&
				item.bounds.x + item.bounds.w <= region.x + region.w &&
				item.bounds.y + item.bounds.h <= region.y + region.h
		);
	}

	/** Union of every item's bounds, or null when empty. */
	bounds(): Rect | null {
		let result: Rect | null = null;
		for (const item of this.items.values()) {
			result = result ? rectUnion(result, item.bounds) : item.bounds;
		}
		return result;
	}

	/** Back to front: by `z`, then by insertion order so ties stay stable. */
	private sorted(items: SceneItem[]): SceneItem[] {
		return items.sort(
			(a, b) => a.z - b.z || (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0)
		);
	}
}
