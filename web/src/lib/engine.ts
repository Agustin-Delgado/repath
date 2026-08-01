/**
 * Thin wrapper over the WebAssembly engine.
 *
 * Waveforms come back as `Float64Array` views rather than JSON: a 20 000-point
 * run holds millions of numbers, and serializing those costs more than the
 * simulation that produced them.
 */

import init, { Simulation, version } from './wasm/repath.js';

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

interface RunMeta {
	unknown_names: string[];
	node_count: number;
	point_count: number;
	element_names: string[];
	net_names: string[];
	digital: DigitalTransition[][];
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
			stats: meta.stats,
			elapsedMs
		};
	} catch (cause) {
		throw toEngineError(cause);
	} finally {
		simulation.free();
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
