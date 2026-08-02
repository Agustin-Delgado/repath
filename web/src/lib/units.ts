/**
 * Engineering notation, in both directions.
 *
 * People type `4k7`, `4.7k`, `10u`, `1meg` and expect all of them to work, and
 * they expect `0.0000047` to come back as `4.7µ`. Getting this wrong makes an
 * otherwise correct simulator feel broken.
 */

/**
 * Scaling by a power of ten is not exact in binary: `100 * 1e-9` comes out as
 * 1.0000000000000001e-7. Invisible on screen, but it is what gets written to a
 * file and carried in a share link, and it resurfaces as a value nobody typed.
 * Fifteen digits is past any physical parameter and short of a double's
 * seventeen, so it clears the noise without touching anything real.
 */
const settle = (value: number) => Number(value.toPrecision(15));

const PREFIXES: Record<string, number> = {
	f: 1e-15,
	p: 1e-12,
	n: 1e-9,
	u: 1e-6,
	'µ': 1e-6,
	'μ': 1e-6,
	m: 1e-3,
	k: 1e3,
	K: 1e3,
	M: 1e6,
	G: 1e9,
	T: 1e12
};

/** Ordered largest first, for formatting. */
const SCALE: Array<[number, string]> = [
	[1e12, 'T'],
	[1e9, 'G'],
	[1e6, 'M'],
	[1e3, 'k'],
	[1, ''],
	[1e-3, 'm'],
	[1e-6, 'µ'],
	[1e-9, 'n'],
	[1e-12, 'p'],
	[1e-15, 'f']
];

/**
 * Parse a value with an optional engineering suffix.
 *
 * Returns `null` for anything unparseable, so callers can keep the previous
 * value rather than silently substituting a zero.
 */
export function parseValue(input: string): number | null {
	const text = input.trim().replace(/\s+/g, '');
	if (text === '') return null;

	// `meg` before the single-letter table, or `1meg` parses as 1 milli.
	const meg = /^([+-]?[\d.]+)meg$/i.exec(text);
	if (meg) {
		const n = Number(meg[1]);
		return Number.isFinite(n) ? settle(n * 1e6) : null;
	}

	// Infix form: 4k7 means 4.7k. Common on schematics because it survives a
	// decimal point being lost to a bad photocopy.
	const infix = /^([+-]?\d+)([fpnuµμmkKMGT])(\d+)$/.exec(text);
	if (infix) {
		const n = Number(`${infix[1]}.${infix[3]}`);
		return Number.isFinite(n) ? settle(n * PREFIXES[infix[2]]) : null;
	}

	const suffixed = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([fpnuµμmkKMGT])?$/.exec(text);
	if (!suffixed) return null;
	const n = Number(suffixed[1]);
	if (!Number.isFinite(n)) return null;
	return suffixed[2] ? settle(n * PREFIXES[suffixed[2]]) : n;
}

/** Render a number with an engineering suffix and at most `digits` significant figures. */
export function formatValue(value: number, digits = 4): string {
	if (!Number.isFinite(value)) return '—';
	if (value === 0) return '0';

	const magnitude = Math.abs(value);
	const [scale, suffix] = SCALE.find(([s]) => magnitude >= s) ?? SCALE[SCALE.length - 1];
	const scaled = value / scale;
	// Trim trailing zeros — 4.7000k reads worse than 4.7k — but only after a
	// decimal point. Stripping them unconditionally turns 400µ into 4µ.
	const text = scaled
		.toPrecision(digits)
		.replace(/(\.\d*?)0+$/, '$1')
		.replace(/\.$/, '');
	return `${text}${suffix}`;
}

/** Format with a unit, e.g. `formatWithUnit(4700, 'Ω')` → `4.7 kΩ`. */
export function formatWithUnit(value: number, unit: string, digits = 4): string {
	const text = formatValue(value, digits);
	const match = /^(.*?)([fpnµmkMGT])?$/.exec(text);
	const prefix = match?.[2] ?? '';
	const number = match?.[1] ?? text;
	return `${number} ${prefix}${unit}`;
}

/**
 * The prefixes offered in the editor, largest first.
 *
 * The same ladder `formatValue` uses, so a value typed in one form and read back
 * in the other cannot disagree about which decade it is in.
 */
export const PREFIX_OPTIONS: ReadonlyArray<{ prefix: string; scale: number; label: string }> =
	SCALE.map(([scale, prefix]) => ({
		prefix,
		scale,
		label: prefix === '' ? '—' : prefix
	}));

/** A value as it is edited: a number to read, and the decade it sits in. */
export interface SplitValue {
	mantissa: number;
	prefix: string;
}

/**
 * Split a value into the number and its prefix.
 *
 * Editing them apart is the point: a field that takes `4k7` asks people to know a
 * notation before they can change a resistor, and mixing digits with letters
 * makes the value hard to step with the arrow keys.
 */
export function splitValue(value: number, digits = 4): SplitValue {
	if (!Number.isFinite(value) || value === 0) return { mantissa: 0, prefix: '' };

	const magnitude = Math.abs(value);
	const [scale, prefix] = SCALE.find(([s]) => magnitude >= s) ?? SCALE[SCALE.length - 1];
	// Rounded to the precision it is displayed at, so what is shown and what is
	// stored cannot drift apart over repeated edits.
	return { mantissa: Number((value / scale).toPrecision(digits)), prefix };
}

/** Put a split value back together. */
export function joinValue(mantissa: number, prefix: string): number {
	const found = PREFIX_OPTIONS.find((option) => option.prefix === prefix);
	return settle(mantissa * (found?.scale ?? 1));
}

/** The decade below a prefix, or undefined at the bottom of the ladder. */
function decadeBelow(prefix: string): { prefix: string; scale: number } | undefined {
	const index = PREFIX_OPTIONS.findIndex((option) => option.prefix === prefix);
	return index >= 0 ? PREFIX_OPTIONS[index + 1] : undefined;
}

/**
 * Move a value one step, and let it settle into the right decade.
 *
 * Stepping happens on the number being read rather than on the underlying value,
 * so a nudge means the same thing at every scale: one at 4.7 k moves to 5.7 k,
 * not to 4.7001 k. Going up, crossing a thousand re-splits on its own, which is
 * what makes 999 Ω step to 1 kΩ instead of growing a fourth digit.
 *
 * Going down needs saying explicitly, or 1 kΩ would step to nothing and stop —
 * a value could be raised with the arrows but never lowered past the bottom of
 * its own decade. Falling through takes the step in the decade below instead, so
 * 1 kΩ nudges to 999 Ω.
 */
export function stepValue(value: number, by: number, digits = 4): number {
	const { mantissa, prefix } = splitValue(value, digits);
	const moved = mantissa + by;

	if (value !== 0 && Math.sign(moved) !== Math.sign(mantissa)) {
		const below = decadeBelow(prefix);
		if (below) {
			return settle(Number((value / below.scale + by).toPrecision(12)) * below.scale);
		}
	}

	return joinValue(Number(moved.toPrecision(12)), prefix);
}
