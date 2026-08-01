/**
 * Editor state.
 *
 * Connectivity and the compiled netlist are derived, never stored. Anything that
 * caches them has to remember to invalidate, and the moment that goes wrong the
 * simulator quietly runs the circuit you drew a minute ago.
 */

import { runFrequencySweep, runTransient, type FrequencyRun, type TransientRun } from './engine';
import { EXAMPLES, exampleById } from './examples';
import {
	GRID,
	defaultParams,
	definitionOf,
	nextName,
	pointKey,
	snap,
	type Instance,
	type Rotation,
	type Schematic,
	type Wire
} from './schematic/model';
import { compileSchematic } from './schematic/netlist';

export type Tool = { mode: 'select' } | { mode: 'wire' } | { mode: 'place'; kind: string };

export interface ProbeInfo {
	/** Stable handle: a grid point the net passes through. */
	key: string;
	netIndex: number;
	analog?: string;
	digital?: string;
	label: string;
	colour: string;
}

/** Distinguishable at a glance, and readable on a dark background. */
export const TRACE_COLOURS = [
	'#4ea8ff',
	'#ffb454',
	'#5ddc9a',
	'#ff7b9c',
	'#c58bff',
	'#5ad4e6',
	'#ffe066',
	'#ff9b6a'
];

let idCounter = 0;
const freshId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

/** Direction-independent identity for a wire, for spotting duplicates. */
function wireSignature(x1: number, y1: number, x2: number, y2: number): string {
	const a = `${x1},${y1}`;
	const b = `${x2},${y2}`;
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const HISTORY_LIMIT = 100;

class AppState {
	schematic = $state<Schematic>(EXAMPLES[0].build());
	tool = $state<Tool>({ mode: 'select' });
	selection = $state<string[]>([]);
	probes = $state<string[]>([]);
	stopTime = $state(EXAMPLES[0].stopTime);
	exampleId = $state(EXAMPLES[0].id);

	/** Net under the cursor, highlighted across every wire that carries it. */
	hoverNet = $state<number | null>(null);

	running = $state(false);
	result = $state<TransientRun | null>(null);
	error = $state<string | null>(null);

	/** Which analysis the Run button performs. */
	analysis = $state<'transient' | 'frequency'>('transient');
	acStart = $state(1);
	acStop = $state(1e6);
	acResult = $state<FrequencyRun | null>(null);

	/** Whether any source is set up to drive the frequency sweep. */
	hasAcDrive = $derived(
		this.schematic.instances.some(
			(i) => (i.kind === 'vsource' || i.kind === 'isource') && Number(i.params.ac) > 0
		)
	);

	// -- playback ---------------------------------------------------------

	playing = $state(false);
	/** Where in simulated time the live overlay is showing. */
	playbackTime = $state(0);
	/** How many times faster or slower than the default four-second replay. */
	playbackSpeed = $state(1);
	showVoltage = $state(true);
	showCurrent = $state(true);

	/** Simulated seconds per real second at the current speed setting. */
	get playbackRate(): number {
		return (this.stopTime / 4) * this.playbackSpeed;
	}

	togglePlay(): void {
		if (!this.result) return;
		// Restarting from the end rather than sitting there doing nothing.
		if (!this.playing && this.playbackTime >= this.stopTime) this.playbackTime = 0;
		this.playing = !this.playing;
	}

	seek(time: number): void {
		this.playbackTime = Math.min(Math.max(time, 0), this.stopTime);
	}

	private past: string[] = [];
	private future: string[] = [];
	private clipboard: { instances: Instance[]; wires: Wire[] } | null = null;

	compiled = $derived(compileSchematic(this.schematic));

	activeProbes = $derived.by((): ProbeInfo[] => {
		const compiled = this.compiled;
		const out: ProbeInfo[] = [];
		for (const key of this.probes) {
			const netIndex = compiled.connectivity.netOfPoint.get(key);
			if (netIndex === undefined) continue;
			const names = compiled.names.get(netIndex);
			const label = names?.analog ?? names?.digital;
			if (!label) continue;
			out.push({
				key,
				netIndex,
				analog: names?.analog,
				digital: names?.digital,
				label,
				colour: TRACE_COLOURS[out.length % TRACE_COLOURS.length]
			});
		}
		return out;
	});

	selectedInstances = $derived(
		this.schematic.instances.filter((i) => this.selection.includes(i.id))
	);

	canUndo = $derived(this.past.length > 0);

	// -- history ----------------------------------------------------------

	/** Call immediately *before* mutating the schematic. */
	private checkpoint(): void {
		this.past.push(JSON.stringify(this.schematic));
		if (this.past.length > HISTORY_LIMIT) this.past.shift();
		this.future.length = 0;
	}

	undo(): void {
		const previous = this.past.pop();
		if (!previous) return;
		this.future.push(JSON.stringify(this.schematic));
		this.schematic = JSON.parse(previous) as Schematic;
		this.selection = [];
	}

	redo(): void {
		const next = this.future.pop();
		if (!next) return;
		this.past.push(JSON.stringify(this.schematic));
		this.schematic = JSON.parse(next) as Schematic;
		this.selection = [];
	}

	// -- editing ----------------------------------------------------------

	place(kind: string, x: number, y: number, rotation: Rotation = 0): Instance {
		this.checkpoint();
		const instance: Instance = {
			id: freshId(),
			kind,
			name: nextName(this.schematic.instances, kind),
			x,
			y,
			rotation,
			params: defaultParams(kind)
		};
		this.schematic.instances.push(instance);
		this.selection = [instance.id];
		return instance;
	}

	addWire(x1: number, y1: number, x2: number, y2: number): void {
		this.addWirePath([
			{ x: x1, y: y1 },
			{ x: x2, y: y2 }
		]);
	}

	/**
	 * Commit a polyline as wires, one per segment.
	 *
	 * The routing decision belongs to the tool that drew it, not here — that way
	 * the preview the user saw and the geometry that lands are the same thing.
	 */
	addWirePath(points: ReadonlyArray<{ x: number; y: number }>): void {
		const already = new Set(
			this.schematic.wires.map((w) => wireSignature(w.x1, w.y1, w.x2, w.y2))
		);
		const segments: Wire[] = [];

		for (let i = 0; i < points.length - 1; i++) {
			const a = points[i];
			const b = points[i + 1];
			if (a.x === b.x && a.y === b.y) continue;
			// Retracing an existing wire is a no-op, not a second wire lying
			// invisibly on top of the first.
			const signature = wireSignature(a.x, a.y, b.x, b.y);
			if (already.has(signature)) continue;
			already.add(signature);
			segments.push({ id: freshId(), x1: a.x, y1: a.y, x2: b.x, y2: b.y });
		}

		if (segments.length === 0) return;
		this.checkpoint();
		this.schematic.wires.push(...segments);
	}

	deleteSelection(): void {
		if (this.selection.length === 0) return;
		this.checkpoint();
		const doomed = new Set(this.selection);
		this.schematic.instances = this.schematic.instances.filter((i) => !doomed.has(i.id));
		this.schematic.wires = this.schematic.wires.filter((w) => !doomed.has(w.id));
		this.selection = [];
	}

	rotateSelection(): void {
		if (this.selection.length === 0) return;
		this.checkpoint();
		for (const instance of this.schematic.instances) {
			if (this.selection.includes(instance.id)) {
				instance.rotation = ((instance.rotation + 90) % 360) as Rotation;
			}
		}
	}

	/** Move the selection. `commit` is false during a drag and true when it ends. */
	moveSelection(dx: number, dy: number, commit: boolean): void {
		if (dx === 0 && dy === 0) return;
		if (commit) this.checkpoint();
		const chosen = new Set(this.selection);
		for (const instance of this.schematic.instances) {
			if (chosen.has(instance.id)) {
				instance.x += dx;
				instance.y += dy;
			}
		}
		for (const wire of this.schematic.wires) {
			if (chosen.has(wire.id)) {
				wire.x1 += dx;
				wire.y1 += dy;
				wire.x2 += dx;
				wire.y2 += dy;
			}
		}
	}

	setParam(id: string, key: string, value: number | string): void {
		const instance = this.schematic.instances.find((i) => i.id === id);
		if (!instance || instance.params[key] === value) return;
		this.checkpoint();
		instance.params[key] = value;
	}

	rename(id: string, name: string): void {
		const trimmed = name.trim();
		if (!trimmed) return;
		const instance = this.schematic.instances.find((i) => i.id === id);
		if (!instance || instance.name === trimmed) return;
		if (this.schematic.instances.some((i) => i.id !== id && i.name === trimmed)) return;
		this.checkpoint();
		instance.name = trimmed;
	}

	clear(): void {
		this.checkpoint();
		this.schematic = { instances: [], wires: [] };
		this.selection = [];
		this.probes = [];
		this.result = null;
	}

	// -- clipboard --------------------------------------------------------

	/** Copy the selection. Returns false when there was nothing to copy. */
	copySelection(): boolean {
		const chosen = new Set(this.selection);
		if (chosen.size === 0) return false;

		this.clipboard = {
			instances: this.schematic.instances
				.filter((i) => chosen.has(i.id))
				.map((i) => structuredClone($state.snapshot(i)) as Instance),
			wires: this.schematic.wires
				.filter((w) => chosen.has(w.id))
				.map((w) => structuredClone($state.snapshot(w)) as Wire)
		};
		return true;
	}

	get hasClipboard(): boolean {
		return this.clipboard !== null;
	}

	/**
	 * Paste the clipboard. With `at`, the copied group's top-left corner lands
	 * there; without, it is nudged clear of the original so the two do not sit
	 * exactly on top of each other and look like one.
	 */
	paste(at?: { x: number; y: number }): void {
		if (!this.clipboard) return;
		const { instances, wires } = this.clipboard;
		if (instances.length === 0 && wires.length === 0) return;

		const xs = [...instances.map((i) => i.x), ...wires.flatMap((w) => [w.x1, w.x2])];
		const ys = [...instances.map((i) => i.y), ...wires.flatMap((w) => [w.y1, w.y2])];
		const minX = Math.min(...xs);
		const minY = Math.min(...ys);
		const dx = at ? snap(at.x) - snap(minX) : GRID * 3;
		const dy = at ? snap(at.y) - snap(minY) : GRID * 3;

		this.checkpoint();
		const existing = [...this.schematic.instances];
		const fresh: string[] = [];

		for (const source of instances) {
			// Names have to be regenerated as we go, or pasting three resistors
			// would produce three of whatever R-number was free at the start.
			const copy: Instance = {
				...structuredClone(source),
				id: freshId(),
				name: nextName(existing, source.kind),
				x: source.x + dx,
				y: source.y + dy
			};
			existing.push(copy);
			this.schematic.instances.push(copy);
			fresh.push(copy.id);
		}

		for (const source of wires) {
			const copy: Wire = {
				id: freshId(),
				x1: source.x1 + dx,
				y1: source.y1 + dy,
				x2: source.x2 + dx,
				y2: source.y2 + dy
			};
			this.schematic.wires.push(copy);
			fresh.push(copy.id);
		}

		this.selection = fresh;
	}

	duplicateSelection(): void {
		if (!this.copySelection()) return;
		this.paste();
	}

	// -- probes -----------------------------------------------------------

	toggleProbe(key: string): void {
		const netIndex = this.compiled.connectivity.netOfPoint.get(key);
		if (netIndex === undefined) return;
		// Probe the net, not the point: clicking anywhere on the same wire toggles
		// the same trace.
		const existing = this.probes.find(
			(k) => this.compiled.connectivity.netOfPoint.get(k) === netIndex
		);
		this.probes = existing ? this.probes.filter((k) => k !== existing) : [...this.probes, key];
	}

	isProbed(netIndex: number): boolean {
		return this.activeProbes.some((p) => p.netIndex === netIndex);
	}

	/** Pick a few interesting nets so a freshly loaded circuit plots something. */
	autoProbe(): void {
		const compiled = compileSchematic(this.schematic);
		const chosen: string[] = [];
		for (const net of compiled.connectivity.nets) {
			if (chosen.length >= 4) break;
			if (net.isGround) continue;
			const names = compiled.names.get(net.index);
			if (!names?.analog && !names?.digital) continue;
			// Prefer nets with a wire on them; a lone pin is rarely what you want.
			if (net.points.length < 2) continue;
			chosen.push(net.points[0]);
		}
		this.probes = chosen;
	}

	// -- examples ---------------------------------------------------------

	loadExample(id: string): void {
		const example = exampleById(id);
		this.past.length = 0;
		this.future.length = 0;
		this.schematic = example.build();
		this.stopTime = example.stopTime;
		this.exampleId = example.id;
		// Each example arrives in whichever analysis actually shows it off — a
		// resonant filter has nothing to say in the time domain.
		this.analysis = example.analysis ?? 'transient';
		if (example.frequencyRange) {
			this.acStart = example.frequencyRange.start;
			this.acStop = example.frequencyRange.stop;
		}
		this.selection = [];
		this.result = null;
		this.acResult = null;
		this.error = null;
		this.autoProbe();
	}

	/** Adopt a circuit that arrived in a link. */
	loadShared(circuit: { schematic: Schematic; stopTime: number }): void {
		this.past.length = 0;
		this.future.length = 0;
		this.schematic = circuit.schematic;
		this.stopTime = circuit.stopTime;
		this.exampleId = '';
		this.selection = [];
		this.result = null;
		this.error = null;
		this.autoProbe();
	}

	// -- persistence ------------------------------------------------------

	toJSON(): string {
		return JSON.stringify(
			{ version: 1, schematic: this.schematic, stopTime: this.stopTime, probes: this.probes },
			null,
			2
		);
	}

	fromJSON(text: string): void {
		const parsed = JSON.parse(text) as {
			schematic?: Schematic;
			stopTime?: number;
			probes?: string[];
		};
		if (!parsed.schematic?.instances) throw new Error('That file is not a repath schematic.');
		// Re-key everything so a pasted circuit cannot collide with what is open.
		const remap = new Map<string, string>();
		for (const instance of parsed.schematic.instances) {
			const id = freshId();
			remap.set(instance.id, id);
			instance.id = id;
			definitionOf(instance.kind); // throws early on an unknown component
		}
		for (const wire of parsed.schematic.wires ?? []) wire.id = freshId();

		this.past.length = 0;
		this.future.length = 0;
		this.schematic = { instances: parsed.schematic.instances, wires: parsed.schematic.wires ?? [] };
		this.stopTime = parsed.stopTime ?? 1e-3;
		this.probes = parsed.probes ?? [];
		this.selection = [];
		this.result = null;
		this.error = null;
	}

	// -- simulation -------------------------------------------------------

	async run(): Promise<void> {
		const compiled = this.compiled;
		if (!compiled.netlist) {
			this.error = compiled.errors.join(' ');
			this.result = null;
			return;
		}
		this.running = true;
		this.error = null;
		try {
			if (this.analysis === 'frequency') {
				if (!this.hasAcDrive) {
					throw new Error(
						'No source is driving the sweep. Set a voltage source’s AC drive to 1 to make it the input.'
					);
				}
				this.acResult = await runFrequencySweep(compiled.netlist, this.acStart, this.acStop);
				if (this.probes.length === 0) this.autoProbe();
			} else {
				// At least a few hundred points, so a flat trace still looks like a
				// line rather than two dots joined up.
				this.result = await runTransient(compiled.netlist, this.stopTime, this.stopTime / 400);
				if (this.probes.length === 0) this.autoProbe();
				this.playbackTime = 0;
				this.playing = true;
			}
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
			if (this.analysis === 'frequency') this.acResult = null;
			else this.result = null;
		} finally {
			this.running = false;
		}
	}
}

export const app = new AppState();
export { pointKey };
