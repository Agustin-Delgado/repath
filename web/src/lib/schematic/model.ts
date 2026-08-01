/**
 * The schematic data model and the component catalog.
 *
 * Every pin declares which domain it belongs to. That is what lets the netlist
 * builder work out, on its own, where an analog wire meets digital logic and
 * drop a bridge in between — so you can wire a comparator straight into a NAND
 * gate and it just works, with no explicit converter to place.
 */

/** Snap resolution, in schematic units. All pins sit on multiples of this. */
export const GRID = 10;

export type Domain = 'analog' | 'digital';
export type PinDirection = 'in' | 'out' | 'inout';
export type Rotation = 0 | 90 | 180 | 270;

export interface PinDef {
	name: string;
	/** Offset from the component origin, before rotation. */
	x: number;
	y: number;
	domain: Domain;
	direction: PinDirection;
}

export interface ParamDef {
	key: string;
	label: string;
	/** Unit shown next to the field. Empty for dimensionless values. */
	unit: string;
	default: number | string;
	choices?: Array<{ value: string; label: string }>;
	/** Only show this parameter when another parameter has one of these values. */
	visibleWhen?: { key: string; values: string[] };
	/** Longer explanation, shown under the field. */
	description?: string;
}

export type Group = 'passive' | 'sources' | 'semiconductor' | 'analog' | 'logic';

export interface ComponentDef {
	kind: string;
	label: string;
	group: Group;
	/** Reference designator prefix: R, C, Q, U… */
	prefix: string;
	pins: PinDef[];
	params: ParamDef[];
	/**
	 * Half-height of the drawn body, used to keep the reference designator and
	 * value clear of it. Defaults to 30, which suits the two-terminal parts.
	 */
	bodyExtent?: number;
	/**
	 * Local, unrotated bounding box of everything drawn, leads included.
	 *
	 * Used for culling and for hit testing, so it wants to be tight: a square
	 * derived from the pin extents would make a resistor selectable from 20 units
	 * above it, where there is nothing drawn at all.
	 */
	box: { x: number; y: number; w: number; h: number };
}

export interface Instance {
	id: string;
	kind: string;
	name: string;
	x: number;
	y: number;
	rotation: Rotation;
	params: Record<string, number | string>;
}

/** An axis-aligned wire segment. */
export interface Wire {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface Schematic {
	instances: Instance[];
	wires: Wire[];
}

// ---------------------------------------------------------------------------
// Pin geometry
// ---------------------------------------------------------------------------

export function rotatePoint(x: number, y: number, rotation: Rotation): { x: number; y: number } {
	switch (rotation) {
		case 90:
			return { x: -y, y: x };
		case 180:
			return { x: -x, y: -y };
		case 270:
			return { x: y, y: -x };
		default:
			return { x, y };
	}
}

export function pinPosition(instance: Instance, pin: PinDef): { x: number; y: number } {
	const r = rotatePoint(pin.x, pin.y, instance.rotation);
	return { x: instance.x + r.x, y: instance.y + r.y };
}

export function pointKey(x: number, y: number): string {
	return `${Math.round(x)},${Math.round(y)}`;
}

export function snap(value: number): number {
	return Math.round(value / GRID) * GRID;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

const analog = (name: string, x: number, y: number): PinDef => ({
	name,
	x,
	y,
	domain: 'analog',
	direction: 'inout'
});

const digitalIn = (name: string, x: number, y: number): PinDef => ({
	name,
	x,
	y,
	domain: 'digital',
	direction: 'in'
});

const digitalOut = (name: string, x: number, y: number): PinDef => ({
	name,
	x,
	y,
	domain: 'digital',
	direction: 'out'
});

const DELAY_PARAM: ParamDef = { key: 'delay', label: 'Propagation delay', unit: 's', default: 1e-9 };

/** Two inputs on the left, one output on the right — the shape every gate shares. */
const gatePins = (): PinDef[] => [
	digitalIn('a', -30, -10),
	digitalIn('b', -30, 10),
	digitalOut('y', 30, 0)
];

const SOURCE_PARAMS: ParamDef[] = [
	{
		key: 'waveform',
		label: 'Waveform',
		unit: '',
		default: 'dc',
		choices: [
			{ value: 'dc', label: 'DC' },
			{ value: 'sine', label: 'Sine' },
			{ value: 'pulse', label: 'Pulse' }
		]
	},
	{ key: 'value', label: 'Amplitude', unit: '', default: 5 },
	{
		key: 'offset',
		label: 'Offset',
		unit: '',
		default: 0,
		visibleWhen: { key: 'waveform', values: ['sine', 'pulse'] }
	},
	{
		key: 'frequency',
		label: 'Frequency',
		unit: 'Hz',
		default: 1000,
		visibleWhen: { key: 'waveform', values: ['sine', 'pulse'] }
	},
	{
		key: 'duty',
		label: 'Duty cycle',
		unit: '',
		default: 0.5,
		visibleWhen: { key: 'waveform', values: ['pulse'] }
	},
	{
		key: 'ac',
		label: 'AC drive',
		unit: '',
		default: 0,
		// Only the source being swept carries a drive; a supply rail should not
		// also inject a signal, or the frequency response is of the wrong circuit.
		description: 'Amplitude used by the frequency sweep. Set one source to 1.'
	}
];

export const CATALOG: ComponentDef[] = [
	{
		kind: 'resistor',
		box: { x: -30, y: -9, w: 60, h: 18 },
		label: 'Resistor',
		group: 'passive',
		prefix: 'R',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [{ key: 'resistance', label: 'Resistance', unit: 'Ω', default: 1000 }]
	},
	{
		kind: 'capacitor',
		box: { x: -30, y: -13, w: 60, h: 26 },
		label: 'Capacitor',
		group: 'passive',
		prefix: 'C',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [{ key: 'capacitance', label: 'Capacitance', unit: 'F', default: 1e-6 }]
	},
	{
		kind: 'inductor',
		box: { x: -30, y: -8, w: 60, h: 16 },
		label: 'Inductor',
		group: 'passive',
		prefix: 'L',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [{ key: 'inductance', label: 'Inductance', unit: 'H', default: 1e-3 }]
	},
	{
		kind: 'ground',
		box: { x: -12, y: -10, w: 24, h: 20 },
		label: 'Ground',
		group: 'passive',
		prefix: 'GND',
		pins: [analog('g', 0, -10)],
		params: []
	},
	{
		kind: 'vsource',
		box: { x: -17, y: -30, w: 34, h: 60 },
		label: 'Voltage source',
		group: 'sources',
		prefix: 'V',
		pins: [analog('plus', 0, -30), analog('minus', 0, 30)],
		params: SOURCE_PARAMS
	},
	{
		kind: 'isource',
		box: { x: -17, y: -30, w: 34, h: 60 },
		label: 'Current source',
		group: 'sources',
		prefix: 'I',
		pins: [analog('plus', 0, -30), analog('minus', 0, 30)],
		params: SOURCE_PARAMS.map((p) =>
			p.key === 'value' ? { ...p, label: 'Amplitude', unit: 'A', default: 1e-3 } : p
		)
	},
	{
		kind: 'diode',
		box: { x: -30, y: -11, w: 60, h: 22 },
		label: 'Diode',
		group: 'semiconductor',
		prefix: 'D',
		pins: [analog('anode', -30, 0), analog('cathode', 30, 0)],
		params: [
			{
				key: 'model',
				label: 'Type',
				unit: '',
				default: 'silicon',
				choices: [
					{ value: 'silicon', label: 'Silicon (1N4148)' },
					{ value: 'led', label: 'LED (red)' },
					{ value: 'zener', label: 'Zener' }
				]
			},
			{
				key: 'breakdown',
				label: 'Breakdown',
				unit: 'V',
				default: 5.1,
				visibleWhen: { key: 'model', values: ['zener'] }
			}
		]
	},
	{
		kind: 'nmos',
		box: { x: -30, y: -30, w: 42, h: 60 },
		label: 'NMOS',
		group: 'semiconductor',
		prefix: 'M',
		pins: [analog('gate', -30, 0), analog('drain', 10, -30), analog('source', 10, 30)],
		params: [
			{ key: 'vto', label: 'Threshold', unit: 'V', default: 2 },
			{ key: 'kp', label: 'Transconductance', unit: 'A/V²', default: 2e-5 },
			{ key: 'ratio', label: 'W/L', unit: '', default: 10 }
		]
	},
	{
		kind: 'pmos',
		box: { x: -30, y: -30, w: 42, h: 60 },
		label: 'PMOS',
		group: 'semiconductor',
		prefix: 'M',
		pins: [analog('gate', -30, 0), analog('drain', 10, 30), analog('source', 10, -30)],
		params: [
			{ key: 'vto', label: 'Threshold', unit: 'V', default: 2 },
			{ key: 'kp', label: 'Transconductance', unit: 'A/V²', default: 2e-5 },
			{ key: 'ratio', label: 'W/L', unit: '', default: 10 }
		]
	},
	{
		kind: 'npn',
		box: { x: -30, y: -30, w: 42, h: 60 },
		label: 'NPN',
		group: 'semiconductor',
		prefix: 'Q',
		pins: [analog('base', -30, 0), analog('collector', 10, -30), analog('emitter', 10, 30)],
		params: [
			{ key: 'bf', label: 'Forward gain β', unit: '', default: 200 },
			{ key: 'is', label: 'Saturation current', unit: 'A', default: 6.73e-15 }
		]
	},
	{
		kind: 'pnp',
		box: { x: -30, y: -30, w: 42, h: 60 },
		label: 'PNP',
		group: 'semiconductor',
		prefix: 'Q',
		pins: [analog('base', -30, 0), analog('collector', 10, 30), analog('emitter', 10, -30)],
		params: [
			{ key: 'bf', label: 'Forward gain β', unit: '', default: 200 },
			{ key: 'is', label: 'Saturation current', unit: 'A', default: 6.73e-15 }
		]
	},
	{
		kind: 'opamp',
		box: { x: -30, y: -22, w: 60, h: 44 },
		label: 'Op-amp',
		group: 'analog',
		prefix: 'U',
		pins: [analog('plus', -30, -10), analog('minus', -30, 10), analog('out', 30, 0)],
		params: [
			{ key: 'gain', label: 'Open-loop gain', unit: '', default: 1e5 },
			{ key: 'v_max', label: 'Positive rail', unit: 'V', default: 15 },
			{ key: 'v_min', label: 'Negative rail', unit: 'V', default: -15 }
		]
	},
	{
		kind: 'and',
		box: { x: -30, y: -18, w: 60, h: 36 },
		label: 'AND',
		group: 'logic',
		prefix: 'U',
		pins: gatePins(),
		params: [DELAY_PARAM]
	},
	{
		kind: 'nand',
		box: { x: -30, y: -18, w: 60, h: 36 },
		label: 'NAND',
		group: 'logic',
		prefix: 'U',
		pins: gatePins(),
		params: [DELAY_PARAM]
	},
	{
		kind: 'or',
		box: { x: -30, y: -18, w: 60, h: 36 },
		label: 'OR',
		group: 'logic',
		prefix: 'U',
		pins: gatePins(),
		params: [DELAY_PARAM]
	},
	{
		kind: 'nor',
		box: { x: -30, y: -18, w: 60, h: 36 },
		label: 'NOR',
		group: 'logic',
		prefix: 'U',
		pins: gatePins(),
		params: [DELAY_PARAM]
	},
	{
		kind: 'xor',
		box: { x: -30, y: -18, w: 60, h: 36 },
		label: 'XOR',
		group: 'logic',
		prefix: 'U',
		pins: gatePins(),
		params: [DELAY_PARAM]
	},
	{
		kind: 'not',
		box: { x: -30, y: -16, w: 60, h: 32 },
		label: 'NOT',
		group: 'logic',
		prefix: 'U',
		pins: [digitalIn('a', -30, 0), digitalOut('y', 30, 0)],
		params: [DELAY_PARAM]
	},
	{
		kind: 'dff',
		box: { x: -30, y: -32, w: 60, h: 64 },
		label: 'D flip-flop',
		group: 'logic',
		prefix: 'FF',
		pins: [
			digitalIn('d', -30, -20),
			digitalIn('clk', -30, 20),
			digitalOut('q', 30, -20),
			digitalOut('qn', 30, 20)
		],
		params: [DELAY_PARAM],
		bodyExtent: 44
	},
	{
		kind: 'clock',
		box: { x: -22, y: -16, w: 52, h: 32 },
		label: 'Clock',
		group: 'logic',
		prefix: 'CLK',
		pins: [digitalOut('out', 30, 0)],
		params: [
			{ key: 'frequency', label: 'Frequency', unit: 'Hz', default: 1e6 },
			{ key: 'duty', label: 'Duty cycle', unit: '', default: 0.5 }
		]
	}
];

const BY_KIND = new Map(CATALOG.map((d) => [d.kind, d]));

export function definitionOf(kind: string): ComponentDef {
	const def = BY_KIND.get(kind);
	if (!def) throw new Error(`unknown component kind: ${kind}`);
	return def;
}

export function defaultParams(kind: string): Record<string, number | string> {
	const params: Record<string, number | string> = {};
	for (const p of definitionOf(kind).params) params[p.key] = p.default;
	return params;
}

/** Whether a parameter should be shown, given the rest of the instance's values. */
export function isParamVisible(param: ParamDef, params: Record<string, number | string>): boolean {
	if (!param.visibleWhen) return true;
	return param.visibleWhen.values.includes(String(params[param.visibleWhen.key]));
}

/** Next free reference designator for a kind, e.g. `R3`. */
export function nextName(instances: Instance[], kind: string): string {
	const prefix = definitionOf(kind).prefix;
	const used = new Set(instances.map((i) => i.name));
	for (let n = 1; ; n++) {
		const candidate = `${prefix}${n}`;
		if (!used.has(candidate)) return candidate;
	}
}
