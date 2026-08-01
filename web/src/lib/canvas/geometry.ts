/**
 * Plain 2D geometry.
 *
 * Points and rectangles are object literals rather than classes: they are
 * created in the thousands per frame during hit testing and culling, and a
 * literal is something the JIT can keep in registers.
 */

export interface Vec2 {
	x: number;
	y: number;
}

/** An axis-aligned rectangle. `w` and `h` are never negative. */
export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });

export function rect(x: number, y: number, w: number, h: number): Rect {
	return w >= 0 && h >= 0
		? { x, y, w, h }
		: { x: w < 0 ? x + w : x, y: h < 0 ? y + h : y, w: Math.abs(w), h: Math.abs(h) };
}

export function rectFromPoints(a: Vec2, b: Vec2): Rect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		w: Math.abs(a.x - b.x),
		h: Math.abs(a.y - b.y)
	};
}

export function rectFromBounds(minX: number, minY: number, maxX: number, maxY: number): Rect {
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export const rectRight = (r: Rect) => r.x + r.w;
export const rectBottom = (r: Rect) => r.y + r.h;

export function rectContains(r: Rect, p: Vec2, tolerance = 0): boolean {
	return (
		p.x >= r.x - tolerance &&
		p.x <= r.x + r.w + tolerance &&
		p.y >= r.y - tolerance &&
		p.y <= r.y + r.h + tolerance
	);
}

/** Whether `outer` fully contains `inner`. */
export function rectContainsRect(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}

export function rectIntersects(a: Rect, b: Rect, tolerance = 0): boolean {
	return !(
		a.x - tolerance > b.x + b.w ||
		a.x + a.w + tolerance < b.x ||
		a.y - tolerance > b.y + b.h ||
		a.y + a.h + tolerance < b.y
	);
}

export function rectUnion(a: Rect, b: Rect): Rect {
	const x = Math.min(a.x, b.x);
	const y = Math.min(a.y, b.y);
	return {
		x,
		y,
		w: Math.max(a.x + a.w, b.x + b.w) - x,
		h: Math.max(a.y + a.h, b.y + b.h) - y
	};
}

export function rectExpand(r: Rect, by: number): Rect {
	return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

/** Smallest rectangle containing every point. `null` for an empty list. */
export function boundsOf(points: readonly Vec2[]): Rect | null {
	if (points.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return rectFromBounds(minX, minY, maxX, maxY);
}

export const rectCenter = (r: Rect): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceSquared(a: Vec2, b: Vec2): number {
	const dx = a.x - b.x;
	const dy = a.y - b.y;
	return dx * dx + dy * dy;
}

/** Closest point to `p` on the segment `a`–`b`. */
export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return { x: a.x, y: a.y };
	// Project onto the segment and clamp to its ends.
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
	return { x: a.x + t * dx, y: a.y + t * dy };
}

export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
	return distance(p, closestPointOnSegment(p, a, b));
}

/** Round to the nearest multiple of `step`. */
export function snapTo(value: number, step: number): number {
	return step <= 0 ? value : Math.round(value / step) * step;
}

export function snapPoint(p: Vec2, step: number): Vec2 {
	return { x: snapTo(p.x, step), y: snapTo(p.y, step) };
}

export const clamp = (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi);
