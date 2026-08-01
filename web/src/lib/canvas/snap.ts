/**
 * Snapping.
 *
 * This is most of what separates an editor that feels precise from one that
 * feels like fighting the mouse. Three things can be snapped to, in order of
 * how much the user probably meant them:
 *
 * 1. **Points** — component pins, wire ends, junctions. Landing on a pin is
 *    almost always the intent, so these win whenever one is in range.
 * 2. **Segments** — anywhere along a wire, which is how you tap into an existing
 *    net. The result is the perpendicular projection onto that wire.
 * 3. **The grid** — the fallback, so nothing ever lands off-lattice.
 *
 * The radius is passed in world units by the caller, which converts from a
 * screen-pixel tolerance. That keeps the snap "feel" constant across zoom
 * levels instead of getting stickier as you zoom in.
 */

import { closestPointOnSegment, distanceSquared, snapPoint, type Rect, type Vec2 } from './geometry';

export type SnapKind = 'pin' | 'junction' | 'wire-end' | 'wire' | 'grid';

export interface SnapTarget {
	x: number;
	y: number;
	kind: SnapKind;
	/** Scene item this belongs to, when it came from one. */
	ownerId?: string;
	/** Shown as a hint while hovering, e.g. a pin name. */
	label?: string;
}

export interface SnapPoint {
	x: number;
	y: number;
	kind: Exclude<SnapKind, 'wire' | 'grid'>;
	ownerId?: string;
	label?: string;
}

export interface SnapSegment {
	a: Vec2;
	b: Vec2;
	ownerId?: string;
}

/** Ranking used when two candidates are equally close. */
const PRIORITY: Record<SnapKind, number> = {
	pin: 4,
	junction: 3,
	'wire-end': 2,
	wire: 1,
	grid: 0
};

const CELL = 64;

export class SnapIndex {
	private points: SnapPoint[] = [];
	private segments: SnapSegment[] = [];
	private pointBuckets = new Map<number, number[]>();
	private segmentBuckets = new Map<number, number[]>();
	private cell: number;

	constructor(cellSize = CELL) {
		this.cell = cellSize;
	}

	private key(cx: number, cy: number): number {
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

	rebuild(points: readonly SnapPoint[], segments: readonly SnapSegment[] = []): void {
		this.points = [...points];
		this.segments = [...segments];
		this.pointBuckets.clear();
		this.segmentBuckets.clear();

		this.points.forEach((p, index) => {
			const key = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell));
			const bucket = this.pointBuckets.get(key);
			if (bucket) bucket.push(index);
			else this.pointBuckets.set(key, [index]);
		});

		this.segments.forEach((s, index) => {
			const bounds: Rect = {
				x: Math.min(s.a.x, s.b.x),
				y: Math.min(s.a.y, s.b.y),
				w: Math.abs(s.a.x - s.b.x),
				h: Math.abs(s.a.y - s.b.y)
			};
			for (const key of this.cellsOf(bounds)) {
				const bucket = this.segmentBuckets.get(key);
				if (bucket) bucket.push(index);
				else this.segmentBuckets.set(key, [index]);
			}
		});
	}

	/** Nearest snappable point within `radius`, ignoring segments and the grid. */
	nearestPoint(at: Vec2, radius: number, exclude?: (p: SnapPoint) => boolean): SnapTarget | null {
		const limit = radius * radius;
		let best: SnapPoint | null = null;
		let bestDistance = Infinity;

		const region: Rect = { x: at.x - radius, y: at.y - radius, w: radius * 2, h: radius * 2 };
		for (const key of this.cellsOf(region)) {
			for (const index of this.pointBuckets.get(key) ?? []) {
				const point = this.points[index];
				if (exclude?.(point)) continue;
				const d = distanceSquared(at, point);
				if (d > limit) continue;
				// Closer wins; when it is a tie, the more meaningful kind wins.
				if (
					d < bestDistance - 1e-9 ||
					(Math.abs(d - bestDistance) <= 1e-9 &&
						best !== null &&
						PRIORITY[point.kind] > PRIORITY[best.kind])
				) {
					best = point;
					bestDistance = d;
				}
			}
		}
		return best ? { ...best } : null;
	}

	/** Nearest point on any wire within `radius`. */
	nearestSegment(at: Vec2, radius: number, exclude?: (s: SnapSegment) => boolean): SnapTarget | null {
		const limit = radius * radius;
		let best: SnapTarget | null = null;
		let bestDistance = Infinity;

		const region: Rect = { x: at.x - radius, y: at.y - radius, w: radius * 2, h: radius * 2 };
		const seen = new Set<number>();
		for (const key of this.cellsOf(region)) {
			for (const index of this.segmentBuckets.get(key) ?? []) {
				if (seen.has(index)) continue;
				seen.add(index);
				const segment = this.segments[index];
				if (exclude?.(segment)) continue;
				const projected = closestPointOnSegment(at, segment.a, segment.b);
				const d = distanceSquared(at, projected);
				if (d <= limit && d < bestDistance) {
					best = { x: projected.x, y: projected.y, kind: 'wire', ownerId: segment.ownerId };
					bestDistance = d;
				}
			}
		}
		return best;
	}

	/**
	 * The snap the editor should actually use: a point if one is close, then a
	 * wire, and the grid otherwise. Never returns null — there is always a grid.
	 */
	resolve(
		at: Vec2,
		radius: number,
		grid: number,
		options: {
			points?: boolean;
			segments?: boolean;
			excludePoint?: (p: SnapPoint) => boolean;
			excludeSegment?: (s: SnapSegment) => boolean;
		} = {}
	): SnapTarget {
		if (options.points !== false) {
			const point = this.nearestPoint(at, radius, options.excludePoint);
			if (point) return point;
		}
		if (options.segments !== false) {
			const segment = this.nearestSegment(at, radius, options.excludeSegment);
			if (segment) {
				// Land on the lattice along the wire so the resulting geometry stays
				// on-grid; a wire tapped at x=137.4 makes a mess of everything after.
				const snapped = snapPoint(segment, grid);
				const onAxis =
					Math.abs(segment.x - snapped.x) < grid && Math.abs(segment.y - snapped.y) < grid;
				return onAxis ? { ...segment, x: snapped.x, y: snapped.y } : segment;
			}
		}
		const snapped = snapPoint(at, grid);
		return { x: snapped.x, y: snapped.y, kind: 'grid' };
	}

	get pointCount(): number {
		return this.points.length;
	}

	get segmentCount(): number {
		return this.segments.length;
	}
}
