/**
 * Orthogonal wire routing.
 *
 * A* over the schematic grid, with costs rather than hard walls almost
 * everywhere. A router that refuses to produce a wire when the ideal path is
 * blocked is worse than one that produces a slightly ugly wire, so the only true
 * obstacles are component bodies; everything else — crossing a wire, running
 * alongside one, turning a corner — is expensive but possible. The route that
 * comes out is the cheapest compromise available, and when there is no
 * compromise it still finds something.
 *
 * The penalties encode what a person drawing by hand would care about, in order:
 * do not run *along* an existing wire (two conductors on the same line are
 * indistinguishable), do not cross one if you can help it, and do not add corners
 * for no reason.
 */

import { snapTo, type Vec2 } from '$lib/canvas';
import { definitionOf, rotatePoint, wireSegments, type Point, type Schematic } from './model';

export interface RouteOptions {
	grid: number;
	/** Ignore these instances when building obstacles — usually the ones moving. */
	ignoreInstances?: ReadonlySet<string>;
	/** Ignore these wires — usually the one being re-routed. */
	ignoreWires?: ReadonlySet<string>;
	/** Points the route is allowed to pass through even if something occupies them. */
	allow?: ReadonlySet<string>;
	/** Cap on explored cells, so a hopeless route fails fast instead of hanging. */
	effort?: number;
}

const COST = {
	/** Per grid step travelled. */
	step: 10,
	/**
	 * Each corner.
	 *
	 * Deliberately steep — worth about four steps of detour. A cheap turn lets the
	 * search staircase its way across the page, which is technically the shortest
	 * path and reads as a tangle.
	 */
	turn: 42,
	/** Passing through a point where a wire crosses this cell perpendicular. */
	cross: 30,
	/** Travelling along a cell an existing wire already occupies in the same axis. */
	overlap: 240,
	/** Passing over a component's body. Expensive, but not impossible. */
	body: 400,
	/** Landing on a pin that is not the destination. */
	foreignPin: 500,
	/**
	 * Leaving or meeting a pin across its lead instead of along it.
	 *
	 * Between two points there are usually several routes of the same length with
	 * the same number of corners, and the search takes whichever it expanded first.
	 * This settles those draws the way a person would draw them: carry on out of
	 * the terminal before turning, so the wire reads as coming *out* of the part
	 * rather than clipping past it.
	 *
	 * Charged only when travelling along the lead closes distance to the other end.
	 * That condition is the whole difference between this and an earlier attempt
	 * that had to be reverted: without it, a wire drawn straight up off a sideways
	 * pin would hook out and back to obey the rule, which is worse than the draw it
	 * was settling.
	 *
	 * Deliberately below `turn`. It decides a draw and nothing more: a route that
	 * would have to add a corner to leave or arrive along a lead should not bother,
	 * because a corner is the more visible cost of the two.
	 */
	stub: 30
};

/*
 * There was a clearance ring here — a charge for running through the cells
 * immediately around a component body, borrowed from the flow-chart routers that
 * wrap each shape in a protected rectangle.
 *
 * It is gone because it was answering a question nobody had asked. The case that
 * motivated it was a wire leaving a voltage source's terminal sideways, close to
 * the circle, which I judged from a synthetic test to look like it was passing the
 * source rather than connecting to it. The cost of that judgement showed up in the
 * plainest wiring there is: a source terminal at the same height as the part next
 * to it, where the straight wire pays for hugging its own symbol and the router
 * steps up and back down to avoid it. A pointless jog in the common case is far
 * worse than a slightly tight wire in a rare one.
 *
 * Wires running alongside symbols is normal in a schematic. Bodies are still
 * expensive to cross, which is the part that was ever in question.
 */

/**
 * Slight over-weighting of the heuristic.
 *
 * Among the many equally short orthogonal paths between two points, plain A*
 * picks whichever it happened to expand first, which is often a staircase.
 * Leaning on the heuristic makes it commit to heading towards the goal, which
 * produces the straight-then-turn shape a person would draw. The cost is that
 * the route can be a few percent longer than optimal, which nobody can see.
 */
const GREED = 1.06;

/**
 * Search box sizes, in grid cells beyond the endpoints.
 *
 * Twelve covers essentially every route on a normal schematic and keeps the
 * common case cheap. Forty is for the rarer case where the obstacle is wider
 * than the detour room, and is only ever tried when the cheap box came back with
 * a route that paid to cross something.
 */
const SEARCH_MARGINS = [12, 40];

/** Blocked and discouraged cells, built once per route. */
interface Obstacles {
	/** Cells covered by a component body. */
	body: Set<number>;
	/** Cells a wire runs through horizontally. */
	horizontal: Set<number>;
	/** Cells a wire runs through vertically. */
	vertical: Set<number>;
	/** Cells occupied by a pin. */
	pins: Set<number>;
	/**
	 * Which way each pin's lead points, by cell.
	 *
	 * Built from every instance, including any a drag is ignoring as obstacles: a
	 * part on the move still has leads that point somewhere, and the wire chasing
	 * it should still meet them end on.
	 */
	leads: Map<number, { x: number; y: number }>;
}

/**
 * Which way a pin's lead points, before rotation.
 *
 * The dominant axis of its offset from the body origin. Every pin in the catalog
 * sits at the end of a lead running along one axis — a MOSFET's drain at
 * (10, -30) hangs off the top, an op-amp input at (-30, -10) off the left — so
 * the larger component says which way it faces.
 */
function leadDirection(pin: { x: number; y: number }): { x: number; y: number } {
	if (Math.abs(pin.x) >= Math.abs(pin.y)) return { x: Math.sign(pin.x), y: 0 };
	return { x: 0, y: Math.sign(pin.y) };
}

/** The four ways a route may step, and the four cells that touch a cell. */
const DIRECTIONS = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1]
] as const;

/** Pack grid coordinates into one integer key. */
const cell = (gx: number, gy: number) => ((gx + 0x8000) << 16) | ((gy + 0x8000) & 0xffff);

function buildObstacles(schematic: Schematic, options: RouteOptions): Obstacles {
	const { grid } = options;
	const obstacles: Obstacles = {
		body: new Set(),
		horizontal: new Set(),
		vertical: new Set(),
		pins: new Set(),
		leads: new Map()
	};

	for (const instance of schematic.instances) {
		for (const pin of definitionOf(instance.kind).pins) {
			const offset = rotatePoint(pin.x, pin.y, instance.rotation);
			const lead = leadDirection(pin);
			const facing = rotatePoint(lead.x, lead.y, instance.rotation);
			obstacles.leads.set(
				cell(
					Math.round((instance.x + offset.x) / grid),
					Math.round((instance.y + offset.y) / grid)
				),
				{ x: Math.round(facing.x), y: Math.round(facing.y) }
			);
		}
	}

	for (const instance of schematic.instances) {
		if (options.ignoreInstances?.has(instance.id)) continue;
		const def = definitionOf(instance.kind);

		const corners = [
			{ x: def.box.x, y: def.box.y },
			{ x: def.box.x + def.box.w, y: def.box.y },
			{ x: def.box.x, y: def.box.y + def.box.h },
			{ x: def.box.x + def.box.w, y: def.box.y + def.box.h }
		].map((c) => rotatePoint(c.x, c.y, instance.rotation));

		// Shrink by a whisker: the box includes the pin leads, and a route has to
		// be able to reach a pin without paying the body penalty to get there.
		const inset = grid * 0.5;
		const minX = Math.min(...corners.map((c) => c.x)) + instance.x + inset;
		const maxX = Math.max(...corners.map((c) => c.x)) + instance.x - inset;
		const minY = Math.min(...corners.map((c) => c.y)) + instance.y + inset;
		const maxY = Math.max(...corners.map((c) => c.y)) + instance.y - inset;

		for (let x = Math.ceil(minX / grid); x <= Math.floor(maxX / grid); x++) {
			for (let y = Math.ceil(minY / grid); y <= Math.floor(maxY / grid); y++) {
				obstacles.body.add(cell(x, y));
			}
		}

		for (const pin of def.pins) {
			const offset = rotatePoint(pin.x, pin.y, instance.rotation);
			obstacles.pins.add(
				cell(Math.round((instance.x + offset.x) / grid), Math.round((instance.y + offset.y) / grid))
			);
		}
	}

	for (const wire of schematic.wires) {
		if (options.ignoreWires?.has(wire.id)) continue;
		for (const segment of wireSegments(wire)) {
			const horizontal = segment.a.y === segment.b.y;
			const from = horizontal ? segment.a.x : segment.a.y;
			const to = horizontal ? segment.b.x : segment.b.y;
			const fixed = horizontal ? segment.a.y : segment.a.x;
			const step = Math.sign(to - from) || 1;

			for (let v = from; step > 0 ? v <= to : v >= to; v += step * grid) {
				const key = horizontal
					? cell(Math.round(v / grid), Math.round(fixed / grid))
					: cell(Math.round(fixed / grid), Math.round(v / grid));
				(horizontal ? obstacles.horizontal : obstacles.vertical).add(key);
			}
		}
	}

	return obstacles;
}

/** Manhattan distance in grid steps, which never overestimates. */
const heuristic = (ax: number, ay: number, bx: number, by: number) =>
	(Math.abs(ax - bx) + Math.abs(ay - by)) * COST.step;

/**
 * Route from `from` to `to`, orthogonally, avoiding what it reasonably can.
 *
 * Returns the corners including both ends. Falls back to a plain L when the
 * search gives up, so a route always comes back.
 */
export function routeWire(
	schematic: Schematic,
	from: Point,
	to: Point,
	options: RouteOptions
): Point[] {
	const { grid } = options;
	const start = { x: Math.round(from.x / grid), y: Math.round(from.y / grid) };
	const goal = { x: Math.round(to.x / grid), y: Math.round(to.y / grid) };

	if (start.x === goal.x && start.y === goal.y) {
		return [{ x: from.x, y: from.y }];
	}

	const obstacles = buildObstacles(schematic, options);
	const effort = options.effort ?? 20_000;

	/**
	 * The leads at either end, and whether following them gets anywhere.
	 *
	 * A lead only earns its tie-break when travelling along it closes distance to
	 * the other end. Leaving a sideways pin to reach something directly above it
	 * gains nothing on that axis, so the wire is free to turn at the tip instead of
	 * hooking out and back — and a pin whose lead points away from the goal is left
	 * alone entirely.
	 */
	const productive = (lead: { x: number; y: number } | undefined, dx: number, dy: number) =>
		lead !== undefined && lead.x * dx + lead.y * dy > 0;

	const startLead = obstacles.leads.get(cell(start.x, start.y));
	const goalLead = obstacles.leads.get(cell(goal.x, goal.y));
	const leaveAlong = productive(startLead, goal.x - start.x, goal.y - start.y)
		? startLead
		: undefined;
	const arriveAlong = productive(goalLead, start.x - goal.x, start.y - goal.y)
		? goalLead
		: undefined;


	// The search is bounded — unbounded A* on an open grid wanders — but a bound
	// that is too tight hides the cheap way round. Nothing here is a hard wall, so
	// a clipped search still returns *a* route; it just settles for barging through
	// a component body when the detour around it lies outside the box.
	//
	// So: try a cheap box, and widen only when the result shows it paid a penalty
	// and the walls were in its way. The common route never pays for the retry.
	const bend = start.x !== goal.x && start.y !== goal.y ? COST.turn : 0;
	// The ideal L, plus one corner's slack. A route at or under this went straight
	// there and stepped over nothing; no wider box could improve on it.
	const clean = heuristic(start.x, start.y, goal.x, goal.y) + bend + COST.turn;

	let best: { path: Point[]; cost: number } | null = null;
	for (const margin of SEARCH_MARGINS) {
		const attempt = search(margin);
		if (attempt.path && (!best || attempt.cost < best.cost)) {
			best = { path: attempt.path, cost: attempt.cost };
		}
		if (attempt.exhausted) break;
		if (best && best.cost <= clean) break;
		// The bounds never turned anything away, so they are not what is costing it.
		if (!attempt.clipped) break;
	}

	return best ? best.path : elbow(from, to);

	interface Node {
		x: number;
		y: number;
		/** 0 = horizontal, 1 = vertical, -1 = no direction yet. */
		axis: number;
		cost: number;
		estimate: number;
		parent: Node | null;
	}

	/** One bounded pass. Reports *why* it failed, so the caller knows to widen. */
	function search(margin: number): {
		path?: Point[];
		/** Total cost of `path`, for comparing one box against another. */
		cost: number;
		/** The bounds turned a neighbour away — a wider box might get through. */
		clipped: boolean;
		/** Ran out of explored-cell budget. Widening would only cost more. */
		exhausted: boolean;
	} {
		const lo = { x: Math.min(start.x, goal.x) - margin, y: Math.min(start.y, goal.y) - margin };
		const hi = { x: Math.max(start.x, goal.x) + margin, y: Math.max(start.y, goal.y) + margin };
		let clipped = false;

		const open: Node[] = [
			{
				x: start.x,
				y: start.y,
				axis: -1,
				cost: 0,
				estimate: heuristic(start.x, start.y, goal.x, goal.y) * GREED,
				parent: null
			}
		];
		const best = new Map<number, number>();
		const key = (x: number, y: number, axis: number) => cell(x, y) * 4 + (axis + 1);
		best.set(key(start.x, start.y, -1), 0);

		let explored = 0;
		while (open.length > 0 && explored < effort) {
			// A linear scan is fine at this size — a schematic route explores hundreds
			// of cells, and a heap would cost more in bookkeeping than it saves.
			let bestIndex = 0;
			for (let i = 1; i < open.length; i++) {
				if (open[i].estimate < open[bestIndex].estimate) bestIndex = i;
			}
			const node = open.splice(bestIndex, 1)[0];
			explored++;

			if (node.x === goal.x && node.y === goal.y) {
				const path: Point[] = [];
				for (let n: Node | null = node; n; n = n.parent) {
					path.push({ x: n.x * grid, y: n.y * grid });
				}
				path.reverse();
				// Anchor the ends exactly where they were asked for, in case a pin sits
				// off-lattice.
				path[0] = { x: from.x, y: from.y };
				path[path.length - 1] = { x: to.x, y: to.y };
				return { path: collapse(path), cost: node.cost, clipped, exhausted: false };
			}

			for (const [dx, dy] of DIRECTIONS) {
				const nx = node.x + dx;
				const ny = node.y + dy;
				if (nx < lo.x || nx > hi.x || ny < lo.y || ny > hi.y) {
					clipped = true;
					continue;
				}

				const axis = dx === 0 ? 1 : 0;
				const here = cell(nx, ny);
				const isGoal = nx === goal.x && ny === goal.y;
				const permitted = options.allow?.has(`${nx},${ny}`) ?? false;

				let step = COST.step;
				if (node.axis !== -1 && node.axis !== axis) step += COST.turn;
				if (!isGoal && !permitted) {
					if (obstacles.body.has(here)) step += COST.body;
					if (obstacles.pins.has(here)) step += COST.foreignPin;

					// Running along a wire is much worse than crossing it: two conductors
					// drawn on the same line cannot be told apart.
					//
					// Charged only for cells the route passes *through*. The destination
					// is where it stops, so landing on the end of an existing wire is a
					// junction, not an overlap — and charging for it made every join onto
					// a wire end jog sideways and back to approach from a free direction.
					const along = axis === 0 ? obstacles.horizontal : obstacles.vertical;
					const across = axis === 0 ? obstacles.vertical : obstacles.horizontal;
					if (along.has(here)) step += COST.overlap;
					else if (across.has(here)) step += COST.cross;
				}

				// Break a tie towards leaving and meeting each pin along its lead.
				if (node.axis === -1 && leaveAlong && (dx !== leaveAlong.x || dy !== leaveAlong.y)) {
					step += COST.stub;
				}
				if (isGoal && arriveAlong && (dx !== -arriveAlong.x || dy !== -arriveAlong.y)) {
					step += COST.stub;
				}

				const cost = node.cost + step;
				const k = key(nx, ny, axis);
				const known = best.get(k);
				if (known !== undefined && known <= cost) continue;

				best.set(k, cost);
				open.push({
					x: nx,
					y: ny,
					axis,
					cost,
					estimate: cost + heuristic(nx, ny, goal.x, goal.y) * GREED,
					parent: node
				});
			}
		}

		return { cost: Infinity, clipped, exhausted: explored >= effort };
	}
}

/** Remove the interior points of straight runs, leaving only corners. */
function collapse(points: Point[]): Point[] {
	const out: Point[] = [points[0]];
	for (let i = 1; i < points.length - 1; i++) {
		const [before, here, after] = [out[out.length - 1], points[i], points[i + 1]];
		const straight =
			(before.x === here.x && here.x === after.x) || (before.y === here.y && here.y === after.y);
		if (!straight) out.push(here);
	}
	out.push(points[points.length - 1]);
	return out;
}

/** The plain two-segment route, used as a preview and as the fallback. */
export function elbow(from: Point, to: Point, verticalFirst = false): Point[] {
	if (from.x === to.x || from.y === to.y) return [from, to];
	const corner = verticalFirst ? { x: from.x, y: to.y } : { x: to.x, y: from.y };
	return [from, corner, to];
}

/** Snap a point to the routing lattice. */
export function onGrid(p: Vec2, grid: number): Point {
	return { x: snapTo(p.x, grid), y: snapTo(p.y, grid) };
}

/**
 * Does this path run through a component body?
 *
 * For deciding whether a shape that was arrived at some other way is good
 * enough, or whether the router should be asked instead. Bodies only: crossing a
 * wire is untidy, running through a symbol is wrong.
 */
export function crossesBody(schematic: Schematic, path: readonly Point[], options: RouteOptions): boolean {
	if (path.length < 2) return false;
	const { grid } = options;
	const obstacles = buildObstacles(schematic, options);

	for (let i = 0; i < path.length - 1; i++) {
		const a = path[i];
		const b = path[i + 1];
		const steps = Math.round((Math.abs(b.x - a.x) + Math.abs(b.y - a.y)) / grid);
		const dx = Math.sign(b.x - a.x);
		const dy = Math.sign(b.y - a.y);
		for (let k = 0; k <= steps; k++) {
			const x = Math.round(a.x / grid) + dx * k;
			const y = Math.round(a.y / grid) + dy * k;
			if (obstacles.body.has(cell(x, y))) return true;
		}
	}
	return false;
}
