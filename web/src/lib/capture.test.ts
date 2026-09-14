/**
 * The memory, fed by hand.
 *
 * The samples are a ring of a fixed depth; the edges of a slow net have to
 * outlive it, or the top of a counter can never be measured while the bottom
 * of it is busy.
 */

import { describe, expect, it } from 'vitest';
import { Capture, DEPTH, EDGE_HISTORY } from './capture';
import type { Chunk, LogicState } from './engine';

function chunk(from: number, count: number, edges: Array<[number, LogicState]> = []): Chunk {
	const time = new Float64Array(count);
	for (let i = 0; i < count; i++) time[i] = from + i * 1e-6;
	return {
		time,
		signalsByIndex: [new Float64Array(count)],
		currents: [],
		digital: [edges.map(([t, state]) => ({ time: t, state }))],
		failures: [],
		stats: { accepted_steps: count, rejected_steps: 0, newton_iterations: count, digital_events: edges.length, work: count }
	};
}

describe('the capture', () => {
	it('lets a slow net keep its edges after the samples that carried them are gone', () => {
		const capture = new Capture(['v(n1)'], [], ['d1'], 1);
		// One edge, then far more samples than the memory holds.
		capture.add(chunk(0, 10, [[0, 'low'], [5e-6, 'high']]));
		capture.add(chunk(1, DEPTH * 3));

		// The samples have moved on and the windowed list has forgotten the edge…
		expect(capture.earliest).toBeGreaterThan(1);
		expect(capture.digital[0]).toEqual([]);
		expect(capture.openingState(0)).toBe('high');
		// …but the history has not.
		expect(capture.edges(0).events.map((e) => e.time)).toEqual([0, 5e-6]);
		expect(capture.edges(0).opening).toBe('unknown');
	});

	it('bounds the history, and remembers the level before what it kept', () => {
		const capture = new Capture(['v(n1)'], [], ['d1'], 1);
		const edges: Array<[number, LogicState]> = [];
		for (let i = 0; i < EDGE_HISTORY + 10; i++) edges.push([i * 1e-6, i % 2 ? 'high' : 'low']);
		capture.add(chunk(0, 10, edges));

		const { events, opening } = capture.edges(0);
		expect(events.length).toBe(EDGE_HISTORY);
		expect(events[0].time).toBeCloseTo(10e-6, 12);
		// Edge 9 was 'high' (odd), and it is the one just before the kept run.
		expect(opening).toBe('high');
	});
});
