/**
 * The arrow keys move what is selected, a grid step at a time.
 *
 * Dragging a part exactly one square is fiddly with a mouse and worse with a
 * finger; the keys are how a drawing gets lined up. Shift makes the step five.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Scene, SnapIndex, Viewport, type EditorPointer, type ToolContext } from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { buildSceneItems, buildSnapTargets } from '../scene';
import { createSelectTool } from '.';

function context(): ToolContext {
	const scene = new Scene();
	const snap = new SnapIndex();
	scene.replaceAll(buildSceneItems(app.schematic));
	const targets = buildSnapTargets(app.schematic);
	snap.rebuild(targets.points, targets.segments);
	return {
		viewport: new Viewport(),
		scene,
		snap,
		size: { width: 800, height: 600 },
		unit: 1,
		tolerance: 7,
		gridSize: 10,
		invalidate() {},
		setCursor() {}
	};
}

function key(name: string, shiftKey = false): KeyboardEvent {
	return { key: name, shiftKey, ctrlKey: false, metaKey: false, altKey: false } as KeyboardEvent;
}

function press(x: number, y: number, origin = { x, y }): EditorPointer {
	return {
		world: { x, y },
		screen: { x, y },
		origin,
		delta: { x: 0, y: 0 },
		button: 0,
		buttons: 1,
		shift: false,
		ctrl: false,
		alt: false,
		meta: false,
		pointerId: 1,
		detail: 1,
		dragging: origin.x !== x || origin.y !== y,
		native: {} as PointerEvent
	};
}

beforeEach(() => {
	app.clear();
	app.selection = [];
});

describe('the arrow keys', () => {
	it('move the selection one grid point, or five with Shift', () => {
		app.place('resistor', 200, 200, 0);
		const part = app.schematic.instances[0];
		app.selection = [part.id];
		const tool = createSelectTool();
		const ctx = context();

		expect(tool.keyDown!(key('ArrowRight'), ctx)).toBe(true);
		expect([part.x, part.y]).toEqual([210, 200]);
		expect(tool.keyDown!(key('ArrowUp'), ctx)).toBe(true);
		expect([part.x, part.y]).toEqual([210, 190]);
		expect(tool.keyDown!(key('ArrowLeft', true), ctx)).toBe(true);
		expect([part.x, part.y]).toEqual([160, 190]);
		expect(tool.keyDown!(key('ArrowDown', true), ctx)).toBe(true);
		expect([part.x, part.y]).toEqual([160, 240]);
	});

	it('are left alone with nothing selected, so the page can have them', () => {
		app.place('resistor', 200, 200, 0);
		app.selection = [];
		const tool = createSelectTool();

		expect(tool.keyDown!(key('ArrowRight'), context())).toBe(false);
		expect(app.schematic.instances[0].x).toBe(200);
	});

	it('stay out of a drag that is in progress', () => {
		app.place('resistor', 200, 200, 0);
		const part = app.schematic.instances[0];
		const tool = createSelectTool();
		const ctx = context();

		tool.pointerDown!(press(200, 200), ctx);
		tool.pointerMove!(press(250, 200, { x: 200, y: 200 }), ctx);
		expect(tool.keyDown!(key('ArrowRight'), ctx)).toBe(false);
		expect(part.x).toBe(250);

		tool.pointerUp!(press(250, 200, { x: 200, y: 200 }), ctx);
		expect(part.x).toBe(250);
	});
});
