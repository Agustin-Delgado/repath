/**
 * Thin wrapper over the WebAssembly engine.
 *
 * Waveforms come back as `Float64Array` views rather than JSON: a 20 000-point
 * run holds millions of numbers, and serializing those costs more than the
 * simulation that produced them.
 */

import init, { Simulation, runFrequencySweep as sweep, version } from './wasm/repath.js';

export type LogicState = 'low' | 'high' | 'unknown' | 'highz';

export interface DigitalTransition {
	time: number;
	state: LogicState;
}

export interface RunStats {
	accepted_steps: number;
	rejected_steps: number;
	newton_iterations: number;
	digital_events: number;
}

/** A part the engine destroyed partway through the run. */
export interface PartFailure {
	name: string;
	/** Simulated time it failed at. */
	time: number;
	/** Largest current it reached before then. */
	peak: number;
	rated: number;
}

interface RunMeta {
	unknown_names: string[];
	node_count: number;
	point_count: number;
	element_names: string[];
	net_names: string[];
	digital: DigitalTransition[][];
	failures: PartFailure[];
	stats: RunStats;
}

export interface TransientRun {
	time: Float64Array;
	/** Signal label (`v(n1)`, `i(R2)`) -> samples, aligned with `time`. */
	signals: Map<string, Float64Array>;
	/**
	 * The same samples indexed by unknown rather than by name.
	 *
	 * Columnar rather than a row per timepoint: the animation asks for one
	 * signal across time far more often than for every signal at one instant,
	 * and this way that is a single contiguous array.
	 */
	signalsByIndex: Float64Array[];
	unknownNames: string[];
	nodeCount: number;
	/** Instance names, indexing `currents`. */
	elementNames: string[];
	/** Current through each element across the run, one array per element. */
	currents: Float64Array[];
	netNames: string[];
	digital: DigitalTransition[][];
	/**
	 * Parts destroyed during the run, soonest first.
	 *
	 * Not an error: the run continued with each one open, which is what the
	 * circuit does. The waveforms after a failure are the circuit without it.
	 */
	failures: PartFailure[];
	stats: RunStats;
	/** Wall-clock milliseconds spent inside the engine. */
	elapsedMs: number;
}

export interface OperatingPointRun {
	names: string[];
	values: number[];
	nodeCount: number;
	iterations: number;
}

let booted: Promise<void> | null = null;

/** Load the wasm module. Safe to call repeatedly; the work happens once. */
export function ensureEngine(): Promise<void> {
	booted ??= init().then(() => undefined);
	return booted;
}

export function engineVersion(): string {
	return version();
}

/** Anything the engine rejects arrives here with its message intact. */
export class EngineError extends Error {}

function toEngineError(cause: unknown): EngineError {
	const message = cause instanceof Error ? cause.message : String(cause);
	return new EngineError(message);
}

export async function runTransient(
	netlist: unknown,
	stop: number,
	maxStep: number
): Promise<TransientRun> {
	await ensureEngine();

	let simulation: Simulation;
	try {
		simulation = new Simulation(JSON.stringify(netlist));
	} catch (cause) {
		throw toEngineError(cause);
	}

	try {
		const started = performance.now();
		const meta = JSON.parse(simulation.runTransient(stop, maxStep)) as RunMeta;
		const elapsedMs = performance.now() - started;

		const time = simulation.time();
		const signals = new Map<string, Float64Array>();
		const signalsByIndex = meta.unknown_names.map((name, index) => {
			const samples = simulation.signal(index);
			signals.set(name, samples);
			return samples;
		});
		const currents = meta.element_names.map((_, index) => simulation.current(index));

		return {
			time,
			signals,
			signalsByIndex,
			unknownNames: meta.unknown_names,
			nodeCount: meta.node_count,
			elementNames: meta.element_names,
			currents,
			netNames: meta.net_names,
			digital: meta.digital,
			failures: meta.failures ?? [],
			stats: meta.stats,
			elapsedMs
		};
	} catch (cause) {
		throw toEngineError(cause);
	} finally {
		simulation.free();
	}
}

/** One piece of a live run: the timepoints solved since the last call. */
export interface Chunk {
	time: Float64Array;
	/** Samples per unknown, aligned with `time`. */
	signalsByIndex: Float64Array[];
	/** Samples per element, aligned with `time`. */
	currents: Float64Array[];
	/** Transitions that happened during this piece, per digital net. */
	digital: DigitalTransition[][];
	failures: PartFailure[];
	stats: RunStats;
}

/**
 * A simulation that is still going.
 *
 * The engine keeps the circuit and the solver state; this side keeps nothing but
 * the handle. Every call to `advance` carries the run further and hands back only
 * what happened on the way — nothing is ever recomputed, which is what makes an
 * operation performed halfway through stay done.
 */
export class LiveRun {
	private simulation: Simulation;
	readonly unknownNames: string[];
	readonly elementNames: string[];
	readonly netNames: string[];
	readonly nodeCount: number;
	/** The first chunk: the single timepoint at t = 0. */
	readonly first: Chunk;
	private freed = false;

	constructor(netlist: unknown, maxStep: number) {
		try {
			this.simulation = new Simulation(JSON.stringify(netlist));
		} catch (cause) {
			throw toEngineError(cause);
		}
		try {
			const meta = JSON.parse(this.simulation.beginLive(maxStep)) as RunMeta;
			this.unknownNames = meta.unknown_names;
			this.elementNames = meta.element_names;
			this.netNames = meta.net_names;
			this.nodeCount = meta.node_count;
			this.first = this.collect(meta);
		} catch (cause) {
			this.simulation.free();
			this.freed = true;
			throw toEngineError(cause);
		}
	}

	/** Simulated seconds reached so far. */
	get time(): number {
		return this.freed ? 0 : this.simulation.liveTime();
	}

	/** Carry the run to `until`, in seconds from its start. */
	advance(until: number): Chunk {
		if (this.freed) throw new EngineError('the run has been closed');
		try {
			const meta = JSON.parse(this.simulation.advance(until)) as RunMeta;
			return this.collect(meta);
		} catch (cause) {
			throw toEngineError(cause);
		}
	}

	/**
	 * Give a source a new waveform from here on — somebody's hand on a switch.
	 *
	 * The waveform is written in the netlist's own shape, so a contact can hand
	 * over its whole bounce train anchored at the instant it was thrown.
	 */
	setWaveform(name: string, waveform: unknown): boolean {
		if (this.freed) return false;
		return this.simulation.setSourceWaveform(name, JSON.stringify(waveform));
	}

	/** Move a logic source to a level, from `at` onwards. */
	setLogic(name: string, state: LogicState, at: number): boolean {
		if (this.freed) return false;
		return this.simulation.setLogic(name, state, at);
	}

	free(): void {
		if (this.freed) return;
		this.simulation.free();
		this.freed = true;
	}

	private collect(meta: RunMeta): Chunk {
		return {
			time: this.simulation.time(),
			signalsByIndex: this.unknownNames.map((_, index) => this.simulation.signal(index)),
			currents: this.elementNames.map((_, index) => this.simulation.current(index)),
			digital: meta.digital,
			failures: meta.failures ?? [],
			stats: meta.stats
		};
	}
}

export interface FrequencyRun {
	frequencies: Float64Array;
	unknownNames: string[];
	nodeCount: number;
	/** Linear magnitude per unknown, indexed by frequency. */
	magnitude: Float64Array[];
	/** Phase in degrees per unknown, already unwrapped. */
	phase: Float64Array[];
	elapsedMs: number;
}

export async function runFrequencySweep(
	netlist: unknown,
	startHz: number,
	stopHz: number,
	pointsPerDecade = 20
): Promise<FrequencyRun> {
	await ensureEngine();

	let run;
	try {
		const started = performance.now();
		run = sweep(JSON.stringify(netlist), startHz, stopHz, pointsPerDecade);
		const elapsedMs = performance.now() - started;

		const meta = JSON.parse(run.meta()) as {
			names: string[];
			node_count: number;
			point_count: number;
		};
		return {
			frequencies: run.frequencies(),
			unknownNames: meta.names,
			nodeCount: meta.node_count,
			magnitude: meta.names.map((_, i) => run!.magnitude(i)),
			phase: meta.names.map((_, i) => run!.phase(i)),
			elapsedMs
		};
	} catch (cause) {
		throw toEngineError(cause);
	} finally {
		run?.free();
	}
}

export async function runOperatingPoint(netlist: unknown): Promise<OperatingPointRun> {
	await ensureEngine();

	let simulation: Simulation;
	try {
		simulation = new Simulation(JSON.stringify(netlist));
	} catch (cause) {
		throw toEngineError(cause);
	}

	try {
		const parsed = JSON.parse(simulation.operatingPoint()) as {
			names: string[];
			values: number[];
			node_count: number;
			iterations: number;
		};
		return {
			names: parsed.names,
			values: parsed.values,
			nodeCount: parsed.node_count,
			iterations: parsed.iterations
		};
	} catch (cause) {
		throw toEngineError(cause);
	} finally {
		simulation.free();
	}
}
