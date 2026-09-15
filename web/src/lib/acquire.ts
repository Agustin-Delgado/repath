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

/**
 * Wall-clock milliseconds a frame may spend inside the engine.
 *
 * Half of a sixty-hertz frame, leaving the other half for drawing what came
 * out. The engine is handed a step budget sized to fit this from how fast its
 * steps have been going, and stops short of the frame's target when it runs
 * out — so a clock turned up to a hundred megahertz slows the sweep down rather
 * than freezing the page, which is what it did when a frame ran to its target
 * however long that took.
 */
const ENGINE_MS = 8;

/** Steps allowed before anything has been measured. */
const OPENING_BUDGET = 2_000;

/** The budget never goes below this: a frame that could not take a step would never learn its speed. */
const LEAST_BUDGET = 200;

/** Samples across one window: what the step ceiling is set from. */
const SAMPLES_PER_WINDOW = 200;

/**
 * Samples across the part of a frame's span that no screen will show.
 *
 * At real time on a narrow window, a frame carries more simulated time than the
 * window is wide: sixteen milliseconds of it at a five-millisecond window. Only
 * the last window's worth is ever drawn — the frames are snapshots, and the
 * stretch between them is never on screen. Solving that stretch at the
 * window's resolution was forty thousand steps a second for samples nobody
 * would see, and the sweep fell behind the clock the moment the scope was
 * zoomed in. Now the run is solved coarsely up to where the window opens and
 * finely across it. The coarse part is a ceiling, not a grid: the circuit's own
 * dynamics and every logic edge that reaches the analog side still cut the
 * steps as short as they need to be.
 */
const SAMPLES_BETWEEN_WINDOWS = 20;

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

	/**
	 * Solver work per wall-clock millisecond, as recently measured, in steps —
	 * the engine counts a digital event as a fraction of one.
	 *
	 * What the next frame's budget is sized from. Eased like `keeping`, so one
	 * frame that happened to share the machine with something else does not
	 * halve the next.
	 */
	private stepsPerMs: number | null = null;
	private workSoFar = 0;
	/** The step ceiling across a window: what the screen resolves. */
	private fine: number;

	constructor(
		netlist: unknown,
		maxStep: number,
		private readonly host: AcquisitionHost
	) {
		this.fine = maxStep;
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

	/**
	 * Follow a change of timebase: the run's step ceiling tracks the screen.
	 *
	 * Set when the run began from the width of the screen, and a screen zoomed
	 * in ten times while the run is going would otherwise be twenty samples
	 * wide. Nothing already solved changes; what comes next is solved finer.
	 */
	setMaxStep(step: number): void {
		this.fine = step;
		this.run.setMaxStep(step);
	}

	private step = (now: number) => {
		const wall = Math.min((now - this.lastWall) / 1000, MAX_FRAME);
		this.lastWall = now;

		const asked = wall * this.host.rate();
		const target = this.run.time + asked;
		let until = this.limit === null ? target : Math.min(target, this.limit);

		const from = this.run.time;
		const budget =
			this.stepsPerMs === null ? OPENING_BUDGET : Math.max(LEAST_BUDGET, this.stepsPerMs * ENGINE_MS);
		this.run.setFrameBudget(budget);
		const began = performance.now();
		try {
			// Coarsely up to where the window that will be drawn opens, if the
			// frame carries more than a window; then finely across it.
			const window = this.fine * SAMPLES_PER_WINDOW;
			const opens = until - window;
			let work = this.workSoFar;
			if (opens > from + this.fine) {
				this.run.setMaxStep(Math.max(this.fine, (opens - from) / SAMPLES_BETWEEN_WINDOWS));
				const coarse = this.run.advance(opens);
				this.capture.add(coarse);
				work = coarse.stats.work;
				this.run.setMaxStep(this.fine);
				// What is left of the frame's share, if it got there at all.
				const remaining = budget - (work - this.workSoFar);
				if (this.run.time < opens - this.fine || remaining < LEAST_BUDGET) {
					until = this.run.time;
				} else {
					this.run.setFrameBudget(remaining);
				}
			}
			if (until > this.run.time) {
				const chunk = this.run.advance(until);
				this.capture.add(chunk);
				work = chunk.stats.work;
			}
			// Work is counted from the start of the run; the frame's share is the
			// difference. Timed around the whole call, since the samples coming back
			// across the boundary are part of what the frame paid for.
			const steps = work - this.workSoFar;
			this.workSoFar = work;
			const spent = performance.now() - began;
			if (steps > 0 && spent > 0.5) {
				const measured = steps / spent;
				this.stepsPerMs =
					this.stepsPerMs === null ? measured : this.stepsPerMs * 0.7 + measured * 0.3;
			}
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
