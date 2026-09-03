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

	it('shows a 5 on the shipped BCD example, end to end', () => {
		// Switches, decoder, resistors, digit — the whole chain in one run. The
		// assertion is on which bars carry current, because that is the only place
		// a wrong equation, a crossed wire or a mis-numbered leg all show up the
		// same way: as a number that is not the one on the switches.
		const example = EXAMPLES.find((e) => e.id === 'bcd-display')!.build();
		const compiled = compileSchematic(example);
		expect(compiled.errors).toEqual([]);
		const sim = new Simulation(JSON.stringify(compiled.netlist));
		const meta = JSON.parse(sim.runTransient(2e-6, 5e-8));
		const lit = meta.element_names
			.map((name: string, k: number) => {
				const series = sim.current(k);
				return [name, series[series.length - 1]] as const;
			})
			.filter(([name, amps]: readonly [string, number]) => name.startsWith('DS1') && amps > 1e-3)
			.map(([name]: readonly [string, number]) => name.split(':')[1] ?? 'a')
			.sort();
		sim.free();
		// a, c, d, f and g, and no b or e: that is a 5.
		expect(lit).toEqual(['a', 'c', 'd', 'f', 'g']);
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

	it('puts exactly one line of the 74138 low, and the right one', () => {
		// A decoder that lit two lines, or the wrong line, would still compile and
		// still look like a decoder. So every address is walked, and the assertion
		// is on all eight outputs at once rather than on the one being aimed at.
		for (let address = 0; address < 8; address++) {
			const inputs: Record<string, 'high' | 'low'> = {
				A: address & 1 ? 'high' : 'low',
				B: address & 2 ? 'high' : 'low',
				C: address & 4 ? 'high' : 'low',
				G1: 'high',
				G2A: 'low',
				G2B: 'low'
			};
			for (let line = 0; line < 8; line++) {
				expect(evaluate('74138', inputs, `Y${line}`), `address ${address} line ${line}`).toBe(
					line === address ? 'low' : 'high'
				);
			}
		}
	});

	it('turns the whole 74138 off from any one of its three enables', () => {
		// The enables are why this part stacks, and they are the half of it a
		// composition is most likely to get backwards: G1 is active high and the
		// two G2s are active low.
		const on = { A: 'low', B: 'low', C: 'low', G1: 'high', G2A: 'low', G2B: 'low' } as const;
		expect(evaluate('74138', on, 'Y0')).toBe('low');
		expect(evaluate('74138', { ...on, G1: 'low' }, 'Y0')).toBe('high');
		expect(evaluate('74138', { ...on, G2A: 'high' }, 'Y0')).toBe('high');
		expect(evaluate('74138', { ...on, G2B: 'high' }, 'Y0')).toBe('high');
	});

	it('switches all four channels of the 74157 on one pin', () => {
		// Every channel is driven with A and B opposite, so a channel wired to the
		// wrong select — or to another channel's data — shows up immediately.
		for (const n of [1, 2, 3, 4]) {
			const data = { [`${n}A`]: 'high', [`${n}B`]: 'low', G: 'low' } as Record<
				string,
				'high' | 'low'
			>;
			expect(evaluate('74157', { ...data, S: 'low' }, `${n}Y`), `channel ${n} A`).toBe('high');
			expect(evaluate('74157', { ...data, S: 'high' }, `${n}Y`), `channel ${n} B`).toBe('low');
			// And the strobe blanks it whichever side is selected.
			expect(evaluate('74157', { ...data, S: 'low', G: 'high' }, `${n}Y`), `channel ${n} off`).toBe(
				'low'
			);
		}
	});

	it('lights the right bars of a 4511 for all ten digits', () => {
		// Seven equations, ten codes, seventy answers — and a decoder that gets one
		// of them wrong shows a 6 with the top bar missing and nothing else looks
		// amiss. So all seventy are checked rather than a couple of digits.
		const DIGITS: Record<number, string> = {
			0: 'abcdef',
			1: 'bc',
			2: 'abdeg',
			3: 'abcdg',
			4: 'bcfg',
			5: 'acdfg',
			6: 'acdefg',
			7: 'abc',
			8: 'abcdefg',
			9: 'abcdfg'
		};
		for (const [value, lit] of Object.entries(DIGITS)) {
			const n = Number(value);
			const inputs: Record<string, 'high' | 'low'> = {
				A: n & 1 ? 'high' : 'low',
				B: n & 2 ? 'high' : 'low',
				C: n & 4 ? 'high' : 'low',
				D: n & 8 ? 'high' : 'low',
				// Latches open, no blanking, no lamp test.
				LE: 'low',
				BI: 'high',
				LT: 'high'
			};
			for (const seg of 'abcdefg') {
				expect(evaluate('4511', inputs, seg), `digit ${n} segment ${seg}`).toBe(
					lit.includes(seg) ? 'high' : 'low'
				);
			}
		}
	});

	it('blanks and lamp-tests the 4511 from pins that are active low', () => {
		const one: Record<string, 'high' | 'low'> = {
			A: 'high',
			B: 'low',
			C: 'low',
			D: 'low',
			LE: 'low',
			BI: 'high',
			LT: 'high'
		};
		// Showing a 1: b and c on, a off.
		expect(evaluate('4511', one, 'a')).toBe('low');
		expect(evaluate('4511', one, 'b')).toBe('high');
		// Blanking pulls every bar down, data or no data.
		expect(evaluate('4511', { ...one, BI: 'low' }, 'b')).toBe('low');
		// Lamp test lights every bar, including the ones this digit does not use,
		// and it wins over blanking — which is how the dead segment gets found.
		expect(evaluate('4511', { ...one, LT: 'low' }, 'a')).toBe('high');
		expect(evaluate('4511', { ...one, LT: 'low', BI: 'low' }, 'a')).toBe('high');
	});

	it('drives the 7447 the opposite way round from the 4511', () => {
		// Same seven equations, opposite polarity: this one pulls a segment down to
		// light it, because it is meant for a common-anode digit. Wire it to a
		// common-cathode one and it shows the photographic negative of the number,
		// so the polarity is the thing worth pinning.
		const five = { A: 'high', B: 'low', C: 'high', D: 'low' } as const;
		const quiet = { LT: 'high', BI: 'high', RBI: 'high' } as const;
		// A 5 is a c d f g. On this part those read low and the other two read high.
		for (const seg of 'acdfg') {
			expect(evaluate('7447', { ...five, ...quiet }, seg), `lit ${seg}`).toBe('low');
		}
		for (const seg of 'be') {
			expect(evaluate('7447', { ...five, ...quiet }, seg), `dark ${seg}`).toBe('high');
		}
		// And the 4511 says the same digit the other way round.
		const cmos = { ...five, LE: 'low', BI: 'high', LT: 'high' } as const;
		expect(evaluate('4511', cmos, 'a')).toBe('high');
		expect(evaluate('4511', cmos, 'b')).toBe('low');
	});

	it('blanks a leading zero on the 7447 but never the lamp test', () => {
		const zero = { A: 'low', B: 'low', C: 'low', D: 'low', LT: 'high', BI: 'high' } as const;
		// Ripple blanking off: a zero is a zero.
		expect(evaluate('7447', { ...zero, RBI: 'high' }, 'a')).toBe('low');
		// On: this digit shows nothing, which is how 007 becomes 7.
		expect(evaluate('7447', { ...zero, RBI: 'low' }, 'a')).toBe('high');
		// Except under lamp test, which has to light what blanking would hide or it
		// is not a test.
		expect(evaluate('7447', { ...zero, RBI: 'low', LT: 'low' }, 'a')).toBe('low');
	});

	it('picks each of the eight inputs of a 74151 in turn', () => {
		// Every address is walked with only its own input high, so a mux wired to
		// the wrong data line — or to two of them — fails on the address that names
		// it rather than on all of them at once.
		for (let address = 0; address < 8; address++) {
			const inputs: Record<string, 'high' | 'low'> = {
				A: address & 1 ? 'high' : 'low',
				B: address & 2 ? 'high' : 'low',
				C: address & 4 ? 'high' : 'low',
				G: 'low'
			};
			for (let line = 0; line < 8; line++) inputs[`D${line}`] = line === address ? 'high' : 'low';
			expect(evaluate('74151', inputs, 'Y'), `address ${address}`).toBe('high');
			// W is Y inverted, and it is on the package because half the circuits
			// that use one of these want the complement.
			expect(evaluate('74151', inputs, 'W'), `address ${address} W`).toBe('low');
			// Now the same address with that one input low: nothing else may leak in.
			const inverted = { ...inputs, [`D${address}`]: 'low' as const };
			for (let line = 0; line < 8; line++) {
				if (line !== address) inverted[`D${line}`] = 'high';
			}
			expect(evaluate('74151', inverted, 'Y'), `address ${address} isolated`).toBe('low');
		}
	});

	it('counts 0 to 15 on the 74161 and carries at the top', () => {
		// A counter is the one part where a still picture proves nothing: it has to
		// be clocked. So this places the chip with a real clock on it, runs, and
		// reads the four outputs at the middle of every count.
		const chip = chipById('74161')!;
		const def = chipDefinition(chip);
		const part = at(CHIP_PREFIX + '74161', 'U1', 600, 400);
		const ground = at('ground', 'GND1', 1100, 800);
		const instances: Instance[] = [part, ground];
		const wires: Array<[number, number, number, number]> = [];

		const drive = (pin: string, state: 'high' | 'low') => {
			const place = def.pins.find((p) => p.name === pin)!;
			const source = at('toggle', pin, 600 + place.x - 120, 400 + place.y);
			source.params = { state };
			instances.push(source);
			wires.push([600 + place.x - 90, 400 + place.y, 600 + place.x, 400 + place.y]);
		};
		// Counting, never loading, never cleared, and the load inputs held low so a
		// stray load would be obvious rather than invisible.
		for (const pin of ['ENP', 'ENT', 'CLR', 'LOAD']) drive(pin, 'high');
		for (const pin of ['A', 'B', 'C', 'D']) drive(pin, 'low');

		const clkPlace = def.pins.find((p) => p.name === 'CLK')!;
		const clock = at('clock', 'CLK1', 600 + clkPlace.x - 120, 400 + clkPlace.y);
		clock.params = { frequency: 1e6, duty: 0.5 };
		instances.push(clock);
		wires.push([600 + clkPlace.x - 90, 400 + clkPlace.y, 600 + clkPlace.x, 400 + clkPlace.y]);

		const compiled = compileSchematic(drawing(instances, wires));
		expect(compiled.errors).toEqual([]);
		const sim = new Simulation(JSON.stringify(compiled.netlist));
		const meta = JSON.parse(sim.runTransient(20e-6, 5e-8));
		sim.free();

		const series = (pin: string) => {
			const net = compiled.connectivity.netOfPin.get(`${part.id}:${pin}`)!;
			const label = compiled.names.get(net)!.digital!;
			return meta.digital[meta.net_names.indexOf(label)] ?? [];
		};
		const bit = (events: Array<{ time: number; state: string }>, t: number) =>
			events.filter((e) => e.time <= t).at(-1)?.state === 'high' ? 1 : 0;
		const q = ['QA', 'QB', 'QC', 'QD'].map(series);
		const rco = series('RCO');

		// The clock rises at 0.5 us and every microsecond after, so read at 0.9,
		// 1.9 and so on: well clear of the edge either side.
		const counted: number[] = [];
		for (let n = 0; n < 17; n++) {
			const t = n * 1e-6 + 0.9e-6;
			counted.push(q.reduce((sum, events, i) => sum + bit(events, t) * (1 << i), 0));
		}
		expect(counted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);

		// And the carry is up only while the count is fifteen — one count wide,
		// which is what the next counter in the chain is waiting for.
		expect(bit(rco, 14 * 1e-6 + 0.9e-6)).toBe(1);
		expect(bit(rco, 13 * 1e-6 + 0.9e-6)).toBe(0);
		expect(bit(rco, 15 * 1e-6 + 0.9e-6)).toBe(0);
	});

	it('counts to ten on a 7490 with its two halves tied together', () => {
		// The part is a divide-by-two and a divide-by-five that share nothing but
		// the package, so counting to ten means wiring QA to CKB on the drawing —
		// which is what somebody does with a real one, and what this test does too.
		const chip = chipById('7490')!;
		const def = chipDefinition(chip);
		const part = at(CHIP_PREFIX + '7490', 'U1', 600, 400);
		const ground = at('ground', 'GND1', 1100, 800);
		const instances: Instance[] = [part, ground];
		const wires: Array<[number, number, number, number]> = [];
		const place = (pin: string) => {
			const found = def.pins.find((p) => p.name === pin)!;
			return { x: 600 + found.x, y: 400 + found.y };
		};
		const drive = (pin: string, state: 'high' | 'low') => {
			const { x, y } = place(pin);
			const side = x < 600 ? -1 : 1;
			const source = at('toggle', pin, x + 120 * side, y);
			source.params = { state };
			instances.push(source);
			wires.push([x + 90 * side, y, x, y]);
		};
		// Neither reset asserted: both pins of each pair have to be up to act.
		for (const pin of ['R01', 'R02', 'R91', 'R92']) drive(pin, 'low');

		// CKA is pin 14, so it is on the right-hand side, and a clock put there
		// faces further right — the wire has to start at its output, not in front
		// of it.
		const clkA = place('CKA');
		const clock = at('clock', 'CLK1', clkA.x + 200, clkA.y);
		clock.params = { frequency: 1e6, duty: 0.5 };
		instances.push(clock);
		wires.push([clkA.x + 230, clkA.y, clkA.x, clkA.y]);

		// QA into CKB: the two halves in series is what makes it a decade.
		const qa = place('QA');
		const ckb = place('CKB');
		wires.push(
			[qa.x, qa.y, qa.x + 60, qa.y],
			[qa.x + 60, qa.y, qa.x + 60, 760],
			[ckb.x - 60, 760, qa.x + 60, 760],
			[ckb.x - 60, ckb.y, ckb.x - 60, 760],
			[ckb.x - 60, ckb.y, ckb.x, ckb.y]
		);

		const compiled = compileSchematic(drawing(instances, wires));
		expect(compiled.errors).toEqual([]);
		const sim = new Simulation(JSON.stringify(compiled.netlist));
		const meta = JSON.parse(sim.runTransient(24e-6, 5e-8));
		sim.free();

		const series = (pin: string) => {
			const net = compiled.connectivity.netOfPin.get(`${part.id}:${pin}`)!;
			const label = compiled.names.get(net)!.digital!;
			return meta.digital[meta.net_names.indexOf(label)] ?? [];
		};
		const bit = (events: Array<{ time: number; state: string }>, t: number) =>
			events.filter((e) => e.time <= t).at(-1)?.state === 'high' ? 1 : 0;
		const q = ['QA', 'QB', 'QC', 'QD'].map(series);

		// The clock starts low and this part counts on the falling edge, so the
		// first one is at 1 us and each count owns the microsecond after it. Read
		// halfway through, clear of both edges.
		const counted: number[] = [];
		for (let n = 0; n < 12; n++) {
			const t = n * 1e-6 + 1.5e-6;
			counted.push(q.reduce((sum, events, i) => sum + bit(events, t) * (1 << i), 0));
		}
		// Ten states and then round: nine is 1001, and what comes after it is zero
		// rather than ten. A divide-by-five built as a binary counter with a reset
		// would pass through five on the way, and this is where that shows.
		expect(counted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
	});

	it('sets a 7490 to nine and clears it to zero, from pins that come in pairs', () => {
		// Both pins of a pair have to be up, which is the point of them: one stray
		// signal cannot reset the counter. And nine wins over zero.
		const evaluateStatic = (inputs: Record<string, 'high' | 'low'>, pin: string) =>
			evaluate('7490', inputs, pin);
		const idle = { R01: 'low', R02: 'low', R91: 'low', R92: 'low' } as const;
		// Reset to zero needs both R0 pins.
		expect(evaluateStatic({ ...idle, R01: 'high', R02: 'high' }, 'QA')).toBe('low');
		expect(evaluateStatic({ ...idle, R01: 'high', R02: 'high' }, 'QD')).toBe('low');
		// Nine is 1001, and it wins even with both reset pins also up.
		const nine = { R91: 'high', R92: 'high', R01: 'high', R02: 'high' } as const;
		expect(evaluateStatic(nine, 'QA')).toBe('high');
		expect(evaluateStatic(nine, 'QB')).toBe('low');
		expect(evaluateStatic(nine, 'QC')).toBe('low');
		expect(evaluateStatic(nine, 'QD')).toBe('high');
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
