/**
 * Putting a circuit in a URL.
 *
 * The point of a free simulator is that someone can answer a forum question with
 * a link and the person reading it sees the working circuit, not a screenshot.
 * That only holds if the link is self-contained — no server, no database, no
 * account — so the whole schematic is compressed into the fragment.
 *
 * The fragment is used rather than the query string because it is never sent to
 * the host, which keeps the promise that circuits stay on your machine.
 */

import {
	BLOCK_PREFIX,
	SUBCIRCUIT_PREFIX,
	isKnownKind,
	migrateInstance,
	registerSubcircuits,
	type BlockDef,
	type Instance,
	type Schematic,
	type Wire
} from './schematic/model';
import { registerBlocks } from './schematic/blocks';
import { probePin } from './schematic/nets';

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
	analysis?: 'transient' | 'frequency';
	acStart?: number;
	acStop?: number;
}

export interface SharedCircuit {
	schematic: Schematic;
	stopTime: number;
	probes?: string[];
	settings?: CircuitSettings;
}

/** Bumped if the payload shape ever changes incompatibly. */
const VERSION = 1;

/**
 * A probe as it travels: a pin, as the position of its part and the pin's name,
 * or a grid point written out as it stands.
 *
 * Added without bumping the version, because it can be: a link written before
 * this simply has no probes in it, and a build from before this ignores the field.
 */
type TravellingProbe = string | [number, string];

const PREFIX = 'c';

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
	const padded = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
	if (typeof CompressionStream === 'undefined') return null;
	const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
	if (typeof DecompressionStream === 'undefined') return null;
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Strip what does not need to travel.
 *
 * Ids are regenerated on load anyway, and dropping them takes roughly a third
 * off the payload — which matters, because a URL that wraps across three lines
 * of a chat message does not get clicked.
 */
type TravellingInstance = [string, string, number, number, number, Record<string, number | string>];

const packInstance = (n: Instance): TravellingInstance => [n.kind, n.name, n.x, n.y, n.rotation, n.params];
const packWire = (w: Wire): number[] => w.points.flatMap((p) => [p.x, p.y]);

function unpackWires(flat: number[][] | undefined, id: () => string): Wire[] {
	return (flat ?? [])
		.map((coords) => {
			const points: Array<{ x: number; y: number }> = [];
			for (let i = 0; i + 1 < coords.length; i += 2) points.push({ x: coords[i], y: coords[i + 1] });
			return { id: id(), points };
		})
		.filter((wire) => wire.points.length >= 2);
}

/**
 * A block as it travels: its insides packed the way the drawing is. Its
 * terminals are port parts among the instances, so nothing else needs to.
 */
type TravellingBlock = [string, string, TravellingInstance[], number[][]];

function packBlock(block: BlockDef): TravellingBlock {
	return [block.id, block.name, block.instances.map(packInstance), block.wires.map(packWire)];
}

function unpackBlock(packed: TravellingBlock, id: () => string): BlockDef {
	const [bid, name, instances, wires] = packed;
	return {
		id: bid,
		name,
		instances: instances.map((packedInstance) => unpackInstance(packedInstance, id())),
		wires: unpackWires(wires, id)
	};
}

function unpackInstance([kind, name, x, y, rotation, params]: TravellingInstance, id: string): Instance {
	// A link outlives the catalog it was written against, so what comes out of
	// one is brought up to date before anything else touches it.
	return migrateInstance({
		id,
		kind,
		name,
		x,
		y,
		rotation: rotation as 0 | 90 | 180 | 270,
		params: params ?? {}
	});
}

function compact(circuit: SharedCircuit): unknown {
	// Probes name a pin by *which* instance rather than by its id, because ids are
	// exactly what does not travel: they are dropped here and minted again on the
	// far side. An index survives that by construction, and is shorter besides.
	const at = new Map(circuit.schematic.instances.map((n, index) => [n.id, index] as const));
	return {
		v: VERSION,
		t: circuit.stopTime,
		i: circuit.schematic.instances.map(packInstance),
		// Corners flattened to a number list: a wire is mostly coordinates, and
		// every character saved here is a character of URL someone has to paste.
		w: circuit.schematic.wires.map(packWire),
		// Imported definitions travel with the drawing. A link that carried a part
		// but not what it is made of would open as a hole in someone's circuit.
		x: circuit.schematic.subcircuits?.map((s) => [s.id, s.name, s.ports, s.source]),
		b: circuit.schematic.blocks?.map(packBlock),
		// Groups, by the index of each member for the same reason probes are.
		g: circuit.schematic.groups?.map((group) => [
			group.name,
			group.members.map((m) => at.get(m)).filter((i) => i !== undefined)
		]),
		// What the sender was watching. A link is usually sent *because* of a
		// signal, and one that arrived with the scope empty made the person
		// receiving it go and find it again.
		p: (circuit.probes ?? []).flatMap((handle): TravellingProbe[] => {
			if (!handle.startsWith('pin:')) return [handle];
			const rest = handle.slice('pin:'.length);
			const cut = rest.indexOf(':');
			const index = cut < 0 ? undefined : at.get(rest.slice(0, cut));
			return index === undefined ? [] : [[index, rest.slice(cut + 1)]];
		}),
		// The settings, added the way probes were: absent in an older link, and
		// ignored by an older build.
		s: circuit.settings
	};
}

/** Why a link is refused, in terms of the link rather than of the code. */
class Damaged extends Error {
	constructor(what: string) {
		super(`That link is damaged (${what}), so nothing in it was opened.`);
	}
}

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

function checkInstance(packed: unknown, where: string): void {
	if (!Array.isArray(packed) || packed.length < 5) throw new Damaged(`a part in ${where}`);
	const [kind, name, x, y, rotation, params] = packed;
	if (typeof kind !== 'string' || typeof name !== 'string') throw new Damaged(`a part in ${where}`);
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) throw new Damaged(`where ${name} is`);
	if (![0, 90, 180, 270].includes(rotation)) throw new Damaged(`how ${name} is turned`);
	if (params !== undefined && params !== null) {
		if (typeof params !== 'object' || Array.isArray(params)) throw new Damaged(`${name}'s values`);
		for (const value of Object.values(params)) {
			if (typeof value !== 'string' && !isFiniteNumber(value)) throw new Damaged(`${name}'s values`);
		}
	}
}

function checkWires(wires: unknown, where: string): void {
	if (wires === undefined) return;
	if (!Array.isArray(wires)) throw new Damaged(`the wires in ${where}`);
	for (const wire of wires) {
		if (!Array.isArray(wire) || !wire.every(isFiniteNumber)) throw new Damaged(`a wire in ${where}`);
	}
}

/**
 * Check a decoded link from end to end before any of it is used.
 *
 * A link is text anyone can edit, or one from a newer build, and a part the
 * catalog does not know used to reach the editor: the drawing then threw on
 * every read, and nothing short of a reload got the editor back. So the shape
 * of everything is checked here, and every part is asked of the catalog once
 * the definitions the link carries have been registered.
 */
function check(data: Record<string, unknown>): void {
	for (const key of ['i', 'w', 'x', 'b', 'p', 'g'] as const) {
		if (data[key] !== undefined && !Array.isArray(data[key])) throw new Damaged(`its ${key} list`);
	}
	if (data.t !== undefined && !(isFiniteNumber(data.t) && data.t > 0)) throw new Damaged('the run length');
	for (const sub of (data.x as unknown[]) ?? []) {
		if (
			!Array.isArray(sub) ||
			typeof sub[0] !== 'string' ||
			typeof sub[1] !== 'string' ||
			!Array.isArray(sub[2]) ||
			!sub[2].every((p: unknown) => typeof p === 'string') ||
			typeof sub[3] !== 'string'
		) {
			throw new Damaged('an imported part');
		}
	}
	for (const block of (data.b as unknown[]) ?? []) {
		if (!Array.isArray(block) || typeof block[0] !== 'string' || typeof block[1] !== 'string') {
			throw new Damaged('a block');
		}
		if (!Array.isArray(block[2])) throw new Damaged(`block ${block[1]}`);
		for (const packed of block[2]) checkInstance(packed, `block ${block[1]}`);
		checkWires(block[3], `block ${block[1]}`);
	}
	for (const packed of (data.i as unknown[]) ?? []) checkInstance(packed, 'the drawing');
	checkWires(data.w, 'the drawing');
	for (const probe of (data.p as unknown[]) ?? []) {
		const ok =
			typeof probe === 'string' ||
			(Array.isArray(probe) && Number.isInteger(probe[0]) && typeof probe[1] === 'string');
		if (!ok) throw new Damaged('what was being watched');
	}
	for (const group of (data.g as unknown[]) ?? []) {
		if (
			!Array.isArray(group) ||
			typeof group[0] !== 'string' ||
			!Array.isArray(group[1]) ||
			!group[1].every((m: unknown) => Number.isInteger(m))
		) {
			throw new Damaged('a group');
		}
	}
	if (data.s !== undefined && (typeof data.s !== 'object' || data.s === null || Array.isArray(data.s))) {
		throw new Damaged('its settings');
	}
}

/** Settings as they arrived, each kept only if it is the kind of thing it says it is. */
function readSettings(raw: unknown): CircuitSettings {
	const s = (raw ?? {}) as Record<string, unknown>;
	const out: CircuitSettings = {};
	if (isFiniteNumber(s.temperature)) out.temperature = s.temperature;
	if (typeof s.logicFamily === 'string') out.logicFamily = s.logicFamily;
	if (isFiniteNumber(s.sample)) out.sample = s.sample;
	if (isFiniteNumber(s.sweepCount)) out.sweepCount = s.sweepCount;
	if (s.analysis === 'transient' || s.analysis === 'frequency') out.analysis = s.analysis;
	if (isFiniteNumber(s.acStart) && s.acStart > 0) out.acStart = s.acStart;
	if (isFiniteNumber(s.acStop) && s.acStop > 0) out.acStop = s.acStop;
	return out;
}

function expand(raw: unknown): SharedCircuit {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Damaged('not a circuit');
	const data = raw as {
		v?: number;
		t?: number;
		i?: TravellingInstance[];
		w?: number[][];
		x?: Array<[string, string, string[], string]>;
		b?: TravellingBlock[];
		p?: Array<string | [number, string]>;
		g?: Array<[string, number[]]>;
		s?: unknown;
	};
	if (data.v !== VERSION) throw new Error('That link was made by a different version of repath.');
	check(data as Record<string, unknown>);

	// Every part is one the catalog knows or one the link defines, checked before
	// anything is registered: registering first would put the link's definitions
	// over the open drawing's own even for a link that is then refused.
	const defined = new Set([
		...(data.x ?? []).map(([sid]) => SUBCIRCUIT_PREFIX + sid),
		...(data.b ?? []).map(([bid]) => BLOCK_PREFIX + bid)
	]);
	const known = (kind: string) =>
		kind.startsWith(SUBCIRCUIT_PREFIX) || kind.startsWith(BLOCK_PREFIX)
			? defined.has(kind)
			: isKnownKind(migrateInstance({ id: '', kind, name: '', x: 0, y: 0, rotation: 0, params: {} }).kind);
	for (const [kind] of [...(data.i ?? []), ...(data.b ?? []).flatMap((block) => block[2])]) {
		if (!known(kind)) throw new Error(`That link has a part this version of repath does not know (${kind}).`);
	}

	let counter = 0;
	const id = () => `s${++counter}`;

	// Definitions first, and registered before a single instance is read: the very
	// next line asks the catalog what each part is, and a part whose definition
	// arrived later would have thrown before it got there.
	const subcircuits = (data.x ?? []).map(([sid, name, ports, source]) => ({
		id: sid,
		name,
		ports,
		source
	}));
	registerSubcircuits({ instances: [], wires: [], subcircuits });
	const blocks = (data.b ?? []).map((packed) => unpackBlock(packed, id));
	registerBlocks({ instances: [], wires: [], blocks });

	const instances = (data.i ?? []).map((packed) => unpackInstance(packed, id()));

	return {
		stopTime: data.t ?? 1e-3,
		settings: readSettings(data.s),
		// A pin probe travelled as the position of its part, so it is pointed back
		// at whatever id that part has just been given. A probe on bare wire
		// travelled as the grid point it sits on, which did not move.
		probes: (data.p ?? []).flatMap((entry) => {
			if (typeof entry === 'string') return [entry];
			const instance = instances[entry[0]];
			return instance ? [probePin(instance.id, entry[1])] : [];
		}),
		schematic: {
			subcircuits,
			blocks,
			instances,
			wires: unpackWires(data.w, id),
			groups: (data.g ?? [])
				.map(([name, members]) => ({
					id: id(),
					name,
					members: members.map((index) => instances[index]?.id).filter((m) => m !== undefined)
				}))
				.filter((group) => group.members.length > 0)
		}
	};
}

/** Encode a circuit into a URL fragment (without the leading `#`). */
export async function encodeCircuit(circuit: SharedCircuit): Promise<string> {
	const json = JSON.stringify(compact(circuit));
	const bytes = new TextEncoder().encode(json);
	const squashed = await deflate(bytes);
	// `z` for compressed, `u` for uncompressed, so a browser without
	// CompressionStream still produces a link that anyone else can open.
	return squashed ? `${PREFIX}z${toBase64Url(squashed)}` : `${PREFIX}u${toBase64Url(bytes)}`;
}

/** Decode a fragment produced by `encodeCircuit`. Throws on anything malformed. */
export async function decodeCircuit(fragment: string): Promise<SharedCircuit> {
	const text = fragment.startsWith('#') ? fragment.slice(1) : fragment;
	if (!text.startsWith(PREFIX)) throw new Error('That is not a repath link.');

	const mode = text[1];
	const payload = fromBase64Url(text.slice(2));

	let bytes: Uint8Array;
	if (mode === 'z') {
		const expanded = await inflate(payload);
		if (!expanded) throw new Error('This browser cannot decompress that link.');
		bytes = expanded;
	} else if (mode === 'u') {
		bytes = payload;
	} else {
		throw new Error('That link is in a format repath does not recognise.');
	}

	return expand(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Full shareable URL for a circuit, based on the page's current location. */
export async function shareUrl(circuit: SharedCircuit, base: URL): Promise<string> {
	const fragment = await encodeCircuit(circuit);
	return `${base.origin}${base.pathname}#${fragment}`;
}
