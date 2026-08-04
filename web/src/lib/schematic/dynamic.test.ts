/**
 * What the live layer is allowed to do on its own.
 *
 * Everything drawn over the schematic is a function of the playback instant,
 * except the current dots, which carry a phase that accumulates frame by frame.
 * That phase is the only thing in the app that moves without time moving, so it
 * is the only thing that has to be told when the transport stops — dots still
 * crawling under a paused clock report a flow that the readouts beside them say
 * has been frozen.
 */

import { describe, expect, it, vi } from 'vitest';
import { createAnimationState } from './animate';
import { drawDynamic, tick, type DynamicView } from './dynamic';
import type { FlowFrame } from './flow';

const WIRE = 'w1#0';

// Symbol geometry is compiled into `Path2D`, which is a browser API these tests
// do not have. Nothing here looks at what ends up in one — only at whether the
// drawing code reached for it — so an empty stand-in is enough.
vi.stubGlobal(
	'Path2D',
	class {
		addPath() {}
		rect() {}
		moveTo() {}
		arc() {}
	}
);

function view(overrides: Partial<DynamicView> = {}): DynamicView {
	const frame: FlowFrame = {
		netVoltage: new Map(),
		wireCurrent: new Map([[WIRE, 1]]),
		instanceCurrent: new Map()
	};
	return {
		schematic: { instances: [], wires: [] },
		frame,
		// `tick` reads the reference current and nothing else; the rest of a flow
		// context is planning state for the frame it is handed.
		context: { currentScale: 1 } as DynamicView['context'],
		animation: createAnimationState(),
		netOfPoint: new Map(),
		showVoltage: false,
		showCurrent: true,
		showLight: false,
		showValues: false,
		running: true,
		time: 0,
		stopTime: 1,
		burnouts: new Map(),
		selection: new Set<string>(),
		selectionColour: '#f0f5ff',
		...overrides
	};
}

describe('tick', () => {
	it('moves the current dots along as playback moves', () => {
		const running = view();
		tick(running, 1 / 60);
		expect(running.animation.phase.get(WIRE)).toBeGreaterThan(0);
	});

	it('leaves them exactly where they are when playback has not moved', () => {
		// Which is what being paused amounts to: the transport is not consulted at
		// all, because a paused transport is simply one that is not advancing.
		const paused = view();
		for (let i = 0; i < 120; i++) tick(paused, 0);
		expect(paused.animation.phase.get(WIRE)).toBeUndefined();
	});

	it('does not lose the position it was paused at', () => {
		// Resuming has to pick up where it stopped rather than snapping back to the
		// start, so pausing must not clear the phase either.
		const state = view();
		tick(state, 1 / 60);
		const held = state.animation.phase.get(WIRE);

		const paused = view({ running: false, animation: state.animation });
		tick(paused, 0);
		expect(paused.animation.phase.get(WIRE)).toBe(held);
	});

	it('runs them backwards when the timeline is dragged back', () => {
		// The reported case: pausing froze the dots, but scrubbing backwards left
		// them frozen too — at most their brightness changed. Dragging the timeline
		// is a rewind, and the flow has to rewind with it.
		const forward = view();
		for (let i = 0; i < 8; i++) tick(forward, 1 / 60);
		const ahead = forward.animation.phase.get(WIRE)!;
		expect(ahead).toBeGreaterThan(0);

		tick(forward, -4 / 60);
		expect(forward.animation.phase.get(WIRE)).toBeLessThan(ahead);
	});

	it('stays still with the current layer switched off', () => {
		const hidden = view({ showCurrent: false });
		tick(hidden, 1 / 60);
		expect(hidden.animation.phase.get(WIRE)).toBeUndefined();
	});
});

describe('drawDynamic', () => {
	/** Records which primitives were called, which is all these tests care about. */
	function recorder() {
		const calls: string[] = [];
		const noop = (name: string) => (...args: unknown[]) => {
			void args;
			calls.push(name);
		};
		return {
			calls,
			painter: {
				polyline: noop('polyline'),
				line: noop('line'),
				circle: noop('circle'),
				dot: noop('dot'),
				glow: noop('glow'),
				strokePath: noop('strokePath'),
				fillPath: noop('fillPath'),
				transformed: (_at: unknown, _rotation: unknown, draw: () => void) => {
					calls.push('transformed');
					draw();
				}
			} as unknown as Parameters<typeof drawDynamic>[0]
		};
	}

	const REGION = { x: -1000, y: -1000, w: 2000, h: 2000 };

	const withLed = (overrides: Partial<DynamicView> = {}): DynamicView =>
		view({
			schematic: {
				instances: [
					{ id: 'd1', kind: 'led', name: 'D1', x: 0, y: 0, rotation: 0, params: { colour: 'red' } }
				],
				wires: []
			},
			showCurrent: false,
			showLight: true,
			frame: {
				netVoltage: new Map(),
				wireCurrent: new Map(),
				instanceCurrent: new Map([['d1', 0.02]])
			},
			...overrides
		});

	it('lights an LED carrying current', () => {
		const { painter, calls } = recorder();
		drawDynamic(painter, withLed(), REGION);
		expect(calls).toContain('glow');
	});

	it('does not light one with the light layer off', () => {
		const { painter, calls } = recorder();
		drawDynamic(painter, withLed({ showLight: false }), REGION);
		expect(calls).not.toContain('glow');
	});

	it('still draws the wreckage of a burnt one with the light layer off', () => {
		// Being destroyed is a fact about the circuit, not an effect. Hiding it with
		// the light layer left the drawing contradicting both the panel and a scope
		// trace that visibly steps at the moment the part failed.
		const burnt = withLed({
			showLight: false,
			time: 5e-4,
			burnouts: new Map([
				['d1', { instanceId: 'd1', name: 'D1', time: 3e-4, peak: 0.06, rated: 0.02 }]
			])
		});

		const { painter, calls } = recorder();
		drawDynamic(painter, burnt, REGION);
		expect(calls).toContain('strokePath');
		// The blast is light, though, so that one does answer to the toggle.
		expect(calls).not.toContain('glow');
	});
});

describe('which way the dots travel', () => {
	/** Every dot the layer drew, in the order it drew them. */
	function dotted(view: DynamicView) {
		const dots: Array<{ x: number; y: number }> = [];
		const painter = {
			polyline() {},
			line() {},
			circle(centre: { x: number; y: number }) {
				dots.push({ x: centre.x, y: centre.y });
			},
			dot(centre: { x: number; y: number }) {
				dots.push({ x: centre.x, y: centre.y });
			},
			glow() {},
			strokePath() {},
			fillPath() {},
			transformed(_at: unknown, _rotation: unknown, draw: () => void) {
				draw();
			},
			viewport: { scale: 1 }
		} as unknown as Parameters<typeof drawDynamic>[0];
		drawDynamic(painter, view, { x: -500, y: -500, w: 1000, h: 1000 });
		return dots;
	}

	it('sends a part the same way as the wire feeding it', () => {
		// Reported: the dots crossing a resistor ran one way and the dots on the
		// wires at either end ran the other, on what is electrically one path.
		//
		// Upright, a resistor has `a` on top, and the engine reports the current
		// flowing *into* `a` — so a positive reading is current heading downwards,
		// and so is the wire above delivering it. At a phase of zero the first dot
		// of a run sits on the end it starts from, which is what pins the order.
		const resistor = {
			id: 'r1',
			kind: 'resistor',
			name: 'R1',
			x: 100,
			y: 100,
			rotation: 90 as const,
			params: {}
		};

		const dots = dotted(
			view({
				schematic: {
					instances: [resistor],
					// The wire above it, carrying the same current down into the pin.
					wires: [{ id: 'w', points: [{ x: 100, y: 20 }, { x: 100, y: 70 }] }]
				},
				context: {
					currentScale: 1,
					instanceFlow: new Map([['r1', { from: 'a', to: 'b' }]])
				} as unknown as DynamicView['context'],
				frame: {
					netVoltage: new Map(),
					wireCurrent: new Map([['w#0', 0.5]]),
					instanceCurrent: new Map([['r1', 0.5]])
				}
			})
		);

		const onTheWire = dots.filter((d) => d.y < 70);
		const throughThePart = dots.filter((d) => d.y >= 70);
		expect(onTheWire.length).toBeGreaterThan(0);
		expect(throughThePart.length).toBeGreaterThan(0);

		// Both runs start at their upper end and step downwards.
		expect(onTheWire[0]).toEqual({ x: 100, y: 20 });
		expect(throughThePart[0]).toEqual({ x: 100, y: 70 });
		for (const run of [onTheWire, throughThePart]) {
			for (let i = 1; i < run.length; i++) expect(run[i].y).toBeGreaterThan(run[i - 1].y);
		}
	});
});
