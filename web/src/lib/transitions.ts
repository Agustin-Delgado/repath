/**
 * Looking things up in a net's transitions.
 *
 * A lane is a list of edges in time order, and a run kept for a long stretch
 * of a slow sweep holds a lot of them: a net toggling a thousand times per
 * screen, over the hundreds of screens the memory covers, is hundreds of
 * thousands. Anything done once a frame has to find its place in that list by
 * bisection rather than by walking it — walking it was a frame that grew
 * longer for as long as the run went on.
 */

import type { DigitalTransition, LogicState } from './engine';

/** Index of the first transition later than `time`; the list's length if none is. */
export function firstAfter(events: readonly DigitalTransition[], time: number): number {
	let lo = 0;
	let hi = events.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (events[mid].time <= time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The level a net had settled on at `time`: that of the last transition at or
 * before it, or `opening` if there is none — what the net was already at when
 * the list begins.
 */
export function levelAt(
	events: readonly DigitalTransition[],
	time: number,
	opening: LogicState = 'unknown'
): LogicState {
	const at = firstAfter(events, time);
	return at === 0 ? opening : events[at - 1].state;
}
