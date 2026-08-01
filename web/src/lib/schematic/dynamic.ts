/**
 * Drawing the live layer over the schematic.
 *
 * Sits on its own canvas above the static drawing, so a playing animation
 * repaints only this and never re-rasterizes the components underneath.
 */

import { rectExpand, type Painter, type Rect, type Vec2 } from '$lib/canvas';
import { advance, drawFlow, voltageColour, type AnimationState } from './animate';
import type { FlowContext, FlowFrame } from './flow';
import { pointKey, type Schematic } from './model';
import { instancePins } from './scene';

export interface DynamicView {
	schematic: Schematic;
	frame: FlowFrame;
	context: FlowContext;
	animation: AnimationState;
	netOfPoint: ReadonlyMap<string, number>;
	showVoltage: boolean;
	showCurrent: boolean;
}

/** Advance the animation. Call once per frame, before drawing. */
export function tick(view: DynamicView, dt: number): void {
	if (!view.showCurrent) return;
	advance(view.animation, view.frame, view.context.currentScale, dt);
}

export function drawDynamic(painter: Painter, view: DynamicView, visible: Rect): void {
	const { frame, context, schematic } = view;
	const region = rectExpand(visible, 60);
	const inside = (x: number, y: number) =>
		x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h;

	if (view.showVoltage) {
		for (const wire of schematic.wires) {
			if (!inside(wire.x1, wire.y1) && !inside(wire.x2, wire.y2)) continue;
			const net = view.netOfPoint.get(pointKey(wire.x1, wire.y1));
			if (net === undefined) continue;
			const volts = frame.netVoltage.get(net);
			if (volts === undefined) continue;
			// Drawn opaque over the static wire, replacing it rather than tinting.
			painter.line(
				{ x: wire.x1, y: wire.y1 },
				{ x: wire.x2, y: wire.y2 },
				{ color: voltageColour(volts, context.voltageRange), width: 2.5 }
			);
		}
	}

	if (!view.showCurrent) return;

	for (const wire of schematic.wires) {
		if (!inside(wire.x1, wire.y1) && !inside(wire.x2, wire.y2)) continue;
		const current = frame.wireCurrent.get(wire.id);
		if (current === undefined) continue;
		drawFlow(
			painter,
			{ x: wire.x1, y: wire.y1 },
			{ x: wire.x2, y: wire.y2 },
			current,
			context.currentScale,
			view.animation.phase.get(wire.id) ?? 0,
			'#ffe9a8'
		);
	}

	// And through the devices themselves, so current does not appear to vanish
	// on entering a resistor and reappear on the far side.
	for (const instance of schematic.instances) {
		const path = context.instanceFlow.get(instance.id);
		if (!path) continue;
		const current = frame.instanceCurrent.get(instance.id);
		if (current === undefined) continue;
		if (!inside(instance.x, instance.y)) continue;

		const pins = new Map(instancePins(instance).map(({ pin, at }) => [pin.name, at] as const));
		const from = pins.get(path.from);
		const to = pins.get(path.to);
		if (!from || !to) continue;

		// Current flows from the `to` pin toward the `from` pin when positive,
		// matching the engine's convention of current *into* the first terminal.
		drawFlow(
			painter,
			to as Vec2,
			from as Vec2,
			current,
			context.currentScale,
			view.animation.phase.get(`i:${instance.id}`) ?? 0,
			'#ffe9a8'
		);
	}
}
