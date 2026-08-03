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
	it('moves the current dots along while the transport runs', () => {
		const running = view();
		tick(running, 1 / 60);
		expect(running.animation.phase.get(WIRE)).toBeGreaterThan(0);
	});

	it('leaves them exactly where they are while it is paused', () => {
		const paused = view({ running: false });
		for (let i = 0; i < 120; i++) tick(paused, 1 / 60);
		expect(paused.animation.phase.get(WIRE)).toBeUndefined();
	});

	it('does not lose the position it was paused at', () => {
		// Resuming has to pick up where it stopped rather than snapping back to the
		// start, so pausing must not clear the phase either.
		const state = view();
		tick(state, 1 / 60);
		const held = state.animation.phase.get(WIRE);

		const paused = view({ running: false, animation: state.animation });
		tick(paused, 1 / 60);
		expect(paused.animation.phase.get(WIRE)).toBe(held);
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
