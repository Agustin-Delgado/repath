/**
 * Reading a SPICE `.model` card.
 *
 * The point of this file is that a part should be a paste from the manufacturer
 * rather than something someone hand-transcribes. Every parameter typed by hand
 * is a chance to put the decimal point somewhere else, and the numbers here are
 * the kind nobody checks: `IS=6.734f` looks like every other saturation current
 * ever written, and it is off by a factor of a thousand if it is read as milli.
 *
 * Which is the other point. `M` means milli and `MEG` means mega, so `1M` is a
 * billionth of `1MEG` — the most expensive letter in the format, and the reason
 * the suffix table is ordered longest-first rather than being a lookup.
 */

/** A parsed `.model` card. Parameter names are upper-cased; values are SI. */
export interface ModelCard {
	name: string;
	/** Device type as written, upper-cased: `D`, `NPN`, `PNP`, `NMOS`, `PMOS`. */
	type: string;
	params: Map<string, number>;
}

/**
 * Scale suffixes, longest first.
 *
 * The order is the whole correctness argument: matching `M` before `MEG` reads
 * `1MEG` as one milli followed by the letters `EG`, and a transistor with an
 * Early voltage of 0.074 V instead of 74 V does not amplify at all.
 */
const SCALES: ReadonlyArray<readonly [string, number]> = [
	['MEG', 1e6],
	['MIL', 25.4e-6],
	['T', 1e12],
	['G', 1e9],
	['K', 1e3],
	['M', 1e-3],
	['U', 1e-6],
	['N', 1e-9],
	['P', 1e-12],
	['F', 1e-15]
];

/**
 * A SPICE number: sign, digits, optional exponent, optional scale suffix, and
 * then whatever unit the author felt like writing.
 *
 * `4pF` is four picofarads and `4F` is four femtofarads, which looks like a trap
 * and is not one: the suffix is taken once and everything after it is a comment
 * to the reader. Same rule both times.
 */
export function parseSpiceNumber(text: string): number | null {
	const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(.*)$/.exec(text.trim());
	if (!match) return null;
	const value = Number(match[1]);
	if (!Number.isFinite(value)) return null;

	const rest = match[2].toUpperCase();
	for (const [suffix, scale] of SCALES) {
		if (rest.startsWith(suffix)) return value * scale;
	}
	return value;
}

/**
 * Every `.model` card in a blob of text.
 *
 * Takes a whole paste rather than one line, because what comes off a datasheet
 * or a vendor's library is a whole file: comment banners, continuation lines,
 * and often several parts. Anything that is not a `.model` card is skipped
 * rather than refused — a subcircuit further down the file is not an error, it
 * is simply not what this reads.
 */
/**
 * A SPICE file reduced to one logical line per statement.
 *
 * Comments go first, so a `.model` inside one is not found and a trailing `;`
 * note cannot be mistaken for a parameter. Then continuations: a leading `+`
 * means "this line is more of the last one", which is how anything long enough
 * to matter is always written.
 */
function joinContinuations(text: string): string[] {
	const lines = text.split(/\r?\n/).map((line) => {
		const trimmed = line.trimEnd();
		if (/^\s*\*/.test(trimmed)) return '';
		const semicolon = trimmed.indexOf(';');
		return semicolon >= 0 ? trimmed.slice(0, semicolon) : trimmed;
	});

	const joined: string[] = [];
	for (const line of lines) {
		const continuation = /^\s*\+(.*)$/.exec(line);
		if (continuation && joined.length > 0) {
			joined[joined.length - 1] += ' ' + continuation[1];
		} else {
			joined.push(line);
		}
	}
	return joined;
}

export function parseModelCards(text: string): ModelCard[] {
	const cards: ModelCard[] = [];
	for (const line of joinContinuations(text)) {
		// `.model NAME TYPE(...)`, with the parentheses optional and the space
		// before them likewise — both spellings are in the wild.
		const head = /^\s*\.model\s+(\S+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/i.exec(line);
		if (!head) continue;

		const body = head[3].replace(/^\(/, '').replace(/\)\s*$/, '');
		const params = new Map<string, number>();
		// `=` may or may not have spaces around it, and pairs may be separated by
		// spaces or commas.
		for (const pair of body.split(/[\s,]+/).join(' ').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S+)/g)) {
			const value = parseSpiceNumber(pair[2]);
			if (value !== null) params.set(pair[1].toUpperCase(), value);
		}

		cards.push({ name: head[1], type: head[2].toUpperCase(), params });
	}
	return cards;
}

// ---------------------------------------------------------------------------
// Turning a card into a model this engine can run
// ---------------------------------------------------------------------------

/** What a card became, and what had to be left out of it. */
export interface Applied {
	/** Fields to merge over the device's defaults. */
	model: Record<string, number>;
	/** SPICE parameters this simulator has no equivalent for, as written. */
	ignored: string[];
}

/**
 * Parameters that are real, understood, and deliberately not applied.
 *
 * Kept apart from the ignored list so a report says something useful. A card's
 * `FC` is the same 0.5 this engine already uses and its `TNOM` is the same 27 °C;
 * listing them as dropped would bury the ones that change the answer under noise
 * that does not.
 */
const HARMLESS = new Set(['FC', 'TNOM', 'T_ABS', 'T_MEASURED', 'XTI', 'XTB', 'EG', 'KF', 'AF']);

function take(
	params: Map<string, number>,
	mapping: Record<string, string>,
	extra?: (out: Record<string, number>, params: Map<string, number>) => Set<string>
): Applied {
	const model: Record<string, number> = {};
	const used = new Set<string>();
	for (const [spice, ours] of Object.entries(mapping)) {
		const value = params.get(spice);
		if (value === undefined) continue;
		model[ours] = value;
		used.add(spice);
	}
	if (extra) for (const key of extra(model, params)) used.add(key);

	const ignored = [...params.keys()].filter((k) => !used.has(k) && !HARMLESS.has(k));
	return { model, ignored };
}

const DIODE: Record<string, string> = {
	IS: 'is',
	N: 'n',
	// The bulk resistance. Modelled — it is what bends a rectifier's forward curve
	// away from the exponential at an amp — so a card that names it has to be read
	// rather than reported as something this simulator has no equivalent for.
	RS: 'rs',
	CJO: 'cj0',
	CJ0: 'cj0',
	VJ: 'vj',
	M: 'm',
	TT: 'tt'
};

const BJT: Record<string, string> = {
	IS: 'is',
	BF: 'bf',
	BR: 'br',
	VAF: 'vaf',
	VA: 'vaf',
	CJE: 'cje',
	VJE: 'vje',
	MJE: 'mje',
	CJC: 'cjc',
	VJC: 'vjc',
	MJC: 'mjc',
	TF: 'tf',
	TR: 'tr'
};

const MOSFET: Record<string, string> = {
	VTO: 'vto',
	VT0: 'vto',
	KP: 'kp',
	LAMBDA: 'lambda',
	W: 'w',
	L: 'l',
	CGS: 'cgs',
	CGD: 'cgd',
	CDS: 'cds'
};

/**
 * Fold a card into a diode model.
 *
 * `BV` is the one that needs thinking about. SPICE quotes a breakdown voltage
 * together with the current it is measured at, and this engine anchors its
 * breakdown at a fixed one milliamp — so a card that names a different `IBV` is
 * describing a knee at a different place than the one we will draw. Close enough
 * to use, far enough to say so.
 */
export function diodeFromCard(card: ModelCard): Applied {
	return take(card.params, DIODE, (out, params) => {
		const used = new Set<string>();
		const bv = params.get('BV');
		if (bv !== undefined) {
			out.bv = Math.abs(bv);
			used.add('BV');
			// Consumed either way: it is about breakdown, and reporting it as
			// unmodelled would suggest the breakdown itself was dropped.
			if (params.has('IBV')) used.add('IBV');
		}
		return used;
	});
}

export function bjtFromCard(card: ModelCard): Applied {
	return take(card.params, BJT);
}

/**
 * Fold a card into a MOSFET model.
 *
 * The overlap capacitances are given per metre of gate width, so they only mean
 * anything alongside a `W`. Without one there is no way to turn them into
 * farads, and guessing a width to make the multiplication work would be
 * inventing the number rather than reading it.
 */
export function mosfetFromCard(card: ModelCard): Applied {
	const applied = take(card.params, MOSFET, (out, params) => {
		const used = new Set<string>();
		const w = params.get('W');
		if (w === undefined || w <= 0) return used;
		for (const [spice, ours] of [
			['CGSO', 'cgs'],
			['CGDO', 'cgd']
		] as const) {
			const perMetre = params.get(spice);
			if (perMetre === undefined) continue;
			out[ours] = perMetre * w;
			used.add(spice);
		}
		return used;
	});

	// A width and a length mean something together and nothing apart. Taking one
	// and leaving the other at its default put a metre beside a micrometre: the
	// ratio, which is all this model level uses, came out six orders of magnitude
	// away from anything the file said.
	const hasW = applied.model.w !== undefined;
	const hasL = applied.model.l !== undefined;
	if (hasW !== hasL) {
		delete applied.model.w;
		delete applied.model.l;
		applied.ignored.push(hasW ? 'W' : 'L');
	}
	return applied;
}

// ---------------------------------------------------------------------------
// Subcircuits
// ---------------------------------------------------------------------------

/**
 * One element line from inside a `.subckt`, in the terms this engine builds in.
 *
 * Kept as data rather than as a closure that emits the component, so a line can
 * be read, tested and reported on without anything being built from it.
 */
export type SubElement =
	| { kind: 'resistor'; name: string; nodes: string[]; value: number }
	| { kind: 'capacitor'; name: string; nodes: string[]; value: number }
	| { kind: 'inductor'; name: string; nodes: string[]; value: number }
	| { kind: 'vsource'; name: string; nodes: string[]; value: number }
	| { kind: 'isource'; name: string; nodes: string[]; value: number }
	| { kind: 'diode'; name: string; nodes: string[]; model: string }
	| { kind: 'bjt'; name: string; nodes: string[]; model: string }
	| {
			kind: 'mosfet';
			name: string;
			nodes: string[];
			model: string;
			/** The instance's own width and length, which win over the card's. */
			w?: number;
			l?: number;
	  }
	| { kind: 'vcvs'; name: string; nodes: string[]; gain: number }
	| { kind: 'vccs'; name: string; nodes: string[]; gain: number };

export interface Subcircuit {
	name: string;
	/** Terminals, in the order the `.subckt` line gives them. */
	ports: string[];
	elements: SubElement[];
	/** `.model` cards found in the same text, by name. */
	models: Map<string, ModelCard>;
	/** Lines inside the definition that could not be read, as written. */
	unread: string[];
}

/** How many nodes each SPICE designator takes, and what it becomes here. */
const ELEMENTS: Record<string, { nodes: number; kind: SubElement['kind']; value: 'number' | 'model' }> = {
	R: { nodes: 2, kind: 'resistor', value: 'number' },
	C: { nodes: 2, kind: 'capacitor', value: 'number' },
	L: { nodes: 2, kind: 'inductor', value: 'number' },
	V: { nodes: 2, kind: 'vsource', value: 'number' },
	I: { nodes: 2, kind: 'isource', value: 'number' },
	D: { nodes: 2, kind: 'diode', value: 'model' },
	Q: { nodes: 3, kind: 'bjt', value: 'model' },
	M: { nodes: 4, kind: 'mosfet', value: 'model' },
	E: { nodes: 4, kind: 'vcvs', value: 'number' },
	G: { nodes: 4, kind: 'vccs', value: 'number' }
};

/**
 * Read one element line.
 *
 * The shape is `<designator><name> <nodes…> <value or model> <extras…>`, and a
 * line is only taken when every part of it that changes the answer is
 * understood. Anything else — a transient source (`PULSE(…)`, `SIN(…)`), a
 * behavioural expression, a polynomial source, an area or a multiplier this
 * engine would have to ignore — comes back as null, which puts the line on the
 * subcircuit's list of what it could not read, so the part says so. Taking the
 * last token as the value, as this used to, turned `V1 a 0 DC 5 AC 1` into a
 * one-volt source and `PULSE(0 5 …)` into two microvolts, without a word.
 *
 * Extras that do not change a DC or transient answer here — `IC=`, a MOSFET's
 * junction areas, `OFF` — are still dropped.
 */
function readElement(line: string): SubElement | null {
	// Anything bracketed is a waveform, an expression or a polynomial: a
	// different kind of source from the constant one built below.
	if (/[({]/.test(line)) return null;
	if (/\b(pulse|sin|pwl|exp|sffm|am|poly|value|table|laplace|freq)\b/i.test(line)) return null;

	// `W = 1u` and `W=1u` are the same assignment; one token is easier to read.
	const tokens = line.trim().replace(/\s*=\s*/g, '=').split(/\s+/);
	if (tokens.length < 3) return null;
	const spec = ELEMENTS[tokens[0][0].toUpperCase()];
	if (!spec) return null;
	const name = tokens[0];

	const assigned = new Map<string, string>();
	const plain: string[] = [];
	for (const token of tokens.slice(1)) {
		const eq = token.indexOf('=');
		if (eq > 0) assigned.set(token.slice(0, eq).toUpperCase(), token.slice(eq + 1));
		// `OFF` is an initial guess for a DC solve, not a node or a model.
		else if (!/^off$/i.test(token)) plain.push(token);
	}

	// A multiplier is so many copies in parallel. A MOSFET's is folded into its
	// width below; on anything else it would be a different value.
	const multiplier = assigned.has('M') ? parseSpiceNumber(assigned.get('M')!) : 1;
	if (multiplier === null || multiplier <= 0) return null;
	if (multiplier !== 1 && spec.kind !== 'mosfet') return null;
	if (assigned.has('AREA')) return null;

	if (spec.kind === 'vsource' || spec.kind === 'isource') {
		if (plain.length < 2) return null;
		const nodes = plain.slice(0, 2);
		// What follows the nodes is `[DC] <value>` and `AC <mag> [<phase>]`, in
		// either order. The DC value is the constant built here; the AC one drives
		// a sweep of the whole circuit, not a part inside it.
		let value: number | null = null;
		const dc = assigned.get('DC');
		if (dc !== undefined) {
			value = parseSpiceNumber(dc);
			if (value === null) return null;
		}
		const rest = plain.slice(2);
		for (let i = 0; i < rest.length; i++) {
			if (/^ac$/i.test(rest[i])) {
				i++;
				if (i + 1 < rest.length && parseSpiceNumber(rest[i + 1]) !== null) i++;
				continue;
			}
			if (/^dc$/i.test(rest[i])) continue;
			const number = parseSpiceNumber(rest[i]);
			if (number === null || value !== null) return null;
			value = number;
		}
		// No DC value at all is a DC value of zero, as in any SPICE.
		return { kind: spec.kind, name, nodes, value: value ?? 0 };
	}

	if (spec.value === 'model') {
		// A `Q` may or may not name its substrate, so the model is the last plain
		// token and the nodes are what comes before it.
		if (plain.length < spec.nodes + 1) return null;
		const model = plain[plain.length - 1];
		// A number where the model should be is an area after it: `D1 a k DX 2`.
		if (parseSpiceNumber(model) !== null) return null;
		const nodes = plain.slice(0, -1);
		if (nodes.length > spec.nodes + (spec.kind === 'bjt' ? 1 : 0)) return null;
		const used = nodes.slice(0, spec.nodes);
		if (spec.kind !== 'mosfet') return { kind: spec.kind, name, nodes: used, model } as SubElement;
		const size: { w?: number; l?: number } = {};
		for (const [key, field] of [
			['W', 'w'],
			['L', 'l']
		] as const) {
			const text = assigned.get(key);
			if (text === undefined) continue;
			const number = parseSpiceNumber(text);
			if (number === null || number <= 0) return null;
			size[field] = number;
		}
		if (multiplier !== 1) {
			// Copies side by side are one transistor that much wider.
			if (size.w === undefined) return null;
			size.w *= multiplier;
		}
		return { kind: 'mosfet', name, nodes: used, model, ...size };
	}

	// R, C, L, E and G: exactly their nodes, then exactly one value.
	if (plain.length !== spec.nodes + 1) return null;
	const value = parseSpiceNumber(plain[spec.nodes]);
	if (value === null) return null;
	const nodes = plain.slice(0, spec.nodes);
	const key = spec.kind === 'vcvs' || spec.kind === 'vccs' ? 'gain' : 'value';
	return { kind: spec.kind, name, nodes, [key]: value } as SubElement;
}

/**
 * Every `.subckt` in a blob of text, with the `.model` cards that go with them.
 *
 * The cards are collected from the whole text rather than from inside each
 * definition, because that is where they are: a vendor's file declares its
 * transistors once at the top and the subcircuits below refer to them by name.
 */
/**
 * Files parsed lately, and what they came to.
 *
 * A drawing is recompiled whenever it changes, which during a drag is every
 * frame, and every placed instance re-reads the text it came from. Eight copies
 * of a vendor macromodel cost about a millisecond and a half of each frame that
 * way. One entry used to be kept, which is enough for one library and none for
 * two: instances of two imported parts alternate within a compile, and each
 * evicted the other every time. Sixteen covers any drawing a person makes; the
 * oldest is dropped first.
 */
const PARSE_CACHE = 16;

function remembered<T>(cache: Map<string, T>, key: string, compute: () => T): T {
	const hit = cache.get(key);
	if (hit !== undefined) {
		// Re-inserted, so the map's order is the order of use.
		cache.delete(key);
		cache.set(key, hit);
		return hit;
	}
	const value = compute();
	cache.set(key, value);
	if (cache.size > PARSE_CACHE) cache.delete(cache.keys().next().value!);
	return value;
}

const parsedSubcircuits = new Map<string, Subcircuit[]>();
const parsedCards = new Map<string, ModelCard[]>();

export function parseSubcircuits(text: string): Subcircuit[] {
	return remembered(parsedSubcircuits, text, () => parseSubcircuitsUncached(text));
}

function parseSubcircuitsUncached(text: string): Subcircuit[] {
	const models = new Map<string, ModelCard>();
	for (const card of parseModelCards(text)) models.set(card.name.toUpperCase(), card);

	const lines = joinContinuations(text);
	const out: Subcircuit[] = [];
	let current: Subcircuit | null = null;

	for (const line of lines) {
		const start = /^\s*\.subckt\s+(\S+)\s+(.*)$/i.exec(line);
		if (start) {
			// `PARAMS:` and anything after it is a parameterised definition, which is
			// a different feature; the terminals stop there.
			const rest = start[2].split(/\s+params\s*:/i)[0];
			current = {
				name: start[1],
				ports: rest.trim().split(/\s+/).filter(Boolean),
				elements: [],
				models,
				unread: []
			};
			continue;
		}
		if (/^\s*\.ends\b/i.test(line)) {
			if (current) out.push(current);
			current = null;
			continue;
		}
		if (!current) continue;
		// A `.model` inside the definition is already collected; anything else
		// beginning with a dot is a directive this does not act on.
		if (/^\s*\./.test(line)) continue;
		if (!line.trim()) continue;

		const element = readElement(line);
		if (element) current.elements.push(element);
		else current.unread.push(line.trim());
	}
	return out;
}

/**
 * A card with an instance's own `W=` and `L=` written over it.
 *
 * Through the card rather than onto the finished model, because the overlap
 * capacitances are per metre of width and have to be multiplied by the width
 * this transistor actually has.
 */
function sized(card: ModelCard, element: { w?: number; l?: number }): ModelCard {
	if (element.w === undefined && element.l === undefined) return card;
	const params = new Map(card.params);
	if (element.w !== undefined) params.set('W', element.w);
	if (element.l !== undefined) params.set('L', element.l);
	return { ...card, params };
}

/**
 * What one placed subcircuit becomes.
 *
 * Flattened rather than kept as a hierarchy, because the engine solves one
 * matrix: a subcircuit is a way of writing a circuit down, not a thing the
 * solver knows about.
 */
export interface Expansion {
	components: unknown[];
	/** Lines that had to be skipped, phrased for the person who pasted them. */
	skipped: string[];
}

/**
 * Expand a subcircuit placed as `instanceName`, with its ports already bound to
 * the nets they touch in the parent drawing.
 *
 * Internal nodes are prefixed with the instance name, so two of the same part
 * are two circuits and not one. `0` is not renamed: inside a subcircuit it means
 * the global ground, and namespacing it would leave every part floating in a
 * ground of its own.
 */
export function expandSubcircuit(
	sub: Subcircuit,
	instanceName: string,
	portNets: readonly string[]
): Expansion {
	const bound = new Map<string, string>();
	sub.ports.forEach((port, i) => bound.set(port, portNets[i] ?? 'gnd'));

	const node = (name: string) => {
		if (name === '0' || name.toLowerCase() === 'gnd') return 'gnd';
		return bound.get(name) ?? `${instanceName}.${name}`;
	};
	const named = (element: SubElement) => `${instanceName}.${element.name}`;

	const components: unknown[] = [];
	const skipped = sub.unread.map((line) => line.split(/\s+/)[0]);

	for (const element of sub.elements) {
		const n = element.nodes.map(node);
		switch (element.kind) {
			case 'resistor':
				components.push({ type: 'resistor', name: named(element), a: n[0], b: n[1], resistance: element.value });
				break;
			case 'capacitor':
				components.push({ type: 'capacitor', name: named(element), a: n[0], b: n[1], capacitance: element.value });
				break;
			case 'inductor':
				components.push({ type: 'inductor', name: named(element), a: n[0], b: n[1], inductance: element.value });
				break;
			case 'vsource':
			case 'isource':
				components.push({
					type: element.kind === 'vsource' ? 'voltage_source' : 'current_source',
					name: named(element),
					plus: n[0],
					minus: n[1],
					waveform: { type: 'dc', value: element.value },
					ac_magnitude: 0,
					ac_phase: 0
				});
				break;
			case 'diode':
			case 'bjt':
			case 'mosfet': {
				// A device line names a model rather than carrying one, so the card it
				// points at has to be in the same paste. Without it the part would fall
				// back to a generic one of its type, which is a different circuit
				// wearing the right name.
				const card = sub.models.get(element.model.toUpperCase());
				if (!card) {
					skipped.push(`${element.name} (no .model ${element.model})`);
					break;
				}
				if (element.kind === 'diode') {
					components.push({
						type: 'diode',
						name: named(element),
						anode: n[0],
						cathode: n[1],
						model: { is: 2.52e-9, n: 1.752, bv: null, temp: 300.15, ...diodeFromCard(card).model }
					});
				} else if (element.kind === 'bjt') {
					components.push({
						type: 'bjt',
						name: named(element),
						collector: n[0],
						base: n[1],
						emitter: n[2],
						model: {
							polarity: card.type === 'PNP' ? 'pnp' : 'npn',
							is: 6.73e-15,
							bf: 200,
							br: 4,
							temp: 300.15,
							...bjtFromCard(card).model
						}
					});
				} else {
					// The engine's MOSFET ties its bulk to its source, which is how a
					// three-terminal part is drawn and is not what a `.subckt`
					// necessarily says. Where the file puts it somewhere else the
					// device really is a different one, so it is reported rather than
					// quietly built as though the fourth node were not there.
					if (n[3] !== undefined && n[3] !== n[2]) {
						skipped.push(`${element.name} (a bulk that is not its source)`);
					}
					components.push({
						type: 'mosfet',
						name: named(element),
						drain: n[0],
						gate: n[1],
						source: n[2],
						model: {
							channel: card.type === 'PMOS' ? 'p' : 'n',
							vto: 2,
							kp: 2e-5,
							lambda: 0.02,
							w: 10,
							l: 1,
							...mosfetFromCard(sized(card, element)).model
						}
					});
				}
				break;
			}
			case 'vcvs':
			case 'vccs':
				components.push({
					type: element.kind,
					name: named(element),
					plus: n[0],
					minus: n[1],
					control_plus: n[2],
					control_minus: n[3],
					...(element.kind === 'vcvs'
						? { gain: element.gain }
						: { transconductance: element.gain })
				});
				break;
		}
	}

	return { components, skipped };
}

/** Which of this editor's parts a card describes, or null if none of them. */
export function kindForCard(card: ModelCard): string | null {
	switch (card.type) {
		case 'D':
			return 'diode';
		case 'NPN':
			return 'npn';
		case 'PNP':
			return 'pnp';
		case 'NMOS':
			return 'nmos';
		case 'PMOS':
			return 'pmos';
		default:
			return null;
	}
}

/**
 * The card an instance should use, given the text stored on it.
 *
 * Picks the first card whose type suits the part rather than simply the first
 * card, so pasting a whole vendor library onto an NPN finds the NPN in it.
 */
export function cardFor(text: string, kind: string): ModelCard | null {
	if (!text.trim()) return null;
	// A pasted card can be a whole vendor library, and this runs per instance
	// per compile.
	const cards = remembered(parsedCards, text, () => parseModelCards(text));
	// An LED is a diode with different numbers in it, so a diode card suits one.
	const wanted = kind === 'led' ? 'diode' : kind;
	return cards.find((c) => kindForCard(c) === wanted) ?? null;
}

/**
 * Which reported current arrives at each terminal of an element, and whether it
 * drains that node or feeds it.
 *
 * The engine reports current flowing *into* an element at its first terminal, so
 * that terminal drains the net it sits on and the return one feeds it. A device
 * with more than two terminals reports each of them separately, under a suffixed
 * name, and every one of those is into the device.
 *
 * `null` where nothing is reported: a voltage-controlled source's control pins
 * carry no current, and a `G` element has no branch to read at all.
 */
const TERMINAL_FLOW: Record<SubElement['kind'], Array<{ sign: number; series?: string } | null>> = {
	resistor: [{ sign: -1 }, { sign: 1 }],
	capacitor: [{ sign: -1 }, { sign: 1 }],
	inductor: [{ sign: -1 }, { sign: 1 }],
	vsource: [{ sign: -1 }, { sign: 1 }],
	isource: [{ sign: -1 }, { sign: 1 }],
	diode: [{ sign: -1 }, { sign: 1 }],
	bjt: [{ sign: -1 }, { sign: -1, series: ':b' }, { sign: -1, series: ':e' }],
	mosfet: [{ sign: -1 }, { sign: -1, series: ':g' }, { sign: -1, series: ':s' }, null],
	vcvs: [{ sign: -1 }, { sign: 1 }, null, null],
	vccs: [null, null, null, null]
};

/** One reported series arriving at a subcircuit's terminal. */
export interface PortInjection {
	/** Port name, which is also the pin name on the placed part. */
	port: string;
	/** Name the engine reports this current under, e.g. `X1.Q1:b`. */
	element: string;
	sign: number;
}

/**
 * Where the current at each terminal of a placed subcircuit comes from.
 *
 * A subcircuit is flattened before the engine sees it, so there is no element
 * called `X1` to ask — its current lives spread across `X1.R1`, `X1.Q1:b` and the
 * rest. Without this the drawing had nothing to accumulate at those pins, so a
 * net whose only part was an imported one animated as carrying nothing at all.
 */
export function portInjections(sub: Subcircuit, instanceName: string): PortInjection[] {
	const ports = new Set(sub.ports);
	const out: PortInjection[] = [];
	for (const element of sub.elements) {
		const flow = TERMINAL_FLOW[element.kind];
		element.nodes.forEach((node, index) => {
			const terminal = flow[index];
			if (!terminal || !ports.has(node)) return;
			out.push({
				port: node,
				element: `${instanceName}.${element.name}${terminal.series ?? ''}`,
				sign: terminal.sign
			});
		});
	}
	return out;
}
