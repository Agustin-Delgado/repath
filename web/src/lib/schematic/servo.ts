/**
 * The hobby servo, an SG90 or anything wired like one: how it is drawn, what
 * it draws from its supply, and what a run reports about it.
 *
 * The engine (`servo` in repath-core) times the pulses on the signal wire and
 * turns the horn at the motor's speed; the editor places the part, builds its
 * load on the supply, and draws the horn where the engine says it is.
 */

import type { Vec2 } from '$lib/canvas';

export const SERVO_KIND = 'servo';

/**
 * What the servo draws from its supply, as a resistor from VCC to GND: 10 mA
 * at 5 V, an SG90 holding still. The 100–250 mA it takes while turning and
 * the 650 mA of a stalled one are not modelled.
 */
export const SERVO_LOAD_OHMS = 500;

/** The pulses the engine takes for a position at all, in microseconds. */
export const MIN_PULSE_US = 400;
export const MAX_PULSE_US = 2600;

/** Where the horn is before any pulse has moved it, as in the engine. */
export const SERVO_START_ANGLE = 90;

/** The engine's device for servo `name`, beside the resistor under the name itself. */
export function servoDeviceName(name: string): string {
	return `${name}:servo`;
}

// ---- geometry ------------------------------------------------------------

/** The three wires, top to bottom, in the order of the connector: brown, red, orange. */
export const SERVO_LEGS = ['GND', 'VCC', 'SIG'] as const;
export const SERVO_LEG_X = -60;
export const servoLegY = (index: number) => (index - 1) * 10;

/** The case, seen from above, and the output shaft near its far end. */
export const SERVO_BODY = { x: -40, y: -20, w: 80, h: 40 };
export const SERVO_SHAFT: Vec2 = { x: 20, y: 0 };
/** The boss round the shaft. */
export const SERVO_BOSS = 9;
/** From the shaft to the end of the horn, and the arm's half-widths at each end. */
const HORN_LENGTH = 28;
const HORN_ROOT = 5.5;
const HORN_TIP = 3;
/** The marks at 0°, 45°, 90°, 135° and 180°, round the shaft beyond the horn. */
export const SERVO_SCALE = { inner: 31, outer: 35 };

/**
 * The direction `angle` degrees points in, from the shaft: 0° to the right,
 * 90° straight up, 180° to the left, as a protractor reads. Screen y grows
 * downwards, hence the minus.
 */
export function servoDirection(angle: number): Vec2 {
	const radians = (angle * Math.PI) / 180;
	return { x: Math.cos(radians), y: -Math.sin(radians) };
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The horn at `angle`, as an SVG path to fill: a tapered arm with round ends,
 * from a little behind the shaft out to its tip.
 */
export function hornPath(angle: number): string {
	const u = servoDirection(angle);
	const n = { x: -u.y, y: u.x };
	const at = (along: number, across: number) => {
		const x = SERVO_SHAFT.x + u.x * along + n.x * across;
		const y = SERVO_SHAFT.y + u.y * along + n.y * across;
		return `${round(x)} ${round(y)}`;
	};
	return [
		`M${at(0, HORN_ROOT)}`,
		`L${at(HORN_LENGTH, HORN_TIP)}`,
		`A${HORN_TIP} ${HORN_TIP} 0 0 0 ${at(HORN_LENGTH, -HORN_TIP)}`,
		`L${at(0, -HORN_ROOT)}`,
		`A${HORN_ROOT} ${HORN_ROOT} 0 0 0 ${at(0, HORN_ROOT)}`,
		'Z'
	].join(' ');
}

// ---- what a run reports --------------------------------------------------

/** The last pulse the servo measured, taken for a position or not. */
export interface ServoPulse {
	/** When it ended, in simulated seconds. */
	at: number;
	/** How long it was high. */
	width: number;
	/** In range, after a long enough gap: whether it moved the target. */
	taken: boolean;
}

/** The servo at one instant, as the engine's `servoState` gives it. */
export interface ServoFrame {
	time: number;
	/** Degrees from the 0° end. */
	angle: number;
	/** Where the last pulse taken sent it. */
	target: number;
	version: number;
	pulse: ServoPulse | null;
}

/**
 * How many changes of one servo a run keeps, oldest dropped first: a frame a
 * piece of the run while it is turning, none while it holds.
 */
export const SERVO_HISTORY = 20000;

/** Whether two frames say the same about the horn and its last pulse. */
export function sameServo(a: ServoFrame, b: ServoFrame): boolean {
	return (
		Math.abs(a.angle - b.angle) < 1e-3 &&
		a.target === b.target &&
		a.pulse?.taken === b.pulse?.taken &&
		Math.abs((a.pulse?.width ?? 0) - (b.pulse?.width ?? 0)) < 0.5e-6
	);
}

/**
 * Add `state` to a servo's `history` if it says something new, oldest first.
 *
 * `previous` is the reading before this one. A servo can hold for seconds and
 * then move, and the frame it held at is long before the one it moved in; the
 * reading just before the move goes in first, so the horn is drawn holding
 * until then rather than creeping all the way across the gap.
 */
export function recordServo(
	history: ServoFrame[],
	state: ServoFrame,
	previous: ServoFrame | null
): void {
	const last = history[history.length - 1];
	if (last && sameServo(last, state)) return;
	if (last && previous && previous.time > last.time && sameServo(last, previous)) {
		history.push(previous);
	}
	history.push(state);
	if (history.length > SERVO_HISTORY) history.splice(0, history.length - SERVO_HISTORY);
}

/**
 * The servo as it was at `time`: the angle between the two readings either
 * side of it, which is a straight line while it turns at its one speed; the
 * nearest reading outside them. Null before the run has read it at all.
 */
export function servoAt(history: readonly ServoFrame[], time: number): ServoFrame | null {
	if (history.length === 0) return null;
	if (time <= history[0].time) return history[0];
	const lastIndex = history.length - 1;
	if (time >= history[lastIndex].time) return history[lastIndex];
	let lo = 0;
	let hi = lastIndex;
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (history[mid].time <= time) lo = mid;
		else hi = mid;
	}
	const a = history[lo];
	const b = history[hi];
	const share = (time - a.time) / (b.time - a.time);
	return { ...a, time, angle: a.angle + (b.angle - a.angle) * share };
}
