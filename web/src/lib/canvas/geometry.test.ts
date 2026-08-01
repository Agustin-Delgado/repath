import { describe, expect, it } from 'vitest';
import {
	boundsOf,
	closestPointOnSegment,
	distanceToSegment,
	rect,
	rectContains,
	rectContainsRect,
	rectFromPoints,
	rectIntersects,
	rectUnion,
	snapTo,
	vec
} from './geometry';

describe('rect', () => {
	it('normalises negative extents', () => {
		expect(rect(10, 10, -4, -6)).toEqual({ x: 6, y: 4, w: 4, h: 6 });
	});

	it('builds from two corners in any order', () => {
		expect(rectFromPoints(vec(30, 5), vec(10, 25))).toEqual({ x: 10, y: 5, w: 20, h: 20 });
	});

	it('treats touching edges as intersecting', () => {
		const a = rect(0, 0, 10, 10);
		const b = rect(10, 0, 10, 10);
		expect(rectIntersects(a, b)).toBe(true);
		expect(rectIntersects(a, rect(11, 0, 10, 10))).toBe(false);
	});

	it('containment is strict about the whole box', () => {
		const outer = rect(0, 0, 100, 100);
		expect(rectContainsRect(outer, rect(10, 10, 10, 10))).toBe(true);
		// Sticking out on one side is enough to fail — marquee selection depends
		// on this, or half-covered components would get picked up.
		expect(rectContainsRect(outer, rect(95, 10, 10, 10))).toBe(false);
	});

	it('honours a tolerance when testing points', () => {
		const r = rect(0, 0, 10, 10);
		expect(rectContains(r, vec(-2, 5))).toBe(false);
		expect(rectContains(r, vec(-2, 5), 3)).toBe(true);
	});

	it('unions to the enclosing box', () => {
		expect(rectUnion(rect(0, 0, 10, 10), rect(20, 5, 10, 30))).toEqual({
			x: 0,
			y: 0,
			w: 30,
			h: 35
		});
	});
});

describe('boundsOf', () => {
	it('returns null for nothing', () => {
		expect(boundsOf([])).toBeNull();
	});

	it('wraps every point', () => {
		expect(boundsOf([vec(5, 5), vec(-5, 20), vec(10, 0)])).toEqual({
			x: -5,
			y: 0,
			w: 15,
			h: 20
		});
	});
});

describe('segments', () => {
	it('projects onto the segment', () => {
		expect(closestPointOnSegment(vec(5, 10), vec(0, 0), vec(10, 0))).toEqual({ x: 5, y: 0 });
	});

	it('clamps to the ends rather than the infinite line', () => {
		// Off the end of the segment: the answer is the endpoint, not x = 50.
		expect(closestPointOnSegment(vec(50, 3), vec(0, 0), vec(10, 0))).toEqual({ x: 10, y: 0 });
		expect(closestPointOnSegment(vec(-50, 3), vec(0, 0), vec(10, 0))).toEqual({ x: 0, y: 0 });
	});

	it('handles a degenerate segment', () => {
		expect(distanceToSegment(vec(3, 4), vec(0, 0), vec(0, 0))).toBe(5);
	});

	it('measures perpendicular distance', () => {
		expect(distanceToSegment(vec(5, 7), vec(0, 0), vec(10, 0))).toBe(7);
	});
});

describe('snapTo', () => {
	it('rounds to the nearest multiple', () => {
		expect(snapTo(13, 10)).toBe(10);
		expect(snapTo(16, 10)).toBe(20);
		expect(snapTo(-13, 10)).toBe(-10);
	});

	it('is a no-op for a zero step', () => {
		expect(snapTo(13.7, 0)).toBe(13.7);
	});
});
