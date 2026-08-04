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
import {
	defaultParams,
	definitionOf,
	registerSubcircuits,
	SUBCIRCUIT_PREFIX,
	type Instance,
	type Rotation,
	type Schematic
} from './model';

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

describe('a pasted SPICE model', () => {
	const Q2N3904 = `.MODEL 2N3904 NPN(IS=6.734f XTI=3 EG=1.11 VAF=74.03 BF=416.4 NE=1.259
+ ISE=6.734f IKF=66.78m XTB=1.5 BR=.7371 NC=2 RC=1 CJC=3.638p MJC=.3085
+ VJC=.75 FC=.5 CJE=4.493p MJE=.2593 VJE=.75 TR=239.5n TF=301.2p RB=10)`;

	/** An NPN wired up enough to compile, with whatever card is handed in. */
	function transistor(spice: string, fields: Record<string, number> = {}) {
		const q = at('npn', 'Q1', 200, 200);
		Object.assign(q.params, fields);
		q.params.spice = spice;
		const schematic = drawing(
			[at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 320), q],
			[
				[100, 170, 170, 170],
				[170, 170, 170, 200],
				[100, 230, 100, 320],
				[100, 300, 210, 300],
				[210, 230, 210, 300],
				[210, 170, 210, 170]
			]
		);
		const result = compileSchematic(schematic);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> } | null;
		const bjt = netlist?.components.find((c) => c.name === 'Q1');
		return { model: bjt?.model as Record<string, number> | undefined, warnings: result.warnings };
	}

	it('is what the part is simulated as', () => {
		// The whole point of step two: a part becomes a paste from the manufacturer
		// rather than a row of numbers someone transcribed by hand.
		const { model } = transistor(Q2N3904);
		expect(model?.bf).toBeCloseTo(416.4, 6);
		expect(model?.vaf).toBeCloseTo(74.03, 6);
		expect(model?.is).toBeCloseTo(6.734e-15, 25);
		// Including the ones no field on the part exposes.
		expect(model?.br).toBeCloseTo(0.7371, 8);
		expect(model?.mje).toBeCloseTo(0.2593, 8);
		expect(model?.tr).toBeCloseTo(239.5e-9, 20);
	});

	it('outranks the fields it overlaps with', () => {
		// A card is an explicit statement that *this* is the part. A field quietly
		// winning would leave someone looking at a 2N3904 behaving like the generic
		// transistor it was meant to replace.
		const { model } = transistor(Q2N3904, { bf: 12 });
		expect(model?.bf).toBeCloseTo(416.4, 6);
	});

	it('names what it could not use', () => {
		// A 2N3904 without its high-level injection keeps its gain at currents where
		// the real part has lost most of it. Dropping that in silence is the
		// difference between a simplification and a lie.
		const { warnings } = transistor(Q2N3904);
		const note = warnings.find((w) => w.includes('2N3904'));
		expect(note).toBeTruthy();
		expect(note).toContain('IKF');
		expect(note).toContain('RB');
		// Parameters this engine matches anyway are not worth crowding it with.
		expect(note).not.toContain('FC');
	});

	it('leaves the part alone when there is no card', () => {
		const { model, warnings } = transistor('');
		expect(model?.bf).toBe(200);
		expect(warnings.some((w) => w.includes('does not model'))).toBe(false);
	});

	it('ignores a card meant for something else', () => {
		// Pasting a diode onto a transistor should not half-apply: `IS` means
		// different things in the two models, and taking the parameters that happen
		// to share a name would build a part that is neither.
		const { model } = transistor('.model 1N4148 D(IS=2.52n N=1.752 BV=100)');
		expect(model?.is).toBe(6.73e-15);
		expect(model?.bf).toBe(200);
	});
});

describe('an imported subcircuit', () => {
	// A one-pole op-amp macromodel of the shape a vendor ships. Ports are 1 =
	// non-inverting, 2 = inverting, 3 = output.
	const OPAMP = `.SUBCKT OPAMP1 1 2 3
RIN 1 2 2MEG
E1 4 0 1 2 100K
R1 4 5 1K
C1 5 0 15.9u
E2 6 0 5 0 1
ROUT 6 3 75
.ENDS`;

	function withOpamp(instances: (kind: string) => Instance[], runs: Array<[number, number, number, number]>) {
		const sub = {
			id: 'opamp1',
			name: 'OPAMP1',
			ports: ['1', '2', '3'],
			source: OPAMP
		};
		registerSubcircuits({ instances: [], wires: [], subcircuits: [sub] });
		const schematic = drawing(instances(SUBCIRCUIT_PREFIX + sub.id), runs);
		schematic.subcircuits = [sub];
		return compileSchematic(schematic);
	}

	it('becomes a part whose pins are its ports', () => {
		registerSubcircuits({
			instances: [],
			wires: [],
			subcircuits: [{ id: 'opamp1', name: 'OPAMP1', ports: ['1', '2', '3'], source: OPAMP }]
		});
		const def = definitionOf(SUBCIRCUIT_PREFIX + 'opamp1');
		expect(def.pins.map((p) => p.name)).toEqual(['1', '2', '3']);
		expect(def.label).toBe('OPAMP1');
		// Split across the two sides of the box, and every pin on the grid so a
		// wire can actually reach it.
		expect(def.pins.filter((p) => p.x < 0).length).toBe(2);
		expect(def.pins.every((p) => p.x % 10 === 0 && p.y % 10 === 0)).toBe(true);
	});

	it('is flattened into the circuit it stands for', () => {
		const result = withOpamp(
			(kind) => [at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 320), { ...at(kind, 'X1', 300, 200) }],
			[[100, 170, 260, 170], [100, 230, 100, 320], [100, 300, 260, 300]]
		);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> } | null;
		const names = netlist!.components.map((c) => c.name);
		// Every element of the definition, under the name of the part that holds it.
		expect(names).toContain('X1.RIN');
		expect(names).toContain('X1.E1');
		expect(names).toContain('X1.C1');
		expect(names).toContain('X1.ROUT');
		// And nothing called X1 on its own: the engine never sees the block.
		expect(names).not.toContain('X1');
	});

	it('binds its ports to the nets it was wired to, and keeps its insides to itself', () => {
		const result = withOpamp(
			(kind) => [at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 320), at(kind, 'X1', 300, 200)],
			[[100, 170, 260, 170], [100, 230, 100, 320], [100, 300, 260, 300]]
		);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> };
		const rin = netlist.components.find((c) => c.name === 'X1.RIN')!;
		// Whatever the source's net was called, both are real nets and not the
		// port numbers the file used.
		expect(rin.a).not.toBe('1');
		expect(rin.b).not.toBe('2');
		// An internal node is namespaced, so a second copy is a second circuit.
		const r1 = netlist.components.find((c) => c.name === 'X1.R1')!;
		expect(r1.a).toBe('X1.4');
		// `0` inside a definition is the one global ground.
		const c1 = netlist.components.find((c) => c.name === 'X1.C1')!;
		expect(c1.b).toBe('gnd');
	});

	it('says which lines of a definition it could not build', () => {
		const sub = {
			id: 'odd',
			name: 'ODD',
			ports: ['1', '2'],
			source: '.SUBCKT ODD 1 2\nR1 1 2 1k\nF1 1 2 VS 10\n.ENDS'
		};
		registerSubcircuits({ instances: [], wires: [], subcircuits: [sub] });
		const schematic = drawing(
			[at('ground', 'GND1', 100, 320), at(SUBCIRCUIT_PREFIX + sub.id, 'X1', 300, 200)],
			[]
		);
		schematic.subcircuits = [sub];
		const note = compileSchematic(schematic).warnings.find((w) => w.includes('ODD'));
		expect(note).toContain('F1');
	});
});
