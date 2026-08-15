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
import { crossesBody, routeWire } from './schematic/route';
import { pinKey } from './schematic/nets';
import type { Point } from './schematic/model';

/**
 * The router, wired exactly the way the select tool wires it.
 *
 * `effort` included. It was missing here, so the tests were exercising a
 * different search budget from the one a real drag uses — a gap that would hide
 * any bug living in the fallback.
 */
const routeFor =
	(moving: Set<string>) =>
	(from: Point, to: Point, settling: ReadonlySet<string>, prefer?: readonly Point[]) => {
		void moving;
		return routeWire(app.schematic, from, to, {
			grid: 10,
			ignoreWires: settling,
			prefer,
			effort: 4000
		});
	};

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
	// `clear` deliberately keeps imported parts — they are a library rather than
	// part of the circuit — so a fresh start has to drop them on purpose.
	app.schematic.subcircuits = [];
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

	it('holds both polarities of a transistor to the same rules', () => {
		// The p-channel and pnp entries were copied from their counterparts
		// without the bounds, so a W/L of zero — a device that conducts nothing —
		// was accepted on one of each pair and refused on the other. Nothing on
		// the drawing says which one you picked up.
		app.place('nmos', 700, 200, 0);
		app.place('pmos', 900, 200, 0);
		app.place('npn', 1100, 200, 0);
		app.place('pnp', 1300, 200, 0);

		for (const [name, key] of [
			['M1', 'ratio'],
			['M2', 'ratio'],
			['M1', 'kp'],
			['M2', 'kp'],
			['Q1', 'bf'],
			['Q2', 'bf'],
			['Q1', 'is'],
			['Q2', 'is']
		] as const) {
			expect(app.setParam(find(name).id, key, 0), `${name}.${key} at zero`).toMatch(
				/cannot be zero/i
			);
			expect(app.setParam(find(name).id, key, -1), `${name}.${key} negative`).toMatch(
				/cannot be below/i
			);
		}
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
		// Upwards: dragging down would take the leg over the source's own minus pin
		// at (200,280), which shorts it — a real connection, and not the subject.
		dragLeg(app.schematic.wires[0].id, 0, 0, -70);

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
		for (let i = 1; i <= 20; i++) app.applySegmentMove(id, 0, 0, -i * 5);
		app.applySegmentMove(id, 0, 0, -80);
		app.endMove();
		// Absolute, not incremental, so only the last call decides where it lands.
		expect(app.schematic.wires[0].points[1]).toEqual({ x: 200, y: 140 });
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

describe('when the simulator runs', () => {
	it('is not running until it is asked', () => {
		// Opening on a circuit that is already moving gives no moment to look at it,
		// and the first thing anyone does is change something anyway.
		app.place('resistor', 200, 200, 0);
		expect(app.live).toBe(false);
		expect(app.result).toBeNull();
		expect(app.playing).toBe(false);
	});

	/** A circuit that actually compiles, so the signature is a netlist not an error. */
	function complete() {
		app.place('vsource', 100, 200, 0); // plus (100,170), minus (100,230)
		app.place('resistor', 200, 170, 0); // pins (170,170), (230,170)
		app.place('ground', 100, 300, 0); // pin (100,290)
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 170, y: 170 }
		]);
		app.addWirePath([
			{ x: 230, y: 170 },
			{ x: 300, y: 170 },
			{ x: 300, y: 290 },
			{ x: 100, y: 290 }
		]);
		app.addWirePath([
			{ x: 100, y: 230 },
			{ x: 100, y: 290 }
		]);
		expect(app.compiled.netlist).toBeTruthy();
	}

	it('notices a value change and ignores a move', () => {
		complete();
		const before = app.netlistSignature;

		// Moving a part redraws its wires on every frame of the drag; the circuit
		// those wires describe does not change, and re-simulating for that would be
		// a lot of work to arrive at the same answer.
		app.selection = [find('R1').id];
		app.beginMove();
		app.applyMove(0, 40, routeFor(new Set(app.selection)));
		app.endMove();
		expect(app.netlistSignature).toBe(before);

		app.setParam(find('R1').id, 'resistance', 4700);
		expect(app.netlistSignature).not.toBe(before);
	});

	it('notices the time range', () => {
		complete();
		const before = app.netlistSignature;

		app.stopTime = app.stopTime * 2;
		expect(app.netlistSignature).not.toBe(before);
	});

	it('stops following a circuit that has been replaced', () => {
		app.place('resistor', 200, 200, 0);
		app.live = true;
		app.loadExample('rc-lowpass');
		expect(app.live).toBe(false);
		expect(app.playing).toBe(false);
	});
});

describe('tidying wires', () => {
	/**
	 * Tidying rearranges wires without ever meaning to change what is joined to
	 * what. Every step of it argues that it cannot; between them the arguments
	 * have failed before, and a disconnection that says nothing is the worst thing
	 * this editor can do. So the claim is checked rather than trusted.
	 */
	it('never leaves a circuit more divided than it found it', () => {
		app.place('vsource', 100, 200, 0);
		app.place('resistor', 200, 170, 0);
		app.place('ground', 100, 300, 0);
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 170, y: 170 }
		]);
		app.addWirePath([
			{ x: 230, y: 170 },
			{ x: 300, y: 170 },
			{ x: 300, y: 290 },
			{ x: 100, y: 290 }
		]);
		app.addWirePath([
			{ x: 100, y: 230 },
			{ x: 100, y: 290 }
		]);

		const nets = () => app.compiled.connectivity.nets.length;
		const before = nets();

		// A long run of moves, each of which tidies afterwards.
		for (const [name, dx, dy] of [
			['R1', 40, 30],
			['V1', -20, 20],
			['GND1', 0, 40],
			['R1', -60, -10],
			['V1', 30, -30],
			['GND1', 20, -20]
		] as const) {
			app.selection = [find(name).id];
			app.beginMove();
			app.applyMove(dx, dy, routeFor(new Set(app.selection)));
			app.endMove();
			expect(nets()).toBeLessThanOrEqual(before);
		}
	});
});

describe('what moves when one thing moves', () => {
	/** The RC low-pass, laid out as it ships. */
	function lowPass() {
		app.place('vsource', 100, 200, 0); // plus (100,170), minus (100,230)
		app.place('resistor', 200, 170, 0); // pins (170,170), (230,170)
		app.place('capacitor', 300, 230, 90); // pins (300,200), (300,260)
		app.place('ground', 100, 300, 0); // pin (100,290)
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 170, y: 170 }
		]);
		app.addWirePath([
			{ x: 230, y: 170 },
			{ x: 300, y: 170 },
			{ x: 300, y: 200 }
		]);
		app.addWirePath([
			{ x: 300, y: 260 },
			{ x: 300, y: 290 },
			{ x: 100, y: 290 }
		]);
		app.addWirePath([
			{ x: 100, y: 230 },
			{ x: 100, y: 290 }
		]);
	}

	function drag(name: string, dx: number, dy: number) {
		app.selection = [find(name).id];
		app.beginMove();
		app.applyMove(dx, dy, routeFor(new Set(app.selection)));
		app.endMove();
	}

	it('lowers only the ground when the ground is lowered', () => {
		// Reported: dragging the ground down took the rail it feeds with it. The
		// rail is a long line across the drawing, and nobody asked it to move.
		lowPass();
		drag('GND1', 0, 60);

		// The rail is still where it was drawn, at y = 290.
		expect(shapes()).toContain('300,260 300,290 100,290');
		expect(netOf('GND1', 'g')).toBe(netOf('C1', 'b'));
		expect(netOf('GND1', 'g')).toBe(netOf('V1', 'minus'));
		expect(orthogonal()).toBe(true);
	});

	it('arrives at a pin along the way it faces, not across it', () => {
		// Reported from a shared link. Both L shapes between the two pins are the same
		// length with the same one corner, so nothing about length or corner count can
		// separate them — but one comes down into an upward-facing terminal and the
		// other clips into its side. The router has always known the difference; the
		// drag used to answer without asking it.
		lowPass();
		drag('R1', 10, -30);

		expect(shapes()).toContain('240,140 300,140 300,200');
		expect(netOf('R1', 'b')).toBe(netOf('C1', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('never leaves a wire running through the part it is chasing', () => {
		// Reported from a shared link: the wire feeding the capacitor's top pin came
		// in along the row below it and turned up *inside* the symbol, crossing the
		// plates to reach the terminal. Routing had been told to treat the parts on
		// the move as though they were not there, so nothing objected.
		lowPass();
		drag('C1', 0, -20);

		for (const wire of app.schematic.wires) {
			expect(crossesBody(app.schematic, wire.points, { grid: 10 })).toBe(false);
		}
		expect(netOf('C1', 'a')).toBe(netOf('R1', 'b'));
	});

	it('slides the feed sideways when a part is dragged across the way its pins face', () => {
		// Reported: dragging a part to the right left a step in the wire right where
		// it plugs in — down to the old height, across, then into the pin. The drop
		// that feeds a part should travel with it, and the run above simply gets
		// longer, because nothing that was drawn has to leave the line it is on.
		lowPass();
		drag('C1', 60, 0);

		const after = shapes();
		expect(after).toContain('230,170 360,170 360,200');
		expect(after).toContain('360,260 360,290 100,290');
		expect(orthogonal()).toBe(true);
	});

	it('does not slide when the part is dragged along the way its pins face', () => {
		// The other half of the same rule, and the reason the ground case above still
		// holds: moving along the lead only changes how far the wire has to reach.
		lowPass();
		drag('C1', 0, 40);

		// The run from the resistor is still on the row it was drawn on.
		expect(shapes().some((shape) => shape.startsWith('230,170 300,170'))).toBe(true);
		expect(orthogonal()).toBe(true);
	});

	it('still redraws a wire the move has made nonsense of', () => {
		// The other side of it, and the reason this is a judgement rather than a
		// rule: a wire that used to run along the row above both its ends should
		// not still climb up there to do it. Keeping the old shape is worth one
		// extra bend, not two.
		lowPass();
		drag('R1', 0, 30);

		expect(shapes()).toContain('230,200 300,200');
		for (const wire of app.schematic.wires) {
			const ends = [wire.points[0], wire.points[wire.points.length - 1]];
			const top = Math.min(...ends.map((p) => p.y));
			const bottom = Math.max(...ends.map((p) => p.y));
			for (const p of wire.points) {
				expect(p.y).toBeGreaterThanOrEqual(top);
				expect(p.y).toBeLessThanOrEqual(bottom);
			}
		}
	});

	it('keeps every connection either way', () => {
		lowPass();
		const before = app.compiled.connectivity.nets.length;
		for (const [name, dx, dy] of [
			['GND1', 0, 60],
			['R1', 0, 30],
			['C1', 40, 0],
			['V1', -20, -20]
		] as const) {
			drag(name, dx, dy);
			expect(app.compiled.connectivity.nets.length).toBeLessThanOrEqual(before);
		}
	});
});

describe('two pins that were touching', () => {
	/** R1 at 100,200 and R2 at 160,200: R1's `b` and R2's `a` share 130,200. */
	const touching = () => {
		app.place('resistor', 100, 200, 0);
		app.place('resistor', 160, 200, 0);
		expect(netOf('R1', 'b')).toBe(netOf('R2', 'a'));
	};

	it('are joined by a wire when a drag pulls them apart', () => {
		// Two parts placed pin to pin are connected with nothing to show for it.
		// Dragging one away used to disconnect them silently — while the same drag
		// on the same two parts joined by a visible wire keeps them connected,
		// because a wire follows what it is plugged into. The picture is identical
		// either way, so the outcome should be too.
		touching();
		app.selection = [find('R2').id];
		app.beginMove();
		app.applyMove(120, 0, routeFor(new Set(app.selection)));
		app.endMove();

		expect(app.schematic.wires.length).toBe(1);
		expect(netOf('R1', 'b')).toBe(netOf('R2', 'a'));
		expect(orthogonal()).toBe(true);
	});

	it('leaves nothing behind if the drag comes back', () => {
		// Every frame is recomputed from the snapshot, so a wire drawn while they
		// were apart has to disappear again when they meet — not accumulate one per
		// frame of the gesture.
		touching();
		app.selection = [find('R2').id];
		app.beginMove();
		for (let i = 1; i <= 12; i++) app.applyMove(i * 10, 0, routeFor(new Set(app.selection)));
		app.applyMove(0, 0, routeFor(new Set(app.selection)));
		app.endMove();

		expect(app.schematic.wires).toEqual([]);
		expect(netOf('R1', 'b')).toBe(netOf('R2', 'a'));
	});

	it('does not double up a connection that already had a wire', () => {
		// A pin resting on a wire end is a different case: that wire follows the pin
		// on its own, and drawing a second one alongside it would leave two
		// conductors doing one job.
		app.place('resistor', 100, 200, 0);
		app.place('resistor', 300, 200, 0);
		app.addWirePath([
			{ x: 130, y: 200 },
			{ x: 270, y: 200 }
		]);
		app.selection = [find('R2').id];
		app.beginMove();
		app.applyMove(0, 80, routeFor(new Set(app.selection)));
		app.endMove();

		expect(app.schematic.wires.length).toBe(1);
		expect(netOf('R1', 'b')).toBe(netOf('R2', 'a'));
	});

	it('is undone by Escape, wire and all', () => {
		// Cancelling restores what a drag moved, but this drag *added* something.
		// Putting the parts back while leaving the wire would draw a connection
		// between two pins now sitting on top of each other.
		touching();
		app.selection = [find('R2').id];
		app.beginMove();
		app.applyMove(120, 0, routeFor(new Set(app.selection)));
		app.cancelMove();

		expect(app.schematic.wires).toEqual([]);
		expect(find('R2').x).toBe(160);
	});

	it('takes one undo, like any other drag', () => {
		touching();
		app.selection = [find('R2').id];
		app.beginMove();
		app.applyMove(120, 0, routeFor(new Set(app.selection)));
		app.endMove();

		app.undo();
		expect(app.schematic.wires).toEqual([]);
		expect(find('R2').x).toBe(160);
	});
});

describe('importing a subcircuit', () => {
	const OPAMP = '.SUBCKT OPAMP1 1 2 3\nRIN 1 2 2MEG\nE1 4 0 1 2 100K\nROUT 4 3 75\n.ENDS';

	it('adds a part that can be placed like any other', () => {
		const { added, error } = app.importSubcircuits(OPAMP);
		expect(error).toBeUndefined();
		expect(added).toEqual(['OPAMP1']);

		app.place('x:opamp1', 300, 200, 0);
		const placed = app.schematic.instances[0];
		expect(placed.kind).toBe('x:opamp1');
		// Named from the `X` prefix a subcircuit call has always used.
		expect(placed.name).toBe('X1');
	});

	it('refuses text with no definition in it, and says so', () => {
		const { added, error } = app.importSubcircuits('.model 2N3904 NPN(BF=200)');
		expect(added).toEqual([]);
		expect(error).toBeTruthy();
		expect(app.schematic.subcircuits ?? []).toEqual([]);
	});

	it('replaces a definition rather than adding a second part with the same name', () => {
		// So a corrected file can be pasted over the one it corrects, and the parts
		// already placed pick up the change instead of being orphaned beside a
		// second entry with an identical label.
		app.importSubcircuits(OPAMP);
		app.place('x:opamp1', 300, 200, 0);
		app.importSubcircuits('.SUBCKT OPAMP1 1 2 3\nRIN 1 2 1MEG\nE1 4 0 1 2 50K\nROUT 4 3 50\n.ENDS');

		expect(app.schematic.subcircuits?.length).toBe(1);
		expect(app.schematic.instances.length).toBe(1);
		expect(app.schematic.subcircuits?.[0].source).toContain('1MEG');
	});

	it('refuses a definition that names a terminal twice', () => {
		// Both pins would answer with whichever net was wired last, so the circuit
		// would be quietly wrong rather than refused — the worst outcome available.
		const { added, error } = app.importSubcircuits('.SUBCKT TWICE 1 1 2\nR1 1 2 1k\n.ENDS');
		expect(added).toEqual([]);
		expect(error).toContain('twice');
		expect(app.schematic.subcircuits ?? []).toEqual([]);
	});

	it('keeps imported parts when the drawing is cleared', () => {
		// They are a library, not part of the circuit. Having to paste the op-amp
		// again because you started a new sketch would make importing one not worth
		// the trouble.
		app.importSubcircuits(OPAMP);
		app.place('x:opamp1', 300, 200, 0);
		app.clear();
		expect(app.schematic.instances).toEqual([]);
		expect(app.schematic.subcircuits?.length).toBe(1);
	});

	it('takes anything placed from it away with it', () => {
		// Leaving instances of a definition that no longer exists would be a
		// drawing that cannot be compiled and cannot be repaired from the canvas.
		app.importSubcircuits(OPAMP);
		app.place('x:opamp1', 300, 200, 0);
		app.place('resistor', 500, 200, 0);
		app.removeSubcircuit('opamp1');

		expect(app.schematic.subcircuits).toEqual([]);
		expect(app.schematic.instances.map((i) => i.kind)).toEqual(['resistor']);
	});
});

describe('a diode is one device, not a menu of two', () => {
	it('fills its fields in when a preset is chosen', () => {
		// A preset is where a part starts. Before this the choice *was* the part:
		// two names, hard-coded, and anything else on the market was unreachable.
		app.place('diode', 200, 200, 0);
		const id = app.schematic.instances[0].id;
		app.setParam(id, 'model', 'schottky');

		const params = app.schematic.instances[0].params;
		expect(params.model).toBe('schottky');
		// A metal-semiconductor junction has no stored charge to sweep out, which
		// is most of the reason to reach for one.
		expect(params.tt).toBe(0);
		expect(Number(params.is)).toBeGreaterThan(1e-6);
	});

	it('keeps a value edited after the preset', () => {
		app.place('diode', 200, 200, 0);
		const id = app.schematic.instances[0].id;
		app.setParam(id, 'model', 'rectifier');
		app.setParam(id, 'rs', 0.2);
		expect(app.schematic.instances[0].params.rs).toBe(0.2);
		// And re-picking the same preset is not a change, so it does not silently
		// undo the edit either.
		app.setParam(id, 'model', 'rectifier');
		expect(app.schematic.instances[0].params.rs).toBe(0.2);
	});

	it('takes one undo to put a preset back', () => {
		app.place('diode', 200, 200, 0);
		const id = app.schematic.instances[0].id;
		const before = { ...app.schematic.instances[0].params };
		app.setParam(id, 'model', 'germanium');
		app.undo();
		expect(app.schematic.instances[0].params).toEqual(before);
	});
});

describe('a probe put where you want to measure', () => {
	function rc() {
		app.place('vsource', 100, 200, 0); // plus 100,170
		app.place('resistor', 220, 170, 0); // a 190,170  b 250,170
		app.place('ground', 100, 300, 0);
		app.addWirePath([
			{ x: 100, y: 170 },
			{ x: 190, y: 170 }
		]);
		app.addWirePath([
			{ x: 100, y: 230 },
			{ x: 100, y: 290 }
		]);
	}

	it('measures as soon as it is placed', () => {
		// Putting one there is the request. Having to place it and then also ask
		// for it would be two steps for one intention.
		rc();
		app.place('probe', 150, 170, 0);
		expect(app.activeProbes.map((p) => p.label)).toContain('P1');
	});

	it('goes by the name you give it', () => {
		rc();
		app.place('probe', 150, 170, 0);
		const id = app.schematic.instances.find((i) => i.kind === 'probe')!.id;
		app.setParam(id, 'label', 'drive');
		expect(app.activeProbes.map((p) => p.label)).toContain('drive');
	});

	it('carries no current and changes nothing', () => {
		// It is a name attached to a point. The engine must never hear about it, or
		// the act of measuring would alter what is measured.
		rc();
		const before = JSON.stringify(app.compiled.netlist);
		app.place('probe', 150, 170, 0);
		expect(JSON.stringify(app.compiled.netlist)).toBe(before);
	});

	it('takes the place of a guess about what to plot', () => {
		// With probes on the drawing, the scope shows those and not a handful of
		// nets picked for you.
		rc();
		app.place('probe', 150, 170, 0);
		app.run;
		expect(app.activeProbes.length).toBe(1);
		expect(app.activeProbes[0].label).toBe('P1');
	});
});

describe('clicking a part while it is running', () => {
	beforeEach(() => {
		app.place('toggle', 200, 200, 0);
		app.stopTime = 5e-3;
		app.playbackTime = 0;
		app.live = false;
	});

	const toggle = () => app.schematic.instances.find((i) => i.kind === 'toggle')!;

	it('sets where it starts when nothing is running', () => {
		app.toggleSwitch(toggle().id);
		expect(toggle().params.state).toBe('high');
		expect(app.operationsOf(toggle().id)).toEqual([]);
	});

	it('operates the live circuit instead of editing the drawing', () => {
		// The click has to reach the engine rather than the schematic. Written into
		// the drawing it would be a different circuit, which restarts the sweep —
		// and the moment somebody clicked would take the run back to zero instead of
		// putting an edge in it.
		const moved: Array<[string, string]> = [];
		app.acquiring = {
			time: 2e-3,
			sweeping: true,
			setLogic: (name: string, state: string) => {
				moved.push([name, state]);
				return true;
			},
			setWaveform: () => true
		} as never;

		app.toggleSwitch(toggle().id);
		expect(toggle().params.state).toBe('low');
		expect(moved).toEqual([['T1', 'high']]);
		expect(app.operationsOf(toggle().id)).toEqual([2e-3]);

		// A second click is a second operation, and puts it back.
		app.toggleSwitch(toggle().id);
		expect(moved.at(-1)).toEqual(['T1', 'low']);
		expect(app.operationsOf(toggle().id)).toEqual([2e-3, 2e-3]);

		app.acquiring = null;
	});

	it('hands a switch its whole contact waveform, anchored at the click', () => {
		app.place('switch', 400, 200, 0);
		const s1 = app.schematic.instances.find((i) => i.kind === 'switch')!;
		const sent: Array<{ source: string; points: Array<[number, number]> }> = [];
		app.acquiring = {
			time: 2e-3,
			sweeping: true,
			setLogic: () => true,
			setWaveform: (source: string, waveform: { points: Array<[number, number]> }) => {
				sent.push({ source, points: waveform.points });
				return true;
			}
		} as never;

		app.toggleSwitch(s1.id);
		expect(sent[0].source).toBe('S1__actuator');
		// It starts open, and closes — with its bounce — from the instant of the click.
		expect(sent[0].points[0]).toEqual([0, 0]);
		expect(sent[0].points.some(([t]) => t >= 2e-3)).toBe(true);
		expect(s1.params.start).toBe('open');

		app.acquiring = null;
	});
});

describe('replacing the whole drawing', () => {
	/** A stand-in for a live run. Only whether it is closed matters here. */
	function pretendRunning(): { closed: () => boolean } {
		let closed = false;
		app.acquiring = { close: () => (closed = true) } as never;
		app.playing = true;
		app.playbackTime = 1e-3;
		return { closed: () => closed };
	}

	it('clearing stops the sweep, like every other way of replacing it', () => {
		app.place('resistor', 200, 200, 0);
		const run = pretendRunning();

		app.clear();

		// Clearing used to drop `result` and leave the sweep going: the engine's
		// simulation was never freed, the transport still said it was playing, and
		// the next frame put the samples back on an empty sheet.
		expect(run.closed()).toBe(true);
		expect(app.acquiring).toBeNull();
		expect(app.capture).toBeNull();
		expect(app.result).toBeNull();
		expect(app.playing).toBe(false);
		expect(app.playbackTime).toBe(0);
	});

	it('keeps the probes a saved file was carrying', () => {
		app.place('resistor', 200, 200, 0);
		app.addWire(230, 200, 300, 200);
		app.toggleProbe('230,200');
		expect(app.activeProbes.map((p) => p.label)).toHaveLength(1);

		const saved = app.toJSON();
		const before = app.schematic.instances[0].id;
		app.fromJSON(saved);

		// Every load mints fresh ids, so the handle in the file names a part that
		// no longer exists. Untranslated it resolved to nothing and the probe
		// disappeared without a word — the signals somebody had chosen to watch
		// were the one part of their work that did not survive being saved.
		expect(app.schematic.instances[0].id).not.toBe(before);
		expect(app.activeProbes).toHaveLength(1);
		expect(app.probes[0]).toBe(`pin:${app.schematic.instances[0].id}:b`);
	});

	it('drops a probe whose part the file does not have', () => {
		app.place('resistor', 200, 200, 0);
		const saved = JSON.parse(app.toJSON());
		saved.probes = ['pin:nothing-like-this:b'];
		app.fromJSON(JSON.stringify(saved));
		expect(app.probes).toEqual([]);
	});

	it('opening a file stops it too', () => {
		app.place('resistor', 200, 200, 0);
		const saved = app.toJSON();
		const run = pretendRunning();

		app.fromJSON(saved);

		expect(run.closed()).toBe(true);
		expect(app.acquiring).toBeNull();
		expect(app.playing).toBe(false);
	});
});
