/**
 * Symbol geometry, as data.
 *
 * One definition feeds both renderers: the palette draws it as SVG, the editor
 * draws it as `Path2D` on canvas. Previously the shapes lived inside a Svelte
 * component, which meant the canvas could not reach them and a symbol had to be
 * drawn twice, in two places, to stay in sync. This is the single source.
 *
 * All coordinates are in schematic units, centred on the component's origin,
 * unrotated. Pin positions live in the catalog (`model.ts`) and must agree with
 * where the leads drawn here end.
 */

import { definitionOf, gateInputCount, gatePins, gateReach, SUBCIRCUIT_PREFIX } from './model';

export type Shape =
	| { kind: 'path'; d: string; fill?: boolean }
	| { kind: 'circle'; cx: number; cy: number; r: number; fill?: boolean }
	| { kind: 'rect'; x: number; y: number; w: number; h: number; fill?: boolean };

export interface SymbolLabel {
	x: number;
	y: number;
	text: string;
	anchor?: 'start' | 'middle' | 'end';
	/** Schematic units. */
	size?: number;
}

export interface SymbolGeometry {
	shapes: Shape[];
	labels: SymbolLabel[];
}

const path = (d: string, fill = false): Shape => ({ kind: 'path', d, fill });

/** The gates drawn from their input count rather than from a fixed shape. */
const GATES = new Set(['and', 'nand', 'or', 'nor', 'xor', 'xnor']);

/** Lead length on a generated block, matching what the catalog places its pins at. */
const LEAD = 16;

/** Which variant of a symbol a set of parameters selects. Used as a cache key. */
export function symbolVariant(kind: string, params: Record<string, unknown> = {}): string {
	switch (kind) {
		case 'diode':
			return `diode:${String(params.model ?? 'silicon')}`;
		case 'vsource':
			return `vsource:${String(params.waveform ?? 'dc')}`;
		case 'switch':
			return `switch:${String(params.action ?? 'toggle')}:${String(params.start ?? 'open')}`;
		case 'and':
		case 'nand':
		case 'or':
		case 'nor':
		case 'xor':
		case 'xnor':
			return `${kind}:${gateInputCount(params as Record<string, number | string>)}`;
		default:
			// An imported block's shape is its port list, so the port list *is* the
			// cache key. Re-importing a definition under the same handle then misses
			// both this cache and the one holding the built paths, instead of needing
			// somebody to remember to clear them.
			if (kind.startsWith(SUBCIRCUIT_PREFIX)) {
				return `${kind}(${definitionOf(kind).pins.map((p) => p.name).join(',')})`;
			}
			return kind;
	}
}

const EMPTY: SymbolGeometry = { shapes: [], labels: [] };

const STATIC: Record<string, SymbolGeometry> = {
	resistor: {
		shapes: [
			path('M-30 0 H-18'),
			{ kind: 'rect', x: -18, y: -7, w: 36, h: 14 },
			path('M18 0 H30')
		],
		labels: []
	},

	capacitor: {
		shapes: [path('M-30 0 H-5 M-5 -12 V12 M5 -12 V12 M5 0 H30')],
		labels: []
	},

	inductor: {
		shapes: [
			path('M-30 0 H-18'),
			path('M-18 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 1 9 0'),
			path('M18 0 H30')
		],
		labels: []
	},

	probe: {
		// A stalk up from the point being measured, with a ring on top: the shape
		// of every test point anyone has ever clipped a lead to.
		shapes: [path('M0 0 V-16'), { kind: 'circle', cx: 0, cy: -21, r: 5 }],
		labels: []
	},

	ground: {
		shapes: [path('M0 -10 V0 M-11 0 H11 M-7 4 H7 M-3 8 H3')],
		labels: []
	},

	supply: {
		// Ground's mirror image, and read the same way: a stem up to a rail, with
		// an arrow saying which way the potential goes.
		shapes: [path('M0 10 V-4 M-11 -4 H11 M-6 -10 L0 -16 L6 -10')],
		labels: []
	},

	isource: {
		shapes: [
			path('M0 -30 V-16 M0 16 V30'),
			{ kind: 'circle', cx: 0, cy: 0, r: 16 },
			path('M0 9 V-9 M-5 -4 L0 -9 L5 -4')
		],
		labels: []
	},

	led: {
		shapes: [
			path('M-30 0 H-8'),
			path('M-8 -9 L-8 9 L8 0 Z', true),
			path('M8 -9 V9'),
			path('M8 0 H30'),
			// Two arrows leaving the junction: the mark that says this one emits.
			// Drawn clear of the body so the glow has somewhere to sit.
			path('M-2 -12 L6 -20 M1 -20 H6 V-15'),
			path('M5 -12 L13 -20 M8 -20 H13 V-15')
		],
		labels: []
	},

	nmos: {
		shapes: [
			path('M-30 0 H-16 M-16 -14 V14'),
			path('M-8 -14 V-5 M-8 -4 V4 M-8 5 V14'),
			path('M-8 -11 H10 M10 -11 V-30 M-8 11 H10 M10 11 V30'),
			path('M-8 0 H10'),
			// The arrow points into the channel for an n-channel device.
			path('M2 0 L-4 -4 L-4 4 Z', true)
		],
		labels: []
	},

	pmos: {
		shapes: [
			path('M-30 0 H-16 M-16 -14 V14'),
			path('M-8 -14 V-5 M-8 -4 V4 M-8 5 V14'),
			path('M-8 -11 H10 M10 -11 V-30 M-8 11 H10 M10 11 V30'),
			path('M-8 0 H10'),
			// …and out of it for a p-channel one.
			path('M-8 0 L-2 -4 L-2 4 Z', true)
		],
		labels: []
	},

	npn: {
		shapes: [
			path('M-30 0 H-12 M-12 -15 V15'),
			path('M-12 -7 L10 -20 M10 -20 V-30'),
			path('M-12 7 L10 20 M10 20 V30'),
			path('M10 20 L1 18 L5 11 Z', true)
		],
		labels: []
	},

	pnp: {
		shapes: [
			path('M-30 0 H-12 M-12 -15 V15'),
			path('M-12 -7 L10 -20 M10 -20 V-30'),
			path('M-12 7 L10 20 M10 20 V30'),
			path('M-12 7 L-3 9 L-7 16 Z', true)
		],
		labels: []
	},

	opamp: {
		shapes: [
			path('M-30 -10 H-20 M-30 10 H-20 M24 0 H30'),
			path('M-20 -22 L-20 22 L24 0 Z'),
			path('M-16 -13 H-9 M-12.5 -16.5 V-9.5'),
			path('M-16 10 H-9')
		],
		labels: []
	},

	not: {
		shapes: [
			path('M-30 0 H-14 M22 0 H30'),
			path('M-14 -16 L14 0 L-14 16 Z'),
			{ kind: 'circle', cx: 18, cy: 0, r: 3.5 }
		],
		labels: []
	},

	buffer: {
		shapes: [path('M-30 0 H-14 M14 0 H30'), path('M-14 -16 L14 0 L-14 16 Z')],
		labels: []
	},

	tristate: {
		shapes: [
			path('M-30 0 H-14 M14 0 H30'),
			path('M-14 -16 L14 0 L-14 16 Z'),
			// The enable comes down onto the top edge, where it is read as a control
			// rather than as another thing being buffered.
			path('M0 -30 V-8')
		],
		labels: [{ x: 4, y: -18, text: 'EN', anchor: 'start', size: 8 }]
	},

	dff: {
		shapes: [
			path('M-30 -20 H-22 M-30 20 H-22 M22 -20 H30 M22 20 H30'),
			{ kind: 'rect', x: -22, y: -32, w: 44, h: 64 },
			// The wedge marking an edge-triggered clock input.
			path('M-22 14 L-14 20 L-22 26')
		],
		labels: [
			{ x: -17, y: -16, text: 'D', anchor: 'start', size: 11 },
			{ x: 17, y: -16, text: 'Q', anchor: 'end', size: 11 },
			{ x: 17, y: 24, text: 'Q̅', anchor: 'end', size: 11 }
		]
	},

	clock: {
		shapes: [
			path('M22 0 H30'),
			{ kind: 'rect', x: -22, y: -16, w: 44, h: 32 },
			path('M-14 6 H-8 V-6 H0 V6 H8 V-6 H14')
		],
		labels: []
	}
};

/**
 * A gate, drawn for the number of inputs it actually has.
 *
 * The body stretches vertically and keeps its width, which is what a real
 * schematic does: a three-input AND is the same D, taller. Scaling it in both
 * directions instead would push the output pin off the grid and leave the wide
 * gates twice the size of the narrow ones sitting next to them.
 */
function gate(kind: string, count: number): SymbolGeometry {
	const half = gateReach(count);
	const rounded = kind === 'and' || kind === 'nand';
	const inverted = kind === 'nand' || kind === 'nor' || kind === 'xnor';
	// Where the body ends on the right, which is where the bubble and the output
	// lead have to start from.
	const nose = rounded ? 18 : 20;

	const body = rounded
		? // A rectangle closed off by half an ellipse: tall gates keep the same
			// nose because the radius across is fixed and only the radius down grows.
			path(`M-18 ${-half} H0 A18 ${half} 0 0 1 0 ${half} H-18 Z`)
		: path(
				`M-20 ${-half} Q-6 0 -20 ${half} Q6 ${half} 20 0 Q6 ${-half} -20 ${-half} Z`
			);

	const shapes: Shape[] = [body];
	if (kind === 'xor' || kind === 'xnor') {
		// The second back, set off from the first. It is the whole difference
		// between an OR and an exclusive one.
		shapes.push(path(`M-26 ${-half} Q-12 0 -26 ${half}`));
	}

	// Leads to where the body is, not to where the widest part of it is: on a
	// curved back the outer inputs meet it further left than the middle ones.
	const stop = rounded ? -18 : -16;
	for (const pin of gatePins(count)) {
		if (pin.name === 'y') continue;
		shapes.push(path(`M-30 ${pin.y} H${stop}`));
	}

	if (inverted) {
		shapes.push({ kind: 'circle', cx: nose + 3.5, cy: 0, r: 3.5 });
		shapes.push(path(`M${nose + 7} 0 H30`));
	} else {
		shapes.push(path(`M${nose} 0 H30`));
	}

	return { shapes, labels: [] };
}

/**
 * A switch, drawn in the position it rests in and in the shape of its actuator.
 *
 * The position matters more than it looks: a schematic showing a closed switch
 * and a run that starts with it open is a drawing that lies about the circuit
 * before anything has happened.
 */
function switchSymbol(action: string, start: string): SymbolGeometry {
	const closed = start === 'closed';
	const shapes: Shape[] = [
		path('M-30 0 H-14'),
		path('M14 0 H30'),
		{ kind: 'circle', cx: -14, cy: 0, r: 2 },
		{ kind: 'circle', cx: 14, cy: 0, r: 2 }
	];

	if (action === 'momentary') {
		// A bar on a plunger: pressing it drives the bar down onto the contacts,
		// so a normally-closed button is drawn with the bar already resting there.
		const bar = closed ? 0 : -8;
		shapes.push(path(`M-14 ${bar} H14`));
		shapes.push(path(`M0 ${bar} V-18 M-8 -18 H8`));
	} else {
		// A blade on a pivot, lifted clear when the switch is open.
		shapes.push(closed ? path('M-14 -4 L14 0') : path('M-13 -2 L11 -16'));
	}
	return { shapes, labels: [] };
}

function diode(variant: string): SymbolGeometry {
	const shapes: Shape[] = [path('M-30 0 H-8'), path('M-8 -9 L-8 9 L8 0 Z', true)];
	// A zener's cathode bar is bent, which is the whole visual distinction.
	shapes.push(variant === 'zener' ? path('M8 -9 H3 M8 -9 V9 M8 9 H13') : path('M8 -9 V9'));
	shapes.push(path('M8 0 H30'));
	return { shapes, labels: [] };
}

function voltageSource(waveform: string): SymbolGeometry {
	const shapes: Shape[] = [
		path('M0 -30 V-16 M0 16 V30'),
		{ kind: 'circle', cx: 0, cy: 0, r: 16 }
	];
	if (waveform === 'sine') {
		shapes.push(path('M-9 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 0 9 0'));
	} else if (waveform === 'pulse') {
		shapes.push(path('M-10 5 H-5 V-5 H2 V5 H8 V-5 H10'));
	} else {
		shapes.push(path('M-5 -6 H5 M0 -11 V-1 M-5 7 H5'));
	}
	return { shapes, labels: [] };
}

const variantCache = new Map<string, SymbolGeometry>();

/** Geometry for a component, memoized per variant. */
export function symbolGeometry(
	kind: string,
	params: Record<string, unknown> = {}
): SymbolGeometry {
	const variant = symbolVariant(kind, params);
	const cached = variantCache.get(variant);
	if (cached) return cached;

	let geometry: SymbolGeometry;
	if (kind === 'diode') geometry = diode(String(params.model ?? 'silicon'));
	else if (kind === 'vsource') geometry = voltageSource(String(params.waveform ?? 'dc'));
	else if (kind === 'switch') {
		geometry = switchSymbol(String(params.action ?? 'toggle'), String(params.start ?? 'open'));
	}
	else if (GATES.has(kind)) {
		geometry = gate(kind, gateInputCount(params as Record<string, number | string>));
	}
	else if (kind.startsWith(SUBCIRCUIT_PREFIX)) geometry = block(kind);
	else geometry = STATIC[kind] ?? EMPTY;

	variantCache.set(variant, geometry);
	return geometry;
}

/**
 * An imported subcircuit: a box with its terminals named on the inside.
 *
 * Drawn from the part's own pin list rather than from a stored drawing, so a
 * five-terminal op-amp and a two-terminal filter are one piece of code. The
 * names matter more here than on any other symbol — a `.subckt` numbers its
 * terminals `1 2 3` and nothing but their position says which is the output.
 */
function block(kind: string): SymbolGeometry {
	const def = definitionOf(kind);
	const { x, y, w, h } = def.box;
	const bodyX = x + LEAD;
	const bodyW = w - LEAD * 2;

	const shapes: Shape[] = [{ kind: 'rect', x: bodyX, y, w: bodyW, h }];
	const labels: SymbolLabel[] = [];
	for (const pin of def.pins) {
		const onLeft = pin.x < 0;
		shapes.push(path(`M${pin.x} ${pin.y} H${onLeft ? bodyX : bodyX + bodyW}`));
		labels.push({
			x: (onLeft ? bodyX : bodyX + bodyW) + (onLeft ? 5 : -5),
			y: pin.y,
			text: pin.name,
			anchor: onLeft ? 'start' : 'end',
			size: 8
		});
	}
	return { shapes, labels };
}

/** SVG `d` for a shape, so the palette can render one element per shape. */
export function shapeToPathData(shape: Shape): string {
	switch (shape.kind) {
		case 'path':
			return shape.d;
		case 'rect':
			return `M${shape.x} ${shape.y} h${shape.w} v${shape.h} h${-shape.w} Z`;
		case 'circle': {
			const { cx, cy, r } = shape;
			return `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${r * 2} 0 a${r} ${r} 0 1 0 ${-r * 2} 0`;
		}
	}
}
