import { describe, expect, it } from 'vitest';
import {
	buildConnectivity,
	junctionDots,
	liesWithin,
	mergeWireChains,
	pinKey,
	splitAtJunctions,
	trimOverlaps
} from './nets';
import {
	defaultParams,
	simplifyPath,
	type Instance,
	type Point,
	type Schematic,
	type Wire
} from './model';

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

describe('trimOverlaps', () => {
	const shapes = (wires: Wire[]) => wires.map((w) => w.points.map((p) => `${p.x},${p.y}`).join(' '));

	it('cuts back a wire that doubles along its neighbour', () => {
		// Reported by moving a ground rail up: its end stayed pinned where it was
		// plugged in, so the wire reached back down alongside the wire it was
		// plugged into. Two conductors on the same line, which is the thing the
		// router pays most to avoid.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'moved', points: [{ x: 300, y: 260 }, { x: 100, y: 260 }, { x: 100, y: 290 }] },
				{ id: 'rail', points: [{ x: 100, y: 230 }, { x: 100, y: 290 }] }
			]
		};
		expect(shapes(trimOverlaps(schematic))).toEqual(['300,260 100,260', '100,230 100,290']);
	});

	it('leaves a wire that merely touches another', () => {
		// Meeting at a point is a junction, not an overlap, and must survive.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'a', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
				{ id: 'b', points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] }
			]
		};
		expect(shapes(trimOverlaps(schematic))).toEqual(['0,0 100,0', '100,0 100,100']);
	});

	it('leaves a wire that crosses another', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'a', points: [{ x: 0, y: 50 }, { x: 200, y: 50 }] },
				{ id: 'b', points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] }
			]
		};
		expect(shapes(trimOverlaps(schematic))).toEqual(['0,50 200,50', '100,0 100,100']);
	});

	it('leaves a partial overlap alone', () => {
		// Cutting here would move a corner rather than remove one, and changing the
		// drawn shape is not what this is for.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'a', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
				{ id: 'b', points: [{ x: 50, y: 0 }, { x: 200, y: 0 }] }
			]
		};
		expect(shapes(trimOverlaps(schematic))).toEqual(['0,0 100,0', '50,0 200,0']);
	});

	it('removes a wire that is entirely covered', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'long', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
				{ id: 'duplicate', points: [{ x: 50, y: 0 }, { x: 150, y: 0 }] }
			]
		};
		expect(shapes(trimOverlaps(schematic))).toEqual(['0,0 200,0']);
	});

	it('does not cut both halves of a mutual overlap', () => {
		// The bug in the first version of this. Checking every wire against the
		// original set looks equivalent to checking against the current one and is
		// not: two wires that cover each other were both cut, and the connection
		// they shared went with them. It cost twenty-nine connections across a
		// sweep of the examples before it was measured.
		const schematic: Schematic = {
			instances: [part('resistor', 'R1', 0, 0), part('resistor', 'R2', 200, 0)],
			wires: [
				{ id: 'a', points: [{ x: 30, y: 0 }, { x: 170, y: 0 }] },
				{ id: 'b', points: [{ x: 30, y: 0 }, { x: 170, y: 0 }] }
			]
		};
		const trimmed = trimOverlaps(schematic);
		// One of them goes; the other has to stay, or the two resistors part company.
		expect(trimmed).toHaveLength(1);
		expect(buildConnectivity({ ...schematic, wires: trimmed }).nets.length).toBe(
			buildConnectivity(schematic).nets.length
		);
	});

	it('keeps every connection it had', () => {
		// The segment removed is covered along its whole length, so the wire doing
		// the covering reaches whatever the trimmed part reached. That is what makes
		// this safe rather than merely tidy.
		const schematic: Schematic = {
			instances: [part('resistor', 'R1', 100, 290)],
			wires: [
				{ id: 'moved', points: [{ x: 300, y: 260 }, { x: 100, y: 260 }, { x: 100, y: 290 }] },
				{ id: 'rail', points: [{ x: 100, y: 230 }, { x: 100, y: 290 }] }
			]
		};
		const before = buildConnectivity(schematic).nets.length;
		const after = buildConnectivity({ ...schematic, wires: trimOverlaps(schematic) }).nets.length;
		expect(after).toBe(before);
	});
});

describe('splitAtJunctions', () => {
	let n = 0;
	const fresh = () => `s${++n}`;
	const shapes = (wires: Wire[]) => wires.map((w) => w.points.map((p) => `${p.x},${p.y}`).join(' '));

	it('splits a wire where another one ends partway along it', () => {
		// Until it is split, that junction is a bare point on someone else's
		// segment: move the host and the branch is left holding nothing, with every
		// pin still attached to a wire and no warning to show for it.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'host', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
				{ id: 'branch', points: [{ x: 100, y: 0 }, { x: 100, y: 80 }] }
			]
		};
		expect(shapes(splitAtJunctions(schematic, fresh)).sort()).toEqual(
			['0,0 100,0', '100,0 100,80', '100,0 200,0'].sort()
		);
	});

	it('splits at a corner too', () => {
		// A branch can land on a bend as easily as on a straight, and a bend is not
		// an interior point of either segment meeting there — walking segments alone
		// steps straight over it.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'host', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] },
				{ id: 'branch', points: [{ x: 100, y: 0 }, { x: 200, y: 0 }] }
			]
		};
		expect(shapes(splitAtJunctions(schematic, fresh)).sort()).toEqual(
			['0,0 100,0', '100,0 100,100', '100,0 200,0'].sort()
		);
	});

	it('splits where a pin sits partway along a wire', () => {
		// The mirror image, and the one that cost the most. A wire is not a follower
		// of a pin in its middle, because following is decided by looking at a
		// wire's two ends — so move the part, or re-route the wire, and the pin is
		// left behind with no warning to show for it.
		const schematic: Schematic = {
			instances: [part('resistor', 'R1', 100, 0, 90)], // pins (100,-30) and (100,30)
			wires: [{ id: 'run', points: [{ x: 0, y: 30 }, { x: 200, y: 30 }] }]
		};
		expect(shapes(splitAtJunctions(schematic, fresh)).sort()).toEqual(
			['0,30 100,30', '100,30 200,30'].sort()
		);
	});

	it('leaves a wire alone when nothing ends on it', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'a', points: [{ x: 0, y: 50 }, { x: 200, y: 50 }] },
				{ id: 'b', points: [{ x: 100, y: 0 }, { x: 100, y: 20 }] }
			]
		};
		expect(shapes(splitAtJunctions(schematic, fresh))).toEqual(['0,50 200,50', '100,0 100,20']);
	});

	it('leaves two wires that merely meet end to end', () => {
		// Nothing lands *inside* anything here, so there is nothing to split.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'a', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
				{ id: 'b', points: [{ x: 100, y: 0 }, { x: 100, y: 100 }] }
			]
		};
		expect(shapes(splitAtJunctions(schematic, fresh))).toEqual(['0,0 100,0', '100,0 100,100']);
	});

	it('does not change what is drawn, only how many wires draw it', () => {
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'host', points: [{ x: 0, y: 0 }, { x: 300, y: 0 }] },
				{ id: 'one', points: [{ x: 100, y: 0 }, { x: 100, y: 80 }] },
				{ id: 'two', points: [{ x: 200, y: 0 }, { x: 200, y: 80 }] }
			]
		};
		const split = splitAtJunctions(schematic, fresh);
		// Two branches cut the host into three, and the branches are still two.
		expect(split).toHaveLength(5);
		expect(buildConnectivity({ ...schematic, wires: split }).nets.length).toBe(
			buildConnectivity(schematic).nets.length
		);
	});

	it('is not undone by folding chains back together', () => {
		// Three ends meeting is a junction, and merging only folds a point where
		// exactly two do — so the split survives the next tidy.
		const schematic: Schematic = {
			instances: [],
			wires: [
				{ id: 'host', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] },
				{ id: 'branch', points: [{ x: 100, y: 0 }, { x: 100, y: 80 }] }
			]
		};
		const split = splitAtJunctions(schematic, fresh);
		expect(mergeWireChains({ ...schematic, wires: split })).toHaveLength(split.length);
	});
});

describe('simplifyPath and loops', () => {
	it('cuts out an excursion that returns to where it started', () => {
		// A wire dragged while both ends are pinned grows a leg at each end to reach
		// back, and pushed far enough those legs cross: the path leaves a point and
		// later returns to it. Everything in between carries no current and draws as
		// a knot — and one such knot was splitting a net once every few thousand
		// edits.
		expect(
			simplifyPath([
				{ x: 390, y: 260 },
				{ x: 350, y: 260 },
				{ x: 350, y: 280 },
				{ x: 390, y: 280 },
				{ x: 390, y: 260 },
				{ x: 330, y: 260 }
			])
		).toEqual([
			{ x: 390, y: 260 },
			{ x: 330, y: 260 }
		]);
	});

	it('leaves an honest path alone', () => {
		const path = [
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 }
		];
		expect(simplifyPath(path)).toEqual(path);
	});
});
