/**
 * What compiling a drawing notices about it before anything is simulated.
 *
 * These warnings exist for the failure mode where the simulation is correct and
 * the drawing is a lie. A part shorted by a wire drawn straight past it looks
 * exactly like a part properly in series — the symbol sits on the line with a
 * pin touching it at each end — and the answer that comes back is the right
 * answer to a circuit nobody meant to draw. Without a warning there is nothing
 * to notice: the component simply never does anything, however its values are
 * changed, and the reason is invisible.
 */

import { describe, expect, it } from 'vitest';
import { compileSchematic } from './netlist';
import { defaultParams, type Instance, type Rotation, type Schematic } from './model';

let counter = 0;

function at(kind: string, name: string, x: number, y: number, rotation: Rotation = 0): Instance {
	return { id: `i${++counter}`, kind, name, x, y, rotation, params: defaultParams(kind) };
}

function drawing(instances: Instance[], runs: Array<[number, number, number, number]>): Schematic {
	return {
		instances,
		wires: runs.map(([x1, y1, x2, y2]) => ({
			id: `w${++counter}`,
			points: [
				{ x: x1, y: y1 },
				{ x: x2, y: y2 }
			]
		}))
	};
}

const shortsIn = (schematic: Schematic) =>
	compileSchematic(schematic).warnings.filter((w) => w.includes('shorted out'));

describe('shorted components', () => {
	it('says so when a wire runs straight past a part instead of stopping at it', () => {
		// The reported case: the right-hand wire is drawn from the top rail all the
		// way down to the bottom one, and the LED is dropped on top of it. Both its
		// pins land on that one wire, so the current goes round it.
		const schematic = drawing(
			[
				at('vsource', 'V1', 100, 200),
				at('resistor', 'R1', 260, 170),
				at('led', 'D1', 400, 260, 90),
				at('ground', 'GND1', 100, 340)
			],
			[
				[100, 170, 230, 170],
				[290, 170, 400, 170],
				// Straight through where the LED sits, rather than ending on its pins.
				[400, 170, 400, 330],
				[100, 330, 400, 330],
				[100, 230, 100, 330]
			]
		);

		const shorts = shortsIn(schematic);
		expect(shorts).toHaveLength(1);
		expect(shorts[0]).toContain('D1');
	});

	it('stays quiet when the same part is wired in series properly', () => {
		// Identical drawing, except the wire stops at each pin and picks up again
		// on the far side. Nothing else about the circuit changes.
		const schematic = drawing(
			[
				at('vsource', 'V1', 100, 200),
				at('resistor', 'R1', 260, 170),
				at('led', 'D1', 400, 260, 90),
				at('ground', 'GND1', 100, 340)
			],
			[
				[100, 170, 230, 170],
				[290, 170, 400, 170],
				[400, 170, 400, 230],
				[400, 290, 400, 330],
				[100, 330, 400, 330],
				[100, 230, 100, 330]
			]
		);

		expect(shortsIn(schematic)).toEqual([]);
	});

	it('is about any part, not just the LED that prompted it', () => {
		// A loop of bare wire with the parts sitting on it. Everything lands on one
		// net, so the resistor does nothing — and the source is across a dead short,
		// which the solver would refuse. Saying both beforehand beats a singular
		// matrix and a message about a row number.
		const schematic = drawing(
			[
				at('vsource', 'V1', 100, 200),
				at('resistor', 'R1', 260, 170),
				at('ground', 'GND1', 100, 340)
			],
			[
				[100, 170, 400, 170],
				[100, 330, 400, 330],
				[400, 170, 400, 330],
				[100, 230, 100, 330]
			]
		);

		const shorts = shortsIn(schematic);
		expect(shorts.some((w) => w.includes('R1'))).toBe(true);
		expect(shorts.some((w) => w.includes('V1'))).toBe(true);
	});

	it('says nothing about a one-pin part, which cannot short itself', () => {
		const schematic = drawing(
			[at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 340)],
			[[100, 230, 100, 330]]
		);
		expect(shortsIn(schematic)).toEqual([]);
	});

	it('says nothing about a part that is simply not wired up', () => {
		// Every pin unconnected is a different complaint, and it already has one.
		// Reporting it as shorted as well would be two warnings for one mistake.
		const schematic = drawing([at('resistor', 'R1', 260, 170)], []);
		expect(shortsIn(schematic)).toEqual([]);
		expect(compileSchematic(schematic).warnings.some((w) => w.includes('not connected'))).toBe(true);
	});
});
