/**
 * The one shape a circuit is written down in.
 *
 * A saved `.repath` file, a share link and the draft a reload comes back to are
 * all this document. The link packs it tighter and the draft adds the editor's
 * own state, but what they hold is read by the same code, and what they were
 * written as is upgraded by the same code.
 *
 * Every document says which version of the format it is. Reading one walks it
 * up through `MIGRATIONS`, one step per version, until it is the current one;
 * a change to what a document holds is therefore a new version and a new
 * step, never an edit to how an old one is read. A document from a newer
 * build is refused whole, with a reason, rather than read as far as this
 * build happens to understand it.
 */

import type { Schematic } from './schematic/model';
import type { SpectrumSettings } from './spectrum';
import type { TriggerSettings } from './trigger';

/**
 * How the circuit is run, as opposed to what it is.
 *
 * Travels with it because it changes the answer: the same drawing at 85 °C, in
 * another logic family or on another sample of its tolerances is a different
 * result, and a link that dropped these showed the person receiving it the
 * sender's circuit under their own settings. Every field is optional so a link
 * or file from before they travelled still reads — as the defaults.
 */
export interface CircuitSettings {
	temperature?: number;
	logicFamily?: string;
	sample?: number;
	sweepCount?: number;
	analysis?: Analysis;
	acStart?: number;
	acStop?: number;
	/** The source a DC sweep turns, by name; empty for the first one drawn. */
	dcSource?: string;
	dcStart?: number;
	dcStop?: number;
	dcStep?: number;
	/** Parts whose current a DC sweep plots, by name. */
	dcCurrents?: string[];
	/** The scope's trigger, only what differs from its defaults. */
	trigger?: Partial<TriggerSettings>;
	/** The scope's spectrum, only what differs from its defaults. */
	spectrum?: Partial<SpectrumSettings>;
}

/** What Run does: follow the circuit in time, sweep its frequency response, or sweep a source. */
export type Analysis = 'transient' | 'frequency' | 'dc';

export function isAnalysis(value: unknown): value is Analysis {
	return value === 'transient' || value === 'frequency' || value === 'dc';
}

/** What a document holds about the circuit itself. */
export interface SharedCircuit {
	schematic: Schematic;
	stopTime: number;
	probes?: string[];
	settings?: CircuitSettings;
}

/** One block open for editing: its id, and its insides as they stand. */
export interface EditorLevel {
	block?: string;
	schematic: Schematic;
	probes: string[];
}

/**
 * What only a draft keeps: the state of the editor around the circuit.
 *
 * `levels` are the blocks open for editing, outermost first; the document's
 * own `schematic` is the drawing underneath them all.
 */
export interface EditorState {
	exampleId: string;
	channels: Record<string, { gain: number; offset: number }>;
	levels: EditorLevel[];
}

export const FORMAT = 'repath';

/** The version this build writes, and the newest it reads. */
export const FORMAT_VERSION = 2;

export interface RepathDocument {
	format: typeof FORMAT;
	version: typeof FORMAT_VERSION;
	schematic: Schematic;
	stopTime: number;
	probes: string[];
	settings: CircuitSettings;
	editor?: EditorState;
}

/** A document from a build newer than this one. */
export class NewerFormatError extends Error {
	constructor(
		readonly found: number,
		what: string
	) {
		super(
			`That ${what} was made by a newer version of repath (format ${found}). This version can read up to format ${FORMAT_VERSION}. Reload the page and open it again.`
		);
	}
}

type Raw = Record<string, unknown>;
type Migration = (doc: Raw) => Raw;

const isObject = (value: unknown): value is Raw =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * v0 is anything written before documents said what they were: a bare
 * schematic, or a schematic with its run length beside it.
 */
function migrate_v0_to_v1(doc: Raw): Raw {
	if (Array.isArray(doc.instances)) return { version: 1, schematic: doc };
	return { ...doc, version: 1 };
}

/**
 * v1 came in two shapes: the file (`schematic` with `stopTime`, `probes` and
 * `settings` beside it) and the draft (the settings flat, and every open level,
 * the drawing included, in `levels`). v2 is the file's shape with a `format`
 * marker, and a draft is that plus `editor`.
 */
function migrate_v1_to_v2(doc: Raw): Raw {
	if (!Array.isArray(doc.levels)) {
		return {
			format: FORMAT,
			version: 2,
			schematic: doc.schematic,
			stopTime: doc.stopTime,
			probes: doc.probes ?? [],
			settings: doc.settings ?? {}
		};
	}
	const [root, ...open] = doc.levels as Raw[];
	return {
		format: FORMAT,
		version: 2,
		schematic: root?.schematic,
		stopTime: doc.stopTime,
		probes: root?.probes ?? [],
		settings: {
			temperature: doc.temperature,
			logicFamily: doc.logicFamily,
			sample: doc.sample,
			sweepCount: doc.sweepCount,
			analysis: doc.analysis,
			acStart: doc.acStart,
			acStop: doc.acStop
		},
		editor: {
			exampleId: doc.exampleId ?? '',
			channels: doc.channels ?? {},
			levels: open
		}
	};
}

/** `MIGRATIONS[n]` turns a version-n document into a version n+1 one. */
export const MIGRATIONS: readonly Migration[] = [migrate_v0_to_v1, migrate_v1_to_v2];

/** Which version a document says it is; one that says nothing is v0. */
export function versionOf(raw: Raw): number {
	return typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version >= 0
		? raw.version
		: 0;
}

/**
 * Bring a document of any version this build knows up to the current one.
 *
 * Only the envelope is checked here: that it is a document, of a version that
 * can be read, with a drawing in it. What the drawing holds is checked where it
 * is opened, which has to know the catalog anyway. `what` names the document in
 * the error, the way the person handed it over: a file, a link, a draft.
 */
export function migrate(raw: unknown, what = 'file'): RepathDocument {
	if (!isObject(raw)) throw new Error(`That ${what} is not a repath circuit.`);
	if (raw.format !== undefined && raw.format !== FORMAT) {
		throw new Error(`That ${what} is not a repath circuit.`);
	}
	const found = versionOf(raw);
	if (found > FORMAT_VERSION) throw new NewerFormatError(found, what);
	let doc = raw;
	for (let v = found; v < FORMAT_VERSION; v++) doc = MIGRATIONS[v](doc);
	const schematic = doc.schematic as Schematic | undefined;
	if (!isObject(schematic) || !Array.isArray(schematic.instances)) {
		throw new Error(`That ${what} is not a repath circuit.`);
	}
	const stopTime = doc.stopTime;
	return {
		format: FORMAT,
		version: FORMAT_VERSION,
		schematic: { ...schematic, wires: Array.isArray(schematic.wires) ? schematic.wires : [] },
		stopTime: typeof stopTime === 'number' && Number.isFinite(stopTime) && stopTime > 0 ? stopTime : 1e-3,
		probes: Array.isArray(doc.probes) ? doc.probes.filter((p): p is string => typeof p === 'string') : [],
		settings: isObject(doc.settings) ? (doc.settings as CircuitSettings) : {},
		...(isObject(doc.editor) ? { editor: readEditor(doc.editor) } : {})
	};
}

function readEditor(raw: Raw): EditorState {
	return {
		exampleId: typeof raw.exampleId === 'string' ? raw.exampleId : '',
		channels: isObject(raw.channels) ? (raw.channels as EditorState['channels']) : {},
		levels: Array.isArray(raw.levels) ? (raw.levels as EditorLevel[]) : []
	};
}

/** A circuit as a current document. */
export function toDocument(circuit: SharedCircuit, editor?: EditorState): RepathDocument {
	return {
		format: FORMAT,
		version: FORMAT_VERSION,
		schematic: circuit.schematic,
		stopTime: circuit.stopTime,
		probes: circuit.probes ?? [],
		settings: circuit.settings ?? {},
		...(editor ? { editor } : {})
	};
}

/** A document as the text of a `.repath` file. */
export function serializeDocument(doc: RepathDocument): string {
	// Indented, because a file is something people diff, attach to an issue and
	// now and then fix by hand; a link is where the bytes are counted.
	return JSON.stringify(doc, null, 2);
}

/** The text of a `.repath` file, of any version, as a current document. */
export function parseDocument(text: string, what = 'file'): RepathDocument {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new Error(`That ${what} is not a repath circuit.`);
	}
	return migrate(raw, what);
}
