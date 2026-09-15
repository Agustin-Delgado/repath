import { describe, expect, it } from 'vitest';
import { firstAfter, levelAt } from './transitions';
import type { DigitalTransition } from './engine';

const edges: DigitalTransition[] = [
	{ time: 1, state: 'high' },
	{ time: 2, state: 'low' },
	{ time: 2, state: 'high' },
	{ time: 5, state: 'low' }
];

describe('looking up a lane', () => {
	it('finds the first transition after an instant', () => {
		expect(firstAfter(edges, 0)).toBe(0);
		expect(firstAfter(edges, 1)).toBe(1);
		// Two at the same instant: both are at or before it.
		expect(firstAfter(edges, 2)).toBe(3);
		expect(firstAfter(edges, 4.9)).toBe(3);
		expect(firstAfter(edges, 5)).toBe(4);
		expect(firstAfter([], 3)).toBe(0);
	});

	it('reads the level, and the opening level before the first edge', () => {
		expect(levelAt(edges, 0.5, 'low')).toBe('low');
		expect(levelAt(edges, 0.5)).toBe('unknown');
		expect(levelAt(edges, 1)).toBe('high');
		expect(levelAt(edges, 2)).toBe('high');
		expect(levelAt(edges, 3)).toBe('high');
		expect(levelAt(edges, 7)).toBe('low');
	});
});
