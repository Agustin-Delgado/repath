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
export function parseModelCards(text: string): ModelCard[] {
	// Comments first, so a `.model` inside one is not found, and so a trailing
	// `;` note cannot be mistaken for a parameter.
	const lines = text.split(/\r?\n/).map((line) => {
		const trimmed = line.trimEnd();
		if (/^\s*\*/.test(trimmed)) return '';
		const semicolon = trimmed.indexOf(';');
		return semicolon >= 0 ? trimmed.slice(0, semicolon) : trimmed;
	});

	// Continuations. A leading `+` means "this line is more of the last one",
	// which is how a card long enough to matter is always written.
	const joined: string[] = [];
	for (const line of lines) {
		const continuation = /^\s*\+(.*)$/.exec(line);
		if (continuation && joined.length > 0) {
			joined[joined.length - 1] += ' ' + continuation[1];
		} else {
			joined.push(line);
		}
	}

	const cards: ModelCard[] = [];
	for (const line of joined) {
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
	return take(card.params, MOSFET, (out, params) => {
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
	const cards = parseModelCards(text);
	const wanted = kind === 'led' || kind === 'zener' ? 'diode' : kind;
	return cards.find((c) => kindForCard(c) === wanted) ?? null;
}
