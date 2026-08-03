/**
 * LEDs: the forward voltage the colour buys you, and matching the engine's
 * verdicts back to the parts on the canvas.
 *
 * Deciding *whether* a part burns out belongs to the engine, and is tested in
 * `crates/repath-core/tests/circuits.rs` against real circuits — the rule needs
 * a running solve to mean anything. What is left here is the fit that turns a
 * datasheet number into device parameters, and the bookkeeping that connects a
 * failure the engine reports by name to a symbol that has to be drawn charred.
 */

import { describe, expect, it } from 'vitest';
import type { PartFailure, TransientRun } from '$lib/engine';
import { brightness, findBurnouts, ledDiodeModel, ledRating, RATED } from './led';
import type { Instance, Schematic } from './model';

const VT = 8.617333262e-5 * 300.15;

/** Forward voltage the model produces at a given current — the inverse of the fit. */
function forwardVoltage(model: { is: number; n: number }, current: number): number {
	return model.n * VT * Math.log(current / model.is);
}

function led(name: string, params: Record<string, number | string> = {}): Instance {
	return {
		id: `i-${name}`,
		kind: 'led',
		name,
		x: 0,
		y: 0,
		rotation: 0,
		params: { colour: 'red', imax: RATED, ...params }
	};
}

/** A run that reports the given failures and nothing else of interest. */
function run(...failures: PartFailure[]): TransientRun {
	return {
		time: Float64Array.from([0, 1e-3]),
		signals: new Map(),
		signalsByIndex: [],
		unknownNames: [],
		nodeCount: 0,
		elementNames: failures.map((f) => f.name),
		currents: [],
		netNames: [],
		digital: [],
		failures,
		stats: { accepted_steps: 0, rejected_steps: 0, newton_iterations: 0, digital_events: 0 },
		elapsedMs: 0
	};
}

const failure = (name: string, time: number): PartFailure => ({
	name,
	time,
	peak: RATED * 4,
	rated: RATED
});

const schematicOf = (...instances: Instance[]): Schematic => ({ instances, wires: [] });

describe('ledDiodeModel', () => {
	it('puts the knee at the forward voltage the colour is quoted at', () => {
		for (const [colour, vf] of [
			['red', 1.9],
			['green', 2.2],
			['blue', 3.0]
		] as const) {
			const model = ledDiodeModel(colour, RATED);
			expect(forwardVoltage(model, RATED)).toBeCloseTo(vf, 6);
		}
	});

	it('drops less at a lower current, by about a tenth of a volt per decade', () => {
		const model = ledDiodeModel('red', RATED);
		const decade = forwardVoltage(model, RATED) - forwardVoltage(model, RATED / 10);
		expect(decade).toBeGreaterThan(0.1);
		expect(decade).toBeLessThan(0.14);
	});

	it('falls back to red rather than throwing on a colour it does not know', () => {
		expect(ledDiodeModel('ultraviolet', RATED)).toEqual(ledDiodeModel('red', RATED));
	});

	it('does not break down backwards, which is what makes it a diode and not a zener', () => {
		expect(ledDiodeModel('red', RATED).bv).toBeNull();
	});
});

describe('brightness', () => {
	it('is dark with no current, and reversed current is still dark', () => {
		expect(brightness(0, RATED)).toBe(0);
		expect(brightness(-0.02, RATED)).toBe(0);
	});

	it('reads as lit well before it reaches the rating', () => {
		// The point of the power law: a fifth of the current is not a fifth of the
		// apparent light, and drawing it that way would look switched off.
		expect(brightness(RATED / 5, RATED)).toBeGreaterThan(0.4);
	});

	it('blazes past full when overdriven, which is the warning before it goes', () => {
		expect(brightness(RATED, RATED)).toBeCloseTo(1, 6);
		expect(brightness(RATED * 5, RATED)).toBeGreaterThan(1);
	});
});

describe('ledRating', () => {
	it('takes the rating off the instance', () => {
		expect(ledRating(led('D1', { imax: 0.05 }))).toBe(0.05);
	});

	it('falls back rather than treating a missing or absurd rating as zero', () => {
		// A rating of zero would make every LED in the circuit burn on the first
		// sample, including ones carrying nothing.
		expect(ledRating(led('D1', { imax: 0 }))).toBe(RATED);
		expect(ledRating({ ...led('D1'), params: {} })).toBe(RATED);
	});
});

describe('ledDiodeModel rating', () => {
	it('hands the engine the rating, which is what decides the failure', () => {
		expect(ledDiodeModel('red', 0.05).rated).toBe(0.05);
	});

	it('anchors the curve at the reference current, not at the rating', () => {
		// Raising a rating says the part takes more abuse. It must not also move the
		// forward voltage, or protecting an LED would change how much current the
		// circuit around it draws in the first place.
		const ordinary = ledDiodeModel('red', RATED);
		const tough = ledDiodeModel('red', 1);
		expect(tough.is).toBe(ordinary.is);
		expect(tough.n).toBe(ordinary.n);
	});
});

describe('findBurnouts', () => {
	it('matches a failure to the instance the engine meant', () => {
		const [burnout] = findBurnouts(schematicOf(led('D1')), run(failure('D1', 3.21e-4)));
		expect(burnout.instanceId).toBe('i-D1');
		expect(burnout.time).toBe(3.21e-4);
		expect(burnout.rated).toBe(RATED);
	});

	it('says nothing when the engine reports nothing', () => {
		expect(findBurnouts(schematicOf(led('D1')), run())).toEqual([]);
	});

	it('keeps the order they went in', () => {
		const schematic = schematicOf(led('D1'), led('D2'));
		const order = findBurnouts(schematic, run(failure('D2', 1e-4), failure('D1', 9e-4)));
		expect(order.map((b) => b.name)).toEqual(['D2', 'D1']);
	});

	it('drops a failure whose part is no longer on the canvas', () => {
		// A result outlives the edits made after it, so a run can be describing a
		// component that has since been deleted or renamed. Charring a symbol that
		// is not there is not an option, and neither is throwing.
		expect(findBurnouts(schematicOf(led('D1')), run(failure('D9', 1e-4)))).toEqual([]);
	});

	it('ignores a failure reported against something that is not an LED', () => {
		const diode: Instance = { ...led('D1'), kind: 'diode' };
		expect(findBurnouts(schematicOf(diode), run(failure('D1', 1e-4)))).toEqual([]);
	});
});
