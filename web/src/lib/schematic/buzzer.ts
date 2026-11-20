/**
 * A passive piezo buzzer: what it is, electrically, and what it is playing.
 *
 * A passive piezo is a ceramic disc with a terminal on each face, which is a
 * capacitor: 20 nF is typical of the 12 mm ones in Arduino kits. Driven by a
 * square wave it draws a spike of charge at every edge, 2·C·V a period, and
 * nothing in between. The netlist does not build it as a capacitor: resolving
 * the microsecond spike at each of thousands of edges a second tripled what a
 * run with one costs, and put an Uno playing a tune well behind real time.
 * It is the resistance that draws the same average current at 1 kHz instead
 * — 1 / (2·C·1 kHz), 25 kΩ for 20 nF, 0.2 mA from a 5 V pin — which is the
 * load the pin and the supply see, without the spikes nobody can see at the
 * scope's resolution anyway. No series resistor is needed, as none is on the
 * bench. It has no oscillator of its own: it sounds at whatever it is driven
 * at, which is what `tone()` is for.
 *
 * What it plays is read in the engine (`buzzer.rs`), off the logic nets that
 * drive its legs, where every edge is exact: a tone is a run of periods that
 * agree. Here they are kept for the run, so the drawing and the inspector can
 * say what was sounding at any instant playback shows, and the speaker can
 * play it (`sound.ts`).
 */

export const BUZZER_KIND = 'buzzer';

/** The disc's capacitance, as the catalog's default. */
export const PIEZO_CAPACITANCE = 20e-9;

/** The drive frequency the disc's resistance is matched at. */
const MATCHED_AT = 1000;

/** The resistance standing in for a disc of `capacitance`: its average current at 1 kHz. */
export function piezoResistance(capacitance: number): number {
	return 1 / (2 * Math.max(capacitance, 1e-15) * MATCHED_AT);
}

/**
 * The engine's name for a buzzer's ear. The disc's load is the component
 * under the part's own name, which is what the current on the drawing is read from.
 */
export function buzzerDevice(part: string): string {
	return `${part}:ear`;
}

/** The part a buzzer's ear belongs to. */
export function buzzerPart(device: string): string {
	return device.replace(/:ear$/, '');
}

/** A stretch of steady pitch, as the engine reports it. Seconds and hertz. */
export interface ToneSpan {
	start: number;
	/** When it stopped sounding. */
	end: number;
	frequency: number;
}

/** What one buzzer has played during the run. */
export interface BuzzerTrack {
	/** Finished tones, oldest first. */
	tones: ToneSpan[];
	/** How many tones the engine has finished in all: where to ask from next. */
	finished: number;
	/**
	 * The tone still going on as of the last poll. Sounding up to its `end`;
	 * past that silent, unless a later poll says it went on.
	 */
	open: ToneSpan | null;
}

/** What `buzzerState` hands back for one poll. */
export interface BuzzerState {
	tones: ToneSpan[];
	finished: number;
	open: ToneSpan | null;
}

/** Most finished tones kept per buzzer: minutes of a melody, seconds of a siren. */
export const BUZZER_HISTORY = 4096;

export function emptyTrack(): BuzzerTrack {
	return { tones: [], finished: 0, open: null };
}

/** A track with one poll's news added. */
export function absorbTones(track: BuzzerTrack, state: BuzzerState): BuzzerTrack {
	// Most polls finish nothing, and a long tune's history is not copied for them.
	if (state.tones.length === 0) return { tones: track.tones, finished: state.finished, open: state.open };
	const tones = track.tones.concat(state.tones);
	if (tones.length > BUZZER_HISTORY) tones.splice(0, tones.length - BUZZER_HISTORY);
	return { tones, finished: state.finished, open: state.open };
}

/** The tone sounding at `time`, or null for silence. */
export function toneAt(track: BuzzerTrack | undefined, time: number): ToneSpan | null {
	if (!track) return null;
	const open = track.open;
	if (open && open.start <= time && time < open.end) return open;
	// The latest tone that started at or before `time`.
	const { tones } = track;
	let low = 0;
	let high = tones.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (tones[mid].start <= time) low = mid + 1;
		else high = mid;
	}
	const tone = tones[low - 1];
	return tone && time < tone.end ? tone : null;
}

/**
 * What the buzzer is driven at from `from` to `to`: the frequency in force at
 * `from` — null for silence — and every change after it, oldest first.
 */
export function toneChanges(
	track: BuzzerTrack | undefined,
	from: number,
	to: number
): Array<{ at: number; frequency: number | null }> {
	const changes: Array<{ at: number; frequency: number | null }> = [
		{ at: from, frequency: toneAt(track, from)?.frequency ?? null }
	];
	if (!track) return changes;
	const all = track.open ? [...track.tones, track.open] : track.tones;
	const edges: Array<{ at: number; frequency: number | null }> = [];
	for (let i = all.length - 1; i >= 0; i--) {
		const tone = all[i];
		if (tone.end <= from) break;
		if (tone.start > from && tone.start <= to) edges.push({ at: tone.start, frequency: tone.frequency });
		if (tone.end > from && tone.end <= to) edges.push({ at: tone.end, frequency: null });
	}
	// A tone ending where the next begins is one change, to the next one's pitch.
	edges.sort((a, b) => a.at - b.at || (a.frequency === null ? -1 : 1));
	for (const edge of edges) {
		const last = changes[changes.length - 1];
		if (last.at === edge.at) last.frequency = edge.frequency;
		else if (last.frequency !== edge.frequency) changes.push(edge);
	}
	return changes;
}

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/**
 * The equal-tempered note a frequency is, against A4 = 440 Hz, or null when
 * it is more than a quarter of a semitone from any: `tone()` rounds to the
 * timer's count, which leaves a note a few cents out, not a quarter-tone.
 */
export function noteName(frequency: number): string | null {
	if (!(frequency > 0)) return null;
	const semitones = 12 * Math.log2(frequency / 440);
	const nearest = Math.round(semitones);
	if (Math.abs(semitones - nearest) > 0.25) return null;
	const midi = 69 + nearest;
	if (midi < 0 || midi > 127) return null;
	return `${NOTES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

/** The range a person hears. Outside it, a tone is shown but not played. */
export function audible(frequency: number): boolean {
	return frequency >= 20 && frequency <= 20_000;
}
