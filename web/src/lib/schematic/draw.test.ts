/**
 * Where a symbol's labels sit.
 *
 * The reach is measured off what each part actually draws rather than one number
 * for the whole catalog. A single default has to suit the tallest symbol, which
 * left a resistor's name floating twenty units above a body that stops at nine —
 * the label ends up reading as belonging to nothing in particular.
 */

import { describe, expect, it } from 'vitest';
import { drawnReach } from './draw';
import { CATALOG, definitionOf } from './model';

describe('drawnReach', () => {
	it('measures a flat part by its body, not by its leads', () => {
		// A resistor's leads run sideways, so nothing is drawn above the rectangle.
		expect(drawnReach(definitionOf('resistor'), 0)).toEqual({ x: 30, y: 9 });
	});

	it('swaps the axes when the part is turned', () => {
		expect(drawnReach(definitionOf('resistor'), 90)).toEqual({ x: 9, y: 30 });
		expect(drawnReach(definitionOf('resistor'), 270)).toEqual({ x: 9, y: 30 });
		// Half a turn is the same shape as none.
		expect(drawnReach(definitionOf('resistor'), 180)).toEqual({ x: 30, y: 9 });
	});

	it('includes the leads when they are the tall part', () => {
		// A source's terminals run vertically, so the drawn height really is 30 —
		// while the circle itself is only 17 across, which is why one number for
		// both axes was never going to place labels well.
		expect(drawnReach(definitionOf('vsource'), 0)).toEqual({ x: 17, y: 30 });
		expect(drawnReach(definitionOf('vsource'), 90)).toEqual({ x: 30, y: 17 });
	});

	it('never reports less than the pins it has to clear', () => {
		// A label inside its own symbol is the failure this guards against, and it
		// is the one I introduced while fixing the gap.
		for (const def of CATALOG) {
			for (const rotation of [0, 90, 180, 270] as const) {
				const reach = drawnReach(def, rotation);
				expect(reach.x).toBeGreaterThan(0);
				expect(reach.y).toBeGreaterThan(0);
			}
		}
	});
});
