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
import { advance, createAnimationState, forget, isFlowing } from './animate';
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
		netUndriven: new Set(),
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
		floating: new Set<number>(),
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
				netUndriven: new Set(),
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
					netUndriven: new Set(),
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

describe('a circuit that conducts in bursts', () => {
	/**
	 * The reported symptom: dots that blink rather than flow.
	 *
	 * A CMOS gate charges in twenty nanoseconds and then does nothing for fifty
	 * microseconds, while a frame covers a couple of microseconds. Drawn from the
	 * instant at the end of each frame, the wire showed nothing at all on almost
	 * every frame and one bright flash on the rest. The envelope is what keeps it
	 * on screen between bursts, and the pending travel is what turns the burst's
	 * charge into a glide instead of a jump.
	 */
	it('keeps its dots on screen between the bursts', () => {
		const state = createAnimationState();
		const scale = 1e-5;
		const frames: FlowFrame[] = [];
		// One burst, then thirty frames of nothing, twice over.
		for (let round = 0; round < 2; round++) {
			for (let k = 0; k < 30; k++) {
				frames.push({
					netVoltage: new Map(),
					netUndriven: new Set(),
					wireCurrent: new Map([['w#0', k === 0 ? 3e-4 : 0]]),
					instanceCurrent: new Map()
				});
			}
		}

		let drawn = 0;
		let moving = 0;
		let travel = 0;
		let previous = 0;
		for (const frame of frames) {
			advance(state, frame, scale, 1 / 60);
			const level = state.level.get('w#0') ?? 0;
			if (isFlowing(level, scale)) drawn++;
			const phase = state.phase.get('w#0') ?? 0;
			let step = phase - previous;
			if (Math.abs(step) > 11) step -= Math.sign(step) * 22;
			if (Math.abs(step) > 0.05) moving++;
			travel += Math.abs(step);
			previous = phase;
		}

		// Two bursts in sixty frames used to light two of them.
		expect(drawn).toBeGreaterThan(50);
		expect(moving).toBeGreaterThan(40);
		// And the travel is the charge that went past, not an invention: two
		// bursts of 3e-4 A over a frame each, against a 1e-5 A reference.
		expect(travel).toBeGreaterThan(20);
	});

	it('drops the held reading when the circuit under it changes', () => {
		// The envelope is what keeps a burst on screen, and it is wrong across a
		// contact. A switch bouncing open for a quarter of a millisecond left the
		// branch it fed reading milliamps — beside its own symbol, drawn with the
		// blade open. The engine had picoamps there: the reading was the needle
		// coasting, not a current. `forget` is what the drawing calls when a blade
		// moves, and this is the difference it makes.
		const scale = 5e-3;
		const conducting: FlowFrame = {
			netVoltage: new Map(),
			netUndriven: new Set(),
			wireCurrent: new Map([['w#0', 4e-3]]),
			instanceCurrent: new Map()
		};
		const opened: FlowFrame = {
			netVoltage: new Map(),
			netUndriven: new Set(),
			// What an open contact really carries: leakage through a terohm.
			wireCurrent: new Map([['w#0', 5e-12]]),
			instanceCurrent: new Map()
		};

		const coasting = createAnimationState();
		const cut = createAnimationState();
		for (const state of [coasting, cut]) {
			for (let k = 0; k < 10; k++) advance(state, conducting, scale, 1 / 60);
		}
		const held = cut.phase.get('w#0')!;
		forget(cut);
		// Nothing jumps: forgetting a reading is not moving a dot.
		expect(cut.phase.get('w#0')).toBe(held);
		// A tenth of a second of open contact — well inside the fall time.
		for (let k = 0; k < 6; k++) {
			advance(coasting, opened, scale, 1 / 60);
			advance(cut, opened, scale, 1 / 60);
		}

		// Left alone it still claims most of the current it had.
		expect(coasting.level.get('w#0') ?? 0).toBeGreaterThan(3e-3);
		expect(isFlowing(coasting.level.get('w#0') ?? 0, scale)).toBe(true);
		// Told the circuit changed, it reports what is there now.
		expect(cut.level.get('w#0') ?? 0).toBeLessThan(1e-9);
		expect(isFlowing(cut.level.get('w#0') ?? 0, scale)).toBe(false);
		// And where the dots sit is untouched by any of it — they simply stop.
		expect(cut.phase.get('w#0')).toBe(held);
		expect(coasting.phase.get('w#0')).not.toBe(held);
	});

	it('leaves a wire that carries nothing alone', () => {
		const state = createAnimationState();
		const quiet: FlowFrame = {
			netVoltage: new Map(),
			netUndriven: new Set(),
			wireCurrent: new Map([['w#0', 0]]),
			instanceCurrent: new Map()
		};
		for (let k = 0; k < 60; k++) advance(state, quiet, 1e-5, 1 / 60);
		expect(isFlowing(state.level.get('w#0') ?? 0, 1e-5)).toBe(false);
		expect(state.phase.get('w#0') ?? 0).toBe(0);
	});
});
