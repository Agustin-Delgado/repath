import { describe, expect, it } from 'vitest';
import { vec } from './geometry';
import { SnapIndex, type SnapPoint } from './snap';

const pin = (x: number, y: number, ownerId = 'c1'): SnapPoint => ({
	x,
	y,
	kind: 'pin',
	ownerId,
	label: 'a'
});

describe('SnapIndex', () => {
	it('finds the nearest point within the radius', () => {
		const index = new SnapIndex();
		index.rebuild([pin(100, 100), pin(160, 100)]);

		expect(index.nearestPoint(vec(104, 98), 10)).toMatchObject({ x: 100, y: 100 });
		expect(index.nearestPoint(vec(130, 100), 10)).toBeNull();
	});

	it('prefers a pin over a wire end at the same distance', () => {
		const index = new SnapIndex();
		index.rebuild([
			{ x: 100, y: 100, kind: 'wire-end' },
			{ x: 100, y: 100, kind: 'pin', label: 'gate' }
		]);
		expect(index.nearestPoint(vec(103, 100), 8)?.kind).toBe('pin');
	});

	it('can exclude points, so a wire does not snap to the end it started from', () => {
		const index = new SnapIndex();
		index.rebuild([pin(100, 100, 'self'), pin(112, 100, 'other')]);

		const found = index.nearestPoint(vec(101, 100), 20, (p) => p.ownerId === 'self');
		expect(found).toMatchObject({ x: 112, ownerId: 'other' });
	});

	it('projects onto a wire so you can tap into the middle of a net', () => {
		const index = new SnapIndex();
		index.rebuild([], [{ a: vec(0, 50), b: vec(200, 50), ownerId: 'w1' }]);

		const found = index.nearestSegment(vec(70, 54), 8);
		expect(found).toMatchObject({ x: 70, y: 50, kind: 'wire', ownerId: 'w1' });
		expect(index.nearestSegment(vec(70, 90), 8)).toBeNull();
	});

	it('does not project past the ends of a wire', () => {
		const index = new SnapIndex();
		index.rebuild([], [{ a: vec(0, 0), b: vec(100, 0) }]);
		expect(index.nearestSegment(vec(140, 0), 8)).toBeNull();
		expect(index.nearestSegment(vec(104, 0), 8)).toMatchObject({ x: 100, y: 0 });
	});

	it('resolve falls back to the grid when nothing is close', () => {
		const index = new SnapIndex();
		index.rebuild([pin(500, 500)]);

		const result = index.resolve(vec(103, 97), 8, 10);
		expect(result).toEqual({ x: 100, y: 100, kind: 'grid' });
	});

	it('resolve prefers a pin, then a wire, then the grid', () => {
		const index = new SnapIndex();
		index.rebuild([pin(100, 100)], [{ a: vec(0, 200), b: vec(300, 200), ownerId: 'w1' }]);

		expect(index.resolve(vec(104, 103), 8, 10).kind).toBe('pin');
		expect(index.resolve(vec(153, 203), 8, 10).kind).toBe('wire');
		expect(index.resolve(vec(153, 403), 8, 10).kind).toBe('grid');
	});

	it('keeps a wire tap on the lattice', () => {
		const index = new SnapIndex();
		index.rebuild([], [{ a: vec(0, 50), b: vec(200, 50), ownerId: 'w1' }]);

		// Projected onto the wire at x = 73, which is then pulled to the grid so
		// everything drawn from here stays on-lattice.
		const result = index.resolve(vec(73, 53), 8, 10);
		expect(result.kind).toBe('wire');
		expect(result.x).toBe(70);
		expect(result.y).toBe(50);
	});

	it('finds points spread far apart, across hash cells', () => {
		const index = new SnapIndex(64);
		const points = Array.from({ length: 200 }, (_, i) => pin(i * 137, i * 91, `c${i}`));
		index.rebuild(points);

		for (const p of [points[0], points[57], points[199]]) {
			expect(index.nearestPoint(vec(p.x + 2, p.y - 2), 8)).toMatchObject({ x: p.x, y: p.y });
		}
		expect(index.pointCount).toBe(200);
	});

	it('rebuilding clears what was there before', () => {
		const index = new SnapIndex();
		index.rebuild([pin(10, 10)]);
		index.rebuild([pin(400, 400)]);
		expect(index.nearestPoint(vec(10, 10), 8)).toBeNull();
		expect(index.nearestPoint(vec(400, 400), 8)).not.toBeNull();
	});
});
