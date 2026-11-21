/**
 * What a value typed into a field means, decided apart from the field.
 *
 * The inspector shows a value as a number beside a scale picker, rounded to
 * the four figures it is read at. Two things went wrong at that boundary:
 * leaving a field nobody typed in wrote the rounded number back, so a
 * 32.768 kHz crystal became 32.77 kHz from a Tab through the panel; and a
 * value with the wrong unit on it went in anyway, `5 V` at a resistor as
 * five milliohms, the V read past as though it were not there.
 */

import { joinValue, parseQuantity } from './units';

/** A plain number, with nothing after it: in the decade the picker shows. */
const BARE = /^\s*[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?\s*$/i;

/**
 * Read `raw` as a value of `unit`.
 *
 * A bare number is in `prefix`, the decade beside the field — `4.7` next to
 * k is 4700. Anything else is read the way it would be said, the way the
 * label on the canvas reads it: `4k7`, `10 meg`, `100 nanofarads`, `4,7 kΩ`.
 * A unit that is named has to be `unit`, so `5 V` typed at a resistor is
 * not a resistance. Null when it is not a value of `unit` at all.
 */
export function readEntry(raw: string, unit: string, prefix: string): number | null {
	if (BARE.test(raw)) {
		const n = Number(raw.trim().replace(',', '.'));
		return Number.isFinite(n) ? joinValue(n, prefix) : null;
	}
	return parseQuantity(raw, unit);
}

/** Every unit a field is labelled in. */
const UNITS = ['Ω', 'F', 'H', 'V', 'A', 'Hz', 's', 'W'];

/** Why `raw` was not taken as a value of `unit`, in the field's words. */
export function entryRefusal(raw: string, unit: string): string {
	const text = raw.trim();
	if (unit === '') return `“${text}” is not a number.`;
	// Something that would parse as some other quantity is the wrong unit,
	// which is a different mistake from a typo and is worth naming as one.
	if (UNITS.some((other) => other !== unit && parseQuantity(raw, other) !== null)) {
		return `“${text}” is not in ${unit}.`;
	}
	return `“${text}” is not a number.`;
}

/**
 * What leaving a field does with what is in it.
 *
 * `typed` is the text typed since the field was focused, or null when
 * nothing was: then there is nothing to apply, and the value stays exactly
 * as it is rather than as it is displayed.
 */
export function onLeave(
	typed: string | null,
	unit: string,
	prefix: string
): { kind: 'keep' } | { kind: 'apply'; value: number } | { kind: 'refuse'; message: string } {
	if (typed === null) return { kind: 'keep' };
	const value = readEntry(typed, unit, prefix);
	if (value === null) return { kind: 'refuse', message: entryRefusal(typed, unit) };
	return { kind: 'apply', value };
}

/**
 * Whether a draft is worth handing to `commit`: only when it differs from the
 * value the field was showing. The text shown is rounded, and committing it
 * unchanged on blur snapped a timebase of 4.7183 ms to 4.72.
 */
export function draftChanged(draft: string, shown: string): boolean {
	return draft.trim() !== shown.trim();
}

/**
 * Why `name` cannot be a part's name, or null when it can.
 *
 * A name is how the engine, the scope and the trace all refer to a part, and
 * each of them builds other names out of it: `B1.R1` for a part inside a
 * block, `RV1:b` for a potentiometer's second half, a space between the words
 * of a step in the trace. A name with one of those characters in it was taken,
 * and then read back as something else — `a.b` made nets called `a.b.a`, and
 * a part renamed `my part` replayed as `my`.
 */
export function nameRefusal(name: string): string | null {
	if (/\s/.test(name)) return 'A name cannot have spaces in it.';
	const reserved = /[.:,]/.exec(name);
	if (reserved) {
		return `A name cannot contain “${reserved[0]}”: repath uses it to build other names.`;
	}
	return null;
}
