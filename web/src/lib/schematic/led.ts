/**
 * LEDs: what colour one is, how brightly it lights, and when it lets the smoke out.
 *
 * The electrical part is an ordinary diode, so the engine needs no LED of its
 * own. What separates a red one from a blue one is the forward voltage, and that
 * falls out of the diode equation once the saturation current is chosen to put
 * the knee in the right place. The table below is therefore written the way a
 * datasheet is — a forward voltage at a rated current — and the model parameters
 * are derived from it rather than tuned until the waveform looked plausible.
 *
 * # Burning out
 *
 * Driven past its rating an LED dies, and forgetting the series resistor is the
 * most common way anyone kills one. That is modelled in the engine, inside the
 * transient loop, rather than read off the waveforms afterwards — so a part that
 * fails at 3 ms is open for the rest of the run and everything downstream of it
 * is the circuit that actually exists from then on, not the circuit that would
 * have been had it survived.
 *
 * All this file does with a failure is look up which drawn instance the engine
 * is talking about. The rule that decides it lives in `semiconductor.rs`.
 *
 * One thing still missing: reverse breakdown. Real LEDs break down a few volts
 * backwards and die of that too; here they simply block.
 */

import type { TransientRun } from '$lib/engine';
import type { Instance, Schematic } from './model';

export interface LedColour {
	value: string;
	label: string;
	/** Forward voltage at the rated current, as a datasheet quotes it. */
	vf: number;
	/** What it emits, as canvas rgb channels. */
	rgb: readonly [number, number, number];
}

/**
 * The current every forward voltage below is quoted at, and the default rating.
 *
 * 20 mA is what almost every indicator LED is specified at, which is why the
 * same number does duty as both — as the point the I-V curve is fitted through,
 * and as the rating a part gets until someone says otherwise.
 */
export const RATED = 0.02;

/** Where the curve is anchored. Fixed, unlike a part's rating. */
/** Bulk resistance, as every diode here has. */
const RS = 0.568;

const REFERENCE = RATED;

/**
 * The eight LEDs in a seven-segment digit, in the order every datasheet lists.
 *
 * `a` is the top bar and the rest go clockwise from it, `g` is the middle and
 * `dp` is the point. The order is what the pin names, the drawing and the
 * netlist all agree on, so it lives here rather than being written out three
 * times.
 */
export const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'] as const;

export type Segment = (typeof SEGMENTS)[number];

export const LED_COLOURS: readonly LedColour[] = [
	{ value: 'red', label: 'Red', vf: 1.9, rgb: [255, 78, 62] },
	{ value: 'amber', label: 'Amber', vf: 2.05, rgb: [255, 168, 48] },
	{ value: 'green', label: 'Green', vf: 2.2, rgb: [88, 232, 116] },
	{ value: 'blue', label: 'Blue', vf: 3.0, rgb: [86, 152, 255] },
	{ value: 'white', label: 'White', vf: 3.1, rgb: [236, 242, 255] }
];

/** Emission coefficient. Sets the slope: about 120 mV per decade of current. */
const N = 2;
/** Room temperature, matching the rest of the device models. */
const TEMP = 300.15;
const VT = 8.617333262e-5 * TEMP;

const BY_VALUE = new Map(LED_COLOURS.map((c) => [c.value, c] as const));

/** The named colour, falling back to red rather than throwing on an old file. */
/**
 * Where each bar of the digit sits, in the symbol's own coordinates.
 *
 * Drawn as thick strokes rather than the tapered hexagons a real display has:
 * at the size a schematic symbol is read, the taper is a couple of pixels and
 * the shape is unmistakable without it. The point is a dot, and it is off to
 * the right of the digit where a real one is.
 */
export const SEGMENT_SHAPES: Readonly<Record<Segment, readonly [number, number, number, number]>> = {
	a: [-18, -35, 10, -35],
	b: [14, -31, 14, -4],
	c: [14, 4, 14, 31],
	d: [-18, 35, 10, 35],
	e: [-22, 4, -22, 31],
	f: [-22, -31, -22, -4],
	g: [-18, 0, 10, 0],
	// The decimal point, as a zero-length stroke: a round cap makes it a dot. Off
	// to the right of the digit, which is why the digit itself sits left of centre
	// rather than in the middle of the package.
	dp: [26, 35, 26, 35]
};

export function ledColour(value: unknown): LedColour {
	return BY_VALUE.get(String(value ?? '')) ?? LED_COLOURS[0];
}

/**
 * Diode model parameters for a colour.
 *
 * Inverting `vf = n·Vt·ln(i/is)` for `is` is what makes the table above readable:
 * change the quoted forward voltage and the curve moves to match, with no second
 * number to keep in step by hand.
 */
export function ledDiodeModel(
	value: unknown,
	rated: number
): { is: number; n: number; bv: null; rs: number; temp: number; rated: number } {
	const { vf } = ledColour(value);
	// The curve is anchored at the fixed reference current, never at `rated`.
	// The rating says how much abuse the part takes, and raising it to keep a
	// circuit alive must not quietly move the forward voltage and change how much
	// current that circuit draws in the first place.
	return { is: REFERENCE * Math.exp(-vf / (N * VT)), n: N, bv: null, rs: RS, temp: TEMP, rated };
}

/** What this LED is rated for, in amps. */
export function ledRating(instance: Instance): number {
	const rated = Number(instance.params.imax);
	return Number.isFinite(rated) && rated > 0 ? rated : RATED;
}

/**
 * How bright an LED looks carrying a given forward current.
 *
 * Light output is close to linear in current, but the eye's response is not:
 * a fifth of the current still reads as about half the brightness. The power law
 * is what keeps a dim LED visibly lit instead of looking switched off.
 *
 * Allowed past 1 so an LED being overdriven blazes for the moment before it goes
 * — which is the warning the animation exists to give.
 */
export function brightness(current: number, rated: number): number {
	if (!(current > 0) || !(rated > 0)) return 0;
	return Math.min((current / rated) ** 0.45, 1.6);
}

/**
 * Ink for an LED symbol that is not lit.
 *
 * A hint about which one it is, not the light itself: pulled most of the way to
 * grey and then lifted back to the lightness every other symbol is drawn at, so
 * a blue LED is no dimmer on the page than a white one and neither competes with
 * the glow that appears once current is actually flowing.
 *
 * Derived from the emitted colour rather than mixed against the theme, which
 * would mean parsing a CSS custom property to find out what grey to aim at.
 */
export function ledInk(value: unknown): string {
	const [r, g, b] = ledColour(value).rgb;
	const luminance = (c: readonly number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
	const grey = luminance([r, g, b]);
	const muted = [r, g, b].map((c) => c + (grey - c) * 0.55);
	const lift = 205 / Math.max(luminance(muted), 1);
	const out = muted.map((c) => Math.round(Math.min(c * lift, 255)));
	return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

export interface Burnout {
	instanceId: string;
	name: string;
	/** Simulated time at which the overcurrent finished it off. */
	time: number;
	/** Largest forward current reached up to that moment. */
	peak: number;
	rated: number;
}

/**
 * Which drawn parts the engine destroyed, soonest first.
 *
 * The deciding is already done — it happened inside the transient loop, where
 * the part went open and the rest of the run carried on without it. This only
 * matches the names the engine reports back to the instances on the canvas, so
 * the drawing can char the right symbol.
 *
 * A failure the schematic no longer has a part for is dropped rather than
 * reported against nothing: results outlive edits, so a run can be describing a
 * component that has since been deleted or renamed.
 */
export function findBurnouts(schematic: Schematic, run: TransientRun): Burnout[] {
	const byName = new Map(
		schematic.instances.filter((i) => i.kind === 'led').map((i) => [i.name, i] as const)
	);

	const out: Burnout[] = [];
	for (const failure of run.failures) {
		const instance = byName.get(failure.name);
		if (!instance) continue;
		out.push({
			instanceId: instance.id,
			name: failure.name,
			time: failure.time,
			peak: failure.peak,
			rated: failure.rated
		});
	}
	return out;
}

export function burnoutsById(list: readonly Burnout[]): Map<string, Burnout> {
	return new Map(list.map((b) => [b.instanceId, b] as const));
}
