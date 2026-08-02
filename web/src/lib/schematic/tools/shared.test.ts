/**
 * What counts as something for a wire end to hold on to.
 *
 * This is the decision behind refusing a wire that would be left hanging in
 * space. In a simulator a free end conducts nothing, so drawing one is never
 * what was meant — but the rule has to be generous about what "connected" means,
 * or it turns into an obstacle instead of a guard.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '$lib/state.svelte';
import { connectsAt } from './shared';

beforeEach(() => {
	app.clear();
	app.selection = [];
});

describe('connectsAt', () => {
	it('finds a pin', () => {
		app.place('resistor', 200, 200, 0); // pins (170,200) and (230,200)
		expect(connectsAt({ x: 170, y: 200 })).toBe(true);
		expect(connectsAt({ x: 230, y: 200 })).toBe(true);
	});

	it('finds a pin on a rotated part', () => {
		app.place('resistor', 200, 200, 90); // pins (200,170) and (200,230)
		expect(connectsAt({ x: 200, y: 170 })).toBe(true);
		expect(connectsAt({ x: 170, y: 200 })).toBe(false);
	});

	it('finds the end of a wire', () => {
		app.addWirePath([
			{ x: 100, y: 100 },
			{ x: 300, y: 100 }
		]);
		expect(connectsAt({ x: 100, y: 100 })).toBe(true);
		expect(connectsAt({ x: 300, y: 100 })).toBe(true);
	});

	it('finds a point partway along a wire, which is a junction', () => {
		app.addWirePath([
			{ x: 100, y: 100 },
			{ x: 300, y: 100 },
			{ x: 300, y: 250 }
		]);
		expect(connectsAt({ x: 210, y: 100 })).toBe(true);
		expect(connectsAt({ x: 300, y: 180 })).toBe(true);
	});

	it('says no to empty space', () => {
		app.place('resistor', 200, 200, 0);
		app.addWirePath([
			{ x: 100, y: 100 },
			{ x: 300, y: 100 }
		]);
		expect(connectsAt({ x: 500, y: 500 })).toBe(false);
		// Level with the wire but past its end.
		expect(connectsAt({ x: 400, y: 100 })).toBe(false);
		// Alongside it, one step off.
		expect(connectsAt({ x: 200, y: 110 })).toBe(false);
	});

	it('says no to the body of a component', () => {
		// A symbol is not a terminal. Landing on the middle of a capacitor connects
		// to nothing, however much it looks like part of the circuit.
		app.place('capacitor', 300, 230, 90); // pins (300,200) and (300,260)
		expect(connectsAt({ x: 300, y: 230 })).toBe(false);
		expect(connectsAt({ x: 300, y: 200 })).toBe(true);
	});

	it('says no on an empty schematic', () => {
		expect(connectsAt({ x: 0, y: 0 })).toBe(false);
	});
});
