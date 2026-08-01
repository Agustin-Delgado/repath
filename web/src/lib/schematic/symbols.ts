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

/** Which variant of a symbol a set of parameters selects. Used as a cache key. */
export function symbolVariant(kind: string, params: Record<string, unknown> = {}): string {
	switch (kind) {
		case 'diode':
			return `diode:${String(params.model ?? 'silicon')}`;
		case 'vsource':
			return `vsource:${String(params.waveform ?? 'dc')}`;
		default:
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

	ground: {
		shapes: [path('M0 -10 V0 M-11 0 H11 M-7 4 H7 M-3 8 H3')],
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

	and: {
		shapes: [path('M-30 -10 H-18 M-30 10 H-18 M20 0 H30'), path('M-18 -18 H0 A18 18 0 0 1 0 18 H-18 Z')],
		labels: []
	},

	nand: {
		shapes: [
			path('M-30 -10 H-18 M-30 10 H-18 M26 0 H30'),
			path('M-18 -18 H0 A18 18 0 0 1 0 18 H-18 Z'),
			{ kind: 'circle', cx: 23, cy: 0, r: 3.5 }
		],
		labels: []
	},

	or: {
		shapes: [
			path('M-30 -10 H-16 M-30 10 H-16 M20 0 H30'),
			path('M-20 -18 Q-6 0 -20 18 Q6 18 20 0 Q6 -18 -20 -18 Z')
		],
		labels: []
	},

	nor: {
		shapes: [
			path('M-30 -10 H-16 M-30 10 H-16 M26 0 H30'),
			path('M-20 -18 Q-6 0 -20 18 Q6 18 20 0 Q6 -18 -20 -18 Z'),
			{ kind: 'circle', cx: 23, cy: 0, r: 3.5 }
		],
		labels: []
	},

	xor: {
		shapes: [
			path('M-30 -10 H-16 M-30 10 H-16 M20 0 H30'),
			path('M-20 -18 Q-6 0 -20 18 Q6 18 20 0 Q6 -18 -20 -18 Z'),
			path('M-26 -18 Q-12 0 -26 18')
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

function diode(variant: string): SymbolGeometry {
	const shapes: Shape[] = [path('M-30 0 H-8'), path('M-8 -9 L-8 9 L8 0 Z', true)];
	// A zener's cathode bar is bent, which is the whole visual distinction.
	shapes.push(variant === 'zener' ? path('M8 -9 H3 M8 -9 V9 M8 9 H13') : path('M8 -9 V9'));
	shapes.push(path('M8 0 H30'));
	if (variant === 'led') {
		shapes.push(path('M2 -14 L10 -22 M6 -22 H10 V-18'));
		shapes.push(path('M8 -11 L16 -19 M12 -19 H16 V-15'));
	}
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
	else geometry = STATIC[kind] ?? EMPTY;

	variantCache.set(variant, geometry);
	return geometry;
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
