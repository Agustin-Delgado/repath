/**
 * The sweep: wall-clock time turned into simulated time, a frame at a time.
 *
 * This is the difference between a simulator and a player. Nothing here is ever
 * recomputed — each frame asks the engine for the next slice of the run and the
 * engine carries on from where it was, holding every capacitor's charge and
 * every flip-flop's state. So a switch thrown now is thrown now: the past is
 * already solved and cannot be revised by anything you do to the circuit, which
 * is exactly what a rewind-and-re-solve model could never promise.
 *
 * What the drawing shows is therefore always the newest instant, and there is
 * nothing to seek to. Stop, and the last thing acquired stays on the screen to
 * be measured.
 */

import { Capture } from './capture';
import { EngineError, LiveRun, type LogicState } from './engine';

export interface AcquisitionHost {
	/** New samples have landed. */
	onChunk(): void;
	/** The run gave up. The message is the engine's own. */
	onError(message: string): void;
	/** Simulated seconds per second of wall clock. */
	rate(): number;
}

/**
 * Longest slice of wall clock a single frame may stand in for.
 *
 * A tab left in the background hands back one enormous delta on its first frame,
 * and honouring it would ask for a tenth of a second of simulation in one go —
 * a freeze, and of the least interesting kind, since nobody was watching.
 */
const MAX_FRAME = 0.05;

export class Acquisition {
	readonly capture: Capture;
	private run: LiveRun;
	private frame: number | null = null;
	private lastWall = 0;
	/** Simulated time this sweep stops at, for a single-shot capture. */
	private limit: number | null = null;
	/**
	 * Whether this was a single shot.
	 *
	 * Kept after the sweep ends rather than cleared with the limit: what it was is
	 * still the answer to "is this a finished window or a run somebody paused",
	 * and those are measured differently.
	 */
	single = false;
	/**
	 * How fast the run is really going against the wall clock, as a fraction of
	 * what was asked for. Below one, the engine is the reason — a stiff circuit
	 * simulates slower than it is being asked to, and saying so is better than
	 * pretending the timebase is being honoured.
	 */
	keeping = 1;

	constructor(
		netlist: unknown,
		maxStep: number,
		private readonly host: AcquisitionHost
	) {
		this.run = new LiveRun(netlist, maxStep);
		this.capture = new Capture(
			this.run.unknownNames,
			this.run.elementNames,
			this.run.netNames,
			this.run.nodeCount
		);
		this.capture.add(this.run.first);
	}

	/** Simulated seconds reached. */
	get time(): number {
		return this.run.time;
	}

	/** Whether the sweep is going. */
	get sweeping(): boolean {
		return this.frame !== null;
	}

	start(): void {
		if (this.frame !== null) return;
		this.single = false;
		this.lastWall = performance.now();
		this.frame = requestAnimationFrame(this.step);
	}

	/** Sweep once, for `span` simulated seconds, and stop there. */
	startSingle(span: number): void {
		const limit = this.run.time + Math.max(span, 0);
		this.start();
		this.limit = limit;
		this.single = true;
	}

	stop(): void {
		if (this.frame !== null) cancelAnimationFrame(this.frame);
		this.frame = null;
		this.limit = null;
	}

	close(): void {
		this.stop();
		this.run.free();
	}

	/** Throw a switch: its actuator gets a new waveform from this instant on. */
	setWaveform(source: string, waveform: unknown): boolean {
		return this.run.setWaveform(source, waveform);
	}

	/** Move a logic source now. */
	setLogic(name: string, state: LogicState): boolean {
		return this.run.setLogic(name, state, this.run.time);
	}

	private step = (now: number) => {
		const wall = Math.min((now - this.lastWall) / 1000, MAX_FRAME);
		this.lastWall = now;

		const asked = wall * this.host.rate();
		const target = this.run.time + asked;
		const until = this.limit === null ? target : Math.min(target, this.limit);

		const from = this.run.time;
		try {
			this.capture.add(this.run.advance(until));
		} catch (cause) {
			this.stop();
			this.host.onError(
				cause instanceof EngineError || cause instanceof Error ? cause.message : String(cause)
			);
			return;
		}
		// How much of what was asked for actually got simulated. A circuit that
		// cannot be solved this fast reads as slow motion, which is what it is.
		const advanced = this.run.time - from;
		if (asked > 0) {
			// Eased, because a single slow frame is not a verdict on the run.
			this.keeping = this.keeping * 0.8 + Math.min(advanced / asked, 1) * 0.2;
		}

		this.host.onChunk();

		if (this.limit !== null && this.run.time >= this.limit - 1e-15) {
			this.stop();
			this.host.onChunk();
			return;
		}
		if (this.frame !== null) this.frame = requestAnimationFrame(this.step);
	};
}
