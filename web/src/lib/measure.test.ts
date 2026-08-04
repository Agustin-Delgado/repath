/**
 * Numbers checked against waveforms whose answers are known from the shape,
 * not from what this happens to return.
 */

import { describe, expect, it } from 'vitest';
import { measure } from './measure';

/** `count` samples of `f` over `[0, span]`, evenly spaced. */
function sampled(f: (t: number) => number, span: number, count: number) {
	const time = new Float64Array(count);
	const samples = new Float64Array(count);
	for (let i = 0; i < count; i++) {
		time[i] = (i / (count - 1)) * span;
		samples[i] = f(time[i]);
	}
	return { time, samples };
}

describe('measuring a sine', () => {
	// Ten cycles of 1 kHz, amplitude 2, sitting on 3 volts.
	const { time, samples } = sampled((t) => 3 + 2 * Math.sin(2 * Math.PI * 1000 * t), 10e-3, 20001);
	const m = measure(time, samples)!;

	it('finds its extremes and its average', () => {
		expect(m.min).toBeCloseTo(1, 3);
		expect(m.max).toBeCloseTo(5, 3);
		expect(m.peakToPeak).toBeCloseTo(4, 3);
		expect(m.mean).toBeCloseTo(3, 3);
	});

	it('gives true RMS, not amplitude over root two', () => {
		// About an offset the two are different, and the difference is the point:
		// sqrt(3² + 2²/2) = 3.317, where the textbook A/√2 would say 1.414.
		expect(m.rms).toBeCloseTo(Math.sqrt(9 + 2), 2);
	});

	it('finds the frequency from its own midpoint, not from zero', () => {
		// A signal riding on a supply never reaches zero. Counting zero crossings
		// would call this ordinary waveform frequency-less.
		expect(m.frequency).toBeCloseTo(1000, 0);
		expect(m.duty).toBeCloseTo(0.5, 2);
	});
});

describe('measuring a square wave', () => {
	const { time, samples } = sampled(
		(t) => ((t * 500) % 1 < 0.3 ? 5 : 0),
		20e-3,
		40001
	);
	const m = measure(time, samples)!;

	it('reads back the duty cycle it was given', () => {
		expect(m.frequency).toBeCloseTo(500, 0);
		expect(m.duty).toBeCloseTo(0.3, 2);
	});

	it('has an RMS that follows the duty', () => {
		// 5 V for three tenths of the time: 5·√0.3.
		expect(m.rms).toBeCloseTo(5 * Math.sqrt(0.3), 1);
	});
});

describe('measuring an edge', () => {
	it('times the ten-to-ninety of a rising exponential', () => {
		// One time constant of 1 ms; 10% to 90% is ln(9) of them.
		const { time, samples } = sampled((t) => 5 * (1 - Math.exp(-t / 1e-3)), 10e-3, 20001);
		const m = measure(time, samples)!;
		expect(m.riseTime).toBeCloseTo(Math.log(9) * 1e-3, 4);
		// It approaches from below and never passes its own end.
		expect(m.overshoot).toBeLessThan(0.01);
	});

	it('sees a step that rings past where it lands', () => {
		// A damped ring settling at 1. Its peak is not quite where the cosine turns:
		// the envelope is still falling, so the maximum sits slightly earlier, at
		// tan(wt) = -1/(w·tau). That puts it at 0.9498 ms with an envelope of
		// 0.6220, and an overshoot of 0.6142 — a number to check against rather
		// than a range to guess at.
		const { time, samples } = sampled(
			(t) => 1 - Math.exp(-t / 2e-3) * Math.cos(2 * Math.PI * 500 * t),
			20e-3,
			40001
		);
		const m = measure(time, samples)!;
		expect(m.overshoot).toBeCloseTo(0.6142, 3);
	});
});

describe('measuring something that is not doing anything', () => {
	it('reports a flat trace as flat rather than as very fast', () => {
		// Every sample of a constant is on its own midpoint. Counted naively that
		// is a crossing per sample, and a DC rail would come back as a megahertz.
		const { time, samples } = sampled(() => 2.5, 1e-3, 500);
		const m = measure(time, samples)!;
		expect(m.frequency).toBeNull();
		expect(m.peakToPeak).toBe(0);
		expect(m.mean).toBeCloseTo(2.5, 9);
		expect(m.rms).toBeCloseTo(2.5, 9);
	});

	it('has nothing to say about a run of one point', () => {
		expect(measure(Float64Array.from([0]), Float64Array.from([1]))).toBeNull();
	});
});
