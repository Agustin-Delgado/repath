/**
 * The schematic data model and the component catalog.
 *
 * Every pin declares which domain it belongs to. That is what lets the netlist
 * builder work out, on its own, where an analog wire meets digital logic and
 * drop a bridge in between — so you can wire a comparator straight into a NAND
 * gate and it just works, with no explicit converter to place.
 */

import { LED_COLOURS, RATED } from './led';

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
	/**
	 * Range this value has to fall in.
	 *
	 * A resistance of zero is a short and a negative one is not a thing; the engine
	 * would take the magnitude of one and clamp the other, quietly simulating a
	 * circuit nobody drew. Better to refuse the value and say why.
	 */
	min?: number;
	max?: number;
	/** Refuse exactly zero, for quantities a zero would make degenerate. */
	nonZero?: boolean;
	/**
	 * Kept out of the ordinary list of fields, because a text box is not a value.
	 *
	 * The inspector lays parameters out as a number and a unit. A pasted model
	 * card is neither, and it gets a block of its own rather than being squeezed
	 * into a row that was built for `470 Ω`.
	 */
	hidden?: boolean;
	/**
	 * Show the number as it is, with no engineering prefix beside it.
	 *
	 * For quantities that live near one and mean nothing scaled: a duty cycle of
	 * 0.5 is not "500 milli", however true that is arithmetically.
	 */
	plain?: boolean;
	/** How far one arrow-key press moves a `plain` value. */
	step?: number;
}

/** Why a value was refused, or null when it is fine. */
export function validateParam(param: ParamDef, value: number | string): string | null {
	if (typeof value !== 'number') return null;
	if (!Number.isFinite(value)) return `${param.label} must be a number.`;
	if (param.nonZero && value === 0) return `${param.label} cannot be zero.`;
	if (param.min !== undefined && value < param.min) {
		return `${param.label} cannot be below ${param.min}${param.unit ? ' ' + param.unit : ''}.`;
	}
	if (param.max !== undefined && value > param.max) {
		return `${param.label} cannot be above ${param.max}${param.unit ? ' ' + param.unit : ''}.`;
	}
	return null;
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

export interface Point {
	x: number;
	y: number;
}

/**
 * A routed connection between two places, as a chain of corners.
 *
 * A polyline rather than a lone segment. A wire is one thing the user drew and
 * one thing they expect to move, re-route and delete as a unit — modelling it as
 * a pile of independent segments is why dragging a component used to tear it off
 * whatever it was wired to.
 *
 * Consecutive points are always axis-aligned, so every segment is horizontal or
 * vertical.
 */
export interface Wire {
	id: string;
	points: Point[];
}

export interface WireSegment {
	a: Point;
	b: Point;
	/** Position along the wire, for addressing one leg of it. */
	index: number;
}

export function wireSegments(wire: Wire): WireSegment[] {
	const out: WireSegment[] = [];
	for (let i = 0; i < wire.points.length - 1; i++) {
		out.push({ a: wire.points[i], b: wire.points[i + 1], index: i });
	}
	return out;
}

export const wireStart = (wire: Wire): Point => wire.points[0];
export const wireEnd = (wire: Wire): Point => wire.points[wire.points.length - 1];

/**
 * Drop corners that repeat, sit in the middle of a straight run, or close a loop.
 *
 * The loops are the interesting case. A wire dragged while both its ends are
 * pinned grows a leg at each end to reach back, and pushed far enough those legs
 * cross: the path leaves a point and later returns to it, curling round on
 * itself. Everything between the two visits carries no current and draws as a
 * knot, so it goes.
 */
export function simplifyPath(points: readonly Point[]): Point[] {
	const out: Point[] = [];
	for (const p of points) {
		const last = out[out.length - 1];
		if (last && last.x === p.x && last.y === p.y) continue;

		// Been here before: cut out the excursion rather than draw it.
		const seen = out.findIndex((q) => q.x === p.x && q.y === p.y);
		if (seen !== -1) {
			out.length = seen + 1;
			continue;
		}

		out.push({ x: p.x, y: p.y });
	}
	for (let i = out.length - 2; i > 0; i--) {
		const [before, here, after] = [out[i - 1], out[i], out[i + 1]];
		const straight =
			(before.x === here.x && here.x === after.x) || (before.y === here.y && here.y === after.y);
		if (straight) out.splice(i, 1);
	}
	return out;
}

/** Read a wire from either the polyline form or the older two-point one. */
export function normaliseWire(raw: unknown, id: string): Wire | null {
	const value = raw as Partial<Wire> & { x1?: number; y1?: number; x2?: number; y2?: number };
	if (Array.isArray(value?.points) && value.points.length >= 2) {
		return { id, points: simplifyPath(value.points) };
	}
	if (
		typeof value?.x1 === 'number' &&
		typeof value?.y1 === 'number' &&
		typeof value?.x2 === 'number' &&
		typeof value?.y2 === 'number'
	) {
		return { id, points: [{ x: value.x1, y: value.y1 }, { x: value.x2, y: value.y2 }] };
	}
	return null;
}

/**
 * A subcircuit imported from a SPICE file, as a part you can place.
 *
 * The whole paste is kept rather than the definition alone, for the same reason
 * a `.model` card is: a `.subckt` refers to its transistors by name and the
 * cards that give those names meaning are elsewhere in the same file. Storing
 * the text keeps the two together, and keeps the vendor's file the authority
 * rather than a transcription of it.
 */
export interface SubcircuitDef {
	/** Stable handle. The part's `kind` is `x:` followed by this. */
	id: string;
	/** As the `.subckt` line spells it. */
	name: string;
	/** Terminals in port order, which is also pin order. */
	ports: string[];
	/** The pasted file, verbatim. */
	source: string;
}

export interface Schematic {
	instances: Instance[];
	wires: Wire[];
	/**
	 * Definitions this drawing carries with it, so a saved file or a shared link
	 * is self-contained. A part whose definition travelled separately would open
	 * as a hole in the middle of someone's circuit.
	 */
	subcircuits?: SubcircuitDef[];
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

/**
 * A `.model` card pasted onto a part, verbatim.
 *
 * Held as the text it arrived as rather than unpacked into a row of fields. A
 * card has twenty-odd parameters and this engine models eight of them, so
 * unpacking would mean either twenty fields nobody wants to look at or silently
 * throwing away the twelve that did not fit. Keeping the text means the part
 * says which one it is, the card survives a save and a share link intact, and
 * what could not be used is reported rather than lost.
 */
const SPICE_CARD = [
	{ key: 'spice', label: 'SPICE model', unit: '', default: '', hidden: true }
] as const;

/// What a transistor has to be charged with before it does anything, shared by
/// both polarities of each device. These are the parameters that give a stage a
/// top end; with them at zero it amplifies and switches without limit.
const BASE_CHARGE = [
	{
		key: 'cjc',
		label: 'Collector capacitance',
		unit: 'F',
		default: 3.6e-12,
		min: 0,
		description:
			'Across the base-collector junction. An inverting stage multiplies it by its own gain — Miller — so a few picofarads here is what usually sets the top of the band.'
	},
	{
		key: 'tf',
		label: 'Transit time',
		unit: 's',
		default: 301e-12,
		min: 0,
		description:
			'How long a carrier takes to cross the base, which is what sets the transition frequency: fT is roughly 1/(2π·tf), so 300 ps is a device good to a few hundred megahertz.'
	}
] as const;

const GATE_CHARGE = [
	{
		key: 'cgd',
		label: 'Gate-drain capacitance',
		unit: 'F',
		default: 5e-12,
		min: 0,
		description:
			'A datasheet calls it Crss. It bridges the gate to the drain, so turning the device on means dragging it across the whole output swing — the plateau in a gate-drive waveform.'
	},
	{
		key: 'cgs',
		label: 'Gate-source capacitance',
		unit: 'F',
		default: 20e-12,
		min: 0,
		description:
			'With the gate-drain capacitance this makes up the datasheet Ciss — the charge a driver has to deliver before the device starts conducting at all.'
	}
] as const;

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

const DELAY_PARAM: ParamDef = {
	key: 'delay',
	label: 'Propagation delay',
	unit: 's',
	default: 1e-9,
	min: 0
};

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
		min: 0,
		nonZero: true,
		visibleWhen: { key: 'waveform', values: ['sine', 'pulse'] }
	},
	{
		key: 'duty',
		label: 'Duty cycle',
		unit: '',
		default: 0.5,
		// A pulse that is never high, or never low, is a DC source drawn as a pulse.
		min: 0,
		max: 1,
		nonZero: true,
		plain: true,
		step: 0.05,
		visibleWhen: { key: 'waveform', values: ['pulse'] }
	},
	{
		key: 'ac',
		label: 'AC drive',
		unit: '',
		default: 0,
		min: 0,
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
		params: [{ key: 'resistance', label: 'Resistance', unit: 'Ω', default: 1000, min: 0, nonZero: true }]
	},
	{
		kind: 'capacitor',
		box: { x: -30, y: -13, w: 60, h: 26 },
		label: 'Capacitor',
		group: 'passive',
		prefix: 'C',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [{ key: 'capacitance', label: 'Capacitance', unit: 'F', default: 1e-6, min: 0, nonZero: true }]
	},
	{
		kind: 'inductor',
		box: { x: -30, y: -8, w: 60, h: 16 },
		label: 'Inductor',
		group: 'passive',
		prefix: 'L',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [{ key: 'inductance', label: 'Inductance', unit: 'H', default: 1e-3, min: 0, nonZero: true }]
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
					{ value: 'zener', label: 'Zener' }
				]
			},
			{
				key: 'breakdown',
				label: 'Breakdown',
				unit: 'V',
				default: 5.1,
				// Quoted as a magnitude, the way a datasheet does; the model applies
				// it in reverse. A negative here would mean a zener conducting forward.
				min: 0,
				nonZero: true,
				visibleWhen: { key: 'model', values: ['zener'] }
			},
			...SPICE_CARD
		]
	},
	{
		kind: 'led',
		// Taller than a plain diode: the emission arrows are part of the symbol, and
		// a box that stopped at the body would let a label sit on top of them.
		box: { x: -30, y: -24, w: 60, h: 33 },
		label: 'LED',
		group: 'semiconductor',
		prefix: 'D',
		pins: [analog('anode', -30, 0), analog('cathode', 30, 0)],
		params: [
			{
				key: 'colour',
				label: 'Colour',
				unit: '',
				default: LED_COLOURS[0].value,
				choices: LED_COLOURS.map(({ value, label }) => ({ value, label })),
				description: 'Sets the forward voltage as well as the light: blue needs 3 V where red needs 1.9 V.'
			},
			{
				key: 'imax',
				label: 'Rated current',
				unit: 'A',
				default: RATED,
				min: 0,
				nonZero: true,
				description: 'Held above this the LED burns out. Brief pulses well over it survive.'
			},
			// The colour and the rating survive a pasted card: one is about light and
			// the other about what destroys the part, and neither is something a
			// `.model` line has an opinion on.
			...SPICE_CARD
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
			{ key: 'kp', label: 'Transconductance', unit: 'A/V²', default: 2e-5, min: 0, nonZero: true },
			{ key: 'ratio', label: 'W/L', unit: '', default: 10, min: 0, nonZero: true },
			{
				key: 'lambda',
				label: 'Channel-length modulation',
				unit: '1/V',
				default: 0.02,
				min: 0,
				description: 'The drain current keeps climbing in saturation. Zero makes the device a perfect current source, which nothing is.'
			},
			...GATE_CHARGE,
			...SPICE_CARD
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
			{ key: 'ratio', label: 'W/L', unit: '', default: 10 },
			{
				key: 'lambda',
				label: 'Channel-length modulation',
				unit: '1/V',
				default: 0.02,
				min: 0,
				description: 'The drain current keeps climbing in saturation. Zero makes the device a perfect current source, which nothing is.'
			},
			...GATE_CHARGE,
			...SPICE_CARD
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
			{ key: 'bf', label: 'Forward gain β', unit: '', default: 200, min: 0, nonZero: true },
			{ key: 'is', label: 'Saturation current', unit: 'A', default: 6.73e-15, min: 0, nonZero: true },
			{
				key: 'vaf',
				label: 'Early voltage',
				unit: 'V',
				default: 100,
				min: 0,
				description:
					'Base-width modulation. Sets the output resistance to about VAF/Ic — zero here would make a stage into a high impedance amplify without limit.'
			},
			...BASE_CHARGE,
			...SPICE_CARD
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
			{
				key: 'vaf',
				label: 'Early voltage',
				unit: 'V',
				default: 100,
				min: 0,
				description:
					'Base-width modulation. Sets the output resistance to about VAF/Ic — zero here would make a stage into a high impedance amplify without limit.'
			},
			{ key: 'is', label: 'Saturation current', unit: 'A', default: 6.73e-15 },
			...BASE_CHARGE,
			...SPICE_CARD
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
			{ key: 'gain', label: 'Open-loop gain', unit: '', default: 1e5, min: 0, nonZero: true },
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

// ---------------------------------------------------------------------------
// Imported subcircuits as parts
// ---------------------------------------------------------------------------

/** Distance from the body's edge out to a pin. */
const SUB_LEAD = 16;
const SUB_HALF_WIDTH = 24;
/** Grid-aligned, so a pin always lands somewhere a wire can reach. */
const SUB_PITCH = 20;

export const SUBCIRCUIT_PREFIX = 'x:';

/** How the ports of a subcircuit are split between the two sides of its box. */
export function subcircuitSides(ports: readonly string[]): { left: string[]; right: string[] } {
	const half = Math.ceil(ports.length / 2);
	return { left: ports.slice(0, half), right: ports.slice(half) };
}

/** Where a port sits, given its index down one side of a box holding `count`. */
function portY(index: number, count: number): number {
	return (index - (count - 1) / 2) * SUB_PITCH;
}

/** Half the height of the body, big enough for the longer of the two sides. */
export function subcircuitReach(ports: readonly string[]): number {
	const { left, right } = subcircuitSides(ports);
	const rows = Math.max(left.length, right.length, 2);
	return Math.max(22, ((rows - 1) * SUB_PITCH) / 2 + 12);
}

/**
 * A placeable part built from an imported definition.
 *
 * Generated rather than written out, because the shape of the part is decided by
 * the file: a five-terminal op-amp and a two-terminal filter are the same code
 * with a different port list.
 */
export function subcircuitDefinition(sub: SubcircuitDef): ComponentDef {
	const { left, right } = subcircuitSides(sub.ports);
	const half = subcircuitReach(sub.ports);
	const x = SUB_HALF_WIDTH + SUB_LEAD;
	return {
		kind: SUBCIRCUIT_PREFIX + sub.id,
		label: sub.name,
		group: 'analog',
		prefix: 'X',
		box: { x: -x, y: -half, w: x * 2, h: half * 2 },
		pins: [
			...left.map((port, i) => analog(port, -x, portY(i, left.length))),
			...right.map((port, i) => analog(port, x, portY(i, right.length)))
		],
		params: []
	};
}

/**
 * Make the parts in a drawing available to everything that asks about a kind.
 *
 * The catalog is global and a subcircuit is not, which is a tension worth being
 * explicit about: this has to run *before* anything reads the instances of a
 * drawing, or the first thing to ask what an `x:` part looks like throws. So it
 * is called wherever a whole document arrives — opened, loaded, followed from a
 * link — rather than being left to whoever gets there first.
 *
 * Definitions are only ever added. A stale one costs a map entry; a missing one
 * loses someone's circuit.
 */
export function registerSubcircuits(schematic: Schematic): void {
	for (const sub of schematic.subcircuits ?? []) {
		BY_KIND.set(SUBCIRCUIT_PREFIX + sub.id, subcircuitDefinition(sub));
	}
}

/** The definition a placed subcircuit was built from, if it is one. */
export function subcircuitOf(schematic: Schematic, kind: string): SubcircuitDef | null {
	if (!kind.startsWith(SUBCIRCUIT_PREFIX)) return null;
	const id = kind.slice(SUBCIRCUIT_PREFIX.length);
	return schematic.subcircuits?.find((s) => s.id === id) ?? null;
}

/**
 * Bring an instance up to date with the current catalog.
 *
 * An LED used to be one of the diode's model choices, from before it could light
 * up. Someone's saved file or shared link still says so, and dropping the choice
 * without this would leave them holding a plain silicon diode that no longer
 * glows and no longer has the forward voltage their circuit was designed around.
 */
export function migrateInstance(instance: Instance): Instance {
	if (instance.kind === 'diode' && instance.params.model === 'led') {
		return { ...instance, kind: 'led', params: defaultParams('led') };
	}
	return instance;
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

/**
 * Which axis a pin faces once its part has been turned.
 *
 * A lead leaves the body along whichever axis the pin sits furthest out on, so
 * this is the direction a wire is expected to arrive from — and the direction
 * along which moving the part changes how far that wire has to reach, rather
 * than where it runs.
 */
export function pinAxis(instance: Instance, pin: PinDef): 'x' | 'y' {
	const facing =
		Math.abs(pin.x) >= Math.abs(pin.y) ? { x: 1, y: 0 } : { x: 0, y: 1 };
	const turned = rotatePoint(facing.x, facing.y, instance.rotation);
	return Math.abs(turned.x) >= Math.abs(turned.y) ? 'x' : 'y';
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
