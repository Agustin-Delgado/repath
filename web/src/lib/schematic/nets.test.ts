import { describe, expect, it } from 'vitest';
import {
	buildConnectivity,
	junctionDots,
	liesWithin,
	mergeWireChains,
	pinKey
} from './nets';
import { defaultParams, type Instance, type Point, type Schematic, type Wire } from './model';

let counter = 0;
const id = () => `n${++counter}`;

function part(kind: string, name: string, x: number, y: number, rotation: 0 | 90 = 0): Instance {
	return { id: name, kind, name, x, y, rotation, params: defaultParams(kind) };
}

function wire(...points: Point[]): Wire {
	return { id: id(), points };
}

const netOf = (s: Schematic, instance: string, pin: string) => {
	const c = buildConnectivity(s);
	return c.netOfPin.get(pinKey(instance, pin));
};

describe('liesWithin', () => {
	it('is true strictly inside a segment', () => {
		expect(liesWithin(50, 0, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(true);
		expect(liesWithin(0, 0, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(false);
		expect(liesWithin(100, 0, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(false);
	});

	it('is false off the line', () => {
		expect(liesWithin(50, 1, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(false);
	});
});

describe('connectivity', () => {
	it('joins two pins that touch directly, with no wire between them', () => {
		// A resistor placed so its left pin sits exactly on the source's plus pin.
		const schematic: Schematic = {
			instances: [part('vsource', 'V1', 200, 200), part('resistor', 'R1', 230, 170)],
			wires: []
		};
		expect(netOf(schematic, 'R1', 'a')).toBe(netOf(schematic, 'V1', 'plus'));
	});

	it('keeps them apart once one has moved away', () => {
		const schematic: Schematic = {
			instances: [part('vsource', 'V1', 200, 200), part('resistor', 'R1', 240, 170)],
			wires: []
		};
		expect(netOf(schematic, 'R1', 'a')).not.toBe(netOf(schematic, 'V1', 'plus'));
	});

	it('treats every corner of one wire as the same net', () => {
		const schematic: Schematic = {
			instances: [part('vsource', 'V1', 100, 200), part('resistor', 'R1', 330, 400)],
			wires: [wire({ x: 100, y: 170 }, { x: 300, y: 170 }, { x: 300, y: 400 })]
		};
		expect(netOf(schematic, 'R1', 'a')).toBe(netOf(schematic, 'V1', 'plus'));
	});

	it('makes a T-junction where a wire ends part-way along another', () => {
		const schematic: Schematic = {
			instances: [part('ground', 'GND1', 200, 110)],
			wires: [wire({ x: 0, y: 100 }, { x: 400, y: 100 })]
		};
		// The ground's pin lands mid-wire at (200, 100).
		expect(netOf(schematic, 'GND1', 'g')).toBe(
			buildConnectivity(schematic).netOfPoint.get('0,100')
		);
	});

	it('leaves crossing wires unconnected', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 100 }, { x: 200, y: 100 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 200 })
			]
		};
		const c = buildConnectivity(schematic);
		// They cross at (100,100) but neither ends there, so they are separate nets.
		expect(c.netOfPoint.get('0,100')).not.toBe(c.netOfPoint.get('100,0'));
	});
});

describe('junctionDots', () => {
	it('does not mark a plain bend', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [wire({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 })]
		};
		expect(junctionDots(schematic)).toHaveLength(0);
	});

	it('marks a three-way meeting', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }),
				wire({ x: 100, y: 0 }, { x: 200, y: 0 })
			]
		};
		expect(junctionDots(schematic)).toEqual([{ x: 100, y: 0 }]);
	});

	it('marks a wire stopping part-way along another', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 200, y: 0 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 80 })
			]
		};
		expect(junctionDots(schematic)).toContainEqual({ x: 100, y: 0 });
	});
});

describe('mergeWireChains', () => {
	it('joins two wires meeting at a bare point', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 80 })
			]
		};
		const merged = mergeWireChains(schematic);
		expect(merged).toHaveLength(1);
		expect(merged[0].points).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 80 }
		]);
	});

	it('joins a whole chain, however many pieces', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 80 }),
				wire({ x: 100, y: 80 }, { x: 250, y: 80 }),
				wire({ x: 250, y: 80 }, { x: 250, y: 200 })
			]
		};
		const merged = mergeWireChains(schematic);
		expect(merged).toHaveLength(1);
		expect(merged[0].points).toHaveLength(5);
	});

	it('joins pieces given in any order and either direction', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				// Second piece first, and pointing backwards.
				wire({ x: 100, y: 80 }, { x: 100, y: 0 }),
				wire({ x: 0, y: 0 }, { x: 100, y: 0 })
			]
		};
		const merged = mergeWireChains(schematic);
		expect(merged).toHaveLength(1);
		const ends = [merged[0].points[0], merged[0].points[merged[0].points.length - 1]];
		expect(ends).toContainEqual({ x: 0, y: 0 });
		expect(ends).toContainEqual({ x: 100, y: 80 });
	});

	it('leaves a real junction alone', () => {
		// Three ends meet: this is a node, not a bend.
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 80 }),
				wire({ x: 100, y: 0 }, { x: 200, y: 0 })
			]
		};
		expect(mergeWireChains(schematic)).toHaveLength(3);
	});

	it('leaves a joint that sits on a pin alone', () => {
		// The meeting point is a component's pin, so it is a terminal, not a bend.
		const schematic: Schematic = {
			instances: [part('resistor', 'R1', 130, 0)],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 80 })
			]
		};
		expect(mergeWireChains(schematic)).toHaveLength(2);
	});

	it('never changes what is connected to what', () => {
		const schematic: Schematic = {
			instances: [part('vsource', 'V1', 100, 200), part('resistor', 'R1', 330, 400)],
			wires: [
				wire({ x: 100, y: 170 }, { x: 300, y: 170 }),
				wire({ x: 300, y: 170 }, { x: 300, y: 400 })
			]
		};
		const before = netOf(schematic, 'R1', 'a') === netOf(schematic, 'V1', 'plus');
		const after = { ...schematic, wires: mergeWireChains(schematic) };
		expect(before).toBe(true);
		expect(netOf(after, 'R1', 'a')).toBe(netOf(after, 'V1', 'plus'));
	});

	it('leaves a closed loop as one wire rather than eating itself', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 })
			]
		};
		expect(mergeWireChains(schematic)).toHaveLength(1);
	});

	it('is idempotent', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 100, y: 0 }),
				wire({ x: 100, y: 0 }, { x: 100, y: 80 })
			]
		};
		const once = mergeWireChains(schematic);
		const twice = mergeWireChains({ ...schematic, wires: once });
		expect(twice).toEqual(once);
	});
});
