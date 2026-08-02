/**
 * The circuit the app opens with, before anything touches it.
 *
 * Its own file because every other suite here starts by clearing the editor, and
 * that clearing was hiding a real defect: the startup schematic was the one way
 * into the editor that skipped tidying. Tests that normalise the state first
 * cannot see a bug that lives in the state they normalised away — which is
 * exactly why this one was reported three times before it reproduced.
 *
 * Nothing in this file may reach for `loadExample` or `clear` before it looks.
 */

import { describe, expect, it } from 'vitest';
import { app } from './state.svelte';
import { routeWire } from './schematic/route';
import { definitionOf, pinPosition, type Point } from './schematic/model';

/** Captured at module load, so no test order can spoil it. */
const pristine = app.schematic.wires.map((w) => w.points.map((p) => ({ ...p })));

const routeFor = (moving: Set<string>) => (from: Point, to: Point, settling: ReadonlySet<string>) =>
	routeWire(app.schematic, from, to, {
		grid: 10,
		ignoreInstances: moving,
		ignoreWires: settling,
		effort: 4000
	});

describe('the schematic the app hands over', () => {
	it('has its wires already folded into runs', () => {
		const meetings = new Map<string, number>();
		for (const points of pristine) {
			for (const index of [0, points.length - 1]) {
				const key = `${points[index].x},${points[index].y}`;
				meetings.set(key, (meetings.get(key) ?? 0) + 1);
			}
		}
		const pins = new Set<string>();
		for (const instance of app.schematic.instances) {
			for (const pin of definitionOf(instance.kind).pins) {
				const at = pinPosition(instance, pin);
				pins.add(`${at.x},${at.y}`);
			}
		}
		// Two wire ends meeting where no pin holds them is one conductor drawn in
		// two pieces. Until they are folded together that corner is a fixed point
		// every re-route has to honour, and dragging either end sends its wire off
		// to visit a bend that no longer means anything.
		const looseJoints = [...meetings].filter(([key, n]) => n === 2 && !pins.has(key));
		expect(looseJoints).toEqual([]);
		expect(pristine.length).toBeGreaterThan(0);
	});

	it('does not send a wire up and over when a part is dragged down', () => {
		const r1 = app.schematic.instances.find((i) => i.name === 'R1');
		expect(r1).toBeDefined();

		app.selection = [r1!.id];
		app.beginMove();
		app.applyMove(0, 30, routeFor(new Set(app.selection)));
		app.endMove();

		for (const wire of app.schematic.wires) {
			const ends = [wire.points[0], wire.points[wire.points.length - 1]];
			const top = Math.min(...ends.map((p) => p.y));
			const bottom = Math.max(...ends.map((p) => p.y));
			for (const p of wire.points) {
				expect(p.y).toBeGreaterThanOrEqual(top);
				expect(p.y).toBeLessThanOrEqual(bottom);
			}
		}
	});
});
