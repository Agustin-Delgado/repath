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
/**
 * How far off its marking a part is allowed to be, as a percentage.
 *
 * A 1% resistor is a 1% resistor: the value printed on it is the middle of a
 * band, not a promise. A circuit that only works at the nominal value does not
 * work, and nothing about a single simulation run at nominal will ever say so.
 */
const tolerance = (percent: number) => ({
	key: 'tolerance',
	label: 'Tolerance',
	unit: '%',
	default: percent,
	min: 0,
	max: 100,
	plain: true,
	step: 0.5,
	description:
		'Only does anything with sampling switched on, where each part is drawn once from inside its band and stays there for the run.'
});

/**
 * What each diode preset fills the fields in with.
 *
 * Presets rather than kinds: a diode is one device with one set of equations,
 * and what separates a Schottky from a rectifier is these six numbers. Picking
 * one is a starting point — every field stays editable afterwards, and a part
 * that is none of these is a paste of its `.model` card.
 */
export const DIODE_PRESETS: Record<string, Record<string, number>> = {
	// 1N4148. The one everybody has in a drawer.
	silicon: { is: 2.52e-9, n: 1.752, rs: 0.568, cj0: 4e-12, tt: 5e-9 },
	// 1N4007. A volt of drop at an amp, and slow: microseconds of stored charge,
	// which is why it rectifies mains and nothing faster.
	rectifier: { is: 14.11e-9, n: 1.984, rs: 0.0334, cj0: 25.9e-12, tt: 4.32e-6 },
	// 1N5819. A metal-semiconductor junction has no minority carriers to sweep
	// out, so it has no reverse recovery at all — that, and the low drop, is the
	// whole reason to reach for one.
	schottky: { is: 31.7e-6, n: 1.37, rs: 0.0512, cj0: 160e-12, tt: 0 },
	// OA90. A quarter of a volt forward, and leaky enough that the leakage is a
	// design consideration rather than a footnote.
	germanium: { is: 5e-6, n: 1.4, rs: 1.0, cj0: 1e-12, tt: 1e-9 },
	zener: { is: 2.52e-9, n: 1.752, rs: 0.568, cj0: 4e-12, tt: 5e-9 }
};

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

/**
 * The gates whose input count is yours to choose.
 *
 * A two-input AND is a special case, not the device. Real logic comes in twos,
 * threes and fours on the same part number — a 7410 is three three-input NANDs
 * — and building one out of a chain of two-input gates is a different circuit:
 * it costs an extra propagation delay per level, which is exactly the thing a
 * simulation is meant to show you.
 *
 * NOT and buffer are left out on purpose. An inverter with two inputs is not an
 * inverter.
 */
const WIDE_GATES = new Set(['and', 'nand', 'or', 'nor', 'xor', 'xnor']);

export const MAX_GATE_INPUTS = 4;

/** Vertical spacing between the inputs down the side of a gate. */
const GATE_PITCH = 20;

const INPUT_NAMES = ['a', 'b', 'c', 'd'];

const INPUTS_PARAM: ParamDef = {
	key: 'inputs',
	label: 'Inputs',
	unit: '',
	default: 2,
	min: 2,
	max: MAX_GATE_INPUTS,
	plain: true,
	step: 1,
	description: 'The symbol grows a pin for each one. Wiring only some of them leaves the rest unknown, which propagates.'
};

/** How many inputs a gate's parameters ask for, whatever they say. */
export function gateInputCount(params: Record<string, number | string> = {}): number {
	const raw = Number(params.inputs);
	if (!Number.isFinite(raw)) return 2;
	return Math.min(Math.max(Math.round(raw), 2), MAX_GATE_INPUTS);
}

/** Half the height of a gate body, big enough for the pins it has to carry. */
export function gateReach(count: number): number {
	return Math.max(18, ((count - 1) * GATE_PITCH) / 2 + 8);
}

/** Inputs down the left, one output on the right — the shape every gate shares. */
export function gatePins(count = 2): PinDef[] {
	const pins = INPUT_NAMES.slice(0, count).map((name, i) =>
		digitalIn(name, -30, (i - (count - 1) / 2) * GATE_PITCH)
	);
	return [...pins, digitalOut('y', 30, 0)];
}

function gateBox(count: number): { x: number; y: number; w: number; h: number } {
	const half = gateReach(count);
	return { x: -30, y: -half, w: 60, h: half * 2 };
}

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
		params: [
			{ key: 'resistance', label: 'Resistance', unit: 'Ω', default: 1000, min: 0, nonZero: true },
			tolerance(1)
		]
	},
	{
		kind: 'capacitor',
		box: { x: -30, y: -13, w: 60, h: 26 },
		label: 'Capacitor',
		group: 'passive',
		prefix: 'C',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [
			{ key: 'capacitance', label: 'Capacitance', unit: 'F', default: 1e-6, min: 0, nonZero: true },
			tolerance(10)
		]
	},
	{
		kind: 'inductor',
		box: { x: -30, y: -8, w: 60, h: 16 },
		label: 'Inductor',
		group: 'passive',
		prefix: 'L',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [
			{ key: 'inductance', label: 'Inductance', unit: 'H', default: 1e-3, min: 0, nonZero: true },
			tolerance(10)
		]
	},
	{
		/**
		 * A pair of contacts that meet, or stop meeting, at a time you choose.
		 *
		 * Not a switch you click: a run is computed from end to end before any of
		 * it is drawn, so there is no instant during it for a click to land in.
		 * What there is instead is the question a switch is usually asked in a
		 * simulator — what happens *when* it operates — and that is a time, which
		 * is a parameter.
		 */
		kind: 'switch',
		box: { x: -30, y: -20, w: 60, h: 28 },
		label: 'Switch',
		group: 'passive',
		prefix: 'S',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [
			{
				key: 'action',
				label: 'Action',
				unit: '',
				default: 'toggle',
				choices: [
					{ value: 'toggle', label: 'Toggle' },
					{ value: 'momentary', label: 'Push-button' }
				],
				description: 'A toggle stays where it was put. A push-button springs back.'
			},
			{
				key: 'start',
				label: 'At rest',
				unit: '',
				default: 'open',
				choices: [
					{ value: 'open', label: 'Open' },
					{ value: 'closed', label: 'Closed' }
				]
			},
			{ key: 'at', label: 'Operates at', unit: 's', default: 1e-3, min: 0 },
			{
				key: 'hold',
				label: 'Held for',
				unit: 's',
				default: 10e-3,
				min: 0,
				nonZero: true,
				visibleWhen: { key: 'action', values: ['momentary'] }
			},
			{
				key: 'bounce',
				label: 'Contact bounce',
				unit: 's',
				default: 1e-3,
				min: 0,
				description:
					'Contacts are springs, and they chatter for a millisecond or so before they settle. It is the whole reason a button wired to a counter counts three.'
			},
			{
				key: 'r_on',
				label: 'Closed resistance',
				unit: 'Ω',
				default: 0.05,
				min: 0,
				nonZero: true,
				description: 'The metal and the contact pressure. Milliohms on a good switch, and the reason a bad one gets warm.'
			},
			{
				key: 'r_off',
				label: 'Open resistance',
				unit: 'Ω',
				default: 1e9,
				min: 0,
				nonZero: true,
				description: 'Air, and whatever is condensed on the insulator beside it. Never actually infinite.'
			}
		]
	},
	{
		/**
		 * A place to measure, put where you want to measure it.
		 *
		 * Reading a trace called `n1` means counting nets by hand; reading one
		 * called `out` means nothing at all, because you named it. A probe carries
		 * no current and changes nothing — it is a name attached to a point, which
		 * is what a test point on a bench is.
		 */
		kind: 'probe',
		box: { x: -8, y: -26, w: 16, h: 34 },
		label: 'Probe',
		group: 'analog',
		prefix: 'P',
		pins: [analog('p', 0, 0)],
		params: [
			{
				key: 'label',
				label: 'Name',
				unit: '',
				default: '',
				description:
					'What to call this signal on the scope. Left empty it uses the designator above.'
			}
		]
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
		/**
		 * The other half of the ground symbol: a rail, without the wire back to it.
		 *
		 * Every supply symbol is its own ideal source referred to ground, rather
		 * than a name that ties distant points into one net. For an ideal source
		 * the two are the same circuit — each point is held at the same voltage
		 * either way — and this one does not need a naming scheme to work. What it
		 * costs is that each symbol carries its own current, so three of them on
		 * one rail is three currents rather than one.
		 */
		kind: 'supply',
		box: { x: -12, y: -18, w: 24, h: 28 },
		label: 'Supply',
		group: 'passive',
		prefix: 'PWR',
		pins: [analog('v', 0, 10)],
		params: [
			{
				key: 'voltage',
				label: 'Voltage',
				unit: 'V',
				default: 5,
				description: 'Referred to ground, which the drawing still needs a symbol for.'
			}
		]
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
				label: 'Preset',
				unit: '',
				default: 'silicon',
				// A starting point, not a species. Choosing one fills the fields below
				// in; every one of them is then yours to change, which is what makes
				// this a diode rather than a menu of two of them.
				choices: [
					{ value: 'silicon', label: 'Small signal (1N4148)' },
					{ value: 'rectifier', label: 'Rectifier (1N4007)' },
					{ value: 'schottky', label: 'Schottky (1N5819)' },
					{ value: 'germanium', label: 'Germanium (OA90)' },
					{ value: 'zener', label: 'Zener' }
				]
			},
			{
				key: 'is',
				label: 'Saturation current',
				unit: 'A',
				default: 2.52e-9,
				min: 0,
				nonZero: true,
				description:
					'Where the forward curve sits. Larger means a smaller drop at the same current, which is most of what separates a Schottky from a silicon part.'
			},
			{
				key: 'n',
				label: 'Emission coefficient',
				unit: '',
				default: 1.752,
				min: 0.1,
				max: 4,
				plain: true,
				step: 0.05,
				description: 'How steep the curve is: about 60·n millivolts per decade of current.'
			},
			{
				key: 'rs',
				label: 'Series resistance',
				unit: 'Ω',
				default: 0.568,
				min: 0,
				description:
					'The bulk silicon and the leads. Nothing at a milliamp, and most of the forward drop at an amp.'
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
			{
				key: 'cj0',
				label: 'Junction capacitance',
				unit: 'F',
				default: 4e-12,
				min: 0,
				description: 'Charge in the depletion region, which is what a diode blocks with at high frequency rather than instantly.'
			},
			{
				key: 'tt',
				label: 'Transit time',
				unit: 's',
				default: 5e-9,
				min: 0,
				description:
					'The carriers in transit while it conducts. They have to be swept out before it blocks, so this is the reverse recovery — and it is why a Schottky, which has none, rectifies where a silicon part has given up.'
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
			{
				key: 'gbw',
				label: 'Gain-bandwidth',
				unit: 'Hz',
				default: 1e6,
				min: 0,
				nonZero: true,
				description:
					'Gain and bandwidth are one quantity split two ways: asking this part for a gain of a hundred leaves a hundredth of this, and no amount of feedback buys it back.'
			},
			{
				key: 'slew',
				label: 'Slew rate',
				unit: 'V/s',
				default: 0.5e6,
				min: 0,
				nonZero: true,
				description:
					'The fastest the output can move, whatever the input does. Past it the output stops following and becomes a ramp — which is why a square wave comes out with sloped edges.'
			},
			{ key: 'v_max', label: 'Positive rail', unit: 'V', default: 15 },
			{ key: 'v_min', label: 'Negative rail', unit: 'V', default: -15 },
			{
				key: 'r_out',
				label: 'Output resistance',
				unit: 'Ω',
				default: 75,
				min: 0,
				description: 'Nothing drives a load for free. Feedback hides this at low frequencies and stops hiding it as the loop gain falls.'
			},
			{
				key: 'v_os',
				label: 'Input offset',
				unit: 'V',
				default: 1e-3,
				description:
					'The input pair is never quite matched, so the output does not sit at zero — it sits at this, times the gain the circuit asks for.'
			},
			{
				key: 'i_bias',
				label: 'Input bias current',
				unit: 'A',
				default: 80e-9,
				description: 'Drawn through whatever each input is connected to. The reason an integrator drifts with nothing on its input.'
			}
		]
	},
	...(['and', 'nand', 'or', 'nor', 'xor', 'xnor'] as const).map(
		(kind): ComponentDef => ({
			kind,
			box: gateBox(2),
			label: kind.toUpperCase(),
			group: 'logic',
			prefix: 'U',
			pins: gatePins(2),
			params: [INPUTS_PARAM, DELAY_PARAM]
		})
	),
	{
		/**
		 * A buffer computes nothing, which is the point of it.
		 *
		 * What it buys is a delay you can place deliberately, and a fresh output
		 * driving the net instead of whatever was struggling to. On a bench that is
		 * a fan-out problem; here it is the part you reach for when one signal has
		 * to arrive after the one beside it.
		 */
		kind: 'buffer',
		box: { x: -30, y: -16, w: 60, h: 32 },
		label: 'Buffer',
		group: 'logic',
		prefix: 'U',
		pins: [digitalIn('a', -30, 0), digitalOut('y', 30, 0)],
		params: [DELAY_PARAM]
	},
	{
		/**
		 * The one gate that can decline to drive its output at all.
		 *
		 * With the enable low it lets go of the net rather than pulling it
		 * anywhere, which is how several outputs come to share one wire. Two of
		 * them enabled at once is a bus contention, and the net resolves to unknown
		 * rather than to whichever driver happened to be stamped first.
		 */
		kind: 'tristate',
		box: { x: -30, y: -30, w: 60, h: 46 },
		label: 'Tri-state',
		group: 'logic',
		prefix: 'U',
		pins: [digitalIn('a', -30, 0), digitalIn('en', 0, -30), digitalOut('y', 30, 0)],
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

const gateShapes = new Map<string, ComponentDef>();

/**
 * What a *placed* part looks like, which is not always what its kind says.
 *
 * A gate's pins and the box around them depend on how many inputs it was asked
 * for, so everything that reads geometry — routing, hit testing, connectivity,
 * the labels — has to ask about the instance rather than about the kind. The
 * catalog entry stays the two-input one: that is what the palette offers and
 * what a freshly placed part is.
 */
export function definitionFor(instance: Instance): ComponentDef {
	const base = definitionOf(instance.kind);
	if (!WIDE_GATES.has(instance.kind)) return base;

	const count = gateInputCount(instance.params);
	const key = `${instance.kind}:${count}`;
	let shaped = gateShapes.get(key);
	if (!shaped) {
		shaped = { ...base, pins: gatePins(count), box: gateBox(count) };
		gateShapes.set(key, shaped);
	}
	return shaped;
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
