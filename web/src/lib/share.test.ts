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

	it('rejects anything that is not a repath link', async () => {
		await expect(decodeCircuit('https://example.com')).rejects.toThrow();
		await expect(decodeCircuit('cq' + btoa('nonsense'))).rejects.toThrow();
	});
});
