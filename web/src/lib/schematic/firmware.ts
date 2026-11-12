/**
 * Intel HEX, the format every AVR toolchain hands a program over in.
 *
 * The engine reads the file itself when a run starts, and is what decides
 * whether it runs; this is the same reading done here, so the inspector can
 * say how big a program is, or what is wrong with a file, the moment it is
 * loaded rather than at Run. The rules and the wording are the engine's
 * (`avr::hex`), so the two say the same thing about the same file.
 */

export interface FirmwareSummary {
	/** Bytes of program the file carries. */
	bytes: number;
	/** Why the file cannot be loaded, with the line that says so; null when it can. */
	problem: string | null;
}

const hex2 = (value: number) => value.toString(16).toUpperCase().padStart(2, '0');

/** What a HEX file holds, checked against `capacity` bytes of flash. */
export function readFirmware(text: string, capacity: number): FirmwareSummary {
	let base = 0;
	let bytes = 0;
	const lines = text.split(/\r?\n/);
	// A trailing newline is not a line of its own, the way Rust's `lines` counts.
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	const fail = (line: number, reason: string): FirmwareSummary => ({
		bytes,
		problem: `line ${line}: ${reason}`
	});
	for (const [index, raw] of lines.entries()) {
		const line = index + 1;
		const record = raw.trim();
		if (record === '') continue;
		if (!record.startsWith(':')) return fail(line, "a record has to start with ':'");
		const digits = record.slice(1);
		if (!/^[0-9A-Fa-f]*$/.test(digits)) {
			return fail(line, "a record is hexadecimal digits after the ':'");
		}
		if (digits.length % 2 !== 0 || digits.length < 10) {
			return fail(line, 'the record is too short or has half a byte');
		}
		const data: number[] = [];
		for (let i = 0; i < digits.length; i += 2) data.push(parseInt(digits.slice(i, i + 2), 16));
		const count = data[0];
		if (data.length !== count + 5) {
			return fail(line, `the record says it carries ${count} bytes but has ${data.length - 5}`);
		}
		const sum = data.reduce((a, b) => (a + b) & 0xff, 0);
		if (sum !== 0) {
			const given = data[data.length - 1];
			const expected = (given - sum) & 0xff;
			return fail(line, `the checksum is ${hex2(given)} where the record needs ${hex2(expected)}`);
		}
		const address = (data[1] << 8) | data[2];
		switch (data[3]) {
			case 0x00: {
				const start = base + address;
				const end = start + count;
				if (end > capacity) {
					return fail(
						line,
						`bytes 0x${start.toString(16).toUpperCase()} to 0x${(end - 1).toString(16).toUpperCase()} do not fit in ${capacity} bytes`
					);
				}
				bytes += count;
				break;
			}
			case 0x01:
				return { bytes, problem: null };
			case 0x02:
			case 0x04: {
				if (count !== 2) return fail(line, 'an extended address record carries two bytes');
				const value = (data[4] << 8) | data[5];
				base = data[3] === 0x02 ? value << 4 : value * 0x10000;
				break;
			}
			case 0x03:
			case 0x05:
				break;
			default:
				return fail(line, `record type ${hex2(data[3])} is not one Intel HEX has`);
		}
	}
	return {
		bytes,
		problem: `line ${Math.max(lines.length, 1)}: there is no end-of-file record; the file may have been cut short`
	};
}

/**
 * A program as the HEX file a toolchain would write for it: sixteen bytes a
 * record from address zero, and the end-of-file record.
 *
 * `words` are instructions as the AVR manual encodes them, sixteen bits each,
 * stored low byte first the way the flash holds them.
 */
export function intelHex(words: readonly number[]): string {
	const bytes = words.flatMap((word) => [word & 0xff, (word >> 8) & 0xff]);
	let text = '';
	for (let at = 0; at < bytes.length; at += 16) {
		const chunk = bytes.slice(at, at + 16);
		const record = [chunk.length, (at >> 8) & 0xff, at & 0xff, 0x00, ...chunk];
		const sum = record.reduce((a, b) => (a + b) & 0xff, 0);
		record.push((0x100 - sum) & 0xff);
		text += ':' + record.map(hex2).join('') + '\n';
	}
	return text + ':00000001FF\n';
}
