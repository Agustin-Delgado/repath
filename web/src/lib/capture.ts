/**
 * What the instrument remembers.
 *
 * A run that never ends cannot be kept in full, and a scope does not pretend to:
 * it has a memory depth, the newest samples push the oldest out, and what is
 * gone is gone. That is the whole model here.
 *
 * The buffers are linear rather than circular, and twice as long as the depth
 * they promise. Appending writes at the end; when the far end is reached the
 * newest half is copied to the front and the rest is dropped. That costs one
 * copy every `depth` samples — and buys the thing a ring cannot give: every
 * channel is a contiguous run of memory, so a plot or a measurement can be
 * handed a plain `Float64Array` view with no copy and no wraparound to think
 * about.
 */

import type { Chunk, DigitalTransition, LogicState, PartFailure, TransientRun } from './engine';

/**
 * Samples kept per channel.
 *
 * A screen is about a thousand pixels wide and the engine is asked for a couple
 * of hundred points per window, so this is on the order of a hundred windows of
 * history — enough that stopping and looking back over what just happened is
 * useful, and small enough that a dozen channels of it are a few megabytes.
 */
export const DEPTH = 20_000;

/** One signal's history. */
class Channel {
	private data: Float64Array;
	length = 0;

	constructor(private readonly depth: number) {
		this.data = new Float64Array(depth * 2);
	}

	append(values: Float64Array): void {
		if (values.length === 0) return;
		// A single chunk longer than the whole memory: keep its tail and nothing
		// else, which is what the memory would have ended up holding anyway.
		if (values.length >= this.depth) {
			this.data.set(values.subarray(values.length - this.depth));
			this.length = this.depth;
			return;
		}
		if (this.length + values.length > this.data.length) this.compact();
		this.data.set(values, this.length);
		this.length += values.length;
	}

	/** Slide the newest `depth` samples to the front and forget the rest. */
	private compact(): void {
		const keep = Math.min(this.length, this.depth);
		this.data.copyWithin(0, this.length - keep, this.length);
		this.length = keep;
	}

	get view(): Float64Array {
		return this.data.subarray(0, this.length);
	}
}

/**
 * The acquisition: every channel, plus what the digital side did.
 *
 * Shaped so that `run()` hands back exactly what a completed run used to look
 * like. Everything downstream — the flow planner, the scope, the readings on the
 * drawing — asks the same questions of it as before, and does not need to know
 * whether the samples arrived all at once or are still arriving.
 */
export class Capture {
	private readonly times = new Channel(DEPTH);
	private readonly signals: Channel[];
	private readonly currentChannels: Channel[];
	/** Per net, the transitions still inside the memory. */
	readonly digital: DigitalTransition[][];
	readonly failures: PartFailure[] = [];
	/** What the engine has been through, added up over the whole sweep. */
	private readonly stats = {
		accepted_steps: 0,
		rejected_steps: 0,
		newton_iterations: 0,
		digital_events: 0
	};
	/** Level each net was at when the memory begins, for a trace with no edge in it. */
	private readonly opening: LogicState[];
	private cached: TransientRun | null = null;

	constructor(
		readonly unknownNames: string[],
		readonly elementNames: string[],
		readonly netNames: string[],
		readonly nodeCount: number
	) {
		this.signals = unknownNames.map(() => new Channel(DEPTH));
		this.currentChannels = elementNames.map(() => new Channel(DEPTH));
		this.digital = netNames.map(() => []);
		this.opening = netNames.map(() => 'unknown');
	}

	/** Simulated time of the newest sample. */
	get now(): number {
		const time = this.times.view;
		return time.length ? time[time.length - 1] : 0;
	}

	/** Simulated time of the oldest sample still remembered. */
	get earliest(): number {
		const time = this.times.view;
		return time.length ? time[0] : 0;
	}

	get length(): number {
		return this.times.length;
	}

	add(chunk: Chunk): void {
		this.times.append(chunk.time);
		for (let i = 0; i < this.signals.length; i++) {
			this.signals[i].append(chunk.signalsByIndex[i] ?? new Float64Array(0));
		}
		for (let i = 0; i < this.currentChannels.length; i++) {
			this.currentChannels[i].append(chunk.currents[i] ?? new Float64Array(0));
		}
		for (let net = 0; net < this.digital.length; net++) {
			const events = chunk.digital[net];
			if (events && events.length) this.digital[net].push(...events);
		}
		this.failures.push(...chunk.failures);
		this.stats.accepted_steps += chunk.stats.accepted_steps;
		this.stats.rejected_steps += chunk.stats.rejected_steps;
		this.stats.newton_iterations += chunk.stats.newton_iterations;
		this.stats.digital_events += chunk.stats.digital_events;
		this.forget(this.earliest);
		this.cached = null;
	}

	/**
	 * Drop digital transitions that have fallen out of memory.
	 *
	 * The last one before the window survives, moved into `opening`: it is what
	 * says what the net has been sitting at all along. Dropping it outright would
	 * leave a net that has not changed in a while with no level at all.
	 */
	private forget(from: number): void {
		for (let net = 0; net < this.digital.length; net++) {
			const events = this.digital[net];
			let drop = 0;
			while (drop < events.length && events[drop].time < from) drop++;
			if (drop === 0) continue;
			this.opening[net] = events[drop - 1].state;
			events.splice(0, drop);
		}
	}

	/** The level a net sits at when the visible history opens. */
	openingState(net: number): LogicState {
		return this.opening[net] ?? 'unknown';
	}

	/** Everything remembered, in the shape a finished run has. */
	run(): TransientRun {
		if (this.cached) return this.cached;
		const signalsByIndex = this.signals.map((c) => c.view);
		const signals = new Map<string, Float64Array>();
		this.unknownNames.forEach((name, index) => signals.set(name, signalsByIndex[index]));
		this.cached = {
			time: this.times.view,
			signals,
			signalsByIndex,
			unknownNames: this.unknownNames,
			nodeCount: this.nodeCount,
			elementNames: this.elementNames,
			currents: this.currentChannels.map((c) => c.view),
			netNames: this.netNames,
			digital: this.digital,
			failures: this.failures,
			stats: { ...this.stats },
			elapsedMs: 0
		};
		return this.cached;
	}
}
