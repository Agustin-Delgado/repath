/**
 * The scope's trigger: where on a repeating waveform the screen starts, so it
 * holds still instead of rolling past.
 *
 * An edge trigger, as on a bench scope. It fires where the source crosses the
 * level in the chosen direction, but only once it has been armed by going past
 * the level by the hysteresis the other way first — so noise riding on a slow
 * edge, which crosses the level many times on its way through, fires once.
 * After it fires it ignores everything for the holdoff, which is how a burst
 * of pulses is triggered on its first pulse every time rather than on any of
 * them.
 *
 * The finding is incremental. The run grows a chunk at a time, and the memory
 * lets old samples go a depth at a time, so the samples are found again by
 * their time rather than by their index, and each chunk only the new ones are
 * looked at. Done from scratch on every chunk, holdoff would be counted from
 * wherever the memory happened to start, and a burst would be caught on a
 * different pulse each time the memory moved.
 */

export type TriggerEdge = 'rising' | 'falling';
export type TriggerMode = 'off' | 'auto' | 'normal' | 'single';

export interface TriggerSettings {
	mode: TriggerMode;
	/** Which analog trace, counted down the scope's list from 0. */
	source: number;
	/** Volts, or null for halfway between the source's extremes. */
	level: number | null;
	edge: TriggerEdge;
	/** Seconds after a trigger in which no other can fire. */
	holdoff: number;
	/** Fraction of the screen before the trigger: 0.5 puts it in the middle. */
	position: number;
	/** Volts past the level needed to arm, or null for 2% of the source's swing. */
	hysteresis: number | null;
}

export const DEFAULT_TRIGGER: Readonly<TriggerSettings> = {
	mode: 'off',
	source: 0,
	level: null,
	edge: 'rising',
	holdoff: 0,
	position: 0.5,
	hysteresis: null
};

export const TRIGGER_MODES: readonly TriggerMode[] = ['off', 'auto', 'normal', 'single'];

/** Share of the source's swing that the automatic hysteresis is. */
export const AUTO_HYSTERESIS = 0.02;

/** What a level and hysteresis left on automatic come to, for a source spanning `lo` to `hi`. */
export function resolveLevels(
	settings: Pick<TriggerSettings, 'level' | 'hysteresis'>,
	lo: number,
	hi: number
): { level: number; hysteresis: number } {
	const swing = Number.isFinite(hi - lo) ? hi - lo : 0;
	return {
		level: settings.level ?? (Number.isFinite(lo + hi) ? (lo + hi) / 2 : 0),
		hysteresis: Math.max(settings.hysteresis ?? swing * AUTO_HYSTERESIS, 0)
	};
}

/** Where the search had got to, carried from one chunk to the next. */
export interface TriggerScan {
	/** Time of the last sample looked at. */
	scanned: number;
	/** The last sample looked at, for a crossing that straddles two chunks. */
	previous: number | null;
	armed: boolean;
	/** The last trigger that fired, which holdoff counts from. */
	last: number | null;
	/** Every trigger that fired and is still in memory, oldest first. */
	events: number[];
}

export function freshScan(): TriggerScan {
	return { scanned: -Infinity, previous: null, armed: false, last: null, events: [] };
}

/**
 * Look at the samples after `scan.scanned` and add the triggers among them.
 *
 * `level` and `hysteresis` are in volts, already resolved. Triggers older than
 * the first sample still held are forgotten: their screens can no longer be
 * drawn.
 */
export function advance(
	scan: TriggerScan,
	time: ArrayLike<number>,
	samples: ArrayLike<number>,
	options: { level: number; hysteresis: number; edge: TriggerEdge; holdoff: number }
): TriggerScan {
	const count = Math.min(time.length, samples.length);
	if (count === 0) return scan;
	// The first sample not yet looked at, found by its time.
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] <= scan.scanned) lo = mid + 1;
		else hi = mid;
	}
	// Turned around for a falling edge, so one test serves both.
	const sign = options.edge === 'rising' ? 1 : -1;
	const level = sign * options.level;
	const arm = level - options.hysteresis;
	const holdoff = Math.max(options.holdoff, 0);
	let previous = scan.previous === null ? null : sign * scan.previous;
	let previousTime = scan.scanned;
	if (lo > 0 && previous === null) {
		previous = sign * samples[lo - 1];
		previousTime = time[lo - 1];
	}
	let armed = scan.armed;
	let last = scan.last;
	const fired: number[] = [];
	for (let i = lo; i < count; i++) {
		const v = sign * samples[i];
		const t = time[i];
		if (previous !== null && armed && previous < level && v >= level) {
			const span = v - previous;
			const at = previousTime + (t - previousTime) * (span > 0 ? (level - previous) / span : 0);
			if (last === null || at - last >= holdoff) {
				fired.push(at);
				last = at;
				armed = false;
			}
		}
		if (v < arm) armed = true;
		previous = v;
		previousTime = t;
	}
	const earliest = time[0];
	const kept = scan.events.filter((e) => e >= earliest);
	return {
		scanned: time[count - 1],
		previous: previous === null ? null : sign * previous,
		armed,
		last,
		events: fired.length || kept.length !== scan.events.length ? [...kept, ...fired] : scan.events
	};
}

/** Every trigger in a whole trace, from its start. */
export function findTriggers(
	time: ArrayLike<number>,
	samples: ArrayLike<number>,
	options: { level: number; hysteresis: number; edge: TriggerEdge; holdoff: number }
): number[] {
	return advance(freshScan(), time, samples, options).events;
}

export type TriggerStatus =
	/** A trigger holds the screen. */
	| 'triggered'
	/** Auto, with nothing to trigger on lately: the screen rolls. */
	| 'auto'
	/** Normal, and nothing has triggered yet. */
	| 'waiting'
	/** Single, and the trigger it is waiting for has not come. */
	| 'armed'
	/** Single, and caught. */
	| 'captured';

export interface TriggerFrame {
	/** The screen, or null for one that rolls as it would untriggered. */
	window: { from: number; to: number } | null;
	/** The trigger the screen is placed around. */
	at: number | null;
	status: TriggerStatus;
}

/**
 * Which screen to show, given the triggers found.
 *
 * Only a screen whose part after the trigger has been run is shown: one still
 * filling would be half a trace with a blank after it, and a moment later the
 * same screen again with more of it. While the run goes on, auto lets go of a
 * trigger that is more than a screen old, which is a signal that has stopped
 * triggering, and rolls; normal holds the last screen it caught for as long as
 * the memory has it. Single takes the first trigger at or after it was armed
 * and keeps it.
 */
export function pickFrame(
	events: readonly number[],
	options: {
		mode: TriggerMode;
		width: number;
		position: number;
		now: number;
		/** Whether the run is still going: a stopped one has nothing more to wait for. */
		running: boolean;
		/** For single: triggers before this are not the one being waited for. */
		armedAt?: number;
	}
): TriggerFrame {
	const { mode, width, now, running } = options;
	const position = Math.min(Math.max(options.position, 0), 1);
	const frameAt = (at: number) => ({ from: at - position * width, to: at + (1 - position) * width });
	const complete = (at: number) => at + (1 - position) * width <= now + width * 1e-9;
	if (mode === 'off') return { window: null, at: null, status: 'auto' };
	if (mode === 'single') {
		const armedAt = options.armedAt ?? -Infinity;
		for (const at of events) {
			if (at < armedAt) continue;
			if (!complete(at)) break;
			return { window: frameAt(at), at, status: 'captured' };
		}
		return { window: null, at: null, status: 'armed' };
	}
	let latest: number | null = null;
	for (let i = events.length - 1; i >= 0; i--) {
		if (complete(events[i])) {
			latest = events[i];
			break;
		}
	}
	if (latest === null) return { window: null, at: null, status: mode === 'auto' ? 'auto' : 'waiting' };
	if (mode === 'auto' && running && frameAt(latest).to < now - width) {
		return { window: null, at: null, status: 'auto' };
	}
	return { window: frameAt(latest), at: latest, status: 'triggered' };
}

/** A trigger's settings as they arrived, each kept only if it is the kind of thing it says it is. */
export function readTrigger(raw: unknown): TriggerSettings {
	const s = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
	const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	return {
		mode: TRIGGER_MODES.includes(s.mode as TriggerMode) ? (s.mode as TriggerMode) : DEFAULT_TRIGGER.mode,
		source: finite(s.source) && s.source >= 0 ? Math.floor(s.source) : DEFAULT_TRIGGER.source,
		level: finite(s.level) ? s.level : null,
		edge: s.edge === 'falling' ? 'falling' : 'rising',
		holdoff: finite(s.holdoff) && s.holdoff > 0 ? s.holdoff : 0,
		position: finite(s.position) ? Math.min(Math.max(s.position, 0), 1) : DEFAULT_TRIGGER.position,
		hysteresis: finite(s.hysteresis) && s.hysteresis >= 0 ? s.hysteresis : null
	};
}

/**
 * Only what differs from the defaults, or undefined when nothing does: a
 * circuit whose trigger was never touched saves exactly as it did before
 * there was one.
 */
export function compactTrigger(settings: TriggerSettings): Partial<TriggerSettings> | undefined {
	const out: Partial<TriggerSettings> = {};
	for (const key of Object.keys(DEFAULT_TRIGGER) as Array<keyof TriggerSettings>) {
		if (settings[key] !== DEFAULT_TRIGGER[key]) (out as Record<string, unknown>)[key] = settings[key];
	}
	return Object.keys(out).length ? out : undefined;
}
