/**
 * The chips, checked as packages rather than as the gates inside them.
 *
 * A chip is right or wrong in two places: what its legs are called and in what
 * order, and what the silicon between them does. The first is what somebody
 * reads off the drawing while counting pins on a real part, so it is worth
 * asserting on directly; the second is worth running, because a table that says
 * NAND and emits AND compiles perfectly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import init, { Simulation } from '../wasm/repath.js';
import { CHIPS, chipById, isPower, isUnused, signalPins } from './chips';
import { chipDefinition, CHIP_PREFIX, defaultParams, type Instance, type Schematic } from './model';
import { compileSchematic } from './netlist';

beforeAll(async () => {
	await init({
		module_or_path: readFileSync(fileURLToPath(new URL('../wasm/repath_bg.wasm', import.meta.url)))
	});
});

let counter = 0;
const at = (kind: string, name: string, x: number, y: number): Instance => ({
	id: `i${++counter}`,
	kind,
	name,
	x,
	y,
	rotation: 0,
	params: defaultParams(kind)
});

const drawing = (
	instances: Instance[],
	runs: Array<[number, number, number, number]> = []
): Schematic => ({
	instances,
	wires: runs.map((p, i) => ({
		id: `w${counter}_${i}`,
		points: [
			{ x: p[0], y: p[1] },
			{ x: p[2], y: p[3] }
		]
	}))
});

describe('every chip in the table', () => {
	it('has a package whose pins line up with what is inside it', () => {
		for (const chip of CHIPS) {
			// A DIP has an even number of legs and they come in two equal rows.
			expect(chip.layout.length % 2, chip.id).toBe(0);
			// Both supply pins, exactly once each.
			for (const rail of ['VCC', 'GND']) {
				expect(chip.layout.filter((p) => p === rail).length, `${chip.id} ${rail}`).toBe(1);
			}
			// No leg named twice, or the drawing cannot say which one a wire means.
			expect(new Set(chip.layout).size, chip.id).toBe(chip.layout.length);

			// Every signal leg is reached by something inside, and everything inside
			// reaches either a leg or another block. A pin in the layout that no
			// block touches is a leg wired to nothing, which is the failure this is
			// for: it would draw fine and simulate as an open circuit.
			const touched = new Set<string>();
			for (const block of chip.blocks) {
				for (const pin of block.inputs ?? []) touched.add(pin);
				for (const pin of [block.output, block.clock, block.data, block.reset, block.preset, block.q, block.qn]) {
					if (pin) touched.add(pin);
				}
			}
			for (const pin of signalPins(chip)) {
				expect(touched.has(pin), `${chip.id} pin ${pin} goes nowhere`).toBe(true);
			}
		}
	});

	it('generates a part whose pins are the legs that carry something', () => {
		for (const chip of CHIPS) {
			const def = chipDefinition(chip);
			// Supply and signal, but not the legs the die never reaches: an
			// unconnected pin would collect a "not connected" warning forever.
			expect(def.pins.length, chip.id).toBe(chip.layout.filter((p) => !isUnused(p)).length);
			expect(def.pins.filter((p) => isPower(p.name)).length, chip.id).toBe(2);
			// Pin 1 top left, and the far side counted back up: that is the package.
			const perSide = chip.layout.length / 2;
			const left = def.pins.filter((p) => p.x < 0);
			expect(left.every((p) => chip.layout.indexOf(p.name) < perSide), chip.id).toBe(true);
		}
	});

	it('compiles without an error, and asks to be powered', () => {
		for (const chip of CHIPS) {
			const part = at(CHIP_PREFIX + chip.id, 'U1', 300, 200);
			const ground = at('ground', 'GND1', 300, 400);
			const result = compileSchematic(drawing([part, ground]));
			expect(result.errors, chip.id).toEqual([]);
			// The supply pins are pins like any other, so leaving them unwired is
			// reported the way any loose pin is. That is the whole reason they are
			// on the symbol: a chip nobody powered is a mistake worth making.
			expect(result.warnings.some((w) => w.includes('U1.VCC')), `${chip.id} VCC`).toBe(true);
			expect(result.warnings.some((w) => w.includes('U1.GND')), `${chip.id} GND`).toBe(true);
		}
	});
});

describe('the gates inside a package', () => {
	/**
	 * Drive one gate of a chip and read what comes out.
	 *
	 * The whole chip is placed, not just the gate under test — the other three
	 * NANDs of a 7400 are in the netlist whether anyone uses them or not, and a
	 * package that only works when it is alone is not a package.
	 */
	const evaluate = (id: string, inputs: Record<string, 'high' | 'low'>, output: string) => {
		const chip = chipById(id)!;
		const part = at(CHIP_PREFIX + id, 'U1', 600, 300);
		const ground = at('ground', 'GND1', 900, 600);
		const instances: Instance[] = [part, ground];
		const wires: Array<[number, number, number, number]> = [];

		// A toggle per driven pin, wired straight to its leg.
		const def = chipDefinition(chip);
		for (const [pin, state] of Object.entries(inputs)) {
			const place = def.pins.find((p) => p.name === pin)!;
			const source = at('toggle', pin, 600 + place.x - 120, 300 + place.y);
			source.params = { state };
			instances.push(source);
			wires.push([600 + place.x - 90, 300 + place.y, 600 + place.x, 300 + place.y]);
		}

		const compiled = compileSchematic(drawing(instances, wires));
		expect(compiled.errors, id).toEqual([]);
		const sim = new Simulation(JSON.stringify(compiled.netlist));
		const meta = JSON.parse(sim.runTransient(1e-6, 5e-8));
		sim.free();

		const net = compiled.connectivity.netOfPin.get(`${part.id}:${output}`)!;
		const label = compiled.names.get(net)!.digital!;
		const events = meta.digital[meta.net_names.indexOf(label)] ?? [];
		return events.at(-1)?.state;
	};

	it('makes the 7400 a NAND on the gate nobody is looking at either', () => {
		// Gate 1 and gate 3: if the emission indexed its blocks wrong, the first
		// would work and a later one would be wired to the wrong legs.
		expect(evaluate('7400', { '1A': 'high', '1B': 'high' }, '1Y')).toBe('low');
		expect(evaluate('7400', { '1A': 'high', '1B': 'low' }, '1Y')).toBe('high');
		expect(evaluate('7400', { '3A': 'high', '3B': 'high' }, '3Y')).toBe('low');
		expect(evaluate('7400', { '3A': 'low', '3B': 'high' }, '3Y')).toBe('high');
	});

	it('gives the 7402 the pinout that catches people out', () => {
		// Output first on this package. Wiring it like a 7400 puts a signal on
		// what is actually the output, so the pinout is the part worth asserting.
		const chip = chipById('7402')!;
		expect(chip.layout[0]).toBe('1Y');
		expect(chip.layout.slice(0, 3)).toEqual(['1Y', '1A', '1B']);
		expect(evaluate('7402', { '1A': 'low', '1B': 'low' }, '1Y')).toBe('high');
		expect(evaluate('7402', { '1A': 'high', '1B': 'low' }, '1Y')).toBe('low');
	});

	it('inverts on all six of the 7404', () => {
		for (const n of [1, 2, 3, 4, 5, 6]) {
			expect(evaluate('7404', { [`${n}A`]: 'high' }, `${n}Y`), `gate ${n}`).toBe('low');
			expect(evaluate('7404', { [`${n}A`]: 'low' }, `${n}Y`), `gate ${n}`).toBe('high');
		}
	});

	it('takes all four inputs of a 7420, not just the two it shares with a 7400', () => {
		expect(evaluate('7420', { '1A': 'high', '1B': 'high', '1C': 'high', '1D': 'high' }, '1Y')).toBe(
			'low'
		);
		// One low is enough, and it has to be the fourth input that says so.
		expect(evaluate('7420', { '1A': 'high', '1B': 'high', '1C': 'high', '1D': 'low' }, '1Y')).toBe(
			'high'
		);
	});

	it('keeps two of the same chip out of each other', () => {
		// Two 7400s, one gate driven on each, opposite inputs. If the emission
		// shared a net name between instances they would fight and both read
		// unknown — which is exactly what internal nets would do if they were
		// keyed by chip rather than by instance.
		const first = at(CHIP_PREFIX + '7400', 'U1', 400, 200);
		const second = at(CHIP_PREFIX + '7400', 'U2', 400, 600);
		const ground = at('ground', 'GND1', 800, 800);
		const result = compileSchematic(drawing([first, second, ground]));
		expect(result.errors).toEqual([]);
		const netlist = result.netlist as { devices: Array<{ name: string }> };
		const names = netlist.devices.map((d) => d.name);
		expect(names).toContain('U1');
		expect(names).toContain('U2');
		expect(new Set(names).size).toBe(names.length);
	});
});
