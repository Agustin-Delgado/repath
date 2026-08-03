/**
 * Engineering notation, in both directions, and the stepping built on it.
 *
 * Values are what a simulator is asked about, so an off-by-a-decade here is not
 * a cosmetic problem: it is a different circuit, simulated confidently.
 */

import { describe, expect, it } from 'vitest';
import {
	formatValue,
	formatWithUnit,
	joinValue,
	parseValue,
	splitValue,
	stepValue
} from './units';

describe('parseValue', () => {
	it('reads the forms people actually type', () => {
		expect(parseValue('4700')).toBe(4700);
		expect(parseValue('4.7k')).toBe(4700);
		expect(parseValue('4k7')).toBe(4700);
		expect(parseValue('1meg')).toBe(1e6);
		expect(parseValue('100n')).toBe(1e-7);
		expect(parseValue('2.2e-3')).toBe(0.0022);
	});

	it('does not leave binary dust on a scaled value', () => {
		// `100 * 1e-9` is 1.0000000000000001e-7 in floating point. Invisible on
		// screen, but it is what gets written to a file and carried in a link.
		expect(parseValue('100n')).toBe(1e-7);
		expect(parseValue('4k7')).toBe(4700);
		expect(parseValue('2.2u')).toBe(2.2e-6);
	});

	it('refuses what it cannot read, rather than guessing', () => {
		expect(parseValue('')).toBeNull();
		expect(parseValue('banana')).toBeNull();
		expect(parseValue('4k7k')).toBeNull();
	});
});

describe('splitValue and joinValue', () => {
	it('splits a value into the number and its decade', () => {
		expect(splitValue(4700)).toEqual({ mantissa: 4.7, prefix: 'k' });
		expect(splitValue(1e-6)).toEqual({ mantissa: 1, prefix: 'µ' });
		expect(splitValue(47)).toEqual({ mantissa: 47, prefix: '' });
	});

	it('keeps a negative value negative', () => {
		expect(splitValue(-15)).toEqual({ mantissa: -15, prefix: '' });
	});

	it('round trips', () => {
		for (const value of [4700, 1e-6, 47, 2.2e-9, 1e6, -15, 0.5]) {
			const { mantissa, prefix } = splitValue(value);
			expect(joinValue(mantissa, prefix)).toBe(value);
		}
	});

	it('has nothing to say about zero', () => {
		expect(splitValue(0)).toEqual({ mantissa: 0, prefix: '' });
	});
});

describe('stepValue', () => {
	it('steps the number being read, not the raw value', () => {
		// One nudge means the same thing at every scale.
		expect(stepValue(4700, 1)).toBe(5700);
		expect(stepValue(1e-6, 1)).toBe(2e-6);
		expect(stepValue(47, 1)).toBe(48);
	});

	it('settles into the decade above on the way up', () => {
		expect(stepValue(999, 1)).toBe(1000);
		expect(splitValue(stepValue(999, 1))).toEqual({ mantissa: 1, prefix: 'k' });
	});

	it('falls through to the decade below on the way down', () => {
		// Without this a value could be raised with the arrows but never lowered
		// past the bottom of its own decade: 1 kΩ would step to nothing and stop.
		expect(stepValue(1000, -1)).toBe(999);
		expect(stepValue(1, -1)).toBe(0.999);
		expect(stepValue(1e-6, -1)).toBe(999e-9);
	});

	it('takes a fine step without leaving dust', () => {
		expect(stepValue(4700, 0.1)).toBe(4800);
		expect(stepValue(1e-6, -0.1)).toBe(9e-7);
	});

	it('takes a coarse step', () => {
		expect(stepValue(1000, 10)).toBe(11000);
	});

	it('walks up and back down to where it started', () => {
		let value = 1000;
		for (let i = 0; i < 12; i++) value = stepValue(value, 1);
		for (let i = 0; i < 12; i++) value = stepValue(value, -1);
		expect(value).toBe(1000);
	});
});

describe('formatValue', () => {
	it('reads back what was typed', () => {
		expect(formatValue(4700)).toBe('4.7k');
		expect(formatValue(1e-7)).toBe('100n');
		expect(formatValue(0)).toBe('0');
	});

	it('keeps the zeros that are part of the number', () => {
		// Stripping trailing zeros unconditionally turns 400µ into 4µ.
		expect(formatValue(400e-6)).toBe('400µ');
	});
});

describe('a value that rounds up out of its decade', () => {
	it('steps up the prefix instead of writing a thousand of the smaller one', () => {
		// Reported from a canvas reading: 999.9995 mA came out as `1.00e+3 mA`,
		// which is both the wrong prefix and exponential notation nobody asked for.
		expect(formatValue(0.9999995, 3)).toBe('1');
		expect(formatWithUnit(0.9999995, 'A', 3)).toBe('1 A');
	});

	it('does the same at every step of the ladder', () => {
		expect(formatWithUnit(999.9995, 'Ω', 3)).toBe('1 kΩ');
		expect(formatWithUnit(0.0009999995, 'A', 3)).toBe('1 mA');
		expect(formatWithUnit(999999.5, 'Hz', 3)).toBe('1 MHz');
	});

	it('never reaches for exponential notation', () => {
		for (const value of [0.9999995, 999.9995, 1.0000001e-6, 12345, 0.000123456]) {
			expect(formatValue(value, 3)).not.toMatch(/e[+-]/);
		}
	});

	it('leaves a value that does not round up alone', () => {
		expect(formatWithUnit(0.994, 'A', 3)).toBe('994 mA');
		expect(formatWithUnit(0.5, 'A', 3)).toBe('500 mA');
	});
});
