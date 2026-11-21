/**
 * The spectrum of a transient trace: what a scope's FFT button shows.
 *
 * The run's time axis is adaptive, so a trace is resampled onto an even grid
 * before it is transformed. Linear interpolation, on purpose: between two
 * accepted steps the engine's own integrator treats the waveform as a short
 * polynomial chosen to keep its local error small, and a straight line is what
 * the scope already draws there. A cubic or band-limited (sinc) interpolator
 * looks smoother but rings at every switching edge — a square wave would grow
 * overshoot it never had, and that overshoot is spectral content. The price of
 * a straight line is a gentle roll-off (sinc² of the local step) near the rate
 * the engine was stepping at, which the grid keeps far away by sampling at
 * least twice as densely as the steps are on average.
 *
 * The grid is a power of two, so the transform is a plain iterative radix-2
 * FFT. Mixed-radix or Bluestein would only be needed for an arbitrary length,
 * and the length here is ours to choose: resampling decides it. It runs in
 * TypeScript rather than in the wasm engine because it is cheap there — 65536
 * points transform in a few milliseconds — and a trip into wasm would copy the
 * samples across for nothing.
 *
 * Amplitudes are peak volts, one-sided, corrected for the window's coherent
 * gain: a 1 V sine reads 1 V, which is 0 dB on a scale referred to 1 V peak.
 */

export type WindowKind = 'rectangular' | 'hann' | 'blackman-harris' | 'flat-top';

export const WINDOWS: readonly WindowKind[] = ['rectangular', 'hann', 'blackman-harris', 'flat-top'];

/** Cosine-sum coefficients, a0 − a1·cos + a2·cos2 − a3·cos3 + a4·cos4. */
const COEFFICIENTS: Record<WindowKind, readonly number[]> = {
	rectangular: [1],
	hann: [0.5, 0.5],
	// Four-term, −92 dB sidelobes: for a small harmonic beside a large one.
	'blackman-harris': [0.35875, 0.48829, 0.14128, 0.01168],
	// The five-term flat top: a lobe flat to a hundredth of a dB, for levels.
	'flat-top': [0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]
};

/**
 * Half the width of each window's main lobe, in bins. A tone's power is summed
 * over this many bins either side of its peak, so its level does not depend on
 * where between two bins it fell.
 */
const LOBE: Record<WindowKind, number> = {
	rectangular: 1,
	hann: 2,
	'blackman-harris': 4,
	'flat-top': 5
};

export interface WindowShape {
	kind: WindowKind;
	values: Float64Array;
	/** Mean of the window: what a coherent tone's bin is scaled by. */
	coherentGain: number;
	/** Equivalent noise bandwidth, in bins: N·Σw² / (Σw)². */
	enbw: number;
	lobe: number;
}

const windowCache = new Map<string, WindowShape>();

/**
 * A window of `n` points, in its periodic form — the one a DFT of length `n`
 * sees as one period, which is what makes its coherent gain exactly a0.
 */
export function windowShape(kind: WindowKind, n: number): WindowShape {
	const key = `${kind}:${n}`;
	const cached = windowCache.get(key);
	if (cached) return cached;
	const a = COEFFICIENTS[kind];
	const values = new Float64Array(n);
	let sum = 0;
	let squares = 0;
	for (let i = 0; i < n; i++) {
		let w = 0;
		for (let k = 0; k < a.length; k++) {
			w += (k % 2 === 0 ? 1 : -1) * a[k] * Math.cos((2 * Math.PI * k * i) / n);
		}
		values[i] = w;
		sum += w;
		squares += w * w;
	}
	const shape: WindowShape = {
		kind,
		values,
		coherentGain: sum / n,
		enbw: (n * squares) / (sum * sum),
		lobe: LOBE[kind]
	};
	// A handful of lengths and four windows: never more than a few dozen.
	if (windowCache.size > 32) windowCache.clear();
	windowCache.set(key, shape);
	return shape;
}

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			let t = re[i];
			re[i] = re[j];
			re[j] = t;
			t = im[i];
			im[i] = im[j];
			im[j] = t;
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const half = size >> 1;
		const step = (-2 * Math.PI) / size;
		// The twiddle is advanced by recurrence within a block and recomputed
		// for each block, so rounding cannot build up past one block.
		const wr = Math.cos(step);
		const wi = Math.sin(step);
		for (let start = 0; start < n; start += size) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < half; k++) {
				const a = start + k;
				const b = a + half;
				const tr = re[b] * cr - im[b] * ci;
				const ti = re[b] * ci + im[b] * cr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
				const next = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = next;
			}
		}
	}
}

/**
 * The trace at `n` evenly spaced instants from `from`, `dt` apart, by straight
 * lines between the samples either side. Outside the samples, the nearest end.
 */
export function resample(
	time: ArrayLike<number>,
	samples: ArrayLike<number>,
	from: number,
	dt: number,
	n: number
): Float64Array {
	const out = new Float64Array(n);
	const count = Math.min(time.length, samples.length);
	if (count === 0) return out;
	// Walked once, forwards: the instants and the samples both only increase.
	let lo = 0;
	let hi = count;
	const first = from;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] <= first) lo = mid + 1;
		else hi = mid;
	}
	let j = lo; // first sample after the instant
	for (let k = 0; k < n; k++) {
		const t = from + k * dt;
		while (j < count && time[j] <= t) j++;
		if (j === 0) out[k] = samples[0];
		else if (j === count) out[k] = samples[count - 1];
		else {
			const t0 = time[j - 1];
			const t1 = time[j];
			const span = t1 - t0;
			const alpha = span > 0 ? (t - t0) / span : 0;
			out[k] = samples[j - 1] + (samples[j] - samples[j - 1]) * alpha;
		}
	}
	return out;
}

export interface Spectrum {
	/** Bin spacing, in hertz: one over the span. */
	df: number;
	/** Points transformed. */
	n: number;
	/** Peak amplitude per bin, bins 0 to n/2. Bin 0 is the DC level, unsigned. */
	amplitude: Float64Array;
	/** The time average, signed: what bin 0 stands for. */
	dc: number;
	window: WindowShape;
	from: number;
	to: number;
}

/** Fewest and most points the grid is given. */
export const POINTS = { least: 1024, most: 65536 } as const;

/** The grid for `count` raw samples: a power of two, at least twice as many. */
export function gridPoints(count: number): number {
	let n = POINTS.least;
	while (n < 2 * count && n < POINTS.most) n *= 2;
	return n;
}

/**
 * The spectrum of the trace between `from` and `to`, or null if there is
 * nothing there to transform.
 *
 * The mean is taken out before the window goes on and put back as bin 0.
 * Windowed, a DC level spreads over the window's lobe and buries anything in
 * the first few bins beside it; taken out first, bin 0 says exactly what the
 * mean was and the bins next to it say only what the signal did.
 */
export function spectrum(
	time: ArrayLike<number>,
	samples: ArrayLike<number>,
	from: number,
	to: number,
	options: { window?: WindowKind; points?: number } = {}
): Spectrum | null {
	const span = to - from;
	if (!(span > 0) || time.length < 2) return null;
	if (time[time.length - 1] < from || time[0] > to) return null;
	let inside = 0;
	for (let i = 0; i < time.length; i++) if (time[i] >= from && time[i] <= to) inside++;
	const n = options.points ?? gridPoints(inside);
	if ((n & (n - 1)) !== 0 || n < 4) throw new Error('spectrum: points must be a power of two');
	const dt = span / n;
	const re = resample(time, samples, from, dt, n);
	let mean = 0;
	for (let i = 0; i < n; i++) mean += re[i];
	mean /= n;
	const shape = windowShape(options.window ?? 'hann', n);
	for (let i = 0; i < n; i++) re[i] = (re[i] - mean) * shape.values[i];
	const im = new Float64Array(n);
	fft(re, im);
	const half = n / 2;
	const amplitude = new Float64Array(half + 1);
	const scale = 2 / (n * shape.coherentGain);
	for (let k = 1; k <= half; k++) amplitude[k] = Math.hypot(re[k], im[k]) * scale;
	// The Nyquist bin has no mirror image to fold in.
	amplitude[half] /= 2;
	amplitude[0] = Math.abs(mean);
	return { df: 1 / span, n, amplitude, dc: mean, window: shape, from, to };
}

export interface Tone {
	frequency: number;
	/** Peak volts. */
	amplitude: number;
	/** The bin it peaks in. */
	bin: number;
}

/**
 * A tone's level and frequency, from the bins of its lobe around `bin`.
 *
 * The level is the power over the lobe divided by the window's noise
 * bandwidth, which does not care where between two bins the tone fell — the
 * peak bin alone reads up to 1.4 dB low with a Hann window. The frequency is
 * the power-weighted centre of the lobe.
 */
export function toneAt(spec: Spectrum, bin: number): Tone {
	const { amplitude, window } = spec;
	const last = amplitude.length - 1;
	const lo = Math.max(1, bin - window.lobe);
	const hi = Math.min(last, bin + window.lobe);
	let power = 0;
	let moment = 0;
	for (let k = lo; k <= hi; k++) {
		const p = amplitude[k] * amplitude[k];
		power += p;
		moment += p * k;
	}
	const centre = power > 0 ? moment / power : bin;
	return {
		frequency: centre * spec.df,
		amplitude: Math.sqrt(power / window.enbw),
		bin
	};
}

/**
 * The strongest tones, largest first: each a local maximum standing above its
 * neighbours across a whole lobe, so one tone is not counted once per bin of
 * its own skirt. DC is not a tone; `Spectrum.dc` says what it is.
 */
export function peaks(spec: Spectrum, count = 5, floor = 1e-9, below = 1e-4): Tone[] {
	const { amplitude, window } = spec;
	const last = amplitude.length - 1;
	const found: Tone[] = [];
	for (let k = 1; k <= last; k++) {
		const a = amplitude[k];
		if (a < floor) continue;
		let highest = true;
		for (let j = Math.max(1, k - window.lobe); j <= Math.min(last, k + window.lobe); j++) {
			// Ties go to the lower bin, so a flat top is one peak, not several.
			if (amplitude[j] > a || (amplitude[j] === a && j < k)) {
				highest = false;
				break;
			}
		}
		if (highest) found.push(toneAt(spec, k));
	}
	found.sort((x, y) => y.amplitude - x.amplitude);
	// Nothing more than 80 dB (by default) under the strongest: down there
	// are the window's sidelobes and the rounding of the resampling, not tones.
	const least = (found[0]?.amplitude ?? 0) * below;
	return found.filter((tone) => tone.amplitude >= least).slice(0, count);
}

/**
 * Fewest periods of the fundamental the span must hold for a THD figure
 * through a window: enough that neighbouring harmonics' lobes do not overlap.
 */
export function periodsForDistortion(kind: WindowKind): number {
	return 2 * LOBE[kind] + 1;
}

/** Harmonics counted into a THD figure: the 2nd up to this one. */
export const THD_HARMONICS = 10;

export interface Distortion {
	fundamental: Tone;
	/** The 2nd harmonic onwards, as far as the 10th or the Nyquist bin. */
	harmonics: Tone[];
	/** RMS of the harmonics over the fundamental: a ratio, not a percentage. */
	thd: number;
}

/**
 * Total harmonic distortion of the strongest tone.
 *
 * Each harmonic is looked for in the bins nearest its multiple of the measured
 * fundamental and read the way a tone is, so a harmonic that fell between
 * bins is not under-counted. A harmonic below the noise contributes the
 * noise, as it would on an analyser.
 */
export function distortion(spec: Spectrum, harmonics = THD_HARMONICS): Distortion | null {
	const [fundamental] = peaks(spec, 1);
	if (!fundamental || fundamental.frequency <= 0) return null;
	// Harmonics closer together than a lobe's width share bins, and each would
	// be read with a share of its neighbour's power: a pure sine over three
	// periods through a Hann window read 40%. Not a figure to give.
	if (fundamental.frequency / spec.df < periodsForDistortion(spec.window.kind) - 0.5) return null;
	const { amplitude } = spec;
	const last = amplitude.length - 1;
	const found: Tone[] = [];
	let power = 0;
	for (let h = 2; h <= harmonics; h++) {
		const expected = (h * fundamental.frequency) / spec.df;
		if (expected > last - 1) break;
		// The largest bin within one either side of where the multiple lands.
		let bin = Math.round(expected);
		for (const k of [bin - 1, bin + 1]) {
			if (k >= 1 && k <= last && amplitude[k] > amplitude[bin]) bin = k;
		}
		const tone = toneAt(spec, bin);
		found.push(tone);
		power += tone.amplitude * tone.amplitude;
	}
	if (found.length === 0) return null;
	return { fundamental, harmonics: found, thd: Math.sqrt(power) / fundamental.amplitude };
}

/** Decibels referred to 1 V peak, floored so silence is a number. */
export function dbv(volts: number): number {
	return 20 * Math.log10(Math.max(volts, 1e-12));
}

/** What the spectrum is taken over: the screen, whole periods ending at its right edge, or all of memory. */
export type SpectrumSpan = 'window' | 'periods' | 'memory';

export interface SpectrumSettings {
	/** Whether the spectrum is shown under the scope. */
	on: boolean;
	/** Which analog trace, counted down the scope's list from 0. */
	source: number;
	window: WindowKind;
	span: SpectrumSpan;
	/** How many periods, for a span of whole periods. */
	periods: number;
	/** Levels in decibels referred to 1 V peak, or in volts. */
	scale: 'db' | 'linear';
	axis: 'log' | 'linear';
}

export const DEFAULT_SPECTRUM: Readonly<SpectrumSettings> = {
	on: false,
	source: 0,
	window: 'hann',
	span: 'window',
	periods: 10,
	scale: 'db',
	axis: 'log'
};

/** Most periods a span can be asked for. */
export const MAX_PERIODS = 1000;

/** Spectrum settings as they arrived, each kept only if it is the kind of thing it says it is. */
export function readSpectrum(raw: unknown): SpectrumSettings {
	const s = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	return {
		on: s.on === true,
		source: finite(s.source) && s.source >= 0 ? Math.floor(s.source) : DEFAULT_SPECTRUM.source,
		window: WINDOWS.includes(s.window as WindowKind) ? (s.window as WindowKind) : DEFAULT_SPECTRUM.window,
		span: s.span === 'periods' || s.span === 'memory' ? s.span : 'window',
		periods:
			finite(s.periods) && s.periods >= 1
				? Math.min(Math.round(s.periods), MAX_PERIODS)
				: DEFAULT_SPECTRUM.periods,
		scale: s.scale === 'linear' ? 'linear' : 'db',
		axis: s.axis === 'linear' ? 'linear' : 'log'
	};
}

/** Only what differs from the defaults, or undefined when nothing does. */
export function compactSpectrum(settings: SpectrumSettings): Partial<SpectrumSettings> | undefined {
	const out: Partial<SpectrumSettings> = {};
	for (const key of Object.keys(DEFAULT_SPECTRUM) as Array<keyof SpectrumSettings>) {
		if (settings[key] !== DEFAULT_SPECTRUM[key]) (out as Record<string, unknown>)[key] = settings[key];
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * The stretch of time to transform.
 *
 * Whole periods are the better choice for a steady waveform: a tone that fits
 * the span a whole number of times lands exactly on a bin, and then even the
 * rectangular window reads it without leakage. Counted back from the screen's
 * right edge, using the period measured over the screen, and cut short at the
 * start of memory. A null `period` falls back to the screen.
 */
export function spectrumSpan(
	settings: Pick<SpectrumSettings, 'span' | 'periods'>,
	screen: { from: number; to: number },
	held: { earliest: number; now: number },
	period: number | null
): { from: number; to: number; whole: boolean } {
	if (settings.span === 'memory') return { from: held.earliest, to: held.now, whole: false };
	if (settings.span === 'periods' && period !== null && period > 0) {
		const to = Math.min(screen.to, held.now);
		const fit = Math.max(1, Math.min(settings.periods, Math.floor((to - held.earliest) / period + 1e-9)));
		return { from: to - fit * period, to, whole: true };
	}
	return { from: Math.max(screen.from, held.earliest), to: Math.min(screen.to, held.now), whole: false };
}
