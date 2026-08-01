import { describe, expect, it } from 'vitest';
import { rect, vec } from './geometry';
import { Viewport } from './viewport';

describe('Viewport', () => {
	it('round-trips between world and screen', () => {
		const v = new Viewport();
		v.x = 120;
		v.y = -40;
		v.scale = 2.5;

		const world = vec(37, -13);
		const back = v.toWorld(v.toScreen(world));
		expect(back.x).toBeCloseTo(world.x, 10);
		expect(back.y).toBeCloseTo(world.y, 10);
	});

	it('keeps the anchor fixed while zooming', () => {
		const v = new Viewport();
		const anchor = vec(300, 200);
		const before = v.toWorld(anchor);

		v.zoomAt(anchor, 1.7);
		const after = v.toWorld(anchor);

		// This is the whole contract of zoom-to-cursor: whatever was under the
		// pointer must still be under the pointer.
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
		expect(v.scale).toBeCloseTo(1.7, 10);
	});

	it('refuses to zoom past its limits', () => {
		const v = new Viewport();
		v.limits = { minScale: 0.5, maxScale: 2 };

		for (let i = 0; i < 40; i++) v.zoomAt(vec(0, 0), 1.5);
		expect(v.scale).toBe(2);

		for (let i = 0; i < 40; i++) v.zoomAt(vec(0, 0), 0.5);
		expect(v.scale).toBe(0.5);
	});

	it('reports the visible world region', () => {
		const v = new Viewport();
		v.scale = 2;
		v.x = -100;
		v.y = -50;
		const bounds = v.visibleBounds({ width: 400, height: 200 });
		expect(bounds).toEqual({ x: 50, y: 25, w: 200, h: 100 });
	});

	it('fits content with room to spare', () => {
		const v = new Viewport();
		const content = rect(0, 0, 400, 200);
		const size = { width: 800, height: 600 };
		v.fit(content, size, 50);

		const visible = v.visibleBounds(size);
		expect(visible.x).toBeLessThan(content.x);
		expect(visible.y).toBeLessThan(content.y);
		expect(visible.x + visible.w).toBeGreaterThan(content.x + content.w);
		expect(visible.y + visible.h).toBeGreaterThan(content.y + content.h);

		// And the content ends up centred.
		const centre = v.toScreen(vec(200, 100));
		expect(centre.x).toBeCloseTo(400, 6);
		expect(centre.y).toBeCloseTo(300, 6);
	});

	it('survives fitting a single point', () => {
		const v = new Viewport();
		v.fit(rect(50, 50, 0, 0), { width: 800, height: 600 });
		expect(Number.isFinite(v.scale)).toBe(true);
		expect(v.scale).toBeGreaterThan(0);
		const centre = v.toScreen(vec(50, 50));
		expect(centre.x).toBeCloseTo(400, 6);
	});

	it('converts screen tolerances to world units', () => {
		const v = new Viewport();
		v.scale = 4;
		expect(v.toWorldLength(8)).toBe(2);
		expect(v.pixel).toBe(0.25);
	});
});
