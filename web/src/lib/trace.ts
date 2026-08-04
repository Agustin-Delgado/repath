/**
 * A written record of what someone did to the editor.
 *
 * Reproducing a reported problem is the hard part of fixing one. A screenshot
 * shows the wreckage, a share link shows the circuit afterwards, and neither
 * shows the *route* someone took to get there — which for anything to do with
 * dragging is most of the story. Several bugs in this editor took far longer to
 * find than they should have, purely because the path in was being guessed at.
 *
 * So the editor keeps a log of the operations it performs, and it can be handed
 * over as text and replayed exactly.
 *
 * # Why text, and why this text
 *
 * One step per line, words separated by spaces:
 *
 * ```
 * example rc-lowpass
 * place led 300 230 90
 * move C1 60 0
 * param R1 resistance 330
 * run
 * ```
 *
 * It is deliberately not compressed into an opaque blob like a share link. A
 * trace is read by a person as often as it is replayed by the machine — pasted
 * into a bug report, skimmed to see what happened, edited down to the three
 * lines that still reproduce the problem. Every one of those is easy here and
 * impossible with base64.
 *
 * # Why operations rather than pointer events
 *
 * Raw input would be enormous, and it would replay differently on a different
 * window size or a different frame rate. What matters is what the gesture *did*:
 * a drag that ends where it ends produces the same result whatever path the
 * cursor took to get there, because a move is recomputed from its starting
 * snapshot on every frame rather than accumulated.
 *
 * # Naming things across a replay
 *
 * Ids are minted fresh on every run, so a trace cannot refer to them. Components
 * are named instead — names are unique and visible on screen. Wires have no
 * names, so they are referred to by where their ends were at the time. If a
 * replay cannot find what a step refers to, it says which step and stops, and
 * that divergence is itself worth knowing: it means the run has already departed
 * from the recording before the step everyone was looking at.
 */

import type { Point, Rotation } from './schematic/model';

/** A wire, as a trace refers to it: the two ends it had at the time. */
export type WireRef = string;

export const wireRef = (points: ReadonlyArray<Point>): WireRef =>
	`${points[0].x},${points[0].y}-${points[points.length - 1].x},${points[points.length - 1].y}`;

export type Step =
	| { op: 'example'; id: string }
	| { op: 'clear' }
	| { op: 'place'; kind: string; x: number; y: number; rotation: Rotation }
	| { op: 'wire'; points: Point[] }
	| { op: 'move'; parts: string[]; wires: WireRef[]; dx: number; dy: number }
	| { op: 'segment'; wire: WireRef; index: number; dx: number; dy: number }
	| { op: 'delete'; parts: string[]; wires: WireRef[] }
	| { op: 'rotate'; parts: string[]; wires: WireRef[] }
	| { op: 'param'; part: string; key: string; value: number | string }
	| { op: 'import'; source: string }
	| { op: 'rename'; part: string; to: string }
	| { op: 'undo' }
	| { op: 'redo' }
	| { op: 'stop'; seconds: number }
	| { op: 'temperature'; celsius: number }
	| { op: 'analysis'; mode: string }
	| { op: 'run' };

/**
 * How many steps are kept.
 *
 * Long enough to hold a session's worth of fiddling, short enough that the text
 * can be pasted into a message. The oldest go first — a problem is nearly always
 * reported right after it appears, so the recent end is the useful end.
 */
const LIMIT = 400;

export class Trace {
	steps: Step[] = [];
	/** Cleared and restarted whenever the whole drawing is replaced. */
	private dropped = 0;

	record(step: Step): void {
		// Replacing the drawing makes everything before it irrelevant, and keeping
		// it would mean replaying a circuit that is about to be thrown away.
		if (step.op === 'example' || step.op === 'clear') {
			this.steps = [];
			this.dropped = 0;
		}
		this.steps.push(step);
		if (this.steps.length > LIMIT) {
			this.steps.shift();
			this.dropped++;
		}
	}

	get truncated(): number {
		return this.dropped;
	}

	toText(): string {
		const lines = this.steps.map(format);
		if (this.dropped > 0) {
			lines.unshift(`# ${this.dropped} earlier steps dropped; this is the tail`);
		}
		return lines.join('\n');
	}
}

const list = (names: readonly string[]) => (names.length ? names.join(',') : '-');

/**
 * A value onto one line.
 *
 * The format is one step per line, which held while every value was a number.
 * A pasted `.model` card is not: it arrives with continuation lines, and written
 * out as it stands each of those becomes a line the reader takes for a step of
 * its own — so the trace stops replaying at the point where someone chose a
 * part, which is rarely the uninteresting half of what they did.
 */
const flatten = (value: number | string): string =>
	typeof value === 'number'
		? String(value)
		: value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n');

const unflatten = (text: string): string =>
	text.replace(/\\(.)/g, (_, character) => (character === 'n' ? '\n' : character));

function format(step: Step): string {
	switch (step.op) {
		case 'example':
			return `example ${step.id}`;
		case 'clear':
			return 'clear';
		case 'place':
			return `place ${step.kind} ${step.x} ${step.y} ${step.rotation}`;
		case 'wire':
			return `wire ${step.points.map((p) => `${p.x},${p.y}`).join(' ')}`;
		case 'move':
			return `move ${list(step.parts)} ${list(step.wires)} ${step.dx} ${step.dy}`;
		case 'segment':
			return `segment ${step.wire} ${step.index} ${step.dx} ${step.dy}`;
		case 'delete':
			return `delete ${list(step.parts)} ${list(step.wires)}`;
		case 'rotate':
			return `rotate ${list(step.parts)} ${list(step.wires)}`;
		case 'param':
			return `param ${step.part} ${step.key} ${flatten(step.value)}`;
		case 'import':
			return `import ${flatten(step.source)}`;
		case 'rename':
			return `rename ${step.part} ${step.to}`;
		case 'undo':
			return 'undo';
		case 'redo':
			return 'redo';
		case 'stop':
			return `stop ${step.seconds}`;
		case 'temperature':
			return `temperature ${step.celsius}`;
		case 'analysis':
			return `analysis ${step.mode}`;
		case 'run':
			return 'run';
	}
}

const names = (token: string) => (token === '-' ? [] : token.split(','));
const number = (token: string) => {
	const value = Number(token);
	if (!Number.isFinite(value)) throw new Error(`expected a number, got "${token}"`);
	return value;
};

/** Read a trace back. Throws on a line it cannot make sense of, naming the line. */
export function parseTrace(text: string): Step[] {
	const steps: Step[] = [];
	const lines = text.split('\n');

	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const [op, ...rest] = line.split(/\s+/);
		try {
			steps.push(read(op, rest));
		} catch (cause) {
			const why = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`line ${index + 1} (${line}): ${why}`);
		}
	}
	return steps;
}

function read(op: string, rest: string[]): Step {
	switch (op) {
		case 'example':
			return { op, id: rest[0] };
		case 'clear':
			return { op };
		case 'place':
			return {
				op,
				kind: rest[0],
				x: number(rest[1]),
				y: number(rest[2]),
				rotation: number(rest[3]) as Rotation
			};
		case 'wire':
			return {
				op,
				points: rest.map((token) => {
					const [x, y] = token.split(',');
					return { x: number(x), y: number(y) };
				})
			};
		case 'move':
			return {
				op,
				parts: names(rest[0]),
				wires: names(rest[1]),
				dx: number(rest[2]),
				dy: number(rest[3])
			};
		case 'segment':
			return { op, wire: rest[0], index: number(rest[1]), dx: number(rest[2]), dy: number(rest[3]) };
		case 'delete':
		case 'rotate':
			return { op, parts: names(rest[0]), wires: names(rest[1]) };
		case 'param': {
			const value = rest.slice(2).join(' ');
			return {
				op,
				part: rest[0],
				key: rest[1],
				value:
					Number.isFinite(Number(value)) && value !== '' ? Number(value) : unflatten(value)
			};
		}
		case 'import':
			return { op, source: unflatten(rest.join(' ')) };
		case 'rename':
			return { op, part: rest[0], to: rest[1] };
		case 'undo':
		case 'redo':
			return { op };
		case 'stop':
			return { op, seconds: number(rest[0]) };
		case 'temperature':
			return { op, celsius: number(rest[0]) };
		case 'analysis':
			return { op, mode: rest[0] };
		case 'run':
			return { op };
		default:
			throw new Error(`no such operation "${op}"`);
	}
}
