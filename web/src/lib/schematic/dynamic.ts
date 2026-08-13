/**
 * Drawing the live layer over the schematic.
 *
 * Sits on its own canvas above the static drawing, so a playing animation
 * repaints only this and never re-rasterizes the components underneath.
 *
 * Everything here is a function of the playback instant and nothing else, with
 * one exception: the current dots carry a phase, because motion is the one thing
 * that cannot be read off a single frozen moment. That exception is why `tick`
 * exists, and the phase advances with *playback* rather than with the wall
 * clock — so it holds still under a paused transport, and rewinds and races when
 * the timeline is dragged.
 */

import { rectExpand, type Painter, type Rect, type Vec2 } from '$lib/canvas';
import { advance, drawFlow, voltageColour, type AnimationState } from './animate';
import { drawnReach, LABEL_GAP, leadAxis, symbolPaths } from './draw';
import type { FlowContext, FlowFrame } from './flow';
import { brightness, ledColour, ledRating, type Burnout } from './led';
import { formatWithUnit } from '$lib/units';
import {
	definitionFor,
	definitionOf,
	pointKey,
	rotatePoint,
	wireSegments,
	wireStart,
	type Instance,
	type Schematic
} from './model';
import { instancePins } from './scene';

export interface DynamicView {
	schematic: Schematic;
	frame: FlowFrame;
	context: FlowContext;
	animation: AnimationState;
	netOfPoint: ReadonlyMap<string, number>;
	showVoltage: boolean;
	showCurrent: boolean;
	showLight: boolean;
	showValues: boolean;
	/** Whether the transport is running. Read by the drawing, not by `tick`. */
	running: boolean;
	/** Where playback is, in simulated seconds. */
	time: number;
	/** Length of the run, which sets how long an explosion lasts on screen. */
	stopTime: number;
	/** Instance id -> the moment that LED failed. */
	burnouts: ReadonlyMap<string, Burnout>;
	/** What is selected, and the halo colour — this layer paints over both. */
	selection: ReadonlySet<string>;
	selectionColour: string;
}

/**
 * Advance the animation. Call once per frame, before drawing.
 *
 * `dt` is how far *playback* moved, not how long the frame took — so it is
 * negative when the timeline is dragged backwards and large when it is dragged
 * quickly. That is what makes the dots rewind and race with the scrubber
 * instead of sitting still while only their brightness changes.
 *
 * Which also means there is nothing to gate on the transport: paused and
 * untouched, playback has not moved, `dt` is zero, and the dots hold where they
 * are of their own accord.
 */
export function tick(view: DynamicView, dt: number): void {
	if (!view.showCurrent || dt === 0) return;
	advance(view.animation, view.frame, view.context.currentScale, dt);
}

export function drawDynamic(painter: Painter, view: DynamicView, visible: Rect): void {
	const { frame, context, schematic } = view;
	const region = rectExpand(visible, 60);
	const inside = (x: number, y: number) =>
		x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h;

	if (view.showVoltage) {
		for (const wire of schematic.wires) {
			const start = wireStart(wire);
			const net = view.netOfPoint.get(pointKey(start.x, start.y));
			if (net === undefined) continue;
			const volts = frame.netVoltage.get(net);
			if (volts === undefined) continue;
			if (!wire.points.some((p) => inside(p.x, p.y))) continue;
			// Painted opaquely over the static wire, so a selected one would stop
			// looking selected the moment anything was running — which is exactly
			// when you are most likely to be picking wires out to look at. What it is
			// carrying is on the scope; that it is the one you picked is not.
			const chosen = view.selection.has(wire.id);
			painter.polyline(wire.points, {
				color: chosen ? view.selectionColour : voltageColour(volts, context.voltageRange),
				width: chosen ? 2.4 : 2
			});
		}
	}

	if (view.showCurrent) {
		for (const wire of schematic.wires) {
			for (const segment of wireSegments(wire)) {
				if (!inside(segment.a.x, segment.a.y) && !inside(segment.b.x, segment.b.y)) continue;
				const id = `${wire.id}#${segment.index}`;
				const current = frame.wireCurrent.get(id);
				if (current === undefined) continue;
				drawFlow(
					painter,
					segment.a,
					segment.b,
					current,
					context.currentScale,
					view.animation.phase.get(id) ?? 0,
					'#ffe9a8'
				);
			}
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

			// `from` is the terminal the engine reports current *into*, so a positive
			// reading means it runs `from` → `to` inside the part. Drawn the other
			// way round, the dots crossing a resistor went against the dots on the
			// wires at both of its ends — the same conductor, animated two ways.
			drawFlow(
				painter,
				from as Vec2,
				to as Vec2,
				current,
				context.currentScale,
				view.animation.phase.get(`i:${instance.id}`) ?? 0,
				'#ffe9a8'
			);
		}
	}

	if (view.showValues) drawReadings(painter, view, inside);

	// Not gated on `showLight`: a part that has been destroyed is a fact about the
	// circuit, not a lighting effect. Switching the light layer off has to leave a
	// burnt LED looking burnt, or the drawing contradicts both the panel and the
	// scope trace that steps at the moment it failed.
	for (const instance of schematic.instances) {
		if (instance.kind !== 'led') continue;
		if (!inside(instance.x, instance.y)) continue;
		drawLed(painter, view, instance);
	}
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/** Volts. Green, the way a meter's leads are, and clear of the two voltage poles. */
const VOLTS_INK = '#7fe3a0';
/** Amps, in the colour of the current dots, so the two read as one idea. */
const AMPS_INK = '#ffe9a8';
/** One line of text, in schematic units, for stacking a reading under a label. */
const LINE = 12;

/**
 * Significant figures in a reading.
 *
 * Three, not the four the catalog uses for values someone typed in. A typed
 * value is exact and deserves to be shown back exactly; a reading is a
 * measurement, and `2.695 V` claims a precision the circuit does not have while
 * being harder to read at a glance than `2.7 V`. The scope is there for anyone
 * who wants the fourth digit.
 */
const FIGURES = 3;

/**
 * The numbers behind the colours.
 *
 * Colour and motion say *roughly*, at a glance, which is what you want while
 * something is moving. A number says exactly, which is what you want once you
 * have stopped to check one. They are separate switches for that reason.
 *
 * One voltage per net rather than one per wire: a net is at a single potential
 * by definition, so labelling every leg would be the same number written five
 * times. It goes at the net's topmost-leftmost corner, which is stable — the
 * same net labels itself in the same place from frame to frame and run to run.
 *
 * Current is per component, because that is where the engine defines it.
 */
function drawReadings(
	painter: Painter,
	view: DynamicView,
	inside: (x: number, y: number) => boolean
): void {
	const size = Math.min(11 * painter.viewport.scale, 14);
	if (size < 7) return;

	// Where each part is, so a reading is not written across one.
	//
	// The label sits just above its anchor, and the topmost point of a net is
	// very often a pin — which put the reading inside the symbol it belongs to,
	// overlapping the drawing and, on a source, sitting in the middle of the
	// circle. A point out on the wiring says the same thing and can be read.
	const bodies = view.schematic.instances.map((instance) => {
		const box = definitionFor(instance).box;
		const half = rotatePoint(box.w / 2, box.h / 2, instance.rotation);
		return {
			x: instance.x - Math.abs(half.x),
			y: instance.y - Math.abs(half.y),
			w: Math.abs(half.x) * 2,
			h: Math.abs(half.y) * 2
		};
	});
	const clearOfParts = (p: Vec2) =>
		!bodies.some(
			(b) => p.x >= b.x - 6 && p.x <= b.x + b.w + 6 && p.y >= b.y - 14 && p.y <= b.y + b.h + 6
		);

	const anchor = new Map<number, { at: Vec2; clear: boolean }>();
	for (const wire of view.schematic.wires) {
		for (const point of wire.points) {
			const net = view.netOfPoint.get(pointKey(point.x, point.y));
			if (net === undefined) continue;
			const clear = clearOfParts(point);
			const best = anchor.get(net);
			// Clear of every symbol first, and only then highest and leftmost. A net
			// whose every point is under something keeps the old placement rather
			// than losing its reading altogether.
			const better =
				!best ||
				(clear && !best.clear) ||
				(clear === best.clear &&
					(point.y < best.at.y || (point.y === best.at.y && point.x < best.at.x)));
			if (better) anchor.set(net, { at: { x: point.x, y: point.y }, clear });
		}
	}

	for (const [net, { at }] of anchor) {
		const volts = view.frame.netVoltage.get(net);
		if (volts === undefined || !inside(at.x, at.y)) continue;
		painter.text(formatWithUnit(volts, 'V', FIGURES), { x: at.x, y: at.y - 7 }, {
			size,
			color: VOLTS_INK,
			align: 'center',
			baseline: 'bottom',
			minSize: 7
		});
	}

	for (const instance of view.schematic.instances) {
		const current = view.frame.instanceCurrent.get(instance.id);
		if (current === undefined || !inside(instance.x, instance.y)) continue;
		// Stacked under the name and the value rather than put somewhere of its own.
		// Those two already sit on the side the leads leave clear, and that is the
		// only side with room: dropping the reading anywhere else lands it on a wire
		// for one orientation or the other.
		const def = definitionFor(instance);
		const reach = drawnReach(def, instance.rotation);
		const sideways = leadAxis(def, instance.rotation) === 'x';
		const clear = (sideways ? reach.y : reach.x) + LABEL_GAP;
		painter.text(
			formatWithUnit(Math.abs(current), 'A', FIGURES),
			sideways
				? { x: instance.x, y: instance.y + clear + LINE }
				: { x: instance.x + clear, y: instance.y + 8 + LINE },
			{
				size,
				color: AMPS_INK,
				align: sideways ? 'center' : 'left',
				baseline: 'top',
				minSize: 7
			}
		);
	}
}

// ---------------------------------------------------------------------------
// LEDs
// ---------------------------------------------------------------------------

/**
 * How much of the run an explosion plays over.
 *
 * A fraction rather than a fixed duration, because it is measured in simulated
 * time: that way the burst takes the same share of the replay whether the run
 * covers a microsecond or a minute, and scrubbing back over the moment replays
 * it instead of finding it already finished.
 */
const BURST_SPAN = 0.05;

/** What is left of a part that has burnt, and the cracks through it. */
const CHAR = '#2b2521';
const CRACK = '#7a6250';

function drawLed(painter: Painter, view: DynamicView, instance: Instance): void {
	const at = { x: instance.x, y: instance.y };
	const burn = view.burnouts.get(instance.id);

	if (!burn || view.time < burn.time) {
		if (!view.showLight) return;
		const current = view.frame.instanceCurrent.get(instance.id) ?? 0;
		const lit = brightness(current, ledRating(instance));
		// Below this it is a leakage current, not a light. Drawing it would put a
		// permanent smudge on every LED in the circuit, lit or not.
		if (lit < 0.05) return;

		const { rgb } = ledColour(instance.params.colour);
		// Three passes, all added rather than painted over each other: a wide halo
		// for the spill, a tight one for the part of it that is genuinely bright,
		// and a hot core so the LED reads as the source of the light rather than as
		// something sitting in a pool of it. One pass alone cannot do both ends —
		// wide enough to spill is too faint to look lit at full current.
		painter.glow(at, 14 + 34 * lit, rgb, Math.min(0.2 + lit * 0.5, 0.9));
		painter.glow(at, (14 + 34 * lit) * 0.45, rgb, Math.min(0.25 + lit * 0.55, 1));
		painter.dot(at, 2.2 + 4 * Math.min(lit, 1), {
			color: whiteHot(rgb, Math.max(lit - 0.75, 0) * 0.5),
			alpha: Math.min(0.55 + lit * 0.5, 1)
		});
		return;
	}

	// Past the moment it failed. The char is drawn first and unconditionally, so
	// a burnt part still looks burnt when the transport is paused long after the
	// blast has finished — the failure is a fact about the circuit, not an effect.
	const paths = symbolPaths(instance.kind, instance.params);
	painter.transformed(at, instance.rotation, () => {
		painter.strokePath(paths.stroke, { color: CHAR, width: 3 });
		if (paths.hasFill) painter.fillPath(paths.fill, { color: CHAR });
		painter.polyline(
			[
				{ x: -7, y: -6 },
				{ x: -1, y: 1 },
				{ x: -4, y: 4 },
				{ x: 3, y: 8 }
			],
			{ color: CRACK, width: 1.4 }
		);
		painter.polyline(
			[
				{ x: -2, y: -8 },
				{ x: 2, y: -2 },
				{ x: 8, y: -3 }
			],
			{ color: CRACK, width: 1.2 }
		);
	});

	// The blast itself is light, so it does answer to the toggle. The wreckage
	// above does not.
	const progress = (view.time - burn.time) / Math.max(view.stopTime * BURST_SPAN, 1e-15);
	if (view.showLight && progress <= 1) drawBurst(painter, at, progress, instance.id);
}

/**
 * The explosion, as a function of how far through it we are.
 *
 * No state is kept between frames: the shard directions come from the instance
 * id, so the same LED blows apart the same way every time it is replayed, and
 * scrubbing backwards and forwards over the moment is stable rather than
 * reshuffling the debris on every pass.
 */
function drawBurst(painter: Painter, at: Vec2, progress: number, seed: string): void {
	const fade = 1 - progress;

	// The flash. Brief, white-hot, and gone before the ring has travelled far.
	if (progress < 0.35) {
		const heat = 1 - progress / 0.35;
		painter.glow(at, 18 + 30 * (1 - heat), [255, 238, 205], 0.9 * heat);
	}

	// The shock front, expanding and thinning as it goes.
	painter.circle(at, 6 + 46 * progress, undefined, {
		color: '#ffb066',
		width: 2.6 * fade,
		alpha: fade * 0.9
	});

	// Pieces of the package on their way out, each a short streak along its path.
	const random = seeded(seed);
	for (let i = 0; i < 9; i++) {
		const angle = random() * Math.PI * 2;
		const reach = (24 + random() * 28) * progress;
		const dx = Math.cos(angle);
		const dy = Math.sin(angle);
		const tail = 8 * fade;
		painter.line(
			{ x: at.x + dx * reach, y: at.y + dy * reach },
			{ x: at.x + dx * (reach + tail), y: at.y + dy * (reach + tail) },
			{ color: '#ffd9a0', width: 1.8, alpha: fade }
		);
	}

	// Smoke, once the light has gone out of it.
	if (progress > 0.3) {
		const drift = (progress - 0.3) / 0.7;
		painter.glow({ x: at.x, y: at.y - 26 * drift }, 11 + 26 * drift, [128, 128, 140], 0.3 * (1 - drift));
	}
}

/**
 * Pull a colour toward white.
 *
 * Real light sources desaturate at their centre once they are bright enough to
 * saturate whatever is looking at them, and that is the cue the eye reads as
 * "very bright" — a pure hue can only get so convincing before it just looks
 * like a bigger patch of the same colour.
 */
function whiteHot(rgb: readonly [number, number, number], amount: number): string {
	const t = Math.min(Math.max(amount, 0), 1);
	const mix = (c: number) => Math.round(c + (255 - c) * t);
	return `rgb(${mix(rgb[0])}, ${mix(rgb[1])}, ${mix(rgb[2])})`;
}

/** A small deterministic generator, seeded by text. */
function seeded(text: string): () => number {
	let state = 2166136261;
	for (let i = 0; i < text.length; i++) {
		state ^= text.charCodeAt(i);
		state = Math.imul(state, 16777619);
	}
	return () => {
		state = Math.imul(state ^ (state >>> 15), 2246822507);
		state = Math.imul(state ^ (state >>> 13), 3266489909);
		state ^= state >>> 16;
		return (state >>> 0) / 4294967296;
	};
}
