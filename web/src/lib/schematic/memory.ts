/**
 * What a memory chip holds, written the way people write it: hex bytes.
 *
 * The text is a list of words in hexadecimal, separated by spaces, commas or
 * new lines, filled in from address zero. `@7f0` moves on to another address,
 * the way Verilog's `$readmemh` files and every EPROM programmer's hex dump do,
 * and anything after `;`, `#` or `//` on a line is a comment. So a lookup table
 * can be written with its addresses beside it:
 *
 * ```text
 * ; seven-segment patterns, common cathode
 * 3f 06 5b 4f 66 6d 7d 07 7f 6f
 * @10  77 7c 39 5e 79 71   ; A to F
 * ```
 *
 * A `0x` in front of a word is allowed, since people paste them.
 */

export interface ParsedContents {
	/** One entry per word from address zero; `undefined` where nothing was written. */
	words: Array<number | undefined>;
	/** What could not be used, one line each, for the inspector to show. */
	problems: string[];
}

export function parseContents(text: string, count: number, width: number): ParsedContents {
	const words: Array<number | undefined> = [];
	const problems: string[] = [];
	const limit = 2 ** width;
	let at = 0;
	let overflowed = false;
	for (const [row, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.replace(/(;|#|\/\/).*$/, '');
		for (const token of line.split(/[\s,]+/).filter(Boolean)) {
			const jump = token.startsWith('@');
			const digits = (jump ? token.slice(1) : token).replace(/^0x/i, '');
			const value = /^[0-9a-f]+$/i.test(digits) ? parseInt(digits, 16) : NaN;
			if (!Number.isFinite(value)) {
				problems.push(`Line ${row + 1}: "${token}" is not a hex number.`);
				continue;
			}
			if (jump) {
				at = value;
				continue;
			}
			if (at >= count) {
				if (!overflowed) problems.push(`Line ${row + 1}: past the last address, ${hex(count - 1)}.`);
				overflowed = true;
				continue;
			}
			if (value >= limit) {
				problems.push(`Line ${row + 1}: ${token} does not fit in ${width} bits.`);
			} else {
				words[at] = value;
			}
			at++;
		}
	}
	return { words, problems };
}

function hex(value: number): string {
	return value.toString(16).toUpperCase();
}
