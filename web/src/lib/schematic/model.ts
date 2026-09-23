/**
 * The schematic data model and the component catalog.
 *
 * Every pin declares which domain it belongs to. That is what lets the netlist
 * builder work out, on its own, where an analog wire meets digital logic and
 * drop a bridge in between — so you can wire a comparator straight into a NAND
 * gate and it just works, with no explicit converter to place.
 */

import { BARS, LED_COLOURS, RATED, SEGMENTS } from './led';
import { analogTerminals, CHIPS, chipById, chipName, isPower, isUnused, type ChipDef } from './chips';

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
	/**
	 * Kept under "More settings" rather than with the values everyone sets.
	 * Left out, `isAdvanced` decides from the key; see there.
	 */
	advanced?: boolean;
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

export type Group = 'passive' | 'sources' | 'semiconductor' | 'analog' | 'logic' | 'ic';

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
	/**
	 * The solid part of the symbol, leads excluded, for parts whose leads are
	 * long enough to matter. A click in the strip of leads goes to whatever else
	 * is there — the wire tying two neighbouring legs together runs along that
	 * strip, and with the whole box selectable the package took every click on
	 * it. Absent, the box is the body.
	 */
	body?: { x: number; y: number; w: number; h: number };
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

/**
 * A named handful of parts that move as one.
 *
 * Nothing but a name over a list of instances. Not a subcircuit — the parts
 * stay on the drawing, wired to whatever they are wired to — and not a
 * hierarchy: a group holds parts, never groups. Wires are not members either,
 * on purpose. A wire between two members travels with them anyway, since a
 * move carries any wire whose both ends are on moving pins, and wires are
 * split and merged whenever the drawing is tidied, so a membership list of
 * wire ids would silently rot.
 */
export interface PartGroup {
	id: string;
	name: string;
	/** Instance ids. */
	members: string[];
}

/**
 * One terminal of a block, as the box shows it.
 *
 * Worked out from the port parts inside the block rather than stored: the port
 * part is the terminal, its name is the name on the box, and what it is wired
 * to inside decides whether the pin is analog and which way it faces.
 */
export interface BlockPort {
	name: string;
	side: 'left' | 'right';
	/** The port part inside the block that this terminal is. */
	instance: string;
	domain: Domain;
	direction: PinDirection;
}

/**
 * A circuit drawn here and boxed up as a part.
 *
 * The inside is a schematic of its own — parts, wires, groups — kept as it was
 * drawn, so it can be opened back up and edited. Its terminals are the port
 * parts in it: a wire from a pin to a port makes that pin reachable from
 * outside, under the port's name. Placed, it is one part with one pin per
 * port; for the engine it is unfolded back into the parts it is made of, the
 * way an imported `.subckt` is. Positions inside are relative to where the box
 * sits.
 */
export interface BlockDef {
	/** Stable handle. The part's `kind` is `b:` followed by this. */
	id: string;
	name: string;
	instances: Instance[];
	wires: Wire[];
	groups?: PartGroup[];
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
	/** Circuits boxed up as parts, for the same reason. */
	blocks?: BlockDef[];
	groups?: PartGroup[];
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
/** What choosing each regulator fills its fields in with. */
export const REGULATOR_PRESETS: Record<string, Record<string, number>> = {
	'7805': { voltage: 5, dropout: 2, quiescent: 5e-3 },
	'7809': { voltage: 9, dropout: 2, quiescent: 5e-3 },
	'7812': { voltage: 12, dropout: 2, quiescent: 5e-3 },
	'7815': { voltage: 15, dropout: 2, quiescent: 5e-3 },
	'7905': { voltage: 5, dropout: 1.1, quiescent: 3e-3 },
	'7912': { voltage: 12, dropout: 1.1, quiescent: 3e-3 },
	'7915': { voltage: 15, dropout: 1.1, quiescent: 3e-3 },
	LM317: { voltage: 1.25, dropout: 1.7, quiescent: 50e-6 }
};

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

/** The gate's outline, without the leads on either side of it. */
function gateBody(count: number): { x: number; y: number; w: number; h: number } {
	const half = gateReach(count);
	return { x: -20, y: -half, w: 40, h: half * 2 };
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
		key: 'phase',
		label: 'Phase',
		unit: '°',
		default: 0,
		plain: true,
		step: 15,
		visibleWhen: { key: 'waveform', values: ['sine'] },
		description:
			'Where in the cycle the run starts. Two sources ninety degrees apart is a quadrature pair, and one at 180 is the other half of a differential drive.'
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

/** How a pair of contacts is operated, shared by every part that has a pair. */
const SWITCH_PARAMS: ParamDef[] = [
		{
			key: 'start',
			label: 'Starting position',
			unit: '',
			default: 'open',
			choices: [
				{ value: 'open', label: 'Open' },
				{ value: 'closed', label: 'Closed' }
			],
			description:
				'Where it starts. Clicking the switch on the drawing while something is playing throws it at the playhead instead, so the run keeps everything before that instant and the waveform gets the edge.'
		},
		{
			key: 'action',
			label: 'During the run',
			unit: '',
			default: 'manual',
			choices: [
				{ value: 'manual', label: 'Stays put' },
				{ value: 'toggle', label: 'Operates once' },
				{ value: 'momentary', label: 'Push-button' }
			],
			description:
				'A run is solved end to end before it is drawn, so a click cannot land inside one. This is how the moment it moves gets into the run instead.'
		},
		{
			key: 'at',
			label: 'Operates at',
			unit: 's',
			default: 1e-3,
			min: 0,
			visibleWhen: { key: 'action', values: ['toggle', 'momentary'] }
		},
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
			visibleWhen: { key: 'action', values: ['toggle', 'momentary'] },
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
			// A teraohm, not the gigaohm this used to be. A gigaohm across five
			// volts is five nanoamps, and five nanoamps is not nothing — it is a
			// hundred times the picoamp of leakage the solver puts on every node,
			// so an open switch was the largest current in a circuit that was not
			// conducting, and the animation dutifully scaled it up to a full flow.
			// An open air gap between cleaned contacts is well past this.
			default: 1e12,
			min: 0,
			nonZero: true,
			description: 'Air, and whatever is condensed on the insulator beside it. Never actually infinite.'
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
			tolerance(1),
			{
				key: 'tc1',
				label: 'Temperature coefficient',
				unit: 'ppm/°C',
				// Zero rather than a plausible film figure. The engine has modelled this
				// all along and nothing could reach it, so the temperature control did
				// nothing to any resistor at all; a number invented here to fix that
				// would quietly move the answer of every drawing already saved.
				default: 0,
				plain: true,
				step: 10,
				description:
					'How far the value drifts per degree. A carbon film part is a few hundred ppm and a wirewound one more; the reason a precision divider is built from a matched pair is that theirs cancel.'
			}
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
		 * A resistor with a third terminal that slides along it.
		 *
		 * Two resistors in series with the wiper at their junction, which is all
		 * the part is: the track from one end to the wiper and the rest of it on
		 * to the other. The position is a fraction of the way from `a` to `b`, so
		 * a divider across a supply reads that fraction of it at the wiper — and a
		 * trimmer is the same part set once and left alone.
		 */
		kind: 'potentiometer',
		box: { x: -30, y: -30, w: 60, h: 39 },
		label: 'Potentiometer',
		group: 'passive',
		prefix: 'RV',
		pins: [analog('a', -30, 0), analog('b', 30, 0), analog('wiper', 0, -30)],
		params: [
			{
				key: 'resistance',
				label: 'Track resistance',
				unit: 'Ω',
				default: 10e3,
				min: 0,
				nonZero: true,
				description: 'End to end, whatever the wiper is doing.'
			},
			{
				key: 'position',
				label: 'Wiper position',
				unit: '',
				default: 0.5,
				min: 0,
				max: 1,
				plain: true,
				step: 0.05,
				description:
					'How far along the track the wiper sits, from 0 at a to 1 at b. Across a supply, the wiper reads that fraction of it — until something it feeds draws current and pulls it down.'
			},
			// Pots are sold at twenty percent. A divider that only works at the
			// printed value is a divider that has to be trimmed on every board.
			tolerance(20)
		]
	},
	{
		/**
		 * A quartz crystal, as its equivalent circuit.
		 *
		 * The motional arm — a large inductance, a tiny capacitance and the loss
		 * that sets the Q — in series, with the holder's capacitance across the
		 * whole thing. That is the Butterworth–Van Dyke model every datasheet
		 * quotes its numbers against, and it is why a crystal has two resonances a
		 * fraction of a percent apart: series, where the motional arm is a short,
		 * and parallel just above it, where it rings against the holder.
		 *
		 * The frequency is the parameter rather than the inductance, because that
		 * is what is printed on the can; the inductance is worked out from it and
		 * the motional capacitance.
		 */
		kind: 'crystal',
		box: { x: -30, y: -13, w: 60, h: 26 },
		label: 'Crystal',
		group: 'passive',
		prefix: 'Y',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [
			{
				key: 'frequency',
				label: 'Frequency',
				unit: 'Hz',
				default: 16e6,
				min: 0,
				nonZero: true,
				description: 'The series resonance, which is what the can is marked with.'
			},
			{
				key: 'r1',
				label: 'Series resistance',
				unit: 'Ω',
				default: 30,
				min: 0,
				nonZero: true,
				description:
					'The loss in the motional arm, quoted as ESR. It sets the Q, and it is what an oscillator has to overcome before it starts.'
			},
			{
				key: 'c0',
				label: 'Shunt capacitance',
				unit: 'F',
				default: 5e-12,
				min: 0,
				description:
					'The electrodes and the holder. A few picofarads, and the reason there is a parallel resonance at all.'
			},
			{
				key: 'c1',
				label: 'Motional capacitance',
				unit: 'F',
				default: 20e-15,
				min: 0,
				nonZero: true,
				advanced: true,
				description:
					'Femtofarads for an HC-49 at 16 MHz, a few for a 32.768 kHz watch crystal. With the frequency it fixes the motional inductance.'
			}
		]
	},
	{
		/**
		 * A pair of contacts you flip by clicking them.
		 *
		 * Clicking sets where they rest, and the circuit is re-solved with them
		 * there — which is what a switch is for, and how one behaves in every
		 * simulator anybody has used.
		 *
		 * A run is still computed from end to end before any of it is drawn, so a
		 * click cannot land *inside* one. That is what the schedule is for: a
		 * switch can also be told to operate at a time, once or as a push-button,
		 * and then the run contains the moment it happens. Two different questions
		 * — what does this circuit do with the switch here, and what happens when
		 * it moves — and the part answers both without pretending to be live.
		 */
		kind: 'switch',
		box: { x: -30, y: -20, w: 60, h: 28 },
		label: 'Switch',
		group: 'passive',
		prefix: 'S',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: SWITCH_PARAMS
	},
	{
		/**
		 * A changeover: one common contact that rests on one side and is thrown to
		 * the other.
		 *
		 * Two contacts worked the opposite way round by the same actuator, which
		 * is exactly what the part is inside — so it is operated, scheduled and
		 * bounced the same way the single pair is, and "closed" means thrown: the
		 * common has left NC and landed on NO.
		 */
		kind: 'spdt',
		box: { x: -30, y: -20, w: 60, h: 34 },
		label: 'Changeover switch',
		group: 'passive',
		prefix: 'S',
		pins: [analog('com', -30, 0), analog('no', 30, -10), analog('nc', 30, 10)],
		params: SWITCH_PARAMS.map((param) =>
			param.key === 'start'
				? {
						...param,
						choices: [
							{ value: 'open', label: 'At rest (common on NC)' },
							{ value: 'closed', label: 'Thrown (common on NO)' }
						]
					}
				: param
		)
	},
	{
		/**
		 * A coil and a changeover worked by it.
		 *
		 * The coil is its winding resistance and its inductance in series. The
		 * contacts read the voltage across the resistance — the coil current, in
		 * other words — and pull in above one figure and let go below another,
		 * which is how a relay datasheet specifies them. The inductance is not
		 * decoration: switch the coil off with a transistor and nothing across it,
		 * and the spike it throws back is what the flyback diode on every relay
		 * driver is there for.
		 *
		 * What is left out is the armature's travel: the contacts follow the
		 * current with no mechanical delay and no bounce.
		 */
		kind: 'relay',
		box: { x: -28, y: -30, w: 68, h: 60 },
		label: 'Relay',
		group: 'passive',
		prefix: 'K',
		pins: [
			analog('a', -20, -30),
			analog('b', -20, 30),
			analog('com', 40, 0),
			analog('no', 10, -30),
			analog('nc', 10, 30)
		],
		params: [
			{
				key: 'coil_r',
				label: 'Coil resistance',
				unit: 'Ω',
				default: 70,
				min: 0,
				nonZero: true,
				description: 'The winding. 70 Ω is a common 5 V coil, which draws about 70 mA held in.'
			},
			{
				key: 'coil_l',
				label: 'Coil inductance',
				unit: 'H',
				default: 0.2,
				min: 0,
				nonZero: true
			},
			{
				key: 'pull_in',
				label: 'Pull-in voltage',
				unit: 'V',
				default: 3.75,
				min: 0,
				nonZero: true,
				description:
					'Across the coil, at or above which the contacts are thrown. Datasheets quote 75% of the nominal voltage.'
			},
			{
				key: 'drop_out',
				label: 'Drop-out voltage',
				unit: 'V',
				default: 0.5,
				min: 0,
				description: 'Below this the contacts are back at rest. Between the two they are on their way.'
			},
			{
				key: 'r_on',
				label: 'Contact resistance',
				unit: 'Ω',
				default: 0.05,
				min: 0,
				nonZero: true
			},
			{
				key: 'r_off',
				label: 'Open resistance',
				unit: 'Ω',
				default: 1e12,
				min: 0,
				nonZero: true
			}
		]
	},
	{
		/**
		 * A filament lamp, as the resistance it has when it is lit.
		 *
		 * Rated the way a bulb is sold — a voltage and a wattage — and the
		 * resistance follows from the two. A cold filament is a tenth of that,
		 * which is the inrush that blows bulbs at switch-on; this one is always
		 * hot, so the inrush is not there.
		 */
		kind: 'lamp',
		box: { x: -30, y: -11, w: 60, h: 22 },
		label: 'Lamp',
		group: 'passive',
		prefix: 'LP',
		pins: [analog('a', -30, 0), analog('b', 30, 0)],
		params: [
			{ key: 'voltage', label: 'Rated voltage', unit: 'V', default: 6, min: 0, nonZero: true },
			{
				key: 'power',
				label: 'Rated power',
				unit: 'W',
				default: 1.2,
				min: 0,
				nonZero: true,
				description: 'At the rated voltage. Together they fix the hot resistance: V² / P.'
			}
		]
	},
	{
		/**
		 * A terminal of a block, from the inside.
		 *
		 * A port is what makes a pin of a boxed-up circuit reachable from outside:
		 * the box gets a pin under the port's name, on the side its flow says.
		 * Like a probe it is a name attached to a point — it carries nothing and
		 * changes nothing — so on an ordinary drawing it is a label and no more.
		 */
		kind: 'port',
		box: { x: -40, y: -8, w: 40, h: 16 },
		label: 'Port',
		group: 'logic',
		prefix: 'IO',
		pins: [analog('p', 0, 0)],
		params: [
			{
				key: 'flow',
				label: 'Flow',
				unit: '',
				default: 'in',
				choices: [
					{ value: 'in', label: 'Input — on the left of the box' },
					{ value: 'out', label: 'Output — on the right of the box' }
				]
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
		/**
		 * A cell, or a stack of them: a voltage with a resistance inside it.
		 *
		 * The resistance is the whole difference between a battery and a supply.
		 * An ideal source holds its voltage whatever it is asked for; a 9 V
		 * battery asked for an amp gives most of a volt of it away inside, and a
		 * circuit that only works on the bench supply is found out here.
		 */
		kind: 'battery',
		box: { x: -14, y: -30, w: 28, h: 60 },
		label: 'Battery',
		group: 'sources',
		prefix: 'BT',
		pins: [analog('plus', 0, -30), analog('minus', 0, 30)],
		params: [
			{
				key: 'voltage',
				label: 'Voltage',
				unit: 'V',
				default: 9,
				min: 0,
				nonZero: true,
				description: 'With nothing drawn from it.'
			},
			{
				key: 'r_int',
				label: 'Internal resistance',
				unit: 'Ω',
				default: 1.5,
				min: 0,
				nonZero: true,
				description:
					'About 1.5 Ω for a fresh 9 V alkaline, a tenth of an ohm for an AA cell, and climbing as either runs down.'
			}
		]
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
					{ value: 'zener', label: 'Zener (1N4733A)' }
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
		/**
		 * Seven LEDs in the shape of a digit, and an eighth for the point.
		 *
		 * Electrically there is nothing new here: it is eight diodes with one of
		 * their ends tied together, which is exactly what the part is. Drawing it as
		 * eight separate LEDs would simulate the same and read as nothing at all —
		 * the point of the package is that the shape means a number.
		 *
		 * Which end is tied is the first thing a datasheet tells you, and it decides
		 * how the thing is driven: a common-cathode digit lights on a high and is
		 * driven from ordinary logic outputs, a common-anode one lights on a low and
		 * wants the common pin on the supply. Wiring one as the other lights nothing,
		 * which is a mistake worth being able to make here.
		 */
		kind: 'display7',
		box: { x: -46, y: -62, w: 92, h: 124 },
		label: '7-segment',
		group: 'semiconductor',
		prefix: 'DS',
		pins: [
			// Ten apart, which is the grid: eight pins twenty apart made the package
			// twice the height of the digit inside it, and a symbol that is mostly
			// empty box reads as a mistake.
			...SEGMENTS.map((seg, i) => analog(seg, -50, (i - 3.5) * 10)),
			analog('common', 0, 62)
		],
		params: [
			{
				key: 'polarity',
				label: 'Common pin',
				unit: '',
				default: 'cathode',
				choices: [
					{ value: 'cathode', label: 'Cathode (lights on a high)' },
					{ value: 'anode', label: 'Anode (lights on a low)' }
				],
				description:
					'Which end of the eight LEDs is tied together. Drive a common-cathode digit from logic outputs with its common pin at ground; a common-anode one hangs its common pin on the supply and lights on a low.'
			},
			{
				key: 'colour',
				label: 'Colour',
				unit: '',
				default: LED_COLOURS[0].value,
				choices: LED_COLOURS.map(({ value, label }) => ({ value, label }))
			},
			{
				key: 'imax',
				label: 'Rated current',
				unit: 'A',
				default: RATED,
				min: 0,
				nonZero: true,
				description: 'Per segment, and every segment is its own LED: a digit showing 8 draws eight times this.'
			}
		]
	},
	{
		/**
		 * Ten LEDs in a row, each with both of its legs brought out.
		 *
		 * Nothing is shared inside: anode down one side and cathode down the
		 * other, bar for bar, which is how the common ten-segment packages are
		 * made. So it can be driven from a row of outputs, a decoder or a
		 * comparator ladder, whichever way round the drive happens to be.
		 */
		kind: 'bargraph',
		box: { x: -40, y: -58, w: 80, h: 106 },
		label: 'LED bar graph',
		group: 'semiconductor',
		prefix: 'DS',
		pins: [
			...BARS.map((bar, i) => analog(`a${bar}`, -40, (i - 5) * 10)),
			...BARS.map((bar, i) => analog(`k${bar}`, 40, (i - 5) * 10))
		],
		params: [
			{
				key: 'colour',
				label: 'Colour',
				unit: '',
				default: LED_COLOURS[0].value,
				choices: LED_COLOURS.map(({ value, label }) => ({ value, label }))
			},
			{
				key: 'imax',
				label: 'Rated current',
				unit: 'A',
				default: RATED,
				min: 0,
				nonZero: true,
				description: 'Per bar. Each one is its own LED and needs its own resistor.'
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
			{ key: 'bf', label: 'Forward gain β', unit: '', default: 200, min: 0, nonZero: true },
			{
				key: 'vaf',
				label: 'Early voltage',
				unit: 'V',
				default: 100,
				min: 0,
				description:
					'Base-width modulation. Sets the output resistance to about VAF/Ic — zero here would make a stage into a high impedance amplify without limit.'
			},
			{
				key: 'is',
				label: 'Saturation current',
				unit: 'A',
				default: 6.73e-15,
				min: 0,
				nonZero: true
			},
			...BASE_CHARGE,
			...SPICE_CARD
		]
	},
	{
		/**
		 * A three-terminal linear regulator: the 78xx and 79xx families and the
		 * LM317.
		 *
		 * One part for both because they are one circuit — an error amplifier
		 * holding the output a fixed voltage above the third leg, through a pass
		 * transistor from the input. On a 7805 that leg is ground and the voltage
		 * is 5 V; on an LM317 it is ADJ and the voltage is 1.25 V, which a
		 * divider multiplies up to whatever is wanted.
		 */
		kind: 'regulator',
		box: { x: -30, y: -20, w: 60, h: 50 },
		label: 'Regulator',
		group: 'analog',
		prefix: 'U',
		pins: [analog('in', -30, 0), analog('out', 30, 0), analog('com', 0, 30)],
		params: [
			{
				key: 'part',
				label: 'Part',
				unit: '',
				default: '7805',
				choices: [
					{ value: '7805', label: '7805 (5 V)' },
					{ value: '7809', label: '7809 (9 V)' },
					{ value: '7812', label: '7812 (12 V)' },
					{ value: '7815', label: '7815 (15 V)' },
					{ value: '7905', label: '7905 (−5 V)' },
					{ value: '7912', label: '7912 (−12 V)' },
					{ value: '7915', label: '7915 (−15 V)' },
					{ value: 'LM317', label: 'LM317 (adjustable)' }
				]
			},
			{
				key: 'voltage',
				label: 'Output from COM',
				unit: 'V',
				default: 5,
				min: 0,
				nonZero: true,
				description:
					'What it holds between OUT and its third leg: the output itself on a 78xx, whose third leg is ground, the same below ground on a 79xx, and 1.25 V on an LM317, set up to any output by a divider on ADJ.'
			},
			{
				key: 'dropout',
				label: 'Dropout',
				unit: 'V',
				default: 2,
				min: 0.3,
				description:
					'How far above the output the input has to stay for it to regulate. Two volts on a 78xx: a 7805 wants 7 V in.'
			},
			{
				key: 'quiescent',
				label: 'Quiescent current',
				unit: 'A',
				default: 5e-3,
				min: 0,
				description:
					'What it draws for itself, out of the third leg: 5 mA on a 78xx, 50 µA from the ADJ pin of an LM317.'
			},
			{
				key: 'limit',
				label: 'Current limit',
				unit: 'A',
				default: 1.5,
				min: 0,
				nonZero: true,
				description:
					'Past this the output stops being a voltage and becomes a current: short it and this is what flows, which is what keeps the part alive.'
			}
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
			body: gateBody(2),
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
	},
	{
		/**
		 * A level you set, and a genuinely different part from a switch.
		 *
		 * A switch is a contact. It joins a net to something or it leaves it joined
		 * to nothing, and nothing is not a logic level — so a switch feeding a gate
		 * needs a resistor to hold that input while the contact is open, and
		 * without one the input is undefined half the time. That is the physics and
		 * it is worth learning once.
		 *
		 * It is also not what you want when the question is "what does this circuit
		 * do with A high and B low". This drives the net instead: both of its
		 * positions are a level, there is no rail to wire, nothing to pull, and no
		 * instant at which the net is adrift. Click it to flip it, like a switch.
		 */
		kind: 'toggle',
		box: { x: -26, y: -14, w: 56, h: 28 },
		label: 'Logic toggle',
		group: 'logic',
		prefix: 'T',
		pins: [digitalOut('y', 30, 0)],
		params: [
			{
				key: 'state',
				label: 'Starting level',
				unit: '',
				default: 'low',
				choices: [
					{ value: 'low', label: 'Low (0)' },
					{ value: 'high', label: 'High (1)' }
				],
				description:
					'Where it starts. Clicking it on the drawing while something is playing operates it at the playhead instead, so the waveform gets the edge. It drives the net in both positions, so unlike a switch it never leaves what it feeds floating.'
			}
		]
	}
];

/**
 * Parts a plain click operates rather than merely selects.
 *
 * Both of them are things somebody puts on a drawing in order to move: a switch
 * makes and breaks a contact, a logic toggle drives a level. Everything else is
 * changed through its fields.
 */
export const OPERABLE = new Set(['switch', 'spdt', 'toggle']);

/** Parts with contacts worked by an actuator: thrown by a click or on a schedule. */
export const CONTACTS = new Set(['switch', 'spdt']);

/**
 * Parts that are a name attached to a point: they join a net without making
 * it anything, carry nothing, and the engine never builds them.
 */
export const MARKERS = new Set(['probe', 'port']);

export type PortFlow = 'in' | 'out';

/** Which way a port faces: an input comes in on the left of the box. */
export function portFlow(instance: Instance): PortFlow {
	return instance.params.flow === 'out' ? 'out' : 'in';
}

/**
 * Where a port was put in its column on the box by hand, if it was. Without
 * one, the box reads the order off where the ports sit inside.
 */
export function portOrder(instance: Instance): number | null {
	const order = instance.params.order;
	return typeof order === 'number' ? order : null;
}

// ---------------------------------------------------------------------------
// Integrated circuits
// ---------------------------------------------------------------------------

/** How a placed chip is named: `ic:7400`. */
export const CHIP_PREFIX = 'ic:';

/** Legs are a tenth of an inch apart on the real thing and 20 units here. */
const CHIP_PITCH = 20;
/** Half the width of the body. Wide enough for a pin name inside each edge. */
export const CHIP_BODY_HALF_WIDTH = 46;
/** Half the reach with the legs on, which is where the pins sit. */
const CHIP_HALF_WIDTH = CHIP_BODY_HALF_WIDTH + 14;

/**
 * Where every leg of a DIP sits, in package order.
 *
 * Pin 1 is top left and they run down that side, across the bottom and back up
 * the right — which is why the right-hand column is indexed from the end. That
 * is not decoration: it is how somebody counts legs with the notch facing up,
 * and getting it wrong makes the drawing lie about a part they are holding.
 */
export function chipPinLayout(count: number): Array<{ x: number; y: number; index: number }> {
	const perSide = count / 2;
	const y = (row: number) => (row - (perSide - 1) / 2) * CHIP_PITCH;
	return Array.from({ length: count }, (_, i) =>
		i < perSide
			? { x: -CHIP_HALF_WIDTH, y: y(i), index: i }
			: { x: CHIP_HALF_WIDTH, y: y(count - 1 - i), index: i }
	);
}

/**
 * Half the body height, with room above and below the outermost legs — and,
 * at the bottom, for the part number under the last row of pin names, which
 * it used to sit on top of.
 */
export function chipReach(count: number): number {
	return ((count / 2 - 1) * CHIP_PITCH) / 2 + 28;
}

/**
 * A placeable part generated from a row of the chip table.
 *
 * Direction is read off what is inside rather than declared twice: a pin a block
 * drives is an output, everything else a block touches is an input. Supply pins
 * are analog, because that is what they connect to — a rail and a ground symbol.
 *
 * Unconnected legs are deliberately *not* pins. They exist on the package and
 * the symbol draws their numbers, but a pin the die does not reach would collect
 * a "not connected" warning on every drawing forever.
 */
export function chipDefinition(chip: ChipDef): ComponentDef {
	const driven = new Set<string>();
	const touched = new Set<string>();
	for (const block of chip.blocks) {
		for (const pin of block.inputs ?? []) touched.add(pin);
		for (const pin of [block.clock, block.data, block.reset, block.preset, block.enable]) {
			if (pin) touched.add(pin);
		}
		for (const pin of [block.output, block.q, block.qn]) {
			if (pin) driven.add(pin);
		}
	}
	// A leg anything analog inside reaches is an analog pin, even when logic
	// inside reads it too: the part crosses between the two domains itself, and
	// the net outside sees a voltage.
	const analogLegs = new Set((chip.analog ?? []).flatMap(analogTerminals));

	const places = chipPinLayout(chip.layout.length);
	const pins: PinDef[] = [];
	for (const [i, name] of chip.layout.entries()) {
		if (isUnused(name)) continue;
		const { x, y } = places[i];
		if (isPower(name) || analogLegs.has(name)) pins.push(analog(name, x, y));
		else if (driven.has(name)) pins.push(digitalOut(name, x, y));
		else if (touched.has(name)) pins.push(digitalIn(name, x, y));
	}

	const half = chipReach(chip.layout.length);
	return {
		kind: CHIP_PREFIX + chip.id,
		label: chipName(chip),
		group: 'ic',
		prefix: 'U',
		box: { x: -CHIP_HALF_WIDTH, y: -half, w: CHIP_HALF_WIDTH * 2, h: half * 2 },
		body: { x: -CHIP_BODY_HALF_WIDTH, y: -half, w: CHIP_BODY_HALF_WIDTH * 2, h: half * 2 },
		pins,
		params: []
	};
}

/** The chip a kind names, if it names one. */
export function chipOf(kind: string): ChipDef | undefined {
	return kind.startsWith(CHIP_PREFIX) ? chipById(kind.slice(CHIP_PREFIX.length)) : undefined;
}

const BY_KIND = new Map(
	[...CATALOG, ...CHIPS.map(chipDefinition)].map((d) => [d.kind, d])
);

export function definitionOf(kind: string): ComponentDef {
	const def = BY_KIND.get(kind);
	if (!def) throw new Error(`unknown component kind: ${kind}`);
	return def;
}

const gateShapes = new Map<string, ComponentDef>();

/** An output port: the same part with its flag on the other side of the pin. */
const PORT_OUT: ComponentDef = {
	...(CATALOG.find((d) => d.kind === 'port') as ComponentDef),
	box: { x: 0, y: -8, w: 40, h: 16 }
};

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
	// A port's flag hangs off whichever side of its pin the signal comes from.
	if (instance.kind === 'port') return portFlow(instance) === 'out' ? PORT_OUT : base;
	if (!WIDE_GATES.has(instance.kind)) return base;

	const count = gateInputCount(instance.params);
	const key = `${instance.kind}:${count}`;
	let shaped = gateShapes.get(key);
	if (!shaped) {
		shaped = { ...base, pins: gatePins(count), box: gateBox(count), body: gateBody(count) };
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
		body: { x: -SUB_HALF_WIDTH, y: -half, w: SUB_HALF_WIDTH * 2, h: half * 2 },
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

// ---------------------------------------------------------------------------
// Boxed-up circuits as parts
// ---------------------------------------------------------------------------

export const BLOCK_PREFIX = 'b:';

/** Room the body needs beyond a name printed inside its edge, per character. */
const BLOCK_CHAR = 5;
/** The same for the block's own name along the bottom, which is set a size larger. */
const BLOCK_NAME_CHAR = 6;
/** Space under the lowest port for each line of the block's name. */
const BLOCK_NAME_ROOM = 20;
/** The most of a name that goes on one line along the bottom of the box. */
export const BLOCK_NAME_WIDTH = 20;
/** Lines a name may take up before the rest is folded into an ellipsis. */
export const BLOCK_NAME_LINES = 3;
/**
 * The most a port name can be. A pin name is printed inside the edge, on the
 * pin's own line, where there is no room to wrap it.
 */
export const BLOCK_PORT_WIDTH = 20;

/** A name cut to fit a width, with an ellipsis where the rest was. */
export function clippedName(name: string, width: number): string {
	return name.length > width ? `${name.slice(0, width - 1)}…` : name;
}

/**
 * A block's name as the lines it is printed on: wrapped at the spaces, a
 * word longer than a line cut where the line ends, and no more lines than
 * the box makes room for. However long the name, the box stops growing here;
 * the whole of it is still there to read where the block is listed.
 */
export function blockNameLines(name: string): string[] {
	const lines: string[] = [];
	let line = '';
	const flush = () => {
		if (line) lines.push(line);
		line = '';
	};
	for (let word of name.trim().split(/\s+/).filter(Boolean)) {
		while (word.length > BLOCK_NAME_WIDTH) {
			flush();
			lines.push(word.slice(0, BLOCK_NAME_WIDTH));
			word = word.slice(BLOCK_NAME_WIDTH);
		}
		if (line && line.length + 1 + word.length > BLOCK_NAME_WIDTH) flush();
		line = line ? `${line} ${word}` : word;
	}
	flush();
	if (lines.length <= BLOCK_NAME_LINES) return lines;
	const kept = lines.slice(0, BLOCK_NAME_LINES);
	kept[BLOCK_NAME_LINES - 1] = clippedName(`${kept[BLOCK_NAME_LINES - 1]}…`, BLOCK_NAME_WIDTH);
	return kept;
}

/** The ports on one side, top to bottom. */
export function blockSide(ports: readonly BlockPort[], side: 'left' | 'right'): BlockPort[] {
	return ports.filter((port) => port.side === side);
}

/**
 * Half the width of the body, wide enough that the longest name on each side
 * fits inside its edge. Grown in grid steps so the pins, a lead further out,
 * stay on the grid.
 */
export function blockHalfWidth(ports: readonly BlockPort[], name = ''): number {
	const longest = (side: 'left' | 'right') =>
		Math.max(
			0,
			...blockSide(ports, side).map((port) => Math.min(port.name.length, BLOCK_PORT_WIDTH))
		);
	// Wide enough for the two port names to meet in the middle with a gap, and
	// for the longest line of the block's own name along the bottom:
	// "Frequency Divisor" on a box sized for CLK and OUT ran past both edges.
	const wanted = Math.max(
		(longest('left') + longest('right')) * BLOCK_CHAR + 16,
		Math.max(0, ...blockNameLines(name).map((line) => line.length)) * BLOCK_NAME_CHAR + 12
	);
	let half = SUB_HALF_WIDTH;
	while (half * 2 < wanted) half += GRID;
	return half;
}

/**
 * How far the body reaches above the origin: the longer column of ports,
 * plus one line of the name. It reaches the same below, and further by the
 * lines the name needs beyond the first (`blockNameDepth`): a longer name
 * grows the box downward, under the ports, and leaves the pins where they are.
 */
export function blockReach(ports: readonly BlockPort[]): number {
	const rows = Math.max(blockSide(ports, 'left').length, blockSide(ports, 'right').length, 1);
	return Math.max(22, ((rows - 1) * SUB_PITCH) / 2 + 12 + BLOCK_NAME_ROOM / 2);
}

/** The height the name adds below the box a one-line name gets. */
export function blockNameDepth(name: string): number {
	return BLOCK_NAME_ROOM * Math.max(0, blockNameLines(name).length - 1);
}

/**
 * A placeable part built from a boxed-up circuit and its terminals. The
 * terminals arrive worked out — which is a question about connectivity, and
 * so is answered next to it rather than here.
 */
export function blockDefinition(block: BlockDef, ports: readonly BlockPort[]): ComponentDef {
	const half = blockReach(ports);
	const depth = blockNameDepth(block.name);
	const hw = blockHalfWidth(ports, block.name);
	const x = hw + SUB_LEAD;
	const left = blockSide(ports, 'left');
	const right = blockSide(ports, 'right');
	// The name sits under the ports, so the columns are shifted up to leave it
	// room without the box growing on both ends.
	const lift = BLOCK_NAME_ROOM / 2;
	const pin = (port: BlockPort, px: number, py: number): PinDef => ({
		name: port.name,
		x: px,
		y: py,
		domain: port.domain,
		direction: port.direction
	});
	return {
		kind: BLOCK_PREFIX + block.id,
		label: block.name,
		group: 'logic',
		prefix: 'B',
		box: { x: -x, y: -half, w: x * 2, h: half * 2 + depth },
		body: { x: -hw, y: -half, w: hw * 2, h: half * 2 + depth },
		pins: [
			...left.map((port, i) => pin(port, -x, portY(i, left.length) - lift)),
			...right.map((port, i) => pin(port, x, portY(i, right.length) - lift))
		],
		params: []
	};
}

/** Put a generated definition where everything that asks about a kind will find it. */
export function registerKind(def: ComponentDef): void {
	BY_KIND.set(def.kind, def);
}

/** Whether a kind can be asked about without throwing. */
export function isKnownKind(kind: string): boolean {
	return BY_KIND.has(kind);
}

/** The definition a placed block was built from, if it is one. */
export function blockOf(schematic: Schematic, kind: string): BlockDef | null {
	if (!kind.startsWith(BLOCK_PREFIX)) return null;
	const id = kind.slice(BLOCK_PREFIX.length);
	return schematic.blocks?.find((b) => b.id === id) ?? null;
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
	// A switch used to have no choice but to operate during the run: "toggle at
	// one millisecond" was the default, so every switch anybody drew flipped
	// itself over a millisecond in and undid whatever they had set it to. Left
	// alone, that reads as a switch with a mind of its own.
	//
	// Recognised by the whole default being untouched. Somebody who deliberately
	// wanted a timed operation changed one of these three numbers to say when,
	// and keeps it.
	//
	// Accumulated rather than returned one at a time, because a switch drawn early
	// enough carries both of these defaults and an early return would have applied
	// whichever was written first and silently dropped the other.
	if (instance.kind === 'switch') {
		const params = { ...instance.params };
		if (
			params.action === 'toggle' &&
			params.at === 1e-3 &&
			params.bounce === 1e-3 &&
			params.hold === 10e-3
		) {
			params.action = 'manual';
		}
		// The open contact used to be a gigaohm, which leaks nanoamps — enough to be
		// the biggest current in a circuit that is switched off, and so enough to
		// make the animation run dots through an open switch at full speed. Only the
		// untouched default moves: a number somebody typed is a number they meant.
		if (params.r_off === 1e9) params.r_off = 1e12;
		return { ...instance, params };
	}
	return instance;
}

export function defaultParams(kind: string): Record<string, number | string> {
	const params: Record<string, number | string> = {};
	for (const p of definitionOf(kind).params) params[p.key] = p.default;
	return params;
}

/**
 * The device-physics knobs: a saturation current, a junction capacitance, a
 * gate delay. They are what makes the model honest, and what almost nobody
 * changes; with them all in one column, the resistance of a resistor or the
 * gain of an op-amp is one field among eight. Keyed by name because the same
 * name means the same kind of thing on every part that has it.
 */
const ADVANCED_KEYS = new Set([
	'tolerance', 'tc1', 'bounce', 'r_on', 'r_off', 'phase',
	'is', 'n', 'rs', 'breakdown', 'cj0', 'tt',
	'lambda', 'cgd', 'cgs', 'vaf', 'cjc', 'tf',
	'slew', 'r_out', 'v_os', 'i_bias', 'delay'
]);

/** Whether a parameter belongs under "More settings". */
export function isAdvanced(param: ParamDef): boolean {
	return param.advanced ?? ADVANCED_KEYS.has(param.key);
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
