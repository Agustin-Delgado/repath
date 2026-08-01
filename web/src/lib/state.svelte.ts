/**
 * Editor state.
 *
 * Connectivity and the compiled netlist are derived, never stored. Anything that
 * caches them has to remember to invalidate, and the moment that goes wrong the
 * simulator quietly runs the circuit you drew a minute ago.
 */

import { runTransient, type TransientRun } from './engine';
import { EXAMPLES, exampleById } from './examples';
import {
	defaultParams,
	definitionOf,
	nextName,
	pointKey,
	type Instance,
	type Rotation,
	type Schematic
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

const HISTORY_LIMIT = 100;

class AppState {
	schematic = $state<Schematic>(EXAMPLES[0].build());
	tool = $state<Tool>({ mode: 'select' });
	selection = $state<string[]>([]);
	probes = $state<string[]>([]);
	stopTime = $state(EXAMPLES[0].stopTime);
	exampleId = $state(EXAMPLES[0].id);

	running = $state(false);
	result = $state<TransientRun | null>(null);
	error = $state<string | null>(null);

	private past: string[] = [];
	private future: string[] = [];

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

	place(kind: string, x: number, y: number): Instance {
		this.checkpoint();
		const instance: Instance = {
			id: freshId(),
			kind,
			name: nextName(this.schematic.instances, kind),
			x,
			y,
			rotation: 0,
			params: defaultParams(kind)
		};
		this.schematic.instances.push(instance);
		this.selection = [instance.id];
		return instance;
	}

	addWire(x1: number, y1: number, x2: number, y2: number): void {
		if (x1 === x2 && y1 === y2) return;
		this.checkpoint();
		// Route as an L so every segment stays axis-aligned, which is what the
		// connectivity pass assumes and what schematics look like anyway.
		if (x1 !== x2 && y1 !== y2) {
			this.schematic.wires.push({ id: freshId(), x1, y1, x2: x2, y2: y1 });
			this.schematic.wires.push({ id: freshId(), x1: x2, y1, x2, y2 });
		} else {
			this.schematic.wires.push({ id: freshId(), x1, y1, x2, y2 });
		}
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

	/** Pick a few interesting nets so a freshly loaded example plots something. */
	private autoProbe(): void {
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
			// At least a few hundred points, so a flat trace still looks like a line
			// rather than two dots joined up.
			this.result = await runTransient(compiled.netlist, this.stopTime, this.stopTime / 400);
			if (this.probes.length === 0) this.autoProbe();
		} catch (cause) {
			this.error = cause instanceof Error ? cause.message : String(cause);
			this.result = null;
		} finally {
			this.running = false;
		}
	}
}

export const app = new AppState();
export { pointKey };
