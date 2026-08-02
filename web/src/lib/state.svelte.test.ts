/**
 * The editor's rules about what stays connected to what.
 *
 * These are the behaviours that broke in the ways a user actually noticed:
 * a component dragged off its wires, a wire torn from its pins, a rotation that
 * quietly disconnected everything. Each one gets a test that fails the way the
 * bug did.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from './state.svelte';
import { elbow, routeWire } from './schematic/route';
import { pinKey } from './schematic/nets';
import type { Point } from './schematic/model';

/** The router the tools use, wired the way the select tool wires it. */
/**
 * The router, wired exactly the way the select tool wires it.
 *
 * `effort` included. It was missing here, so the tests were exercising a
 * different search budget from the one a real drag uses — a gap that would hide
 * any bug living in the fallback.
 */
const routeFor = (moving: Set<string>) => (from: Point, to: Point, settling: ReadonlySet<string>) =>
	routeWire(app.schematic, from, to, {
		grid: 10,
		ignoreInstances: moving,
		ignoreWires: settling,
		effort: 4000
	});

const find = (name: string) => app.schematic.instances.find((i) => i.name === name)!;
const netOf = (name: string, pin: string) =>
	app.compiled.connectivity.netOfPin.get(pinKey(find(name).id, pin));
const shapes = () => app.schematic.wires.map((w) => w.points.map((p) => `${p.x},${p.y}`).join(' '));
const orthogonal = () =>
	app.schematic.wires.every((w) =>
		w.points.every((p, i) => i === 0 || p.x === w.points[i - 1].x || p.y === w.points[i - 1].y)
	);

/** Move the selection as a gesture would: begin, apply an offset, end. */
function dragBy(dx: number, dy: number) {
	const moving = new Set(app.selection);
	app.beginMove();
	app.applyMove(dx, dy, routeFor(moving));
	const during = shapes();
	app.endMove();
	return { during, after: shapes() };
}

beforeEach(() => {
	app.clear();
	app.selection = [];
});

describe('moving a component', () => {
	beforeEach(() => {
		app.place('vsource', 200, 250, 0); // plus (200,220), minus (200,280)
		app.place('resistor', 500, 220, 0); // pins (470,220), (530,220)
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
	});

	it('brings its wires with it', () => {
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		// The far pins are deliberately bare, so count them rather than expecting none.
		const looseBefore = app.compiled.warnings.length;

		app.selection = [find('R1').id];
		dragBy(60, 120);

		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		// The move must not create a new loose end.
		expect(app.compiled.warnings.length).toBe(looseBefore);
		expect(orthogonal()).toBe(true);
	});

	it('shows the same geometry mid-drag as it commits', () => {
		app.selection = [find('R1').id];
		const { during, after } = dragBy(-140, 90);
		// The whole point of recomputing from a snapshot: releasing changes nothing.
		expect(after).toEqual(during);
	});

	it('does not drift over a long gesture', () => {
		app.selection = [find('R1').id];
		const moving = new Set(app.selection);
		app.beginMove();
		// Many small steps, as a real pointer produces.
		for (let i = 1; i <= 20; i++) app.applyMove(i * 5, i * 3, routeFor(moving));
		app.applyMove(100, 60, routeFor(moving));
		app.endMove();
		// The offset is absolute, so the end position depends only on the last call.
		expect({ x: find('R1').x, y: find('R1').y }).toEqual({ x: 600, y: 280 });
	});

	it('leaves a wire alone when the point is shared with something staying put', () => {
		app.clear();
		app.place('vsource', 200, 200, 0); // plus at (200,170)
		app.place('resistor', 230, 170, 0); // left pin on that same point
		app.place('ground', 200, 60, 0);
		app.addWirePath([
			{ x: 200, y: 170 },
			{ x: 200, y: 50 }
		]);
		expect(netOf('R1', 'a')).toBe(netOf('V1', 'plus'));

		app.selection = [find('R1').id];
		dragBy(200, 160);

		// The resistor left; the wire belonged to the source's pin and stayed.
		expect(netOf('R1', 'a')).not.toBe(netOf('V1', 'plus'));
		expect(netOf('V1', 'plus')).toBe(netOf('GND1', 'g'));
		expect(shapes()).toEqual(['200,170 200,50']);
	});

	it('translates a wire whose both ends are moving', () => {
		app.selection = [find('V1').id, find('R1').id, app.schematic.wires[0].id];
		dragBy(50, 50);
		expect(shapes()).toEqual(['250,270 520,270']);
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
	});
});

describe('moving a wire', () => {
	beforeEach(() => {
		app.place('vsource', 200, 250, 0);
		app.place('resistor', 500, 220, 0);
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
	});

	it('keeps it plugged in at both ends', () => {
		app.selection = [app.schematic.wires[0].id];
		dragBy(0, 80);

		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		// The ends stayed on the pins; the body moved and grew legs to reach back.
		const points = app.schematic.wires[0].points;
		expect(points[0]).toEqual({ x: 200, y: 220 });
		expect(points[points.length - 1]).toEqual({ x: 470, y: 220 });
		expect(points.length).toBeGreaterThan(2);
		expect(orthogonal()).toBe(true);
	});

	it('never leaves it dangling', () => {
		const looseBefore = app.compiled.warnings.length;
		app.selection = [app.schematic.wires[0].id];
		dragBy(-90, 140);
		expect(app.compiled.warnings.length).toBe(looseBefore);
	});
});

describe('rotating', () => {
	beforeEach(() => {
		app.place('vsource', 200, 250, 0);
		app.place('resistor', 500, 220, 0);
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
	});

	it('keeps the wires attached, like moving does', () => {
		app.selection = [find('R1').id];
		app.rotateSelection(routeFor(new Set(app.selection)));

		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('stays connected through a full turn', () => {
		app.selection = [find('R1').id];
		for (let i = 0; i < 4; i++) {
			app.rotateSelection(routeFor(new Set(app.selection)));
			expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		}
		expect(find('R1').rotation).toBe(0);
	});

	it('works without a router, falling back to an elbow', () => {
		app.selection = [find('R1').id];
		app.rotateSelection();
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		expect(orthogonal()).toBe(true);
	});
});

describe('wires as one thing', () => {
	it('commits a routed path as a single wire', () => {
		app.addWirePath([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 80 }
		]);
		expect(app.schematic.wires).toHaveLength(1);
		expect(app.schematic.wires[0].points).toHaveLength(3);
	});

	it('refuses a path with nowhere to go', () => {
		app.addWirePath([{ x: 10, y: 10 }]);
		app.addWirePath([
			{ x: 10, y: 10 },
			{ x: 10, y: 10 }
		]);
		app.addWirePath([]);
		expect(app.schematic.wires).toHaveLength(0);
	});

	it('folds a chain drawn in pieces into one run', () => {
		app.addWirePath([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 }
		]);
		app.addWirePath([
			{ x: 100, y: 0 },
			{ x: 100, y: 80 }
		]);
		expect(app.schematic.wires).toHaveLength(1);
		expect(app.schematic.wires[0].points).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 80 }
		]);
	});
});

describe('history', () => {
	it('takes one entry per drag, not one per frame', () => {
		app.place('resistor', 200, 200, 0);
		app.selection = [find('R1').id];

		const moving = new Set(app.selection);
		app.beginMove();
		for (let i = 1; i <= 10; i++) app.applyMove(i * 10, 0, routeFor(moving));
		app.endMove();
		expect(find('R1').x).toBe(300);

		app.undo();
		// One undo returns the whole gesture, not a tenth of it.
		expect(find('R1').x).toBe(200);
	});

	it('records nothing for a drag that never moved', () => {
		app.place('resistor', 200, 200, 0);
		app.selection = [find('R1').id];
		app.beginMove();
		app.applyMove(0, 0, routeFor(new Set(app.selection)));
		app.endMove();

		app.undo();
		// The undo should unwind the *placement*, since the drag added nothing.
		expect(app.schematic.instances).toHaveLength(0);
	});

	it('unwinds and replays a whole session', () => {
		for (let i = 0; i < 6; i++) app.place('resistor', 100 + i * 80, 200, 0);
		expect(app.schematic.instances).toHaveLength(6);
		for (let i = 0; i < 6; i++) app.undo();
		expect(app.schematic.instances).toHaveLength(0);
		for (let i = 0; i < 6; i++) app.redo();
		expect(app.schematic.instances).toHaveLength(6);
	});
});

describe('clipboard', () => {
	beforeEach(() => {
		app.place('resistor', 200, 200, 0);
		app.place('capacitor', 400, 200, 0);
	});

	it('pastes at a point without colliding on names', () => {
		app.selection = app.schematic.instances.map((i) => i.id);
		app.copySelection();
		app.paste({ x: 600, y: 500 });

		expect(app.schematic.instances).toHaveLength(4);
		const names = app.schematic.instances.map((i) => i.name);
		expect(new Set(names).size).toBe(4);
		// The copied group's corner lands where it was asked for.
		expect(Math.min(...app.selectedInstances.map((i) => i.x))).toBe(600);
	});

	it('offsets a plain duplicate so it is visibly a second copy', () => {
		app.selection = [find('R1').id];
		app.duplicateSelection();
		const copy = app.selectedInstances[0];
		expect(copy.x).not.toBe(200);
		expect(copy.name).not.toBe('R1');
	});

	it('copies nothing when nothing is selected', () => {
		app.selection = [];
		expect(app.copySelection()).toBe(false);
	});
});

describe('elbow fallback', () => {
	it('is what a rotation without a router produces', () => {
		expect(elbow({ x: 0, y: 0 }, { x: 100, y: 50 })).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 50 }
		]);
	});
});
