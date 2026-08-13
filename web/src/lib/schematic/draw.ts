/**
 * Painting the schematic onto canvas layers.
 *
 * Everything here culls against the visible region first. That is what makes a
 * large drawing pannable: the cost of a frame tracks what is on screen, not how
 * much has been drawn in total.
 *
 * Colours come from CSS custom properties, read once and cached, so the canvas
 * stays in step with the rest of the app's theme without hard-coding hexes in
 * two places.
 */

import { rectExpand, type Painter, type Rect, type Vec2 } from '$lib/canvas';
import { formatWithUnit } from '$lib/units';
import { ledInk, ledRating } from './led';
import {
	definitionFor,
	definitionOf,
	rotatePoint,
	wireStart,
	type ComponentDef,
	type Instance,
	type Rotation,
	type Schematic,
	type Wire
} from './model';
import { instancePins } from './scene';
import { symbolGeometry, symbolVariant, type Shape } from './symbols';

export interface Theme {
	background: string;
	gridDot: string;
	wire: string;
	symbol: string;
	pin: string;
	pinDigital: string;
	accent: string;
	selection: string;
	labelStrong: string;
	labelDim: string;
	/** For showing that something is not going to be accepted. */
	danger: string;
}

const FALLBACK: Theme = {
	background: '#0e1116',
	gridDot: '#232936',
	wire: '#8b96aa',
	symbol: '#cfd7e4',
	pin: '#6d7a8f',
	pinDigital: '#d09b4a',
	accent: '#4ea8ff',
	/**
	 * Yellow, and nothing else on the canvas is.
	 *
	 * It was orange before, which was the second trace colour *exactly* — so a
	 * selected wire and a probed one were the same shade. Yellow is clear of the
	 * traces, of the diverging voltage scale, of danger, and of the LED inks.
	 */
	selection: '#ffd400',
	labelStrong: '#cdd5e2',
	labelDim: '#7c8496',
	danger: '#ff6b7a'
};

/**
 * The theme in effect, so tools can draw overlay feedback without every one of
 * them having to be handed a palette.
 */
let active: Theme = FALLBACK;

export function currentTheme(): Theme {
	return active;
}

export function setCurrentTheme(theme: Theme): void {
	active = theme;
}

/**
 * Clear space between a symbol and its labels.
 *
 * One number for every part, applied to what each part actually draws, so a
 * resistor and a transistor sit the same distance from their names however
 * differently sized their symbols are.
 */
export const LABEL_GAP = 5;

/**
 * Which way a part's leads leave it, once rotated.
 *
 * Labels go on the side with no lead on it, and this is how that side is found.
 * Deciding it from the rotation instead — which is what this did first — works
 * for the parts whose pins happen to lie along their long axis and fails for the
 * ones that do not: an upright voltage source has its terminals top and bottom,
 * so a label placed underneath lands squarely on the wire leaving it.
 */
export function leadAxis(def: ComponentDef, rotation: Rotation): 'x' | 'y' {
	let spreadX = 0;
	let spreadY = 0;
	const turned = def.pins.map((pin) => rotatePoint(pin.x, pin.y, rotation));
	for (const a of turned) {
		for (const b of turned) {
			spreadX = Math.max(spreadX, Math.abs(a.x - b.x));
			spreadY = Math.max(spreadY, Math.abs(a.y - b.y));
		}
	}
	// A single-pin part spreads nowhere; treat its lead as the way the pin points.
	if (spreadX === 0 && spreadY === 0) {
		const only = turned[0] ?? { x: 0, y: 0 };
		return Math.abs(only.x) >= Math.abs(only.y) ? 'x' : 'y';
	}
	return spreadX >= spreadY ? 'x' : 'y';
}

/**
 * How far a symbol reaches from its origin, on each axis, once rotated.
 *
 * The catalog box is in the symbol's own frame; turning a part swaps which of
 * its dimensions faces the label.
 */
export function drawnReach(def: ComponentDef, rotation: Rotation): { x: number; y: number } {
	const corners = [
		{ x: def.box.x, y: def.box.y },
		{ x: def.box.x + def.box.w, y: def.box.y },
		{ x: def.box.x, y: def.box.y + def.box.h },
		{ x: def.box.x + def.box.w, y: def.box.y + def.box.h }
	].map((c) => rotatePoint(c.x, c.y, rotation));
	return {
		x: Math.max(...corners.map((c) => Math.abs(c.x))),
		y: Math.max(...corners.map((c) => Math.abs(c.y)))
	};
}

export function readTheme(element: HTMLElement): Theme {
	const style = getComputedStyle(element);
	const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
	return {
		background: read('--canvas-bg', FALLBACK.background),
		gridDot: read('--grid-dot', FALLBACK.gridDot),
		wire: read('--wire', FALLBACK.wire),
		symbol: read('--symbol', FALLBACK.symbol),
		pin: read('--pin', FALLBACK.pin),
		pinDigital: read('--pin-digital', FALLBACK.pinDigital),
		accent: read('--accent', FALLBACK.accent),
		selection: read('--selection', FALLBACK.selection),
		labelStrong: read('--label-strong', FALLBACK.labelStrong),
		labelDim: read('--label-dim', FALLBACK.labelDim),
		danger: read('--danger', FALLBACK.danger)
	};
}

// ---------------------------------------------------------------------------
// Symbol paths
// ---------------------------------------------------------------------------

interface SymbolPaths {
	stroke: Path2D;
	fill: Path2D;
	hasFill: boolean;
}

const pathCache = new Map<string, SymbolPaths>();

function appendShape(target: Path2D, shape: Shape): void {
	switch (shape.kind) {
		case 'path':
			target.addPath(new Path2D(shape.d));
			break;
		case 'rect':
			target.rect(shape.x, shape.y, shape.w, shape.h);
			break;
		case 'circle':
			target.moveTo(shape.cx + shape.r, shape.cy);
			target.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2);
			break;
	}
}

/** `Path2D` for a symbol variant, built once and reused for every instance. */
export function symbolPaths(kind: string, params: Record<string, unknown>): SymbolPaths {
	const key = symbolVariant(kind, params);
	const cached = pathCache.get(key);
	if (cached) return cached;

	const geometry = symbolGeometry(kind, params);
	const stroke = new Path2D();
	const fill = new Path2D();
	let hasFill = false;
	for (const shape of geometry.shapes) {
		if (shape.fill) {
			appendShape(fill, shape);
			hasFill = true;
		} else {
			appendShape(stroke, shape);
		}
	}

	const built = { stroke, fill, hasFill };
	pathCache.set(key, built);
	return built;
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** Never draw dots closer together than this on screen. */
const MIN_DOT_SPACING = 9;

export function drawGrid(painter: Painter, theme: Theme, gridSize: number, visible: Rect): void {
	const { scale } = painter.viewport;

	// Zoomed out, the base grid would turn into a grey wash. Step up in multiples
	// until the dots are far enough apart to read as a grid again.
	let step = gridSize;
	while (step * scale < MIN_DOT_SPACING) step *= 5;

	const startX = Math.floor(visible.x / step) * step;
	const startY = Math.floor(visible.y / step) * step;
	const endX = visible.x + visible.w;
	const endY = visible.y + visible.h;

	// Bail out rather than lock up if the viewport is somehow enormous.
	const columns = (endX - startX) / step;
	const rows = (endY - startY) / step;
	if (!Number.isFinite(columns) || columns * rows > 40_000) return;

	const ctx = painter.ctx;
	painter.screen();
	ctx.fillStyle = theme.gridDot;
	const radius = scale > 1.5 ? 1.2 : 1;
	for (let x = startX; x <= endX; x += step) {
		for (let y = startY; y <= endY; y += step) {
			const at = painter.viewport.toScreen({ x, y });
			ctx.beginPath();
			ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
			ctx.fill();
		}
	}
	painter.world();
}

// ---------------------------------------------------------------------------
// Schematic
// ---------------------------------------------------------------------------

export interface SchematicView {
	schematic: Schematic;
	theme: Theme;
	/** Ids of selected instances and wires. */
	selection: ReadonlySet<string>;
	/** Net index currently hovered, or null. */
	hoverNet: number | null;
	/** Grid point key -> net index, for colouring wires by net. */
	netOfPoint: ReadonlyMap<string, number>;
	/** Net index -> trace colour, for probed nets. */
	probeColours: ReadonlyMap<number, string>;
	/** Probe instance id -> the name and colour it appears under on the scope. */
	probes?: ReadonlyMap<string, { label: string; colour: string }>;
	junctions: readonly Vec2[];
}

const keyOf = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`;

/** Cheap bounding-box cull for a wire against the visible region. */
export function wireVisible(wire: Wire, region: Rect): boolean {
	const xs = wire.points.map((p) => p.x);
	const ys = wire.points.map((p) => p.y);
	return !(
		Math.max(...xs) < region.x ||
		Math.min(...xs) > region.x + region.w ||
		Math.max(...ys) < region.y ||
		Math.min(...ys) > region.y + region.h
	);
}

function wireColour(wire: Wire, view: SchematicView): { colour: string; width: number } {
	if (view.selection.has(wire.id)) return { colour: view.theme.selection, width: 2.4 };
	const start = wireStart(wire);
	const net = view.netOfPoint.get(keyOf(start.x, start.y));
	if (net !== undefined && net === view.hoverNet) return { colour: view.theme.accent, width: 2.4 };
	const probe = net === undefined ? undefined : view.probeColours.get(net);
	if (probe) return { colour: probe, width: 2 };
	return { colour: view.theme.wire, width: 1.5 };
}

function valueLabel(instance: Instance): string | null {
	const p = instance.params;
	switch (instance.kind) {
		case 'resistor':
			return formatWithUnit(Number(p.resistance), 'Ω');
		case 'capacitor':
			return formatWithUnit(Number(p.capacitance), 'F');
		case 'inductor':
			return formatWithUnit(Number(p.inductance), 'H');
		case 'vsource':
			return p.waveform === 'dc'
				? formatWithUnit(Number(p.value), 'V')
				: `${formatWithUnit(Number(p.value), 'V')} ${formatWithUnit(Number(p.frequency), 'Hz')}`;
		case 'isource':
			return formatWithUnit(Number(p.value), 'A');
		case 'led':
			// The rating rather than the colour: the colour is already on the symbol,
			// and what is worth reading off a schematic is the number you have to size
			// the series resistor against.
			return formatWithUnit(ledRating(instance), 'A');
		case 'clock':
			return formatWithUnit(Number(p.frequency), 'Hz');
		case 'supply':
			return formatWithUnit(Number(p.voltage), 'V');
		case 'switch':
			// When it operates, not what it is made of. A switch that never moves is
			// a wire or a gap, and the drawing already says which.
			return `${p.start === 'closed' ? 'opens' : 'closes'} ${formatWithUnit(Number(p.at), 's')}`;
		default:
			return null;
	}
}

export function drawSchematic(painter: Painter, view: SchematicView, visible: Rect): void {
	const { theme } = view;
	const scale = painter.viewport.scale;
	// Labels track the zoom, but only so far: past a point a value legend that
	// keeps growing crowds out the circuit it is annotating.
	const labelSize = Math.min(11 * scale, 15);
	// A little slack so a component straddling the edge is not clipped mid-symbol.
	const region = rectExpand(visible, 60);

	for (const wire of view.schematic.wires) {
		if (!wireVisible(wire, region)) continue;
		const { colour, width } = wireColour(wire, view);
		painter.polyline(wire.points, { color: colour, width });
	}

	for (const dot of view.junctions) {
		if (dot.x < region.x || dot.x > region.x + region.w) continue;
		if (dot.y < region.y || dot.y > region.y + region.h) continue;
		const net = view.netOfPoint.get(keyOf(dot.x, dot.y));
		const colour =
			(net !== undefined && net === view.hoverNet && theme.accent) ||
			(net !== undefined && view.probeColours.get(net)) ||
			theme.wire;
		painter.dot(dot, 3, { color: colour });
	}

	const showPins = scale > 0.45;
	const showLabels = scale > 0.35;

	for (const instance of view.schematic.instances) {
		const def = definitionFor(instance);
		if (
			instance.x + def.box.x - 40 > region.x + region.w ||
			instance.x + def.box.x + def.box.w + 40 < region.x ||
			instance.y + def.box.y - 40 > region.y + region.h ||
			instance.y + def.box.y + def.box.h + 40 < region.y
		) {
			continue;
		}

		const selected = view.selection.has(instance.id);
		const colour = selected
			? theme.selection
			: instance.kind === 'led'
				? ledInk(instance.params.colour)
				: theme.symbol;
		const paths = symbolPaths(instance.kind, instance.params);

		painter.transformed({ x: instance.x, y: instance.y }, instance.rotation, () => {
			painter.strokePath(paths.stroke, { color: colour, width: 1.5 });
			if (paths.hasFill) painter.fillPath(paths.fill, { color: colour });
		});

		// Symbol text is positioned by the rotation but drawn upright, which stays
		// legible on a component turned on its side.
		for (const label of symbolGeometry(instance.kind, instance.params).labels) {
			const at = rotatePoint(label.x, label.y, instance.rotation);
			painter.text(
				label.text,
				{ x: instance.x + at.x, y: instance.y + at.y },
				{
					size: Math.min((label.size ?? 11) * scale, 15),
					color: colour,
					align: label.anchor === 'start' ? 'left' : label.anchor === 'end' ? 'right' : 'center',
					baseline: 'middle',
					minSize: 7
				}
			);
		}

		if (showPins) {
			for (const { pin, at } of instancePins(instance)) {
				const net = view.netOfPoint.get(keyOf(at.x, at.y));
				const hovered = net !== undefined && net === view.hoverNet;
				painter.dot(
					at,
					3,
					{ color: hovered ? theme.accent : theme.background },
					{ color: hovered ? theme.accent : pin.domain === 'digital' ? theme.pinDigital : theme.pin, width: 1.2 }
				);
			}
		}

		// A probe wears the name it will appear under, in the colour it will appear
		// in — so telling two traces apart is a matter of looking at the drawing
		// rather than of holding a legend in your head.
		if (showLabels && instance.kind === 'probe') {
			const probe = view.probes?.get(instance.id);
			painter.text(
				probe?.label ?? instance.name,
				{ x: instance.x, y: instance.y - 28 },
				{
					size: labelSize,
					color: probe?.colour ?? theme.labelStrong,
					align: 'center',
					baseline: 'bottom',
					minSize: 6
				}
			);
			continue;
		}

		if (showLabels && instance.kind !== 'ground') {
			// Measured off what is actually drawn, rotation included, rather than one
			// number for every part. A single default has to suit the tallest symbol,
			// which left a resistor's name floating twenty units above a body that
			// stops at nine — the label reads as belonging to nothing in particular.
			const reach = drawnReach(def, instance.rotation);
			// Above and below when the leads go sideways; stacked to the right when
			// they go up and down. Either way the labels land where no wire does.
			const sideways = leadAxis(def, instance.rotation) === 'x';
			const clear = (sideways ? reach.y : reach.x) + LABEL_GAP;
			const tx = sideways ? instance.x : instance.x + clear;
			const align = sideways ? 'center' : 'left';

			// A rail is named by its voltage. "5 V" says everything there is to say
			// about it, and "PWR1" says nothing at all — so the value takes the
			// place the designator would have had rather than sitting under it.
			const rail = instance.kind === 'supply';
			painter.text(
				rail ? (valueLabel(instance) ?? instance.name) : instance.name,
				{ x: tx, y: sideways ? instance.y - clear : instance.y - 6 },
				{ size: labelSize, color: theme.labelStrong, align, baseline: 'bottom', minSize: 6 }
			);

			const value = rail ? null : valueLabel(instance);
			if (value) {
				painter.text(
					value,
					{ x: tx, y: sideways ? instance.y + clear : instance.y + 8 },
					{ size: labelSize, color: theme.labelDim, align, baseline: 'top', minSize: 6 }
				);
			}
		}
	}
}
