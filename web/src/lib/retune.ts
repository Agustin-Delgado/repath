/**
 * Which edits a running circuit can take without becoming another circuit.
 *
 * Turning a knob while the sweep is going is a hand on the part, like throwing
 * a switch: the run carries on, everything already solved stays solved, and
 * the value is different from the instant it was turned. Restarting from zero
 * for it replayed the whole run — a servo on a potentiometer swung all the way
 * from its starting angle again rather than following the knob.
 *
 * The question is answered on the compiled netlists rather than on the
 * drawing's parameters, because the netlist is what the engine was given. A
 * potentiometer is two resistors there, a variable capacitor one capacitor, a
 * battery a source and a resistor: comparing what they compile to covers every
 * part built out of those without a table of which parameter of which part
 * lands where. Anything else that differs — a part added, a wire moved, a
 * type changed, a program loaded, the temperature — is a different circuit,
 * and that is still a new run.
 */

import type { Retune } from './engine';

/** One element's new value, by its name in the engine. */
export interface ElementRetune {
	element: string;
	change: Retune;
}

/** A retune made during a run, and the instant of the run it was made at. */
export interface RetuneAt extends ElementRetune {
	at: number;
}

/** The value of each component type that can change under a running circuit. */
const TUNABLE: Record<string, string> = {
	resistor: 'resistance',
	capacitor: 'capacitance',
	inductor: 'inductance',
	voltage_source: 'waveform',
	current_source: 'waveform'
};

/**
 * The parts of a source's waveform that are levels rather than timing.
 *
 * A level changed at an instant is a step in the output, which is what a hand
 * on a bench supply's dial does. A frequency or a delay changed mid-run is not
 * a thing a real generator does to a waveform anchored at t = 0 — the phase
 * would jump to wherever the new frequency says it should have been all along
 * — so those still start the run again. A piecewise-linear table is a script
 * of the whole run (a switch's actuator is one), and is never edited live.
 */
const LEVELS: Record<string, string[]> = {
	dc: ['value'],
	sine: ['offset', 'amplitude'],
	pulse: ['v1', 'v2']
};

/**
 * Fields that change nothing in a transient run: the small-signal drive only
 * the frequency sweep reads.
 */
const IGNORED = new Set(['ac_magnitude', 'ac_phase']);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether two records differ only in `allowed`. */
function differsOnlyIn(a: Fields, b: Fields, allowed: Set<string>): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (allowed.has(key)) continue;
		if (!same(a[key], b[key])) return false;
	}
	return true;
}

/** Whether a source's waveform moved only in its levels. */
function levelsOnly(from: unknown, to: unknown): boolean {
	if (!isRecord(from) || !isRecord(to) || from.type !== to.type) return false;
	const levels = LEVELS[String(from.type)];
	return levels !== undefined && differsOnlyIn(from, to, new Set(levels));
}

/**
 * What it takes to turn the circuit `from` into `to` while it runs.
 *
 * An empty list when nothing the engine reads has changed, and null when the
 * difference is not one a running circuit can take: the caller starts a new
 * run for that.
 */
export function liveChanges(from: unknown, to: unknown): ElementRetune[] | null {
	if (!isRecord(from) || !isRecord(to)) return null;
	if (!differsOnlyIn(from, to, new Set(['components']))) return null;
	const before = Array.isArray(from.components) ? from.components : [];
	const after = Array.isArray(to.components) ? to.components : [];
	if (before.length !== after.length) return null;

	const changes: ElementRetune[] = [];
	for (let i = 0; i < after.length; i++) {
		const a = before[i];
		const b = after[i];
		if (same(a, b)) continue;
		if (!isRecord(a) || !isRecord(b) || a.type !== b.type || a.name !== b.name) return null;
		const key = TUNABLE[String(b.type)];
		if (!key) return null;
		if (!differsOnlyIn(a, b, new Set([key, ...IGNORED]))) return null;
		if (same(a[key], b[key])) continue;
		if (key === 'waveform') {
			if (!levelsOnly(a.waveform, b.waveform)) return null;
			changes.push({ element: String(b.name), change: { waveform: b.waveform } });
			continue;
		}
		const value = b[key];
		if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value)) return null;
		changes.push({ element: String(b.name), change: { [key]: value } as Retune });
	}
	return changes;
}
