import { describe, expect, it } from 'vitest';
import { distanceToSegment, rect, vec, type Vec2 } from './geometry';
import { Scene, type SceneItem } from './scene';

function box(id: string, x: number, y: number, z = 0): SceneItem {
	return { id, kind: 'box', bounds: rect(x, y, 20, 20), z, data: null };
}

/** A thin diagonal: its bounding box is huge but the line itself is not. */
function wire(id: string, a: Vec2, b: Vec2, z = 0): SceneItem {
	return {
		id,
		kind: 'wire',
		bounds: rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y)),
		z,
		data: null,
		hit: (p, tolerance) => distanceToSegment(p, a, b) <= tolerance
	};
}

describe('Scene', () => {
	it('finds items by region across hash cells', () => {
		const scene = new Scene(50);
		scene.add(box('a', 0, 0));
		scene.add(box('b', 500, 500));
		scene.add(box('c', 10, 10));

		const near = scene.query(rect(-5, -5, 40, 40)).map((i) => i.id);
		expect(near.sort()).toEqual(['a', 'c']);
		expect(scene.query(rect(490, 490, 40, 40)).map((i) => i.id)).toEqual(['b']);
	});

	it('indexes items spanning several cells without duplicating them', () => {
		const scene = new Scene(32);
		scene.add({ id: 'wide', kind: 'box', bounds: rect(0, 0, 500, 10), z: 0, data: null });
		const found = scene.query(rect(0, 0, 500, 10));
		expect(found).toHaveLength(1);
	});

	it('picks the frontmost item', () => {
		const scene = new Scene();
		scene.add(box('under', 0, 0, 0));
		scene.add(box('over', 5, 5, 10));
		expect(scene.top(vec(10, 10))?.id).toBe('over');
	});

	it('uses the precise hit test rather than the bounding box', () => {
		const scene = new Scene();
		scene.add(wire('diagonal', vec(0, 0), vec(100, 100)));

		// Dead on the line.
		expect(scene.top(vec(50, 50), 2)?.id).toBe('diagonal');
		// Inside the bounding box but nowhere near the wire. Without a precise
		// test this would select, which is what makes diagonal wires infuriating.
		expect(scene.top(vec(90, 10), 2)).toBeUndefined();
	});

	it('honours the pick tolerance', () => {
		const scene = new Scene();
		scene.add(wire('h', vec(0, 0), vec(100, 0)));
		expect(scene.top(vec(50, 4), 2)).toBeUndefined();
		expect(scene.top(vec(50, 4), 6)?.id).toBe('h');
	});

	it('encloses only items fully inside the marquee', () => {
		const scene = new Scene();
		scene.add(box('inside', 10, 10));
		scene.add(box('straddling', 95, 10));

		const hits = scene.enclosed(rect(0, 0, 100, 100)).map((i) => i.id);
		expect(hits).toEqual(['inside']);
	});

	it('removes items from every cell they occupied', () => {
		const scene = new Scene(32);
		scene.add({ id: 'wide', kind: 'box', bounds: rect(0, 0, 500, 10), z: 0, data: null });
		scene.remove('wide');
		expect(scene.query(rect(0, 0, 500, 10))).toHaveLength(0);
		expect(scene.size).toBe(0);
		// And re-adding still works, which it would not if buckets leaked.
		scene.add(box('later', 400, 0));
		expect(scene.query(rect(390, -5, 40, 40))).toHaveLength(1);
	});

	it('replacing an id does not leave the old geometry behind', () => {
		const scene = new Scene(50);
		scene.add(box('moving', 0, 0));
		scene.add(box('moving', 400, 400));
		expect(scene.size).toBe(1);
		expect(scene.query(rect(-10, -10, 50, 50))).toHaveLength(0);
		expect(scene.query(rect(390, 390, 50, 50))).toHaveLength(1);
	});

	it('reports the union of everything', () => {
		const scene = new Scene();
		expect(scene.bounds()).toBeNull();
		scene.add(box('a', 0, 0));
		scene.add(box('b', 100, 50));
		expect(scene.bounds()).toEqual({ x: 0, y: 0, w: 120, h: 70 });
	});

	it('handles negative coordinates', () => {
		const scene = new Scene(50);
		scene.add(box('negative', -500, -300));
		expect(scene.query(rect(-510, -310, 50, 50)).map((i) => i.id)).toEqual(['negative']);
		expect(scene.top(vec(-495, -295))?.id).toBe('negative');
	});
});
