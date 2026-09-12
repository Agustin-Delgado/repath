/**
 * A gesture the editor takes away from its tool.
 *
 * A second finger landing turns whatever the first one was doing into a
 * pinch, and the tool never sees a release for it. What it had begun — a part
 * being dragged, a wire being drawn — has to be undone rather than left half
 * done, or the pinch that follows moves a resistor it was never meant to touch.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Scene, SnapIndex, Viewport, type EditorPointer, type ToolContext } from '$lib/canvas';
import { app } from '$lib/state.svelte';
import { buildSceneItems, buildSnapTargets } from '../scene';
import { createSelectTool, createWireTool } from '.';

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

describe('the select tool, when its gesture is called off', () => {
	it('puts a part being dragged back where it was', () => {
		app.place('resistor', 200, 200, 0);
		const part = app.schematic.instances[0];
		const tool = createSelectTool();
		const ctx = context();

		tool.pointerDown!(press(200, 200), ctx);
		tool.pointerMove!(press(250, 240, { x: 200, y: 200 }), ctx);
		expect(part.x).toBe(250);

		tool.cancel!(ctx);

		expect(app.schematic.instances[0].x).toBe(200);
		expect(app.schematic.instances[0].y).toBe(200);
		expect(app.isMoving).toBe(false);
	});

	it('drops a wire being drawn off a pin', () => {
		app.place('resistor', 200, 200, 0); // pins (170,200) and (230,200)
		app.place('resistor', 400, 200, 0); // pins (370,200) and (430,200)
		const tool = createSelectTool();
		const ctx = context();

		tool.pointerDown!(press(230, 200), ctx);
		tool.pointerMove!(press(370, 200, { x: 230, y: 200 }), ctx);
		tool.cancel!(ctx);
		// The release that would have committed it arrives anyway on a real
		// pinch's last finger; it must not draw the wire after the fact.
		tool.pointerUp!(press(370, 200, { x: 230, y: 200 }), ctx);

		expect(app.schematic.wires).toHaveLength(0);
	});
});

describe('the wire tool, when its gesture is called off', () => {
	it('forgets the end it had picked up', () => {
		app.place('resistor', 200, 200, 0);
		app.place('resistor', 400, 200, 0);
		const tool = createWireTool();
		const ctx = context();

		tool.pointerDown!(press(230, 200), ctx);
		tool.cancel!(ctx);
		tool.pointerUp!(press(370, 200, { x: 230, y: 200 }), ctx);

		expect(app.schematic.wires).toHaveLength(0);
	});
});
