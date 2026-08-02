/**
 * The editing rules that used to fail quietly.
 *
 * Each of these covers something the editor did without saying so: a group that
 * scrambled itself when turned, a value refused with no explanation, a component
 * pulled out of a chain leaving both halves reaching for nothing. A silent wrong
 * answer is the worst kind, so every one of them gets a test.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from './state.svelte';
import { routeWire } from './schematic/route';
import { pinKey } from './schematic/nets';
import type { Point } from './schematic/model';

const routeFor = (moving: Set<string>) => (from: Point, to: Point, settling: ReadonlySet<string>) =>
	routeWire(app.schematic, from, to, {
		grid: 10,
		ignoreInstances: moving,
		ignoreWires: settling
	});

const find = (name: string) => app.schematic.instances.find((i) => i.name === name)!;
const netOf = (name: string, pin: string) =>
	app.compiled.connectivity.netOfPin.get(pinKey(find(name).id, pin));
const shapes = () => app.schematic.wires.map((w) => w.points.map((p) => `${p.x},${p.y}`).join(' '));
const orthogonal = () =>
	app.schematic.wires.every((w) =>
		w.points.every((p, i) => i === 0 || p.x === w.points[i - 1].x || p.y === w.points[i - 1].y)
	);

beforeEach(() => {
	app.clear();
	app.selection = [];
});

describe('rotating a group', () => {
	beforeEach(() => {
		// A row of three, 100 apart, so the arrangement is obvious after turning.
		app.place('resistor', 100, 200, 0);
		app.place('resistor', 200, 200, 0);
		app.place('resistor', 300, 200, 0);
	});

	it('orbits the centre instead of spinning each part where it stands', () => {
		app.selection = app.schematic.instances.map((i) => i.id);
		app.rotateSelection();

		// The row was horizontal about (200,200); it should now be vertical about
		// that same point, rather than three parts each turned where they sat.
		expect(app.schematic.instances.map((i) => `${i.x},${i.y}`).sort()).toEqual([
			'200,100',
			'200,200',
			'200,300'
		]);
		expect(app.schematic.instances.every((i) => i.rotation === 90)).toBe(true);
	});

	it('leaves a lone component turning on the spot', () => {
		app.selection = [find('R2').id];
		app.rotateSelection();
		expect({ x: find('R2').x, y: find('R2').y }).toEqual({ x: 200, y: 200 });
		expect(find('R2').rotation).toBe(90);
	});

	it('comes back to where it started after four turns', () => {
		app.selection = app.schematic.instances.map((i) => i.id);
		const before = app.schematic.instances.map((i) => `${i.name} ${i.x},${i.y} ${i.rotation}`);
		for (let i = 0; i < 4; i++) app.rotateSelection();
		expect(app.schematic.instances.map((i) => `${i.name} ${i.x},${i.y} ${i.rotation}`)).toEqual(
			before
		);
	});

	it('keeps a connection made inside the group', () => {
		// R1's right pin to R2's left pin, plus the wire itself in the selection.
		app.addWirePath([
			{ x: 130, y: 200 },
			{ x: 170, y: 200 }
		]);
		expect(netOf('R1', 'b')).toBe(netOf('R2', 'a'));

		app.selection = [...app.schematic.instances.map((i) => i.id), app.schematic.wires[0].id];
		app.rotateSelection(routeFor(new Set(app.selection)));

		expect(netOf('R1', 'b')).toBe(netOf('R2', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('keeps a connection to something left behind', () => {
		app.place('ground', 500, 200, 0); // pin at (500,190)
		app.addWirePath([
			{ x: 330, y: 200 },
			{ x: 500, y: 190 }
		]);
		expect(netOf('R3', 'b')).toBe(netOf('GND1', 'g'));

		app.selection = [find('R1').id, find('R2').id, find('R3').id];
		app.rotateSelection(routeFor(new Set(app.selection)));

		expect(netOf('R3', 'b')).toBe(netOf('GND1', 'g'));
		expect(orthogonal()).toBe(true);
	});
});

describe('refusing an edit', () => {
	beforeEach(() => {
		app.place('resistor', 200, 200, 0);
		app.place('capacitor', 400, 200, 0);
	});

	it('says why a negative value is no good, and keeps the old one', () => {
		expect(app.setParam(find('R1').id, 'resistance', -470)).toMatch(/cannot be below/i);
		// The whole point: the engine used to take the magnitude, so the circuit
		// that ran was not the circuit on screen.
		expect(find('R1').params.resistance).toBe(1000);
	});

	it('says why zero is no good', () => {
		expect(app.setParam(find('R1').id, 'resistance', 0)).toMatch(/cannot be zero/i);
		expect(app.setParam(find('C1').id, 'capacitance', 0)).toMatch(/cannot be zero/i);
		expect(find('R1').params.resistance).toBe(1000);
	});

	it('accepts an ordinary value without complaint', () => {
		expect(app.setParam(find('R1').id, 'resistance', 4700)).toBeNull();
		expect(find('R1').params.resistance).toBe(4700);
	});

	it('allows a negative value where one is meaningful', () => {
		app.place('opamp', 700, 200, 0);
		// A negative rail is the entire point of a negative rail.
		expect(app.setParam(find('U1').id, 'v_min', -15)).toBeNull();
		expect(find('U1').params.v_min).toBe(-15);
	});

	it('holds a duty cycle inside its range', () => {
		app.place('vsource', 700, 200, 0);
		expect(app.setParam(find('V1').id, 'duty', 1.5)).toMatch(/cannot be above/i);
		expect(app.setParam(find('V1').id, 'duty', -0.2)).toMatch(/cannot be below/i);
		expect(app.setParam(find('V1').id, 'duty', 0.25)).toBeNull();
	});

	it('says why a name is taken, and does not take it', () => {
		expect(app.rename(find('R1').id, 'C1')).toMatch(/already taken/i);
		expect(find('R1').name).toBe('R1');
	});

	it('says why a blank name is no good', () => {
		expect(app.rename(find('R1').id, '   ')).toMatch(/needs a name/i);
		expect(find('R1').name).toBe('R1');
	});

	it('is happy with a real rename', () => {
		expect(app.rename(find('R1').id, 'RLOAD')).toBeNull();
		expect(find('RLOAD')).toBeDefined();
	});

	it('costs no undo step when it refuses', () => {
		const before = app.schematic.instances.length;
		app.setParam(find('R1').id, 'resistance', -1);
		app.rename(find('R1').id, 'C1');
		app.undo();
		// The undo unwinds the capacitor placement, since neither edit applied.
		expect(app.schematic.instances).toHaveLength(before - 1);
	});
});

describe('undo and the selection', () => {
	it('puts back what was selected', () => {
		app.place('resistor', 200, 200, 0);
		app.place('capacitor', 400, 200, 0);
		const both = app.schematic.instances.map((i) => i.id);
		app.selection = both;
		app.deleteSelection();
		expect(app.selection).toEqual([]);

		app.undo();
		// Undoing a delete and finding nothing selected means re-picking everything
		// by hand, every single time.
		expect(new Set(app.selection)).toEqual(new Set(both));
	});

	it('puts it back on redo too', () => {
		app.place('resistor', 200, 200, 0);
		const id = find('R1').id;
		app.selection = [id];
		app.rotateSelection();
		app.undo();
		app.redo();
		expect(app.selection).toEqual([id]);
	});

	it('never names something that is gone', () => {
		app.place('resistor', 200, 200, 0);
		app.selection = [find('R1').id];
		app.place('capacitor', 400, 200, 0);
		app.undo();
		expect(app.selection.every((id) => app.schematic.instances.some((i) => i.id === id))).toBe(
			true
		);
	});
});

describe('deleting a component', () => {
	it('closes the gap it leaves in a chain', () => {
		app.place('vsource', 100, 200, 0); // plus (100,170)
		app.place('resistor', 300, 170, 0); // pins (270,170), (330,170)
		app.place('ground', 500, 180, 0); // pin (500,170)
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 270, y: 170 }
		]);
		app.addWirePath([
			{ x: 330, y: 170 },
			{ x: 500, y: 170 }
		]);
		expect(netOf('V1', 'plus')).not.toBe(netOf('GND1', 'g'));
		// The source's minus pin is bare in this fixture, so count the loose ends
		// rather than expecting none: what matters is that healing adds no more.
		const looseBefore = app.compiled.warnings.length;

		app.selection = [find('R1').id];
		app.deleteSelection();

		// The two wires that were reaching for the resistor now reach each other.
		expect(netOf('V1', 'plus')).toBe(netOf('GND1', 'g'));
		expect(app.compiled.warnings.length).toBe(looseBefore);
		expect(orthogonal()).toBe(true);
	});

	it('leaves the wire alone when only one side was connected', () => {
		app.place('vsource', 100, 200, 0);
		app.place('resistor', 300, 170, 0);
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 270, y: 170 }
		]);

		app.selection = [find('R1').id];
		app.deleteSelection();
		// Nothing on the far pin, so there is no gap to close. Inventing a wire to
		// nowhere would be worse than leaving the stub.
		expect(shapes()).toEqual(['100,170 270,170']);
	});

	it('does not guess for a part with more than two pins', () => {
		app.place('nmos', 300, 200, 0);
		app.addWirePath([
			{ x: 270, y: 180 },
			{ x: 150, y: 180 }
		]);
		app.addWirePath([
			{ x: 330, y: 170 },
			{ x: 450, y: 170 }
		]);
		const before = app.schematic.wires.length;

		app.selection = [find('M1').id];
		app.deleteSelection();
		// Three pins offer no single obvious pairing, so nothing is invented.
		expect(app.schematic.wires).toHaveLength(before);
	});

	it('takes one undo to put the component and the healing wire back', () => {
		app.place('vsource', 100, 200, 0);
		app.place('resistor', 300, 170, 0);
		app.place('ground', 500, 180, 0);
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 270, y: 170 }
		]);
		app.addWirePath([
			{ x: 330, y: 170 },
			{ x: 500, y: 170 }
		]);
		const before = shapes();

		app.selection = [find('R1').id];
		app.deleteSelection();
		app.undo();

		expect(find('R1')).toBeDefined();
		expect(shapes()).toEqual(before);
	});
});

describe('reshaping a wire', () => {
	beforeEach(() => {
		app.place('vsource', 200, 250, 0); // plus (200,220)
		app.place('resistor', 500, 220, 0); // pin a (470,220)
	});

	/** Drag one leg the way the select tool drives it. */
	function dragLeg(wireId: string, index: number, dx: number, dy: number) {
		app.selection = [wireId];
		app.beginMove();
		app.applySegmentMove(wireId, index, dx, dy);
		const during = shapes();
		app.endMove();
		return { during, after: shapes() };
	}

	it('moves only the leg under the cursor', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 350, y: 220 },
			{ x: 350, y: 300 },
			{ x: 470, y: 300 },
			{ x: 470, y: 220 }
		]);
		const id = app.schematic.wires[0].id;

		dragLeg(id, 2, 0, 60); // the horizontal leg at y = 300

		const points = app.schematic.wires[0].points;
		expect(points[0]).toEqual({ x: 200, y: 220 });
		expect(points[points.length - 1]).toEqual({ x: 470, y: 220 });
		// The dragged leg went down; the legs either side stretched to follow it.
		expect(points.some((p) => p.y === 360)).toBe(true);
		expect(points.some((p) => p.y === 300)).toBe(false);
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('ignores a push along the leg, which would change nothing visible', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
		dragLeg(app.schematic.wires[0].id, 0, 90, 0); // horizontal leg, pushed sideways
		expect(shapes()).toEqual(['200,220 470,220']);
	});

	it('grows a corner rather than pulling off a pin', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
		dragLeg(app.schematic.wires[0].id, 0, 0, 70);

		const points = app.schematic.wires[0].points;
		expect(points[0]).toEqual({ x: 200, y: 220 });
		expect(points[points.length - 1]).toEqual({ x: 470, y: 220 });
		expect(points).toHaveLength(4);
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('straightens back out when dragged back', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
		const id = app.schematic.wires[0].id;
		app.selection = [id];
		app.beginMove();
		app.applySegmentMove(id, 0, 0, 70);
		// The same gesture returned to zero: the corners simplify away again.
		app.applySegmentMove(id, 0, 0, 0);
		app.endMove();
		expect(shapes()).toEqual(['200,220 470,220']);
	});

	it('shows the same shape mid-drag as it commits', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
		const { during, after } = dragLeg(app.schematic.wires[0].id, 0, 0, -40);
		expect(after).toEqual(during);
	});

	it('does not drift over a long gesture', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
		const id = app.schematic.wires[0].id;
		app.selection = [id];
		app.beginMove();
		for (let i = 1; i <= 20; i++) app.applySegmentMove(id, 0, 0, i * 5);
		app.applySegmentMove(id, 0, 0, 80);
		app.endMove();
		// Absolute, not incremental, so only the last call decides where it lands.
		expect(app.schematic.wires[0].points[1]).toEqual({ x: 200, y: 300 });
	});

	it('slides a wire attached to nothing, in both directions at once', () => {
		app.clear();
		app.addWirePath([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 }
		]);
		dragLeg(app.schematic.wires[0].id, 0, 40, 30);
		expect(shapes()).toEqual(['40,30 140,30']);
	});

	it('takes one undo for the whole reshape', () => {
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
		const id = app.schematic.wires[0].id;
		app.selection = [id];
		app.beginMove();
		for (let i = 1; i <= 8; i++) app.applySegmentMove(id, 0, 0, i * 10);
		app.endMove();

		app.undo();
		expect(shapes()).toEqual(['200,220 470,220']);
	});
});

describe('abandoning a drag', () => {
	beforeEach(() => {
		app.place('vsource', 200, 250, 0); // plus (200,220)
		app.place('resistor', 500, 220, 0); // pin a (470,220)
		app.addWirePath([
			{ x: 200, y: 220 },
			{ x: 470, y: 220 }
		]);
	});

	it('puts the component back where it started', () => {
		app.selection = [find('R1').id];
		app.beginMove();
		app.applyMove(140, 90, routeFor(new Set(app.selection)));
		expect(find('R1').x).toBe(640);

		app.cancelMove();
		expect({ x: find('R1').x, y: find('R1').y }).toEqual({ x: 500, y: 220 });
		expect(shapes()).toEqual(['200,220 470,220']);
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
	});

	it('puts a reshaped wire back', () => {
		const id = app.schematic.wires[0].id;
		app.selection = [id];
		app.beginMove();
		app.applySegmentMove(id, 0, 0, 80);
		expect(app.schematic.wires[0].points.length).toBeGreaterThan(2);

		app.cancelMove();
		expect(shapes()).toEqual(['200,220 470,220']);
	});

	it('costs no undo step, and hands back the redo stack', () => {
		app.selection = [find('R1').id];
		// Something to redo: an edit, undone.
		app.setParam(find('R1').id, 'resistance', 4700);
		app.undo();
		expect(find('R1').params.resistance).toBe(1000);

		app.beginMove();
		app.applyMove(100, 0, routeFor(new Set(app.selection)));
		app.cancelMove();

		// The cancelled drag left no trace in either direction.
		app.redo();
		expect(find('R1').params.resistance).toBe(4700);
		expect(find('R1').x).toBe(500);
	});

	it('does nothing when no drag is running', () => {
		const before = shapes();
		app.cancelMove();
		expect(shapes()).toEqual(before);
		expect(app.isMoving).toBe(false);
	});

	it('leaves nothing running', () => {
		app.selection = [find('R1').id];
		app.beginMove();
		app.applyMove(50, 50, routeFor(new Set(app.selection)));
		expect(app.isMoving).toBe(true);
		app.cancelMove();
		expect(app.isMoving).toBe(false);
	});
});

describe('the first drag', () => {
	/**
	 * The one that gave this away: drag a part and the wires come out with a jog,
	 * drag it again and they tidy themselves up. Both drags ask the same question
	 * about the same schematic, so both have to give the same answer — and if the
	 * second one is better, the first one was wrong.
	 *
	 * The cause was that a gesture rewrites its wires one at a time, and the ones
	 * it had not reached yet were still sitting where they used to be. So the first
	 * wire routed around a second wire that was about to move: a detour around a
	 * state that never appears on screen. By the second drag everything had already
	 * settled, which is why it looked fine.
	 */
	beforeEach(() => {
		// The RC low-pass, as it ships.
		app.place('vsource', 100, 200, 0); // plus (100,170)
		app.place('resistor', 200, 170, 0); // pins (170,170), (230,170)
		app.place('capacitor', 300, 230, 90); // pins (300,200), (300,260)
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 170, y: 170 }
		]);
		app.addWirePath([
			{ x: 230, y: 170 },
			{ x: 300, y: 170 },
			{ x: 300, y: 200 }
		]);
	});

	function dragTo(dx: number, dy: number) {
		const moving = new Set(app.selection);
		app.beginMove();
		app.applyMove(dx, dy, routeFor(moving));
		app.endMove();
		return shapes();
	}

	it('settles on the first pass, not the second', () => {
		app.selection = [find('R1').id];
		const first = dragTo(40, 40);
		const again = dragTo(0, 0);
		expect(again).toEqual(first);
	});

	it('routes each wire against where everything is going, not where half of it was', () => {
		app.selection = [find('R1').id];
		dragTo(40, 40);
		// R1's left pin lands at (210,210). The wire from the source reaches it
		// straight across and straight down — it used to turn a column early to
		// dodge the other wire's old position.
		expect(shapes()[0]).toBe('100,170 210,170 210,210');
		expect(netOf('V1', 'plus')).toBe(netOf('R1', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('stays settled over a run of different drags', () => {
		app.selection = [find('R1').id];
		for (const [dx, dy] of [
			[30, 0],
			[0, 50],
			[-20, -40],
			[60, 20]
		]) {
			const first = dragTo(dx, dy);
			// Re-route in place — a second gesture that moves nothing, which is the
			// same question over again.
			expect(dragTo(0, 0)).toEqual(first);
		}
	});
});

describe('dragging two pins together', () => {
	it('drops the wire that used to run between them', () => {
		// Dragging a part until one of its pins touches another is how two things
		// get connected without a wire. When a wire already ran between exactly
		// those two pins it has nowhere left to be, and it used to survive as a
		// single point: invisible, but selectable, saved to file and carried in a
		// share link.
		app.place('vsource', 100, 200, 0); // plus (100,170)
		app.place('resistor', 200, 170, 0); // pins (170,170), (230,170)
		app.place('capacitor', 300, 230, 90); // pins (300,200), (300,260)
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 170, y: 170 }
		]);
		app.addWirePath([
			{ x: 230, y: 170 },
			{ x: 300, y: 170 },
			{ x: 300, y: 200 }
		]);

		// The far pins are deliberately bare in this fixture, so count the loose
		// ends rather than expecting none.
		const looseBefore = app.compiled.warnings.length;

		app.selection = [find('R1').id];
		app.beginMove();
		// R1's right pin lands exactly on the capacitor's top pin.
		app.applyMove(70, 30, routeFor(new Set(app.selection)));
		app.endMove();

		expect(app.schematic.wires.every((w) => w.points.length >= 2)).toBe(true);
		// The connection is now the pins touching, so it must still be one net.
		expect(netOf('R1', 'b')).toBe(netOf('C1', 'a'));
		expect(app.compiled.warnings.length).toBe(looseBefore);
	});
});
