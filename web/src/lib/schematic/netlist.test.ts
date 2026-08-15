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
import { EXAMPLES } from '../examples';
import { compileSchematic } from './netlist';
import {
	defaultParams,
	definitionFor,
	definitionOf,
	migrateInstance,
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

describe('component tolerance', () => {
	/** An RC, with whatever tolerance and sample are asked for. */
	function rc(tolerance: number, seed: number) {
		const r = at('resistor', 'R1', 200, 200);
		const c = at('capacitor', 'C1', 300, 200);
		r.params.tolerance = tolerance;
		c.params.tolerance = tolerance;
		const schematic = drawing([at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 320), r, c], []);
		const netlist = compileSchematic(schematic, 300.15, seed).netlist as {
			components: Array<Record<string, unknown>>;
		} | null;
		const find = (name: string) => netlist?.components.find((x) => x.name === name);
		return { r: find('R1')?.resistance as number, c: find('C1')?.capacitance as number };
	}

	it('leaves every part on its marking until sampling is on', () => {
		// The default has to be the drawing as drawn. A simulator whose numbers
		// move for reasons you did not ask for is worse than one that is optimistic.
		const { r, c } = rc(10, 0);
		expect(r).toBe(1000);
		expect(c).toBe(1e-6);
	});

	it('draws each part from inside its own band', () => {
		const { r, c } = rc(10, 1);
		expect(r).not.toBe(1000);
		expect(r).toBeGreaterThanOrEqual(900);
		expect(r).toBeLessThanOrEqual(1100);
		expect(c).toBeGreaterThanOrEqual(0.9e-6);
		expect(c).toBeLessThanOrEqual(1.1e-6);
		// Two parts, two draws: a sample where everything moves together is not a
		// sample, it is a scale factor.
		expect(r / 1000).not.toBeCloseTo(c / 1e-6, 6);
	});

	it('gives the same circuit back for the same seed', () => {
		// Which is what makes a sample something you can re-run, share in a link
		// and quote in a bug report.
		expect(rc(10, 7)).toEqual(rc(10, 7));
		expect(rc(10, 8)).not.toEqual(rc(10, 7));
	});

	it('stays put when the part has no tolerance to speak of', () => {
		const { r } = rc(0, 5);
		expect(r).toBe(1000);
	});

	it('spreads across the band rather than hugging one end', () => {
		// A hash that clustered would make sampling look like a fixed derating.
		const draws = Array.from({ length: 200 }, (_, i) => rc(10, i + 1).r);
		const lo = Math.min(...draws);
		const hi = Math.max(...draws);
		const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
		expect(lo).toBeLessThan(915);
		expect(hi).toBeGreaterThan(1085);
		expect(Math.abs(mean - 1000)).toBeLessThan(10);
	});
});

describe('logic gates', () => {
	/** A gate with `inputs` inputs, one clock hung on each, compiled. */
	function gate(kind: string, inputs: number) {
		const g = at(kind, 'U1', 300, 300);
		g.params = { ...g.params, inputs };
		const def = definitionFor(g);
		// A clock's output pin sits 30 to its right, so putting one there lands it
		// exactly on the gate's input: pins that touch are one net, no wire needed.
		const clocks = def.pins
			.filter((pin) => pin.direction === 'in')
			.map((pin, i) => at('clock', `CLK${i + 1}`, 300 + pin.x - 30, 300 + pin.y));
		const netlist = compileSchematic(drawing([g, ...clocks], [])).netlist as {
			devices: Array<Record<string, unknown>>;
		};
		return netlist.devices.find((d) => d.name === 'U1')!;
	}

	it('gives the engine as many inputs as the part grew pins for', () => {
		// One gate deciding three ways, not two gates in a row: the chain would
		// cost a second propagation delay, which is a different circuit.
		const three = gate('nand', 3) as { kind: string; inputs: string[] };
		expect(three.kind).toBe('nand');
		expect(three.inputs).toHaveLength(3);
		expect(new Set(three.inputs).size).toBe(3);
		expect(gate('or', 4).inputs).toHaveLength(4);
		expect(gate('xnor', 2).inputs).toHaveLength(2);
	});

	it('refuses an input count no gate has', () => {
		// Whatever the parameter says, the pins and the netlist have to agree —
		// a gate with one input is an inverter and one with nine is a fantasy.
		expect(gate('and', 1).inputs).toHaveLength(2);
		expect(gate('and', 9).inputs).toHaveLength(4);
	});

	it('sends a tri-state as one, enable and all', () => {
		const device = gate('tristate', 2) as Record<string, string>;
		expect(device.type).toBe('tri_state');
		expect(device.enable).not.toBe(device.input);
		expect(device.output).not.toBe(device.input);
	});

	it('carries the logic family the drawing was set to', () => {
		const netlist = (family: string) =>
			compileSchematic(drawing([at('clock', 'CLK1', 100, 100)], []), 300.15, 0, family)
				.netlist as { logic_family: { v_high: number; v_ih: number } };
		expect(netlist('cmos5').logic_family.v_high).toBe(5);
		expect(netlist('cmos3v3').logic_family.v_high).toBeCloseTo(3.3, 6);
		// TTL never reaches its rail, and decides much lower than CMOS does. A
		// circuit that works with one family and not the other usually fails here.
		expect(netlist('ttl').logic_family.v_high).toBeLessThan(4);
		expect(netlist('ttl').logic_family.v_ih).toBeLessThan(netlist('cmos5').logic_family.v_ih);
		// An unknown name is a build that moved on, not a reason to emit nothing.
		expect(netlist('74xx-whatever').logic_family.v_high).toBe(5);
	});
});

describe('the full adder that ships with the app', () => {
	/** Every device in the example, by name. */
	const devices = () => {
		const example = EXAMPLES.find((e) => e.id === 'full-adder')!;
		const result = compileSchematic(example.build());
		expect(result.errors).toEqual([]);
		const netlist = result.netlist as { devices: Array<Record<string, unknown>> };
		return new Map(netlist.devices.map((d) => [d.name as string, d]));
	};

	it('is wired the way a full adder is wired', () => {
		// A drawing is right or wrong in one place: which net each pin landed on.
		// Everything else about this example — the layout, the rails, the crossings
		// that must not connect — only matters because of what it produces here.
		const by = devices();
		const out = (name: string) => by.get(name)!.output as string;
		const ins = (name: string) => new Set(by.get(name)!.inputs as string[]);

		const [a, b, c] = ['CLK1', 'CLK2', 'CLK3'].map(out);
		// Sum is the parity of all three, in one gate.
		expect(by.get('U1')!.kind).toBe('xor');
		expect(ins('U1')).toEqual(new Set([a, b, c]));

		// The carry is any two of the three, so the three ANDs take the three
		// distinct pairs — and none of them takes the same input twice.
		const pairs = ['U2', 'U3', 'U4'].map(ins);
		for (const pair of pairs) expect(pair.size).toBe(2);
		expect(new Set(pairs.map((p) => [...p].sort().join('+'))).size).toBe(3);
		expect(new Set(pairs.flatMap((p) => [...p]))).toEqual(new Set([a, b, c]));

		expect(ins('U5')).toEqual(new Set(['U2', 'U3', 'U4'].map(out)));
	});

	it('keeps the crossing rails apart', () => {
		// Three rails run down the left and every tap off one crosses the others.
		// If a crossing joined, the three inputs would be one net and the adder
		// would still simulate — it would just always answer zero.
		const by = devices();
		const rails = new Set(['CLK1', 'CLK2', 'CLK3'].map((n) => by.get(n)!.output as string));
		expect(rails.size).toBe(3);
	});
});

describe('a probe on a logic signal', () => {
	/** A clock with a probe hung on its output, and nothing else. */
	const probedClock = (label: string) => {
		const clock = at('clock', 'CLK1', 100, 100);
		const probe = at('probe', 'P1', 130, 100);
		probe.params = { ...probe.params, label };
		return compileSchematic(drawing([clock, probe], []));
	};

	it('does not turn the net analog, or ask for a ground that has no meaning', () => {
		// Clipping a probe onto a gate output is the ordinary thing to do with one.
		// A probe carries no current and changes nothing, so it must not conjure an
		// analog node, a bridge to drive it, and a demand for a voltage reference.
		const result = probedClock('clk');
		expect(result.errors).toEqual([]);
		const netlist = result.netlist as { bridges: unknown[]; components: unknown[] };
		expect(netlist.bridges).toEqual([]);
		expect(netlist.components).toEqual([]);
		const named = [...result.names.values()].find((n) => n.digital);
		expect(named?.digital).toBeTruthy();
		expect(named?.analog).toBeUndefined();
	});

	it('still measures a voltage where there is no logic to name', () => {
		// On bare wire there is nothing digital to point at, and a probe that read
		// nothing at all would be a worse answer than an analog node reading zero.
		const probe = at('probe', 'P1', 200, 200);
		const result = compileSchematic(drawing([at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 300), probe], [[200, 200, 260, 200]]));
		const analog = [...result.names.values()].filter((n) => n.analog);
		expect(analog.length).toBeGreaterThan(1);
	});
});

describe('a switch', () => {
	/** The switch and its actuator, out of a drawing that compiles. */
	function switched(params: Record<string, number | string>) {
		const s = at('switch', 'S1', 300, 200);
		s.params = { ...s.params, ...params };
		const result = compileSchematic(
			drawing(
				[at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 320), s],
				[
					[100, 170, 270, 170],
					[270, 170, 270, 200],
					[100, 230, 100, 320]
				]
			)
		);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> };
		const actuator = netlist.components.find((c) => c.name === 'S1__actuator')!.waveform as {
			type: string;
			value?: number;
			points?: Array<[number, number]>;
		};
		return {
			contact: netlist.components.find((c) => c.type === 'switch')!,
			actuator,
			control: actuator.points ?? [],
			errors: result.errors
		};
	}

	/** Levels the control passes through, with the ramps between them dropped. */
	const levels = (points: Array<[number, number]>) =>
		points.map(([, v]) => v).filter((v, i, all) => i === 0 || v !== all[i - 1]);

	it('is a controlled switch with its control written out in advance', () => {
		const { contact } = switched({});
		expect(contact.control_plus).toBe('S1__contact');
		expect(contact.control_minus).toBe('gnd');
		// The two resistances are the part: an open switch is a big resistor and a
		// closed one is a small resistor, and neither is infinite or zero.
		const model = contact.model as Record<string, number>;
		expect(model.r_on).toBeLessThan(1);
		expect(model.r_off).toBeGreaterThan(1e6);
	});

	it('holds still unless something was scheduled', () => {
		// The default. A switch you click is a switch that stays where you put it,
		// and a constant says so without asking the solver to land a timepoint on
		// anything.
		expect(switched({}).actuator).toEqual({ type: 'dc', value: 0 });
		expect(switched({ start: 'closed' }).actuator).toEqual({ type: 'dc', value: 1 });
		// Even with a time set: what decides is whether anything is scheduled.
		expect(switched({ at: 5e-3 }).actuator.type).toBe('dc');
	});

	it('rests where the drawing says, then operates once', () => {
		const closing = switched({ action: 'toggle', start: 'open', at: 2e-3, bounce: 0 });
		expect(closing.control[0]).toEqual([0, 0]);
		expect(levels(closing.control)).toEqual([0, 1]);
		expect(closing.control[closing.control.length - 1][0]).toBeCloseTo(2e-3, 9);

		// And the other way round: a switch drawn closed opens.
		expect(levels(switched({ action: 'toggle', start: 'closed', bounce: 0 }).control)).toEqual([1, 0]);
	});

	it('springs back when it is a push-button', () => {
		const { control } = switched({ action: 'momentary', at: 1e-3, hold: 5e-3, bounce: 0 });
		expect(levels(control)).toEqual([0, 1, 0]);
		// Pressed at one millisecond, released five later.
		expect(control[control.length - 1][0]).toBeCloseTo(6e-3, 9);
	});

	it('chatters, and settles where it was going', () => {
		// The reason a button wired to a counter counts three. A clean edge would
		// hide the one behaviour anybody debounces against.
		const { control } = switched({ action: 'toggle', at: 1e-3, bounce: 2e-3 });
		const changes = levels(control);
		expect(changes.length).toBeGreaterThan(3);
		expect(changes[changes.length - 1]).toBe(1);
		// All of it inside the bounce window, and none of it before the contact
		// was touched.
		const times = control.map(([t]) => t);
		expect(Math.min(...times.slice(1))).toBeGreaterThan(0.9e-3);
		expect(Math.max(...times)).toBeLessThanOrEqual(3e-3 + 1e-9);
	});

	it('is a clean edge with the bounce turned off', () => {
		expect(switched({ action: 'toggle', bounce: 0 }).control).toHaveLength(3);
	});
});

describe('the supply terminal', () => {
	const rail = (parts: Instance[], wires: Array<[number, number, number, number]> = []) =>
		compileSchematic(drawing(parts, wires));

	it('is a source referred to ground, so a rail needs no wire back to it', () => {
		const supply = at('supply', 'PWR1', 200, 100);
		const result = rail(
			[supply, at('resistor', 'R1', 200, 170, 90), at('ground', 'GND1', 200, 240)],
			[
				[200, 110, 200, 140],
				[200, 200, 200, 230]
			]
		);
		expect(result.errors).toEqual([]);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> };
		const source = netlist.components.find((c) => c.name === 'PWR1')!;
		expect(source.type).toBe('voltage_source');
		expect(source.minus).toBe('gnd');
		expect(source.plus).not.toBe('gnd');
		expect(source.waveform).toEqual({ type: 'dc', value: 5 });
	});

	it('refuses to be a short across itself', () => {
		// A rail on the ground net asks for five volts and nothing at one point.
		// The solver would report a singular matrix; the drawing can say why.
		const result = rail([at('supply', 'PWR1', 200, 100), at('ground', 'GND1', 200, 140)], [
			[200, 110, 200, 130]
		]);
		expect(result.errors.some((e) => e.includes('PWR1'))).toBe(true);
		expect(result.netlist).toBeNull();
	});

	it('builds one source where two symbols are wired together', () => {
		// Two ideal sources in parallel is a short between two voltages, and the
		// second is redundant anyway: this is one rail drawn twice.
		const second = at('supply', 'PWR2', 300, 100);
		second.params = { ...second.params, voltage: 12 };
		const result = rail(
			[
				at('supply', 'PWR1', 200, 100),
				second,
				at('resistor', 'R1', 250, 170, 90),
				at('ground', 'GND1', 250, 240)
			],
			[
				[200, 110, 200, 140],
				[200, 140, 300, 140],
				[300, 110, 300, 140],
				[250, 140, 250, 140],
				[250, 200, 250, 230]
			]
		);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> };
		expect(netlist.components.filter((c) => c.type === 'voltage_source')).toHaveLength(1);
		// And the disagreement is named rather than silently resolved.
		expect(result.warnings.some((w) => w.includes('12') && w.includes('PWR1'))).toBe(true);
	});
});

describe('the switch example that ships with the app', () => {
	it('is wired without a warning, which is most of what it is for', () => {
		// It exists to be read as much as run: a supply symbol, a switch and the
		// load resistor that stops the capacitor charging through an open contact.
		const example = EXAMPLES.find((e) => e.id === 'switch-bounce')!;
		const result = compileSchematic(example.build());
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		const netlist = result.netlist as { components: Array<Record<string, unknown>> };
		const contact = netlist.components.find((c) => c.type === 'switch')!;
		// The switch is in series between the rail and the load, not across
		// something: its two sides have to be different nets.
		expect(contact.a).not.toBe(contact.b);
		expect(contact.b).not.toBe('gnd');
	});
});

describe('what counts as a voltage reference', () => {
	const errorsOf = (parts: Instance[], wires: Array<[number, number, number, number]> = []) =>
		compileSchematic(drawing(parts, wires)).errors;

	it('takes a supply terminal as one, with no ground symbol drawn', () => {
		// Reported from a shared link: a 5 V rail through two switches into a NAND,
		// which was refused for having no ground. The supply's negative end *is*
		// ground — that is what the symbol means — so the reference was there the
		// whole time and the drawing was complete.
		const supply = at('supply', 'PWR1', 200, 100);
		const r = at('resistor', 'R1', 200, 170, 90);
		expect(
			errorsOf([supply, r], [[200, 110, 200, 140]]).filter((e) => e.includes('ground'))
		).toEqual([]);
	});

	it('still refuses a drawing that names no reference at all', () => {
		// A source and a resistor with neither end on ground is a loop floating away
		// from the reference node, which is a singular matrix rather than a circuit.
		const errors = errorsOf(
			[at('vsource', 'V1', 100, 200), at('resistor', 'R1', 250, 170, 90)],
			[[100, 170, 250, 170]]
		);
		expect(errors.some((e) => e.includes('No ground'))).toBe(true);
	});
});

describe('a logic input with nothing holding it', () => {
	/**
	 * The reported circuit, reduced: a rail, a switch, and a gate input. With
	 * `pulldown` there is also a resistor to ground, which is the fix.
	 */
	function switchIntoGate(pulldown: boolean) {
		const parts = [
			at('supply', 'PWR1', 100, 100),
			at('switch', 'S1', 100, 170, 90),
			at('and', 'U1', 260, 210),
			at('ground', 'GND1', 100, 340)
		];
		const wires: Array<[number, number, number, number]> = [
			[100, 110, 100, 140],
			[100, 200, 100, 230],
			// Into both inputs of the gate.
			[100, 230, 230, 230],
			[230, 200, 230, 230],
			[230, 220, 230, 230]
		];
		if (pulldown) {
			parts.push(at('resistor', 'R1', 100, 280, 90));
			wires.push([100, 230, 100, 250], [100, 310, 100, 330]);
		}
		return compileSchematic(drawing(parts, wires)).warnings.filter((w) =>
			w.includes('pull-down')
		);
	}

	it('says so, because the simulation is right and looks broken', () => {
		// A logic input draws no current, so with the switch open nothing moves the
		// node at all: it keeps whatever leaked into it, and the gate reads the
		// same level whether the switch is open or closed.
		const said = switchIntoGate(false);
		expect(said.length).toBeGreaterThan(0);
		expect(said[0]).toContain('U1.');
		expect(said[0]).toContain('pull-down');
		// And it says which mistake it is. This input is not undefined for the whole
		// run — it is defined whenever the contact is closed, which is the circuit
		// that was drawn. Reporting it as permanently undefined is how the switch
		// came to do nothing at all.
		expect(said[0]).toContain('while a switch is closed');
	});

	it('stays quiet once something pulls the input the other way', () => {
		expect(switchIntoGate(true)).toEqual([]);
	});

	it('stays quiet for an input a source drives directly', () => {
		// The mixed-signal example: a sine straight into a gate. There is a DC path
		// through the source, so the input has a level at every instant.
		const example = EXAMPLES.find((e) => e.id === 'mixed-signal')!;
		const warnings = compileSchematic(example.build()).warnings;
		expect(warnings.filter((w) => w.includes('no path to either rail'))).toEqual([]);
	});

	it('stays quiet for a gate driven by another gate', () => {
		// Purely digital nets have no analog node to float: the digital domain
		// resolves them, and an undriven one is already unknown rather than wrong.
		const example = EXAMPLES.find((e) => e.id === 'full-adder')!;
		expect(compileSchematic(example.build()).warnings).toEqual([]);
	});
});

describe('what a floating input is handed to the engine as', () => {
	/** The reported circuit: a rail, a switch, and a gate input with no pull. */
	const built = (pulldown: boolean) => {
		const parts = [
			at('supply', 'PWR1', 100, 100),
			at('switch', 'S1', 100, 170, 90),
			at('not', 'U1', 260, 230),
			at('ground', 'GND1', 100, 340)
		];
		const wires: Array<[number, number, number, number]> = [
			[100, 110, 100, 140],
			[100, 200, 100, 230],
			[100, 230, 230, 230]
		];
		if (pulldown) {
			parts.push(at('resistor', 'R1', 100, 280, 90));
			wires.push([100, 230, 100, 250], [100, 310, 100, 330]);
		}
		const result = compileSchematic(drawing(parts, wires));
		return {
			netlist: result.netlist as { bridges: Array<Record<string, unknown>> },
			result
		};
	};

	it('is still bridged when a switch can hold it, or closing it would do nothing', () => {
		// This is the fix for the reported circuit. Deleting the bridge because the
		// input floats *while the switch is open* also deletes it for every instant
		// the switch is closed — and then the contact makes no difference to
		// anything, which is exactly what was reported: five volts on the wire, the
		// gate unmoved, and "floating" printed over a node holding five volts.
		expect(built(false).netlist.bridges.filter((b) => b.direction === 'to_digital')).toHaveLength(
			1
		);
	});

	it('is bridged as soon as something holds it', () => {
		const bridged = built(true).netlist.bridges.filter((b) => b.direction === 'to_digital');
		expect(bridged).toHaveLength(1);
	});

	it('is called floating only at the instants when it is', () => {
		const { result } = built(false);
		const s1 = /** @type {const} */ (
			result.connectivity.nets.flatMap((n) => n.pins).find((p) => p.instance.kind === 'switch')!
		).instance;

		// Open: nothing decides the node, and the drawing says so rather than
		// printing the number leakage left on it.
		expect(result.floatingAt(new Set()).size).toBe(1);
		// Closed: the rail is on it through 50 mΩ. Calling that floating is the same
		// lie in the other direction.
		expect(result.floatingAt(new Set([s1.id]))).toEqual(new Set());
	});

	it('leaves an input no switch can reach unbridged, because that one really is undefined', () => {
		// A gate input behind a capacitor — the AC-coupled input, which is the other
		// classic way to leave one undefined. A capacitor is an open circuit at DC,
		// and unlike a switch there is no position anybody can put it in that makes
		// it conduct, so "unknown" is the whole truth about that node for the whole
		// run.
		const schematic = drawing(
			[
				at('supply', 'PWR1', 100, 100),
				at('capacitor', 'C1', 100, 170, 90),
				at('not', 'U1', 260, 230),
				at('ground', 'GND1', 100, 340)
			],
			[
				[100, 110, 100, 140],
				[100, 200, 100, 230],
				[100, 230, 230, 230]
			]
		);
		const result = compileSchematic(schematic);
		expect(result.warnings.some((w) => w.includes('no path to either rail'))).toBe(true);
		const netlist = result.netlist as { bridges: Array<Record<string, unknown>> } | null;
		expect(netlist?.bridges.filter((b) => b.direction === 'to_digital')).toEqual([]);
	});
});

describe('switches drawn before they could be clicked', () => {
	it('stop operating on their own when an old drawing is opened', () => {
		// Every switch in a saved file or a shared link from that build carries the
		// only default there was: toggle, at one millisecond. Left alone it flips
		// itself over a millisecond into every run and undoes whatever position it
		// was put in, which reads as a switch with a mind of its own.
		const old = at('switch', 'S1', 100, 100);
		old.params = { ...old.params, action: 'toggle', at: 1e-3, bounce: 1e-3, hold: 10e-3, r_off: 1e9 };
		const migrated = migrateInstance(old);
		expect(migrated.params.action).toBe('manual');
		// And both migrations land. A switch from that build carries both defaults,
		// so returning after the first would fix the one written first and drop the
		// other — the sort of bug that only appears on the oldest drawings, which
		// are exactly the ones nobody re-tests.
		expect(migrated.params.r_off).toBe(1e12);
	});

	it('stop drawing current through an open contact', () => {
		// A gigaohm across five volts is five nanoamps, which was the largest
		// current in any circuit that was switched off — so the animation normalised
		// to it and ran the dots at full speed through an open switch.
		const old = at('switch', 'S4', 100, 100);
		old.params = { ...old.params, r_off: 1e9 };
		expect(migrateInstance(old).params.r_off).toBe(1e12);

		// A number somebody typed is a number they meant, even a bad one.
		const chosen = at('switch', 'S5', 100, 100);
		chosen.params = { ...chosen.params, r_off: 5e8 };
		expect(migrateInstance(chosen).params.r_off).toBe(5e8);
	});

	it('leaves a schedule somebody chose alone', () => {
		// Picking a time is what says the operation was wanted. Anyone who set one
		// changed one of these numbers away from the default to say when.
		const deliberate = at('switch', 'S2', 100, 100);
		deliberate.params = { ...deliberate.params, action: 'toggle', at: 4e-3, bounce: 1e-3, hold: 10e-3 };
		expect(migrateInstance(deliberate).params.action).toBe('toggle');

		const button = at('switch', 'S3', 100, 100);
		button.params = { ...button.params, action: 'momentary', at: 1e-3, bounce: 1e-3, hold: 10e-3 };
		expect(migrateInstance(button).params.action).toBe('momentary');
	});

	it('keeps the shipped example operating, since it says when', () => {
		const example = EXAMPLES.find((e) => e.id === 'switch-bounce')!;
		const s1 = example.build().instances.find((i) => i.kind === 'switch')!;
		expect(migrateInstance(s1).params.action).toBe('toggle');
	});
});

describe('a pulse source', () => {
	function pulseOf(duty: number) {
		const schematic = drawing(
			[at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 300)],
			[[100, 230, 100, 290]]
		);
		Object.assign(schematic.instances[0].params, {
			waveform: 'pulse',
			frequency: 1000,
			duty
		});
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);
		const components = (compiled.netlist as { components: Array<Record<string, unknown>> })
			.components;
		return components.find((c) => c.name === 'V1')!.waveform as {
			rise: number;
			width: number;
			period: number;
		};
	}

	it('carries the phase it was set to', () => {
		// The engine has had this all along; nothing could set it, so every sine on
		// every drawing started at zero and a quadrature pair could not be drawn.
		const schematic = drawing(
			[at('vsource', 'V1', 100, 200), at('ground', 'GND1', 100, 300)],
			[[100, 230, 100, 290]]
		);
		Object.assign(schematic.instances[0].params, { waveform: 'sine', phase: 90 });
		const compiled = compileSchematic(schematic);
		expect(compiled.errors).toEqual([]);
		const components = (compiled.netlist as { components: Array<Record<string, unknown>> })
			.components;
		const waveform = components.find((c) => c.name === 'V1')!.waveform as Record<string, number>;
		expect(waveform.phase).toBe(90);
	});

	it('is high for the fraction of the period it was asked for', () => {
		// The engine measures `width` from the top of the rising edge, so handing the
		// duty over as-is came out long by one edge: a pulse asked to be high half
		// the time was high a little more than half, every cycle.
		for (const duty of [0.1, 0.5, 0.9]) {
			const w = pulseOf(duty);
			expect((w.rise + w.width) / w.period).toBeCloseTo(duty, 9);
		}
	});
});
