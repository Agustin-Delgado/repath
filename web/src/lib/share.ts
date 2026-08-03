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

import { migrateInstance, type Schematic } from './schematic/model';

export interface SharedCircuit {
	schematic: Schematic;
	stopTime: number;
	probes?: string[];
}

/** Bumped if the payload shape ever changes incompatibly. */
const VERSION = 1;

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
function compact(circuit: SharedCircuit): unknown {
	return {
		v: VERSION,
		t: circuit.stopTime,
		i: circuit.schematic.instances.map((n) => [n.kind, n.name, n.x, n.y, n.rotation, n.params]),
		// Corners flattened to a number list: a wire is mostly coordinates, and
		// every character saved here is a character of URL someone has to paste.
		w: circuit.schematic.wires.map((w) => w.points.flatMap((p) => [p.x, p.y]))
	};
}

function expand(raw: unknown): SharedCircuit {
	const data = raw as {
		v?: number;
		t?: number;
		i?: Array<[string, string, number, number, number, Record<string, number | string>]>;
		w?: number[][];
	};
	if (data.v !== VERSION) throw new Error('That link was made by a different version of repath.');

	let counter = 0;
	const id = () => `s${++counter}`;

	return {
		stopTime: data.t ?? 1e-3,
		schematic: {
			instances: (data.i ?? []).map(([kind, name, x, y, rotation, params]) =>
				// A link outlives the catalog it was written against, so what comes out
				// of one is brought up to date before anything else touches it.
				migrateInstance({
					id: id(),
					kind,
					name,
					x,
					y,
					rotation: rotation as 0 | 90 | 180 | 270,
					params: params ?? {}
				})
			),
			wires: (data.w ?? [])
				.map((flat) => {
					const points: Array<{ x: number; y: number }> = [];
					for (let i = 0; i + 1 < flat.length; i += 2) {
						points.push({ x: flat[i], y: flat[i + 1] });
					}
					return { id: id(), points };
				})
				.filter((wire) => wire.points.length >= 2)
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
