/**
 * Engineering notation, in both directions.
 *
 * People type `4k7`, `4.7k`, `10u`, `1meg` and expect all of them to work, and
 * they expect `0.0000047` to come back as `4.7µ`. Getting this wrong makes an
 * otherwise correct simulator feel broken.
 */

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
		return Number.isFinite(n) ? n * 1e6 : null;
	}

	// Infix form: 4k7 means 4.7k. Common on schematics because it survives a
	// decimal point being lost to a bad photocopy.
	const infix = /^([+-]?\d+)([fpnuµμmkKMGT])(\d+)$/.exec(text);
	if (infix) {
		const n = Number(`${infix[1]}.${infix[3]}`);
		return Number.isFinite(n) ? n * PREFIXES[infix[2]] : null;
	}

	const suffixed = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([fpnuµμmkKMGT])?$/.exec(text);
	if (!suffixed) return null;
	const n = Number(suffixed[1]);
	if (!Number.isFinite(n)) return null;
	return suffixed[2] ? n * PREFIXES[suffixed[2]] : n;
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
