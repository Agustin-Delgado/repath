/**
 * The DC sweep: one source walked through a range of values, with the
 * operating point solved at each.
 *
 * What is here is the part that does not need the engine: turning a start, a
 * stop and a step into the values to solve at, refusing the ones that cannot be
 * done, and working out which parts of a drawing can be swept and which carry a
 * current worth plotting.
 */

import type { Instance, Schematic } from './schematic/model';

/** Most points one sweep solves. The engine refuses more, with the same number. */
export const MAX_DC_POINTS = 5000;

export const DEFAULT_DC_START = 0;
export const DEFAULT_DC_STOP = 5;
export const DEFAULT_DC_STEP = 0.05;

/** Parts that are an independent source the sweep can turn. */
const SWEEPABLE = new Set(['vsource', 'isource', 'battery', 'supply']);

export interface SweepSource {
	name: string;
	/** What it is set in: a current source in amperes, the rest in volts. */
	unit: 'V' | 'A';
}

/**
 * The values a sweep from `start` to `stop` in steps of `step` solves at, or
 * why there are none.
 *
 * Each value is worked out from the start rather than by adding the step over
 * and over, so a hundred steps of 0.1 land on 10 and not on 9.99999999999998.
 * The stop is reached when it is a whole number of steps away; when it is not,
 * the sweep ends at the last step short of it.
 */
export function dcSweepValues(
	start: number,
	stop: number,
	step: number
): { values: number[] } | { error: string } {
	if (![start, stop, step].every(Number.isFinite)) {
		return { error: 'Start, stop and step must be numbers.' };
	}
	if (start === stop) return { values: [start] };
	if (step === 0) return { error: 'The step cannot be zero.' };
	if (Math.sign(step) !== Math.sign(stop - start)) {
		return {
			error: `A step of ${step} moves away from ${stop}. Give the step the sign of stop − start.`
		};
	}
	// The slack is for a span that is a whole number of steps in decimal and a
	// hair short of one in binary.
	const steps = Math.floor((stop - start) / step + 1e-9);
	const count = steps + 1;
	if (count > MAX_DC_POINTS) {
		return {
			error: `${count} points: the maximum is ${MAX_DC_POINTS}. Use a larger step.`
		};
	}
	const values = new Array<number>(count);
	for (let k = 0; k < count; k++) values[k] = start + k * step;
	// Exactly the stop, when it is reached, rather than within an ulp of it.
	if (Math.abs(values[count - 1] - stop) <= Math.abs(step) * 1e-9) values[count - 1] = stop;
	return { values };
}

/** Names the compiled netlist gave its components. */
function componentNames(netlist: unknown): Set<string> {
	const components = (netlist as { components?: Array<{ name: string }> } | null)?.components;
	return new Set((components ?? []).map((c) => c.name));
}

/**
 * The sources on the drawing a sweep can turn, in the order they were placed.
 *
 * Only those the netlist really built: a supply drawn twice on one rail is
 * built once, and sweeping the copy that was dropped would move nothing.
 */
export function sweepSources(schematic: Schematic, netlist: unknown): SweepSource[] {
	const built = componentNames(netlist);
	return schematic.instances
		.filter((i) => SWEEPABLE.has(i.kind) && built.has(i.name))
		.map((i) => ({ name: i.name, unit: i.kind === 'isource' ? 'A' : 'V' }));
}

/**
 * The source a sweep turns: the one asked for while it is still there, or
 * failing that the first one on the drawing.
 */
export function pickSweepSource(sources: SweepSource[], wanted: string): SweepSource | null {
	return sources.find((s) => s.name === wanted) ?? sources[0] ?? null;
}

/** Parts that carry no current of their own to plot. */
const NO_CURRENT = new Set(['ground', 'probe', 'label', 'text', 'junction']);

/**
 * The parts on the drawing whose current a sweep can plot: every part the
 * netlist built under its own name, which is the name the engine reports its
 * current under.
 */
export function currentCandidates(schematic: Schematic, netlist: unknown): Instance[] {
	const built = componentNames(netlist);
	return schematic.instances.filter((i) => !NO_CURRENT.has(i.kind) && built.has(i.name));
}
