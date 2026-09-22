/**
 * The arithmetic of drawing a trace, apart from the canvas it is drawn on.
 *
 * The scope holds tens of thousands of samples per signal and repaints many
 * times a second, so what it draws has to be only what can be seen, reduced to
 * what a pixel can show. Kept here, as plain functions, so that reduction can
 * be checked against the samples it stands for — a trace that quietly dropped
 * a spike would be a scope lying about the one thing it is for.
 */

import { formatValue } from './units';

/** First index whose time is at or after `at`, or `time.length` if none is. */
function lowerBound(time: ArrayLike<number>, at: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] < at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** First index whose time is after `at`, or `time.length` if none is. */
function upperBound(time: ArrayLike<number>, at: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] <= at) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The samples a window of time needs, as `[start, end)`.
 *
 * One sample either side of the window as well, so the line runs out to the
 * frame's edge rather than stopping at the last sample inside it.
 */
export function visibleRange(
	time: ArrayLike<number>,
	from: number,
	to: number
): { start: number; end: number } {
	const start = Math.max(0, lowerBound(time, from) - 1);
	const end = Math.min(time.length, upperBound(time, to) + 1);
	return { start, end: Math.max(start, end) };
}

/**
 * A trace reduced to what its pixels can show.
 *
 * Every pixel column keeps its first and last sample, so the line joins its
 * neighbours where it did, and its lowest and highest, in the order they came,
 * so a spike one sample wide is still drawn at its full height. That is four
 * points a column at most, whatever the memory holds; a column with four
 * samples or fewer is passed through untouched, which is why a zoomed-in trace
 * looks exactly as it did before any of this.
 *
 * Returned as `[x0, v0, x1, v1, …]`: the position in pixels and the value
 * still in the signal's own units, for the caller to scale.
 */
export function decimate(
	time: ArrayLike<number>,
	values: ArrayLike<number>,
	start: number,
	end: number,
	toX: (t: number) => number
): number[] {
	const out: number[] = [];
	let i = start;
	while (i < end) {
		const x0 = toX(time[i]);
		const column = Math.floor(x0);
		let j = i + 1;
		while (j < end && Math.floor(toX(time[j])) === column) j++;
		if (j - i <= 4) {
			for (let k = i; k < j; k++) out.push(toX(time[k]), values[k]);
		} else {
			let min = i;
			let max = i;
			for (let k = i + 1; k < j; k++) {
				if (values[k] < values[min]) min = k;
				if (values[k] > values[max]) max = k;
			}
			const last = j - 1;
			const inside = min < max ? [min, max] : [max, min];
			for (const k of [i, ...inside, last]) {
				// Three or two points when the extremes are the ends themselves.
				const x = toX(time[k]);
				const n = out.length;
				if (n >= 2 && out[n - 2] === x && out[n - 1] === values[k]) continue;
				out.push(x, values[k]);
			}
		}
		i = j;
	}
	return out;
}

/** Lowest and highest value in `[start, end)`. A NaN compares false either way, so it is passed over. */
export function extent(
	values: ArrayLike<number> | undefined,
	start: number,
	end: number,
	into: { lo: number; hi: number } = { lo: Infinity, hi: -Infinity }
): { lo: number; hi: number } {
	if (!values) return into;
	for (let i = start; i < end && i < values.length; i++) {
		const v = values[i];
		if (v < into.lo) into.lo = v;
		if (v > into.hi) into.hi = v;
	}
	return into;
}

/**
 * Where the gridlines go: every multiple of `step` from `lo` to `hi`.
 *
 * Each one computed as a multiple rather than by adding the step again and
 * again, which drifts: the zero line came out as `-0.0555fV`. And anything
 * that close to zero is zero.
 */
export function ticks(lo: number, hi: number, step: number, slack = 0): number[] {
	if (!(step > 0) || !Number.isFinite(lo) || !Number.isFinite(hi)) return [];
	const out: number[] = [];
	// A line sitting exactly on an end is kept, whatever the division rounds to.
	const first = Math.ceil(lo / step - 1e-9);
	const last = hi + slack + step * 1e-9;
	for (let k = first; k * step <= last && out.length < 1000; k++) {
		const v = k * step;
		out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
	}
	return out;
}

/**
 * A time on the axis, with as many figures as its neighbours need to differ.
 *
 * Three significant figures are plenty at the start of a run and useless one
 * second into it: a fifty-microsecond window there labelled every gridline
 * "1s". The figures needed are however many decades lie between the time and
 * the spacing of the grid.
 */
export function timeLabel(t: number, step: number): string {
	if (t === 0 || !(step > 0)) return `${formatValue(t, 3)}s`;
	const decades = Math.floor(Math.log10(Math.abs(t))) - Math.floor(Math.log10(step));
	const digits = Math.min(Math.max(3, decades + 1), 15);
	return `${formatValue(t, digits)}s`;
}

/**
 * How far one wheel event turns the timebase, or null for one that should not.
 *
 * A mouse wheel sends a notch at a time and a trackpad sends dozens of small
 * deltas for one gesture; a fixed step per event made a trackpad swipe race
 * the timebase to a nanosecond. So the factor follows the size of the delta —
 * a notch, about a hundred pixels, is the 1.25 it always was. A sideways
 * scroll is not a zoom, and neither is Shift-scroll, which browsers turn
 * sideways.
 */
export function wheelFactor(event: {
	deltaX: number;
	deltaY: number;
	deltaMode: number;
}): number | null {
	if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return null;
	// Lines and pages in pixels, near enough: what browsers take them to be.
	const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
	const factor = Math.exp((event.deltaY * unit * Math.log(1.25)) / 100);
	return Math.min(Math.max(factor, 0.5), 2);
}
