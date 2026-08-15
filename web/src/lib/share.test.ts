import { describe, expect, it } from 'vitest';
import { decodeCircuit, encodeCircuit, type SharedCircuit } from './share';
import type { Schematic } from './schematic/model';

function circuit(): SharedCircuit {
	const schematic: Schematic = {
		instances: [
			{
				id: 'a',
				kind: 'vsource',
				name: 'V1',
				x: 100,
				y: 200,
				rotation: 0,
				params: { waveform: 'sine', value: 5, frequency: 1000 }
			},
			{
				id: 'b',
				kind: 'resistor',
				name: 'R1',
				x: 200,
				y: 170,
				rotation: 90,
				params: { resistance: 4700 }
			}
		],
		wires: [
			{
				id: 'w',
				points: [
					{ x: 100, y: 170 },
					{ x: 170, y: 170 },
					{ x: 170, y: 230 }
				]
			}
		]
	};
	return { schematic, stopTime: 5e-3 };
}

describe('circuit links', () => {
	it('round-trips a circuit through a fragment', async () => {
		const original = circuit();
		const decoded = await decodeCircuit(await encodeCircuit(original));

		expect(decoded.stopTime).toBe(original.stopTime);
		expect(decoded.schematic.instances).toHaveLength(2);
		expect(decoded.schematic.wires).toHaveLength(1);

		// Everything that matters survives; only the ids are regenerated, so a
		// pasted circuit can never collide with what is already open.
		const [source, resistor] = decoded.schematic.instances;
		expect(source).toMatchObject({ kind: 'vsource', name: 'V1', x: 100, y: 200, rotation: 0 });
		expect(source.params).toEqual({ waveform: 'sine', value: 5, frequency: 1000 });
		expect(resistor).toMatchObject({ kind: 'resistor', name: 'R1', rotation: 90 });
		// Every corner survives, not just the ends.
		expect(decoded.schematic.wires[0].points).toEqual([
			{ x: 100, y: 170 },
			{ x: 170, y: 170 },
			{ x: 170, y: 230 }
		]);
		expect(decoded.schematic.instances[0].id).not.toBe('a');
	});

	it('produces a fragment that survives a URL', async () => {
		const fragment = await encodeCircuit(circuit());
		// Base64url only: nothing here needs escaping, so the link stays clickable
		// when it is pasted into a chat message or a forum post.
		expect(fragment).toMatch(/^c[zu][A-Za-z0-9_-]+$/);
	});

	it('accepts a fragment with or without its hash', async () => {
		const fragment = await encodeCircuit(circuit());
		const withHash = await decodeCircuit(`#${fragment}`);
		expect(withHash.schematic.instances).toHaveLength(2);
	});

	it('compresses rather than just encoding', async () => {
		// A repetitive circuit should shrink well below its JSON size.
		const big = circuit();
		for (let i = 0; i < 40; i++) {
			big.schematic.instances.push({
				id: `r${i}`,
				kind: 'resistor',
				name: `R${i + 2}`,
				x: i * 40,
				y: 300,
				rotation: 0,
				params: { resistance: 1000 }
			});
		}
		const fragment = await encodeCircuit(big);
		expect(fragment[1]).toBe('z');
		expect(fragment.length).toBeLessThan(JSON.stringify(big).length / 2);
	});

	it('brings an older link up to date on the way in', async () => {
		// A link is the one artefact here that outlives the catalog it was written
		// against — someone posts one in a forum thread and it is opened a year
		// later. LEDs used to be a model choice on the diode, so a link from then
		// still says so, and decoding has to produce the part that was meant rather
		// than a plain rectifier with the wrong forward voltage.
		const old = circuit();
		old.schematic.instances = [
			{
				id: 'd1',
				kind: 'diode',
				name: 'D1',
				x: 200,
				y: 200,
				rotation: 0,
				params: { model: 'led' }
			}
		];

		const back = await decodeCircuit(await encodeCircuit(old));
		expect(back.schematic.instances[0].kind).toBe('led');
		expect(back.schematic.instances[0].params.colour).toBe('red');
		expect(back.schematic.instances[0].name).toBe('D1');
	});

	it('leaves an ordinary diode alone', async () => {
		const old = circuit();
		old.schematic.instances = [
			{
				id: 'd1',
				kind: 'diode',
				name: 'D1',
				x: 200,
				y: 200,
				rotation: 0,
				params: { model: 'zener', breakdown: 5.1 }
			}
		];

		const back = await decodeCircuit(await encodeCircuit(old));
		expect(back.schematic.instances[0].kind).toBe('diode');
		expect(back.schematic.instances[0].params.breakdown).toBe(5.1);
	});

	it('rejects anything that is not a repath link', async () => {
		await expect(decodeCircuit('https://example.com')).rejects.toThrow();
		await expect(decodeCircuit('cq' + btoa('nonsense'))).rejects.toThrow();
	});
});

describe('an imported part in a link', () => {
	const OPAMP = '.SUBCKT OPAMP1 1 2 3\nRIN 1 2 2MEG\nE1 4 0 1 2 100K\nROUT 4 3 75\n.ENDS';

	it('travels with the drawing that uses it', async () => {
		// A link carrying a part but not what it is made of would open as a hole in
		// the middle of someone's circuit — and the whole promise of a link is that
		// the person who clicks it sees the working circuit.
		const shared: SharedCircuit = {
			stopTime: 1e-3,
			schematic: {
				instances: [
					{ id: 'x', kind: 'x:opamp1', name: 'X1', x: 200, y: 200, rotation: 0, params: {} }
				],
				wires: [],
				subcircuits: [{ id: 'opamp1', name: 'OPAMP1', ports: ['1', '2', '3'], source: OPAMP }]
			}
		};

		const back = await decodeCircuit(await encodeCircuit(shared));
		expect(back.schematic.subcircuits?.[0]).toEqual(shared.schematic.subcircuits![0]);
		expect(back.schematic.instances[0].kind).toBe('x:opamp1');
	});

	it('carries what the sender was watching', async () => {
		// A link is usually sent *because* of a signal. Arriving with the scope
		// empty made whoever received it go and find it again — and the field was
		// declared on the payload the whole time, just never written or read.
		const original = { ...circuit(), probes: ['pin:b:a', '170,230'] };
		const decoded = await decodeCircuit(await encodeCircuit(original));

		// Ids are minted fresh on the far side, so the handle cannot come back
		// verbatim: it has to point at whatever the resistor is called now.
		const resistor = decoded.schematic.instances.find((i) => i.name === 'R1')!;
		expect(decoded.probes).toEqual([`pin:${resistor.id}:a`, '170,230']);
		expect(resistor.id).not.toBe('b');
	});

	it('drops a probe on a part the link does not carry', async () => {
		const original = { ...circuit(), probes: ['pin:gone:a'] };
		const decoded = await decodeCircuit(await encodeCircuit(original));
		// Better than a handle that resolves to nothing and sits in the list.
		expect(decoded.probes).toEqual([]);
	});

	it('opens a link written before probes travelled', async () => {
		const decoded = await decodeCircuit(await encodeCircuit(circuit()));
		expect(decoded.probes).toEqual([]);
	});

	it('is a part the catalog knows about by the time the instances are read', async () => {
		// Ordering, not content: the loop that reads instances asks the catalog what
		// each one is, so a definition registered afterwards would already have
		// thrown. Reading the part back is what proves it happened first.
		const { definitionOf } = await import('./schematic/model');
		const shared: SharedCircuit = {
			stopTime: 1e-3,
			schematic: {
				instances: [],
				wires: [],
				subcircuits: [{ id: 'late', name: 'LATE', ports: ['a', 'b'], source: '.SUBCKT LATE a b\nR1 a b 1k\n.ENDS' }]
			}
		};
		await decodeCircuit(await encodeCircuit(shared));
		expect(definitionOf('x:late').pins.map((p) => p.name)).toEqual(['a', 'b']);
	});
});
