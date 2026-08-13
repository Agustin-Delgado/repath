/**
 * Translates the schematic model into what the canvas engine understands:
 * scene items to pick and cull, and snap targets to draw against.
 *
 * Rebuilt whenever the model changes. That sounds wasteful, but it is a few
 * object literals per component and it removes a whole class of bug — the index
 * cannot drift out of step with the document if it is derived from it.
 */

import {
	distanceToSegment,
	rectFromBounds,
	type Rect,
	type SceneItem,
	type SnapPoint,
	type SnapSegment,
	type Vec2
} from '$lib/canvas';
import {
	definitionFor,
	definitionOf,
	pinPosition,
	rotatePoint,
	wireSegments,
	type Instance,
	type PinDef,
	type Rotation,
	type Schematic,
	type Wire
} from './model';
import { junctionDots } from './nets';

export type SchematicItem =
	| { type: 'instance'; instance: Instance }
	| { type: 'wire'; wire: Wire };

export const Z_WIRE = 0;
export const Z_INSTANCE = 10;

const INVERSE: Record<Rotation, Rotation> = { 0: 0, 90: 270, 180: 180, 270: 90 };

/** World-space bounds of a placed component, accounting for its rotation. */
export function instanceBounds(instance: Instance): Rect {
	const { box } = definitionFor(instance);
	const corners: Vec2[] = [
		{ x: box.x, y: box.y },
		{ x: box.x + box.w, y: box.y },
		{ x: box.x, y: box.y + box.h },
		{ x: box.x + box.w, y: box.y + box.h }
	].map((c) => rotatePoint(c.x, c.y, instance.rotation));

	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const c of corners) {
		minX = Math.min(minX, c.x);
		minY = Math.min(minY, c.y);
		maxX = Math.max(maxX, c.x);
		maxY = Math.max(maxY, c.y);
	}
	return rectFromBounds(instance.x + minX, instance.y + minY, instance.x + maxX, instance.y + maxY);
}

/** Is `point` (world space) inside this component's own, unrotated box? */
export function hitInstance(instance: Instance, point: Vec2, tolerance: number): boolean {
	const { box } = definitionFor(instance);
	// Undo the placement, so the test is against the axis-aligned local box.
	const local = rotatePoint(point.x - instance.x, point.y - instance.y, INVERSE[instance.rotation]);
	return (
		local.x >= box.x - tolerance &&
		local.x <= box.x + box.w + tolerance &&
		local.y >= box.y - tolerance &&
		local.y <= box.y + box.h + tolerance
	);
}

export function wireBounds(wire: Wire): Rect {
	const xs = wire.points.map((p) => p.x);
	const ys = wire.points.map((p) => p.y);
	return rectFromBounds(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/** Distance from a point to the nearest part of a wire. */
export function distanceToWire(wire: Wire, point: Vec2): number {
	let best = Infinity;
	for (const segment of wireSegments(wire)) {
		best = Math.min(best, distanceToSegment(point, segment.a, segment.b));
	}
	return best;
}

export function buildSceneItems(schematic: Schematic): SceneItem<SchematicItem>[] {
	const items: SceneItem<SchematicItem>[] = [];

	for (const wire of schematic.wires) {
		items.push({
			id: wire.id,
			kind: 'wire',
			bounds: wireBounds(wire),
			z: Z_WIRE,
			data: { type: 'wire', wire },
			// Distance to the wire itself, not to its box: an L-shaped run's
			// bounding box is mostly empty space, and picking it there would be
			// maddening.
			hit: (point, tolerance) => distanceToWire(wire, point) <= tolerance
		});
	}

	for (const instance of schematic.instances) {
		items.push({
			id: instance.id,
			kind: 'instance',
			bounds: instanceBounds(instance),
			z: Z_INSTANCE,
			data: { type: 'instance', instance },
			hit: (point, tolerance) => hitInstance(instance, point, tolerance)
		});
	}

	return items;
}

export interface SnapTargets {
	points: SnapPoint[];
	segments: SnapSegment[];
}

export function buildSnapTargets(schematic: Schematic): SnapTargets {
	const points: SnapPoint[] = [];

	for (const instance of schematic.instances) {
		for (const pin of definitionFor(instance).pins) {
			const at = pinPosition(instance, pin);
			points.push({
				x: at.x,
				y: at.y,
				kind: 'pin',
				ownerId: instance.id,
				label: `${instance.name}.${pin.name}`
			});
		}
	}

	for (const wire of schematic.wires) {
		// Corners are snappable too — carrying on from a bend is as reasonable as
		// carrying on from an end.
		for (const point of wire.points) {
			points.push({ x: point.x, y: point.y, kind: 'wire-end', ownerId: wire.id });
		}
	}

	// Junctions rank above plain wire ends, so a three-way meeting point wins
	// over whichever wire happened to be drawn first.
	for (const dot of junctionDots(schematic)) {
		points.push({ x: dot.x, y: dot.y, kind: 'junction' });
	}

	const segments: SnapSegment[] = schematic.wires.flatMap((wire) =>
		wireSegments(wire).map((segment) => ({ a: segment.a, b: segment.b, ownerId: wire.id }))
	);

	return { points, segments };
}

/** Every pin of a component, in world space. Used for drawing and for tools. */
export function instancePins(instance: Instance): Array<{ pin: PinDef; at: Vec2 }> {
	return definitionFor(instance).pins.map((pin) => ({ pin, at: pinPosition(instance, pin) }));
}
