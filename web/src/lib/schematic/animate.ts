/**
 * The live layer: voltage as colour, current as motion.
 *
 * # Colour
 *
 * Voltage is a diverging quantity — it has a meaningful zero and a sign — so it
 * gets a diverging scale: two hues with a neutral grey midpoint, never a rainbow
 * and never a hue at the middle. Zero volts is drawn in the ordinary wire grey,
 * so a node at ground potential simply looks like a wire, and colour appears
 * only where there is something to say.
 *
 * The poles were checked for contrast and colour-vision separation against this
 * canvas surface rather than picked by eye: ΔE 22 under protanopia, 32 under
 * tritanopia, 32 with normal vision, all above 3:1 against the background.
 *
 * Colour is never the only channel — the same values are on the scope traces and
 * in the hover readout, and current direction is carried by motion.
 *
 * # Motion
 *
 * Each wire and device carries a phase that advances in real time in proportion
 * to its current, and dots are drawn at fixed spacing along that phase. So the
 * dots move the way the charge does: faster where the current is larger, and
 * backwards when it reverses. Speed is normalised against the largest current in
 * the run, so a circuit switching microamps animates as legibly as one switching
 * amps.
 */

import type { Painter, Vec2 } from '$lib/canvas';
import { distance } from '$lib/canvas';
import type { FlowFrame } from './flow';

/** Diverging poles and the neutral midpoint, validated against `--canvas-bg`. */
export const VOLTAGE_SCALE = {
	negative: '#4d9bff',
	neutral: '#8b96aa',
	positive: '#ff6f61'
} as const;

const CHANNELS = {
	negative: [0x4d, 0x9b, 0xff],
	neutral: [0x8b, 0x96, 0xaa],
	positive: [0xff, 0x6f, 0x61]
} as const;

/**
 * Colour for a voltage, given the range observed across the whole run.
 *
 * Each arm is scaled independently so a supply that swings 0–5 V uses the full
 * warm arm rather than a fifth of it, while zero stays put at the neutral point.
 */
export function voltageColour(volts: number, range: { lo: number; hi: number }): string {
	const span = volts >= 0 ? Math.max(range.hi, 1e-12) : Math.max(-range.lo, 1e-12);
	// Square root keeps small differences visible; a linear ramp leaves most of a
	// rail-to-rail circuit sitting near the midpoint.
	const t = Math.min(Math.sqrt(Math.abs(volts) / span), 1);
	const pole = volts >= 0 ? CHANNELS.positive : CHANNELS.negative;

	const mix = (i: number) => Math.round(CHANNELS.neutral[i] + (pole[i] - CHANNELS.neutral[i]) * t);
	return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** Spacing between current dots, in schematic units. */
const DOT_SPACING = 22;
/** How far a dot travels per second at the reference current. */
const REFERENCE_SPEED = 90;
/** Below this fraction of the reference, nothing is drawn: it reads as noise. */
const MOTION_FLOOR = 0.002;

/**
 * And below this current, nothing is drawn whatever the reference is.
 *
 * The fraction above is the right rule for a working circuit and the wrong one
 * for a circuit that is switched off, because there the largest current in the
 * run *is* the leakage — through the open contact, and through the picoamp of
 * gmin the solver hangs on every node — so normalising to it drew that leakage
 * as a full, brisk flow. An open switch animated exactly like a closed one.
 *
 * A nanoamp: three orders of magnitude above that gmin, and far below anything
 * anybody watches move. A circuit whose signal really is a few picoamps is not
 * one being read off dots on a wire, and it still has the scope.
 */
const CURRENT_FLOOR = 1e-9;

/**
 * How long a burst goes on being drawn after it has passed, in seconds.
 *
 * A switching circuit conducts in bursts far shorter than a frame — a CMOS gate
 * charges in twenty nanoseconds and then does nothing for fifty microseconds —
 * and a wire drawn only on the frames that catch one blinks rather than flows.
 * This is the fall time of a needle: it says "something goes past here" for a
 * moment after it did, which is what an instrument does and what makes a pulse
 * train legible at all.
 */
const LEVEL_FALL = 0.4;

/**
 * Over how long a burst's travel is handed out, in seconds.
 *
 * The charge that crosses a gate arrives inside a single frame. Moving the dots
 * by the whole of it at once is a jump — the eye reads it as a glitch, not as a
 * flow — so it is paid out over about a sixth of a second instead. Every unit of
 * travel is still charge that went past; only its timing inside that window is
 * smoothed, which is unavoidable when the event itself is a thousand times
 * shorter than a frame.
 */
const SPREAD = 0.16;

export interface AnimationState {
	/** Accumulated travel per wire or device, in schematic units. */
	phase: Map<string, number>;
	/**
	 * Travel owed but not yet paid out.
	 *
	 * A burst's whole charge arrives in one frame, and moving the dots by all of
	 * it at once is a teleport rather than a motion. It is paid out over the
	 * following frames instead, a spacing at a time — every unit of travel still
	 * corresponds to charge that really went past, only its timing inside a
	 * fraction of a second is smoothed, which is unavoidable when a twenty
	 * nanosecond event has to be shown in a sixteen millisecond frame.
	 */
	pending: Map<string, number>;
	/** Decaying envelope of the magnitude, for deciding what to draw. */
	level: Map<string, number>;
}

export function createAnimationState(): AnimationState {
	return { phase: new Map(), pending: new Map(), level: new Map() };
}

/**
 * Drop what is being remembered about magnitudes, keeping where the dots are.
 *
 * For when the circuit itself changes under the animation — a contact opening is
 * the case that matters. The envelope exists to hold a reading up across frames
 * where a burst happens to fall between samples, and holding it across a switch
 * instead drew a branch that had just been disconnected as though it were still
 * carrying what it carried a moment ago. The phases stay: dots are positions,
 * and jumping them would be a glitch on a wire whose current never changed.
 */
export function forget(state: AnimationState): void {
	state.level.clear();
	state.pending.clear();
}

/**
 * Advance every phase by one frame.
 *
 * `dt` is real elapsed seconds, not simulated time: the dots are a readout of
 * the present instant, and should crawl or race according to the current at that
 * instant rather than to how fast playback happens to be running.
 */
export function advance(
	state: AnimationState,
	frame: FlowFrame,
	scale: number,
	dt: number
): void {
	const fade = Math.exp(-dt / LEVEL_FALL);
	const step = (key: string, current: number) => {
		// The envelope first: it decays whether or not anything is flowing, and it
		// is what the drawing asks about.
		const held = (state.level.get(key) ?? 0) * fade;
		const level = Math.max(Math.abs(current), held);
		state.level.set(key, level);

		// The same rule the drawing uses, so a dot never advances on a leg that is
		// not being painted — otherwise a switch closed after a long open stretch
		// would show its dots already halfway along.
		if (!isFlowing(level, scale)) {
			state.pending.delete(key);
			return;
		}

		const owed = (state.pending.get(key) ?? 0) + (current / scale) * REFERENCE_SPEED * dt;
		// Paid out over a fraction of a second rather than all at once, and never
		// more than a spacing in a single frame. A steady current fills and drains
		// this at the same rate and comes out unchanged apart from a tenth of a
		// second of lag; a burst comes out as a glide, which is the same travel
		// spread over enough frames for an eye to follow it.
		const drain = 1 - Math.exp(-dt / SPREAD);
		let release = Math.max(-DOT_SPACING, Math.min(DOT_SPACING, owed * drain));
		// Crumbs left in the bucket would keep a wire that has stopped carrying
		// anything twitching forever.
		if (Math.abs(owed - release) < 0.005) release = owed;
		state.pending.set(key, owed - release);

		// Wrap rather than grow without bound: after a few minutes of playback the
		// accumulated value would start losing precision where it matters.
		state.phase.set(key, ((state.phase.get(key) ?? 0) + release) % DOT_SPACING);
	};

	for (const [id, current] of frame.wireCurrent) step(id, current);
	for (const [id, current] of frame.instanceCurrent) step(`i:${id}`, current);
}

/**
 * Dot positions along a segment for the given phase.
 *
 * The phase is a distance offset, so dots enter one end and leave the other
 * instead of appearing and vanishing in place.
 */
export function dotsAlong(a: Vec2, b: Vec2, phase: number): Vec2[] {
	const length = distance(a, b);
	if (length < 1) return [];

	const dx = (b.x - a.x) / length;
	const dy = (b.y - a.y) / length;
	const start = ((phase % DOT_SPACING) + DOT_SPACING) % DOT_SPACING;

	const points: Vec2[] = [];
	for (let d = start; d <= length; d += DOT_SPACING) {
		points.push({ x: a.x + dx * d, y: a.y + dy * d });
	}
	return points;
}

/** Whether a current is worth animating at all. */
export function isFlowing(current: number, scale: number): boolean {
	return Math.abs(current) >= CURRENT_FLOOR && Math.abs(current / scale) >= MOTION_FLOOR;
}

/**
 * Draw the moving dots for one segment.
 *
 * `level` is the envelope rather than the instant's current: what decides
 * whether a wire shows dots is whether charge has gone past it recently, not
 * whether it happens to be going past in the frame being drawn.
 */
export function drawFlow(
	painter: Painter,
	a: Vec2,
	b: Vec2,
	level: number,
	scale: number,
	phase: number,
	colour: string
): void {
	const current = level;
	if (!isFlowing(current, scale)) return;
	// Bigger dots for bigger currents, but only mildly: the position and speed
	// carry the quantity, the size is just emphasis.
	const strength = Math.min(Math.abs(current / scale), 1);
	const radius = 2 + strength * 1.6;
	for (const at of dotsAlong(a, b, phase)) {
		painter.dot(at, radius, { color: colour, alpha: 0.55 + strength * 0.45 });
	}
}
