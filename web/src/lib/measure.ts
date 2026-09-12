/**
 * The numbers people read off a trace by eye.
 *
 * Every one of these is something you can get from two cursors and some
 * arithmetic, which is exactly why they belong here: doing it by hand is slow,
 * and being slow is why nobody checks. A bench scope has a button for each.
 *
 * All of them take the run's own time axis rather than assuming even spacing —
 * the timestep is adaptive, so the samples are closer together where the signal
 * is doing something, and treating them as evenly spaced would weight the quiet
 * parts of a waveform the same as the interesting ones.
 */

import type { DigitalTransition, LogicState } from './engine';

export interface Measurements {
	min: number;
	max: number;
	peakToPeak: number;
	/** Time average, which is what a DC meter would show. */
	mean: number;
	/** True RMS about zero, which is what an AC meter shows. */
	rms: number;
	/** Cycles per second, or null if it does not cross its own midpoint twice. */
	frequency: number | null;
	/** Seconds per cycle: the same fact, the way a cursor measures it. */
	period: number | null;
	/** Fraction of a period spent above the midpoint, or null without a period. */
	duty: number | null;
	/** 10% to 90% of the first rising edge, or null if there is not one. */
	riseTime: number | null;
	/**
	 * How far the first edge went past where it settled, as a fraction.
	 *
	 * Null unless there is an edge to overshoot from. This is the number that
	 * says whether a filter rings, and it is invisible on a plot scaled to fit.
	 */
	overshoot: number | null;
}

/** Trapezoid over an uneven axis: the area under a curve, done properly. */
function integrate(time: Float64Array, of: (i: number) => number): { area: number; span: number } {
	let area = 0;
	for (let i = 1; i < time.length; i++) {
		area += ((of(i) + of(i - 1)) / 2) * (time[i] - time[i - 1]);
	}
	return { area, span: time.length > 1 ? time[time.length - 1] - time[0] : 0 };
}

/** Where a signal crosses `level` between two samples, in time. */
function crossing(time: Float64Array, samples: Float64Array, i: number, level: number): number {
	const [a, b] = [samples[i - 1], samples[i]];
	const span = b - a;
	const alpha = Math.abs(span) < 1e-30 ? 0 : (level - a) / span;
	return time[i - 1] + (time[i] - time[i - 1]) * alpha;
}

export function measure(time: Float64Array, samples: Float64Array): Measurements | null {
	if (time.length < 2 || samples.length < 2) return null;

	let min = Infinity;
	let max = -Infinity;
	for (const v of samples) {
		if (v < min) min = v;
		if (v > max) max = v;
	}

	const { area, span } = integrate(time, (i) => samples[i]);
	const power = integrate(time, (i) => samples[i] * samples[i]).area;
	const mean = span > 0 ? area / span : samples[0];
	const rms = span > 0 ? Math.sqrt(Math.max(power / span, 0)) : Math.abs(samples[0]);

	// Period from crossings of the midpoint rather than of zero: a signal riding
	// on a supply never reaches zero, and a frequency of "none" would be wrong
	// about a perfectly ordinary square wave.
	const mid = (min + max) / 2;
	// Ignore wobble that is not a crossing. A flat trace is noise about its own
	// midpoint, and every sample of it would otherwise be a cycle.
	const alive = max - min > 1e-9;
	const rising: number[] = [];
	let above = samples[0] > mid;
	let aboveTime = 0;
	let lastEdge: number | null = null;
	for (let i = 1; alive && i < time.length; i++) {
		const nowAbove = samples[i] > mid;
		if (nowAbove === above) {
			if (above) aboveTime += time[i] - time[i - 1];
			continue;
		}
		const at = crossing(time, samples, i, mid);
		if (above) aboveTime += at - time[i - 1];
		else if (lastEdge !== null || rising.length === 0) rising.push(at);
		if (nowAbove) lastEdge = at;
		above = nowAbove;
		if (above) aboveTime += time[i] - at;
	}

	const cycles = rising.length - 1;
	const period = cycles >= 1 ? (rising[rising.length - 1] - rising[0]) / cycles : null;
	const frequency = period && period > 0 ? 1 / period : null;
	const duty = span > 0 && frequency ? aboveTime / span : null;

	return {
		min,
		max,
		peakToPeak: max - min,
		mean,
		rms,
		frequency,
		period: frequency ? period : null,
		duty,
		...edge(time, samples, min, max)
	};
}

/** What a logic lane can be asked: how often it goes round, and how much of that it spends high. */
export interface LogicMeasurements {
	frequency: number;
	period: number;
	/** Fraction of a cycle spent high, over the whole cycles measured. */
	duty: number;
	/** Whole cycles the answer is averaged over. */
	cycles: number;
}

/**
 * Frequency and duty of a logic lane, from its transitions.
 *
 * A lane is a list of edges rather than samples, so this is the analog
 * measurement with the hard part already done: a cycle is one rising edge to
 * the next, and the answer is averaged over every whole cycle in memory — a
 * ripple counter's slowest stage may have only one, and one is enough.
 *
 * Null with fewer than two rising edges, which is a lane that has not gone
 * round even once. Anything but a clean high or low — unknown, high-Z — is
 * treated as not high, so a lane that spent its time undriven does not report a
 * duty for a signal it never carried.
 */
export function measureLogic(
	events: readonly DigitalTransition[],
	opening: LogicState
): LogicMeasurements | null {
	const rising: number[] = [];
	// Time spent high, and the part of it that belongs to the cycle begun by the
	// latest rising edge. The period is measured from the first rising edge to
	// the last, so the duty is taken over that same stretch: the high time after
	// the last rising edge is the start of a cycle that has not finished, and
	// counting it would depend on where the memory happened to stop.
	let high = 0;
	let sinceLastRise = 0;
	let level = opening;
	let since = 0;
	for (const event of events) {
		if (event.state === level) continue;
		if (event.state === 'high' && level !== 'high') {
			rising.push(event.time);
			sinceLastRise = 0;
		} else if (level === 'high' && rising.length > 0) {
			high += event.time - since;
			sinceLastRise += event.time - since;
		}
		level = event.state;
		since = event.time;
	}
	const cycles = rising.length - 1;
	if (cycles < 1) return null;
	const measured = rising[rising.length - 1] - rising[0];
	const period = measured / cycles;
	if (!(period > 0)) return null;
	const duty = Math.min((high - sinceLastRise) / measured, 1);
	return { frequency: 1 / period, period, duty, cycles };
}

/** Rise time and overshoot of the first rising edge, if there is one. */
function edge(
	time: Float64Array,
	samples: Float64Array,
	min: number,
	max: number
): { riseTime: number | null; overshoot: number | null } {
	const swing = max - min;
	if (swing < 1e-12) return { riseTime: null, overshoot: null };
	const low = min + swing * 0.1;
	const high = min + swing * 0.9;

	let from: number | null = null;
	for (let i = 1; i < time.length; i++) {
		if (from === null && samples[i - 1] < low && samples[i] >= low) {
			from = crossing(time, samples, i, low);
			continue;
		}
		if (from !== null && samples[i - 1] < high && samples[i] >= high) {
			const to = crossing(time, samples, i, high);
			// What it settles at, taken from the far end rather than from the peak:
			// overshoot is the distance between where it went and where it stopped.
			const settled = samples[samples.length - 1];
			const rise = settled - min;
			return {
				riseTime: to - from,
				overshoot: rise > 1e-12 ? Math.max((max - settled) / rise, 0) : null
			};
		}
	}
	return { riseTime: null, overshoot: null };
}
