/**
 * The switch's contacts, which two things have to agree about.
 *
 * The netlist turns this into the control voltage the engine reads; the drawing
 * turns the same thing into where the blade is painted. A disagreement between
 * them is worse than either being wrong on its own: a switch drawn open over a
 * circuit behaving as though it were closed teaches you to distrust the screen.
 */

import { describe, expect, it } from 'vitest';
import {
	contactControl,
	encodeOperations,
	isActuatedAt,
	isClosedAt,
	isHighAt,
	isScheduled,
	operationTimes,
	restingContact
} from './contacts';
import { defaultParams, type Instance } from './model';

function sw(params: Record<string, number | string> = {}): Instance {
	return {
		id: 's1',
		kind: 'switch',
		name: 'S1',
		x: 0,
		y: 0,
		rotation: 0,
		params: { ...defaultParams('switch'), ...params }
	};
}

describe('a switch nobody scheduled', () => {
	it('is wherever it was left, for the whole run', () => {
		expect(isScheduled(sw())).toBe(false);
		expect(restingContact(sw())).toBe(0);
		for (const t of [0, 1e-6, 1e-3, 1, 1e6]) {
			expect(isClosedAt(sw(), t)).toBe(false);
			expect(isClosedAt(sw({ start: 'closed' }), t)).toBe(true);
		}
	});

	it('has a control that never moves', () => {
		expect(contactControl(sw())).toEqual([[0, 0]]);
		expect(contactControl(sw({ start: 'closed' }))).toEqual([[0, 1]]);
	});
});

describe('a switch that operates during the run', () => {
	const toggling = sw({ action: 'toggle', at: 1e-3, bounce: 0 });

	it('is open before its moment and closed after it', () => {
		expect(isClosedAt(toggling, 0)).toBe(false);
		expect(isClosedAt(toggling, 0.9e-3)).toBe(false);
		// Closed *at* the moment, not just after it: that is where the playhead
		// lands when the scrubber is dragged to the instant it operates.
		expect(isClosedAt(toggling, 1e-3)).toBe(true);
		expect(isClosedAt(toggling, 1)).toBe(true);
	});

	it('goes the other way when it was resting closed', () => {
		const opening = sw({ action: 'toggle', start: 'closed', at: 2e-3, bounce: 0 });
		expect(isClosedAt(opening, 1e-3)).toBe(true);
		expect(isClosedAt(opening, 3e-3)).toBe(false);
	});

	it('springs back, as a push-button', () => {
		const button = sw({ action: 'momentary', at: 1e-3, hold: 4e-3, bounce: 0 });
		expect(isClosedAt(button, 0.5e-3)).toBe(false);
		expect(isClosedAt(button, 3e-3)).toBe(true);
		expect(isClosedAt(button, 6e-3)).toBe(false);
	});
});

describe('contact bounce', () => {
	const bouncing = sw({ action: 'toggle', at: 1e-3, bounce: 1e-3 });

	it('chatters inside its window and settles after it', () => {
		expect(isClosedAt(bouncing, 0.9e-3)).toBe(false);
		expect(isClosedAt(bouncing, 2.1e-3)).toBe(true);

		// Somewhere in the window it is open again, which is the entire point: a
		// counter reading this signal counts more than one press.
		const samples = Array.from({ length: 400 }, (_, i) =>
			isClosedAt(bouncing, 1e-3 + (i / 400) * 1e-3)
		);
		const breaks = samples.filter((closed, i) => i > 0 && !closed && samples[i - 1]).length;
		expect(breaks).toBeGreaterThanOrEqual(2);
	});

	it('never moves before the contact was touched', () => {
		for (const [t] of contactControl(bouncing).slice(1)) {
			expect(t).toBeGreaterThan(0.9e-3);
		}
	});

	it('leaves the control ending where the contact was going', () => {
		const points = contactControl(bouncing);
		expect(points[points.length - 1][1]).toBe(1);
		expect(isClosedAt(bouncing, 1)).toBe(true);
	});

	it('is one clean edge when it is turned off', () => {
		const clean = sw({ action: 'toggle', at: 1e-3, bounce: 0 });
		expect(contactControl(clean)).toHaveLength(3);
	});
});

describe('what the blade is drawn doing', () => {
	const bouncing = sw({ action: 'toggle', at: 1e-3, bounce: 1e-3 });

	it('follows the actuator and not the chatter', () => {
		// Contact bounce is a hundred microns of metal rebounding over a
		// millisecond. You cannot see it — you see it on a scope, which is where
		// this simulator shows it. Drawn as well, the symbol flicked open and shut
		// on every operation, which reads as a rendering fault rather than physics.
		expect(isActuatedAt(bouncing, 0.9e-3)).toBe(false);
		for (let i = 0; i <= 100; i++) {
			expect(isActuatedAt(bouncing, 1e-3 + (i / 100) * 1e-3)).toBe(true);
		}
		// While the electrical side keeps every bounce.
		const chattered = Array.from({ length: 200 }, (_, i) =>
			isClosedAt(bouncing, 1e-3 + (i / 200) * 1e-3)
		);
		expect(chattered.some((closed) => !closed)).toBe(true);
	});

	it('still springs back with a push-button', () => {
		const button = sw({ action: 'momentary', at: 1e-3, hold: 3e-3, bounce: 1e-3 });
		expect(isActuatedAt(button, 0.5e-3)).toBe(false);
		expect(isActuatedAt(button, 2e-3)).toBe(true);
		expect(isActuatedAt(button, 5e-3)).toBe(false);
	});

	it('is just the position for a switch nobody scheduled', () => {
		expect(isActuatedAt(sw(), 1)).toBe(false);
		expect(isActuatedAt(sw({ start: 'closed' }), 1)).toBe(true);
	});
});

describe('a part somebody operated while it was playing', () => {
	it('changes at the instant of the click, not from the start', () => {
		const thrown = sw({ flips: '2e-3' });
		expect(isClosedAt(thrown, 1e-3)).toBe(false);
		expect(isClosedAt(thrown, 2e-3)).toBe(true);
		expect(isActuatedAt(thrown, 1e-3)).toBe(false);
		expect(isActuatedAt(thrown, 3e-3)).toBe(true);
	});

	it('gets a control with an edge in it, so the run has the step', () => {
		// This is the whole point. A click written down as a new resting position
		// would replay the run at the new level throughout, and the edge somebody
		// clicked to see would be the one thing missing from the waveform.
		const thrown = sw({ flips: '2e-3' });
		expect(contactControl(thrown).length).toBeGreaterThan(1);
		expect(contactControl(sw())).toEqual([[0, 0]]);
	});

	it('takes several operations, in the order they happened', () => {
		const clicked = sw({ flips: '3e-3,1e-3' });
		expect(operationTimes(clicked)).toEqual([1e-3, 3e-3]);
		expect(isActuatedAt(clicked, 0.5e-3)).toBe(false);
		expect(isActuatedAt(clicked, 2e-3)).toBe(true);
		expect(isActuatedAt(clicked, 4e-3)).toBe(false);
	});

	it('stacks with a scheduled operation rather than replacing it', () => {
		const both = sw({ action: 'toggle', at: 1e-3, bounce: 0, flips: '2e-3' });
		expect(isActuatedAt(both, 0.5e-3)).toBe(false);
		expect(isActuatedAt(both, 1.5e-3)).toBe(true);
		expect(isActuatedAt(both, 3e-3)).toBe(false);
	});

	it('ignores rubbish rather than putting an edge at zero', () => {
		// Zero and below are not moments inside a run, and a run that started with
		// an edge already at t = 0 would be the flat replay this exists to avoid.
		expect(operationTimes(sw({ flips: '0,-1,abc,2e-3' }))).toEqual([2e-3]);
		expect(encodeOperations([3e-3, 1e-3, NaN])).toBe('0.001,0.003');
	});

	it('drives a logic toggle the same way', () => {
		const toggle: Instance = {
			id: 't1',
			kind: 'toggle',
			name: 'T1',
			x: 0,
			y: 0,
			rotation: 0,
			params: { ...defaultParams('toggle'), flips: '2e-3' }
		};
		expect(isHighAt(toggle, 1e-3)).toBe(false);
		expect(isHighAt(toggle, 2e-3)).toBe(true);
		expect(isHighAt({ ...toggle, params: { state: 'high', flips: '2e-3' } }, 3e-3)).toBe(false);
	});
});
