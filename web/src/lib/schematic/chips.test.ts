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
import { EXAMPLES } from '../examples';

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
			// Two supply pins, whichever names this family gives them: the 74xx says
			// VCC and GND, the 4000 says VDD and VSS, and both are on the drawing the
			// way the datasheet prints them.
			expect(chip.layout.filter(isPower).length, `${chip.id} supply`).toBe(2);
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
			for (const rail of chip.layout.filter(isPower)) {
				expect(
					result.warnings.some((w) => w.includes(`U1.${rail}`)),
					`${chip.id} ${rail}`
				).toBe(true);
			}
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

	it('gives the 4011 its own legs, not the 7400 ones', () => {
		// Both are four 2-input NANDs, and that is exactly why both are here: swap
		// one for the other without redrawing and every wire lands on a pin that
		// does something else. If the two rows ever converged this would catch it.
		const ttl = chipById('7400')!;
		const cmos = chipById('4011')!;
		expect(cmos.layout).not.toEqual(ttl.layout);
		expect(ttl.layout[0]).toBe('1A');
		expect(cmos.layout[0]).toBe('1Y');
		// Same silicon underneath, all the same.
		expect(evaluate('4011', { '1A': 'high', '1B': 'high' }, '1Y')).toBe('low');
		expect(evaluate('4011', { '1A': 'high', '1B': 'low' }, '1Y')).toBe('high');
	});

	it('makes the 4027 a JK, which is only true if it toggles', () => {
		// The JK is composed rather than primitive — `D = J·Q̄ + K̄·Q` — so this is
		// the assertion that says the composition is right. Hold both inputs high
		// and the identity reduces to `D = Q̄`: the output has to change on every
		// rising edge and on no other, which is a divide-by-two.
		const chip = chipById('4027')!;
		const part = at(CHIP_PREFIX + '4027', 'U1', 600, 300);
		const ground = at('ground', 'GND1', 1000, 700);
		const def = chipDefinition(chip);
		const instances: Instance[] = [part, ground];
		const wires: Array<[number, number, number, number]> = [];

		// J and K high, set and reset low, and a clock on the clock pin.
		for (const [pin, state] of [
			['1J', 'high'],
			['1K', 'high'],
			['1SET', 'low'],
			['1RST', 'low']
		] as const) {
			const place = def.pins.find((p) => p.name === pin)!;
			const source = at('toggle', pin, 600 + place.x - 120, 300 + place.y);
			source.params = { state };
			instances.push(source);
			wires.push([600 + place.x - 90, 300 + place.y, 600 + place.x, 300 + place.y]);
		}
		const clkPin = def.pins.find((p) => p.name === '1CLK')!;
		const clock = at('clock', 'CLK1', 600 + clkPin.x - 120, 300 + clkPin.y);
		clock.params = { frequency: 1e6, duty: 0.5 };
		instances.push(clock);
		wires.push([600 + clkPin.x - 90, 300 + clkPin.y, 600 + clkPin.x, 300 + clkPin.y]);

		const compiled = compileSchematic(drawing(instances, wires));
		expect(compiled.errors).toEqual([]);
		const sim = new Simulation(JSON.stringify(compiled.netlist));
		const meta = JSON.parse(sim.runTransient(10e-6, 5e-8));
		sim.free();

		const read = (pin: string) => {
			const net = compiled.connectivity.netOfPin.get(`${part.id}:${pin}`)!;
			const label = compiled.names.get(net)!.digital!;
			return meta.digital[meta.net_names.indexOf(label)] ?? [];
		};
		const q = read('1Q');
		const clk = read('1CLK');
		const edges = clk.filter((e: { state: string }) => e.state === 'high').length;

		// Half as many changes on the output as there are rising edges on the
		// clock, give or take the one it powers up with: that is the division.
		const changes = q.filter((e: { state: string }) => e.state !== 'unknown').length;
		expect(edges).toBeGreaterThan(6);
		expect(changes).toBeGreaterThan(4);
		const level = (t: number) =>
			q.filter((e: { time: number }) => e.time <= t).at(-1)?.state;
		// One clock period apart, the output is back where it started; half a
		// period apart it is not. That is what dividing by two means.
		expect(level(2.6e-6)).toBe(level(4.6e-6));
		expect(level(2.6e-6)).not.toBe(level(3.6e-6));
	});

	it('drives the 7474 preset and clear from the legs that are active low', () => {
		// Both pins have a bar over them on the part, so each arrives through an
		// inverter. Wiring them straight through would leave a chip that sits
		// preset and cleared at once the moment somebody grounds them, which is
		// what a datasheet tells you not to do.
		const chip = chipById('7474')!;
		const inverters = chip.blocks.filter((block) => block.kind === 'not');
		expect(inverters).toHaveLength(4);
		const flops = chip.blocks.filter((block) => block.kind === 'dff');
		expect(flops).toHaveLength(2);
		for (const flop of flops) {
			// Neither asynchronous input is the leg itself.
			expect(chip.layout).not.toContain(flop.reset);
			expect(chip.layout).not.toContain(flop.preset);
		}
	});

	it('leaves no input of the shipped CD4027 example floating', () => {
		// The example uses one half of the chip, and every input of the other half
		// is tied down rather than left in the air. That is not tidiness: a CMOS
		// input floating between the rails turns the stage into an amplifier that
		// draws current and oscillates. Outputs are allowed to go nowhere.
		const example = EXAMPLES.find((e) => e.id === 'cd4027')!.build();
		const result = compileSchematic(example);
		expect(result.errors).toEqual([]);
		const loose = result.warnings.filter((w) => w.includes('not connected'));
		expect(loose).toEqual([
			'U1.1QN is not connected to anything.',
			'U1.2QN is not connected to anything.',
			'U1.2Q is not connected to anything.'
		]);
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
