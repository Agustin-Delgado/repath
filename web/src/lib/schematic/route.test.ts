import { describe, expect, it } from 'vitest';
import { defaultParams, wireSegments, type Instance, type Point, type Schematic } from './model';
import { elbow, routeWire } from './route';

const GRID = 10;

function place(kind: string, name: string, x: number, y: number, rotation: 0 | 90 = 0): Instance {
	return { id: name, kind, name, x, y, rotation, params: defaultParams(kind) };
}

function wire(...points: Point[]) {
	return { id: `w${points[0].x},${points[0].y}`, points };
}

const empty: Schematic = { instances: [], wires: [] };

/** Is every leg of the path horizontal or vertical? */
function isOrthogonal(path: Point[]): boolean {
	for (let i = 0; i < path.length - 1; i++) {
		if (path[i].x !== path[i + 1].x && path[i].y !== path[i + 1].y) return false;
	}
	return true;
}

function length(path: Point[]): number {
	let total = 0;
	for (let i = 0; i < path.length - 1; i++) {
		total += Math.abs(path[i].x - path[i + 1].x) + Math.abs(path[i].y - path[i + 1].y);
	}
	return total;
}

/** Every grid point the path passes through. */
function cells(path: Point[]): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < path.length - 1; i++) {
		const [a, b] = [path[i], path[i + 1]];
		const steps = (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) / GRID;
		const dx = Math.sign(b.x - a.x) * GRID;
		const dy = Math.sign(b.y - a.y) * GRID;
		for (let k = 0; k <= steps; k++) out.add(`${a.x + dx * k},${a.y + dy * k}`);
	}
	return out;
}

describe('routeWire', () => {
	it('runs straight when nothing is in the way', () => {
		const path = routeWire(empty, { x: 0, y: 0 }, { x: 100, y: 0 }, { grid: GRID });
		expect(path).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 }
		]);
	});

	it('takes one corner for a diagonal move', () => {
		const path = routeWire(empty, { x: 0, y: 0 }, { x: 100, y: 60 }, { grid: GRID });
		expect(isOrthogonal(path)).toBe(true);
		expect(path).toHaveLength(3);
		// A single bend is the shortest orthogonal route; anything longer means the
		// turn penalty is not doing its job.
		expect(length(path)).toBe(160);
	});

	it('goes around a component instead of through it', () => {
		const schematic: Schematic = { instances: [place('resistor', 'R1', 100, 0)], wires: [] };
		const path = routeWire(schematic, { x: 20, y: 0 }, { x: 180, y: 0 }, { grid: GRID });

		expect(isOrthogonal(path)).toBe(true);
		// The straight line runs through the resistor body, so the route detours.
		expect(length(path)).toBeGreaterThan(160);
		const occupied = cells(path);
		expect(occupied.has('100,0')).toBe(false);
	});

	it('will pass through a component if there is genuinely no way round', () => {
		// Boxed in on every side: the router must still produce something rather
		// than refuse. An ugly wire beats no wire.
		const schematic: Schematic = {
			instances: [
				place('resistor', 'R1', 100, 0, 90),
				place('resistor', 'R2', 100, 60, 90),
				place('resistor', 'R3', 100, -60, 90)
			],
			wires: []
		};
		const path = routeWire(schematic, { x: 40, y: 0 }, { x: 160, y: 0 }, { grid: GRID });
		expect(path.length).toBeGreaterThanOrEqual(2);
		expect(isOrthogonal(path)).toBe(true);
		expect(path[0]).toEqual({ x: 40, y: 0 });
		expect(path[path.length - 1]).toEqual({ x: 160, y: 0 });
	});

	it('prefers crossing a wire to running along it', () => {
		// A horizontal wire lies directly on the straight path. Overlapping it
		// would make two conductors indistinguishable, so the route steps aside.
		const schematic: Schematic = {
			instances: [],
			wires: [wire({ x: 0, y: 0 }, { x: 200, y: 0 })]
		};
		const path = routeWire(schematic, { x: 20, y: 0 }, { x: 180, y: 0 }, { grid: GRID });
		const occupied = cells(path);

		const overlapping = [...occupied].filter((key) => {
			const [x, y] = key.split(',').map(Number);
			return y === 0 && x > 20 && x < 180;
		});
		expect(overlapping).toHaveLength(0);
	});

	it('ignores the wires and parts it is told to', () => {
		const schematic: Schematic = { instances: [place('resistor', 'R1', 100, 0)], wires: [] };
		const path = routeWire(schematic, { x: 20, y: 0 }, { x: 180, y: 0 }, {
			grid: GRID,
			ignoreInstances: new Set(['R1'])
		});
		// With the obstacle excused, the straight line is available again.
		expect(length(path)).toBe(160);
	});

	it('always lands exactly on the endpoints it was given', () => {
		const schematic: Schematic = {
			instances: [place('npn', 'Q1', 200, 100)],
			wires: [wire({ x: 0, y: 50 }, { x: 400, y: 50 })]
		};
		const from = { x: 30, y: 130 };
		const to = { x: 350, y: 20 };
		const path = routeWire(schematic, from, to, { grid: GRID });

		expect(path[0]).toEqual(from);
		expect(path[path.length - 1]).toEqual(to);
		expect(isOrthogonal(path)).toBe(true);
	});

	it('does not staircase across open space', () => {
		// The classic A* failure: many equally short paths exist, and without a
		// steep turn penalty the search returns whichever zigzag it expanded first.
		const path = routeWire(empty, { x: 0, y: 0 }, { x: 200, y: 150 }, { grid: GRID });
		expect(path).toHaveLength(3);
	});

	it('stays tidy in a crowded schematic', () => {
		// Something like a real circuit: parts and wires between the endpoints.
		const schematic: Schematic = {
			instances: [
				place('resistor', 'R1', 150, 100),
				place('capacitor', 'C1', 250, 200, 90),
				place('npn', 'Q1', 350, 120)
			],
			wires: [
				wire({ x: 0, y: 60 }, { x: 400, y: 60 }),
				wire({ x: 250, y: 240 }, { x: 250, y: 320 })
			]
		};
		const path = routeWire(schematic, { x: 40, y: 300 }, { x: 420, y: 180 }, { grid: GRID });

		expect(isOrthogonal(path)).toBe(true);
		// A handful of corners is a route; a dozen is a tangle.
		expect(path.length).toBeLessThanOrEqual(5);
		// And it should not wander far: the Manhattan distance is 500.
		expect(length(path)).toBeLessThan(500 * 1.6);
	});

	it('collapses to a single point when the ends coincide', () => {
		const path = routeWire(empty, { x: 50, y: 50 }, { x: 50, y: 50 }, { grid: GRID });
		expect(path).toEqual([{ x: 50, y: 50 }]);
	});

	it('gives up gracefully and still returns an elbow', () => {
		// One step of effort cannot find anything, so the fallback has to appear.
		const path = routeWire(empty, { x: 0, y: 0 }, { x: 500, y: 300 }, { grid: GRID, effort: 1 });
		expect(isOrthogonal(path)).toBe(true);
		expect(path[0]).toEqual({ x: 0, y: 0 });
		expect(path[path.length - 1]).toEqual({ x: 500, y: 300 });
	});
});

describe('elbow', () => {
	it('is a straight line when the points already line up', () => {
		expect(elbow({ x: 0, y: 0 }, { x: 100, y: 0 })).toHaveLength(2);
	});

	it('bends horizontally first by default, vertically on request', () => {
		expect(elbow({ x: 0, y: 0 }, { x: 100, y: 50 })[1]).toEqual({ x: 100, y: 0 });
		expect(elbow({ x: 0, y: 0 }, { x: 100, y: 50 }, true)[1]).toEqual({ x: 0, y: 50 });
	});
});

describe('wireSegments', () => {
	it('walks the corners in order', () => {
		const w = wire({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 });
		const segments = wireSegments(w);
		expect(segments).toHaveLength(2);
		expect(segments[0]).toMatchObject({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, index: 0 });
		expect(segments[1]).toMatchObject({ a: { x: 100, y: 0 }, b: { x: 100, y: 80 }, index: 1 });
	});
});

describe('the search bounds', () => {
	/** A run of touching resistor bodies, forming one continuous barrier. */
	function barrier(count: number): Schematic {
		return {
			instances: Array.from({ length: count }, (_, i) => place('resistor', `R${i}`, i * 50, 0)),
			wires: []
		};
	}

	/** Does the path pass through the body of any component? */
	function throughABody(path: Point[], schematic: Schematic): boolean {
		const visited = cells(path);
		for (const instance of schematic.instances) {
			// The drawn body, inset the way the router insets it so a pin stays
			// reachable — this is the region a route is supposed to avoid.
			for (let x = instance.x - 20; x <= instance.x + 20; x += GRID) {
				if (visited.has(`${x},${instance.y}`)) return true;
			}
		}
		return false;
	}

	it('widen far enough to find the way around a wide obstacle', () => {
		// The wall runs from x=-30 to x=230. Getting round it means reaching x=240,
		// which is 140 units from the endpoints — beyond the tight first box. The
		// router used to give up on that and drive straight through the middle.
		const schematic = barrier(5);
		const path = routeWire(schematic, { x: 100, y: -120 }, { x: 100, y: 120 }, { grid: GRID });

		expect(throughABody(path, schematic)).toBe(false);
		expect(Math.max(...path.map((p) => p.x))).toBeGreaterThan(230);
		expect(isOrthogonal(path)).toBe(true);
	});

	it('still cut straight through when going around would cost more', () => {
		// Twenty-one bodies wide: the detour is now over a thousand units, which is
		// dearer than stepping over one component. Widening the box must not turn
		// the router into something that always takes the scenic route.
		const schematic = barrier(21);
		const path = routeWire(schematic, { x: 500, y: -120 }, { x: 500, y: 120 }, { grid: GRID });
		expect(length(path)).toBe(240);
	});

	it('leave an unobstructed route exactly as it was', () => {
		// The widening must never fire when the first box already found a clean
		// path, or every route pays for a second search.
		const path = routeWire(empty, { x: 0, y: 0 }, { x: 200, y: 100 }, { grid: GRID });
		expect(path).toHaveLength(3);
		expect(length(path)).toBe(300);
	});
});

describe('arriving at the destination', () => {
	it('does not jog sideways to join the end of a wire', () => {
		// Two runs facing each other with a gap. Joining them is a straight line;
		// charging the overlap penalty on the destination cell used to make the
		// router step off the line and back on again to approach from a free
		// direction, which is what pulling a part out of a chain looked like.
		const schematic: Schematic = {
			instances: [],
			wires: [
				wire({ x: 0, y: 0 }, { x: 200, y: 0 }),
				wire({ x: 300, y: 0 }, { x: 500, y: 0 })
			]
		};
		const path = routeWire(schematic, { x: 200, y: 0 }, { x: 300, y: 0 }, { grid: GRID });
		expect(path).toEqual([
			{ x: 200, y: 0 },
			{ x: 300, y: 0 }
		]);
	});

	it('still refuses to run along a wire on the way there', () => {
		// The exemption is for the destination only. Passing *through* a wire's
		// cells on the same axis is still what the penalty exists to prevent.
		const schematic: Schematic = {
			instances: [],
			wires: [wire({ x: 100, y: 0 }, { x: 400, y: 0 })]
		};
		const path = routeWire(schematic, { x: 100, y: 0 }, { x: 500, y: 0 }, { grid: GRID });
		expect(isOrthogonal(path)).toBe(true);
		// It has to leave the line rather than ride along it for 300 units.
		expect(path.some((p) => p.y !== 0)).toBe(true);
	});
});
