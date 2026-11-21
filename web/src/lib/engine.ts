/**
 * Thin wrapper over the WebAssembly engine.
 *
 * Waveforms come back as `Float64Array` views rather than JSON: a 20 000-point
 * run holds millions of numbers, and serializing those costs more than the
 * simulation that produced them.
 */

import init, { Simulation, lastFailure, runFrequencySweep as sweep, version } from './wasm/repath.js';
import type { LcdFrame } from './schematic/lcd';
import type { MatrixFrame } from './schematic/max7219';
import type { BuzzerState } from './schematic/buzzer';
import type { ServoFrame } from './schematic/servo';

export type LogicState = 'low' | 'high' | 'unknown' | 'highz';

export interface DigitalTransition {
	time: number;
	state: LogicState;
}

/**
 * A span in which a net switched too fast for its trace to keep every edge.
 *
 * The engine folds edges closer together than the step ceiling can show into
 * one of these: where it began and ended, how many edges, how long high. The
 * transitions of the net say nothing about the span; the level it was left at
 * is recorded as a transition at `to`.
 */
export interface Burst {
	from: number;
	to: number;
	edges: number;
	high: number;
}

export interface RunStats {
	accepted_steps: number;
	rejected_steps: number;
	newton_iterations: number;
	digital_events: number;
	/** Steps and digital events added up in units of a step, which is what a frame is paced by. */
	work: number;
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
	bursts: Burst[][];
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
	/** Per net, the spans it switched through too fast for `digital` to record. */
	bursts: Burst[][];
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

/**
 * Load the wasm module. Safe to call repeatedly; the work happens once.
 *
 * A failure is not cached. Holding on to the rejected promise meant one bad
 * fetch — a flaky network, a proxy in the way — left the engine permanently
 * unavailable for the life of the page, with Run reporting the same error
 * forever and reloading the only way out.
 */
export function ensureEngine(): Promise<void> {
	booted ??= init().then(
		() => undefined,
		(cause) => {
			booted = null;
			throw cause;
		}
	);
	return booted;
}

export function engineVersion(): string {
	return version();
}

/**
 * Where in the circuit a solve failed, in the engine's names: nodes as the
 * netlist named them (`n3`), components as it named them (`D1`, `X1.Q2`,
 * `DS1:b`). Most to blame first.
 */
export interface SolveFailure {
	kind: 'singular' | 'no_convergence' | 'timestep' | 'non_finite' | 'other';
	/** Simulated time it failed at, where there is one. */
	time: number | null;
	nodes: string[];
	elements: string[];
}

/** Anything the engine rejects arrives here with its message intact. */
export class EngineError extends Error {
	/** Where the solve went wrong, when the failure was the solve's. */
	failure: SolveFailure | null = null;
}

/** @internal Exported for the tests; everything else goes through the calls below. */
export function toEngineError(cause: unknown): EngineError {
	if (cause instanceof EngineError) return cause;
	const message = cause instanceof Error ? cause.message : String(cause);
	const error = new EngineError(message);
	error.failure = readFailure(message);
	return error;
}

/**
 * What the engine kept about the error it raised last, if it was a solve's and
 * it is the error in hand.
 *
 * The engine hands a failure over once and says which message it went with.
 * Both matter: without them, an error that never reached the solver — a trap,
 * a copy out of memory, a call made with no live run — picked up whatever the
 * last failed solve had left and highlighted its parts on the drawing.
 */
function readFailure(message: string): SolveFailure | null {
	try {
		const raw = lastFailure();
		if (!raw) return null;
		const { message: raisedWith, ...failure } = JSON.parse(raw) as SolveFailure & { message?: string };
		return raisedWith === message ? failure : null;
	} catch {
		return null;
	}
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
			bursts: meta.bursts ?? meta.digital.map(() => []),
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

/** A byte a microcontroller sent, timed when its stop bit ended. */
export interface SerialByte {
	time: number;
	byte: number;
}

/**
 * A part of the chip the program used that is not simulated, and when it
 * first did: `temperature`, `adc-trigger`, `spi`, `i2c` or `comparator`.
 */
export interface McuNotice {
	peripheral: string;
	time: number;
}

/** What a microcontroller in a live run has to report. */
export interface McuState {
	serial: SerialByte[];
	/**
	 * How many bytes it has sent in all: the `from` to ask with next. More
	 * than `from` plus `serial.length` only when the engine had already let
	 * go of the oldest of them.
	 */
	sent: number;
	/** Every notice so far, not only the new ones: there are at most a handful. */
	notices: McuNotice[];
	/** Why its CPU stopped, and when: an instruction it does not know. */
	fault: { message: string; time: number } | null;
	/** The baud rate its receiver is set to, or null while the receiver is off. */
	listening: number | null;
}

/**
 * A new value for one engine element, in the engine's own shape: the change
 * that can be made under a running circuit without it becoming another one.
 */
export type Retune =
	| { resistance: number }
	| { capacitance: number }
	| { inductance: number }
	| { waveform: unknown };

/** One piece of a live run: the timepoints solved since the last call. */
export interface Chunk {
	time: Float64Array;
	/** Samples per unknown, aligned with `time`. */
	signalsByIndex: Float64Array[];
	/** Samples per element, aligned with `time`. */
	currents: Float64Array[];
	/** Transitions that happened during this piece, per digital net. */
	digital: DigitalTransition[][];
	/** Spans of this piece in which a net switched too fast to record, per net. */
	bursts: Burst[][];
	failures: PartFailure[];
	/** The run's totals so far, not this piece's share: the engine counts from the start. */
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

	/**
	 * Give an element a new value from `at` onwards — somebody's hand on a knob.
	 *
	 * The engine ends a step exactly on `at` and changes the value there, so a
	 * run handed the same retunes lands on the same instants. False when there is
	 * no such element or the change does not fit it.
	 */
	retune(name: string, change: Retune, at: number): boolean {
		if (this.freed) return false;
		try {
			return this.simulation.retune(name, JSON.stringify(change), at);
		} catch (cause) {
			throw toEngineError(cause);
		}
	}

	/** Move a logic source to a level, from `at` onwards. */
	setLogic(name: string, state: LogicState, at: number): boolean {
		if (this.freed) return false;
		return this.simulation.setLogic(name, state, at);
	}

	/**
	 * What a microcontroller has sent and whether its CPU has stopped, or null
	 * when there is none by that name. Bytes come from the `from`-th on, so a
	 * caller polling every frame is handed only the new ones.
	 */
	mcuState(name: string, from: number): McuState | null {
		if (this.freed) return null;
		const state = JSON.parse(this.simulation.mcuState(name, from)) as {
			serial: SerialByte[];
			sent?: number;
			notices: McuNotice[];
			fault: string | null;
			fault_time: number | null;
			listening?: number | null;
		} | null;
		if (!state) return null;
		return {
			serial: state.serial,
			sent: state.sent ?? from + state.serial.length,
			notices: state.notices,
			fault:
				state.fault === null ? null : { message: state.fault, time: state.fault_time ?? 0 },
			listening: state.listening ?? null
		};
	}

	/**
	 * Type bytes into a serial monitor: the USB-serial converter by that name
	 * sends them as UART frames at `baud`, from `at` on. False when there is no
	 * such converter.
	 */
	sendSerial(name: string, bytes: Uint8Array, baud: number, at: number): boolean {
		if (this.freed) return false;
		return this.simulation.sendSerial(name, bytes, Math.max(1, Math.round(baud)), at);
	}

	/**
	 * What a buzzer has been driven at: the tones finished from the `from`-th
	 * of the run on, how many there have been, and the one still going. Null
	 * when there is no buzzer by that name.
	 */
	buzzerState(name: string, from: number): BuzzerState | null {
		if (this.freed) return null;
		return JSON.parse(this.simulation.buzzerState(name, from)) as BuzzerState | null;
	}

	/**
	 * What an I2C LCD module shows, or null when there is none by that name.
	 * One on no bus never changes, and is reported as of the start of the run.
	 */
	lcdState(name: string): LcdFrame | null {
		if (this.freed) return null;
		const state = JSON.parse(this.simulation.lcdState(name)) as {
			time: number | null;
			version: number;
			backlight: boolean;
			cells: number[][];
			cursor: number | null;
			blink: number | null;
			overdriven: boolean;
			blink_interval: number;
		} | null;
		if (!state) return null;
		return {
			time: state.time ?? 0,
			version: state.version,
			backlight: state.backlight,
			cells: state.cells,
			cursor: state.cursor,
			blink: state.blink,
			overdriven: state.overdriven,
			blinkInterval: state.blink_interval
		};
	}

	/**
	 * What a MAX7219 matrix lights, or null when there is none by that name.
	 * Its time is when the program last changed its registers.
	 */
	max7219State(name: string): MatrixFrame | null {
		if (this.freed) return null;
		const state = JSON.parse(this.simulation.max7219State(name)) as {
			time: number;
			version: number;
			lit: number[];
			duty: number;
		} | null;
		if (!state) return null;
		return { time: state.time, version: state.version, lit: state.lit, duty: state.duty };
	}

	/**
	 * Where a servo's horn is, as of the instant the digital side has reached,
	 * or null when there is no servo device by that name.
	 */
	servoState(device: string): ServoFrame | null {
		if (this.freed) return null;
		return JSON.parse(this.simulation.servoState(device)) as ServoFrame | null;
	}

	/**
	 * Most solver steps one `advance` may take before handing back what it has.
	 *
	 * Past it the run stops short of `until`, and `time` says where. The pacing
	 * of a live run against the wall clock lives on this one number.
	 */
	setFrameBudget(steps: number): void {
		if (this.freed) return;
		this.simulation.setFrameBudget(Math.max(1, Math.round(steps)));
	}

	/** Change the step ceiling from here on: the resolution of what comes next. */
	setMaxStep(step: number): void {
		if (this.freed || !(step > 0)) return;
		this.simulation.setLiveMaxStep(step);
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
			bursts: meta.bursts ?? meta.digital.map(() => []),
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
