/**
 * What a switch's contacts are doing, and when.
 *
 * One place, because two things need the same answer and disagreeing about it
 * would be worse than either being wrong: the netlist, which turns it into the
 * control voltage the engine's switch reads, and the drawing, which has to show
 * the blade where the simulation has it. A switch drawn open while the circuit
 * it is in behaves as though it were closed is the kind of thing that makes
 * somebody distrust everything else on the screen.
 */

import type { Instance } from './model';

/** Zero is open, one is closed. The engine's switch reads it as a voltage. */
export type Contact = 0 | 1;

/**
 * How many times a contact makes and breaks before it settles.
 *
 * Four, which is at the quiet end of what a real one does and enough to be the
 * thing it is here to be: a signal that has to be debounced. An even count so
 * the chatter ends on the position the contact was moving to.
 */
const CHATTER = 4;

function num(instance: Instance, key: string, fallback: number): number {
	const value = Number(instance.params[key]);
	return Number.isFinite(value) ? value : fallback;
}

function str(instance: Instance, key: string, fallback: string): string {
	const raw = instance.params[key];
	return raw === undefined ? fallback : String(raw);
}

/** Where the switch rests: where a click put it, and where a run starts. */
export function restingContact(instance: Instance): Contact {
	return str(instance, 'start', 'open') === 'closed' ? 1 : 0;
}

/** Whether anything is scheduled to happen to this switch during the run. */
export function isScheduled(instance: Instance): boolean {
	return str(instance, 'action', 'manual') !== 'manual';
}

/**
 * The contact position over time, as a piecewise-linear control signal.
 *
 * The edges have to be edges: the solver puts a timepoint on every corner of a
 * PWL, and a slow ramp would drag the contact resistance across nine decades
 * over the whole run instead of switching.
 *
 * Contacts are springs. They arrive, rebound, and arrive again a few times over
 * a millisecond or so, with the gaps closing as the energy goes out of them —
 * which is the entire reason a button wired straight to a counter counts three.
 */
export function contactControl(instance: Instance): Array<[number, number]> {
	const rest = restingContact(instance);
	const points: Array<[number, number]> = [[0, rest]];
	if (!isScheduled(instance)) return points;

	const at = Math.max(num(instance, 'at', 1e-3), 0);
	const bounce = Math.max(num(instance, 'bounce', 0), 0);
	// A push-button springs back; a toggle stays where it was put.
	const operations =
		str(instance, 'action', 'manual') === 'momentary'
			? [at, at + Math.max(num(instance, 'hold', 10e-3), 1e-12)]
			: [at];

	// Fast enough to read as a step beside a bounce a thousand times longer, and
	// slow enough that the solver is not asked for a discontinuity.
	const edge = Math.max(Math.min(bounce / 200, 1e-6), 1e-12);
	let level: number = rest;
	const move = (t: number, to: number) => {
		if (to === level) return;
		points.push([Math.max(t - edge, 0), level]);
		points.push([Math.max(t, edge), to]);
		level = to;
	};

	for (const when of operations) {
		const target = 1 - level;
		if (bounce <= 0) {
			move(when, target);
			continue;
		}
		// Gaps halving each time, scaled so the whole train fits inside `bounce`.
		const span = bounce / (1 - Math.pow(0.5, CHATTER));
		move(when, target);
		let elapsed = 0;
		for (let k = 0; k < CHATTER; k++) {
			elapsed += span * Math.pow(0.5, k + 1);
			move(when + elapsed, k % 2 === 0 ? 1 - target : target);
		}
	}
	return points;
}

/**
 * Whether the contacts are touching at a given instant.
 *
 * Read off the same control the engine is given, at the same time, so what is
 * drawn is what was simulated. Half-open on the left: a contact that closes at
 * one millisecond is closed at exactly one millisecond, which is where the
 * playhead lands when somebody drags the scrubber to the moment it operates.
 */
export function isClosedAt(instance: Instance, time: number): boolean {
	const points = contactControl(instance);
	let level = points[0][1];
	for (const [t, value] of points) {
		if (t > time) break;
		level = value;
	}
	// The ramp between two levels is a nanosecond wide and belongs to whichever
	// end it is closer to; rounding is the honest reading of a signal that is
	// only ever meant to be at one end or the other.
	return level >= 0.5;
}

/**
 * Where the blade is *drawn* at an instant, which is not quite the same thing.
 *
 * The chatter is left out. Contact bounce is a hundred microns of metal
 * rebounding for a millisecond — you cannot see it, you see it on a scope, and
 * that is exactly where this simulator shows it. Drawing it as well made the
 * symbol flick open and shut a few times on every operation, which reads as a
 * rendering fault rather than as physics, and hides the one thing the drawing
 * is for: whether the switch is now open or closed.
 *
 * So this follows the actuator — the finger on the button — and the electrical
 * side keeps every bounce.
 */
export function isActuatedAt(instance: Instance, time: number): boolean {
	const rest = restingContact(instance) === 1;
	if (!isScheduled(instance)) return rest;

	const at = Math.max(num(instance, 'at', 1e-3), 0);
	if (time < at) return rest;
	if (str(instance, 'action', 'manual') !== 'momentary') return !rest;
	return time < at + Math.max(num(instance, 'hold', 10e-3), 1e-12) ? !rest : rest;
}
