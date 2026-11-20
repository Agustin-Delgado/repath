/**
 * The speaker: the buzzers' tones, played through Web Audio as the run goes.
 *
 * Off until somebody turns it on. A page may only start making sound after a
 * click, and a simulator that beeps the moment an example opens is one people
 * close; so the context is created by the click that turns sound on.
 *
 * # Pitch and playback speed
 *
 * The run is rarely at real time: a window of 40 ms at 1× is a hundredth of
 * it, one of 40 s ten times it. Playing the run as a tape would — pitch
 * scaled with speed — would turn a 440 Hz note into 4.4 Hz at the first and
 * ultrasound at the second, both silent. So a tone always sounds at the
 * frequency the circuit drives it at, and the speed sets only how long it
 * lasts: at a tenth of real time each note is held ten times as long, the
 * way the scope at a slow sweep shows the same frequency, drawn wider.
 *
 * Paused, or looking back through a stopped run, it is silent: there is no
 * moving instant to play.
 *
 * Each frame plays the stretch of simulated time the run covered since the
 * last one, spread over the next frame's worth of audio. Changes inside the
 * stretch land where they belong in it rather than on the frame, so a beep
 * shorter than a frame is still heard; the cost is a frame of delay.
 */

import { audible, toneChanges, type BuzzerTrack } from './schematic/buzzer';

/** The parts of the Web Audio API used here, so a test can stand in for it. */
export interface AudioParamLike {
	value: number;
	setValueAtTime(value: number, time: number): unknown;
	setTargetAtTime(value: number, time: number, constant: number): unknown;
	cancelScheduledValues(time: number): unknown;
}

export interface ToneVoice {
	frequency: AudioParamLike;
	gain: AudioParamLike;
	stop(): void;
}

export interface SpeakerContext {
	readonly currentTime: number;
	readonly sampleRate: number;
	/** A square-wave oscillator into its own gain, connected, started silent. */
	voice(): ToneVoice;
	resume(): Promise<unknown>;
	suspend(): Promise<unknown>;
}

/** How far ahead of the audio clock the first piece is scheduled, in seconds. */
const LEAD = 0.04;

/** Each buzzer's level. A square wave is loud for its amplitude; this is a beep, not an alarm. */
const LEVEL = 0.05;

/** How fast a voice comes on and goes off, as a time constant: a click-free edge, no more. */
const EDGE = 0.002;

/** The longest frame taken as one stretch; past it the clock has jumped, and play starts over. */
const LONGEST_FRAME = 0.25;

/** Web Audio's own: an oscillator into a gain into the speakers. */
export function webAudio(): SpeakerContext | null {
	const Context =
		globalThis.AudioContext ??
		(globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Context) return null;
	const context = new Context();
	return {
		get currentTime() {
			return context.currentTime;
		},
		get sampleRate() {
			return context.sampleRate;
		},
		voice() {
			const oscillator = context.createOscillator();
			oscillator.type = 'square';
			const gain = context.createGain();
			gain.gain.value = 0;
			oscillator.connect(gain).connect(context.destination);
			oscillator.start();
			return {
				frequency: oscillator.frequency,
				gain: gain.gain,
				stop() {
					oscillator.stop();
					oscillator.disconnect();
					gain.disconnect();
				}
			};
		},
		resume: () => context.resume(),
		suspend: () => context.suspend()
	};
}

export class Speaker {
	private context: SpeakerContext | null = null;
	private readonly voices = new Map<string, ToneVoice>();
	/** Audio time the last stretch was scheduled up to; null when nothing is playing. */
	private cursor: number | null = null;
	on = false;

	constructor(private readonly open: () => SpeakerContext | null = webAudio) {}

	/**
	 * Turn sound on. Call from the click that asks for it: that is what lets
	 * the context start. False where the browser has no Web Audio.
	 */
	async enable(): Promise<boolean> {
		this.context ??= this.open();
		if (!this.context) return false;
		this.on = true;
		await this.context.resume();
		return true;
	}

	disable(): void {
		this.on = false;
		this.silence();
		void this.context?.suspend();
	}

	/**
	 * Play what each buzzer did from `from` to `to` in simulated time, which the
	 * run covered in the last `wall` seconds.
	 */
	play(tracks: ReadonlyMap<string, BuzzerTrack>, from: number, to: number, wall: number): void {
		const context = this.context;
		if (!this.on || !context) return;
		if (!(to > from) || !(wall > 0) || wall > LONGEST_FRAME) {
			// Nothing moved, or the clock jumped: start again from the instant.
			if (wall > LONGEST_FRAME) this.cursor = null;
			return;
		}
		const now = context.currentTime;
		const start = this.cursor === null || this.cursor < now ? now + LEAD : this.cursor;
		const scale = wall / (to - from);
		const nyquist = context.sampleRate / 2;
		for (const [name, track] of tracks) {
			let voice = this.voices.get(name);
			if (!voice) {
				voice = context.voice();
				this.voices.set(name, voice);
			}
			for (const change of toneChanges(track, from, to)) {
				const at = start + (change.at - from) * scale;
				const frequency = change.frequency;
				if (frequency !== null && audible(frequency) && frequency < nyquist) {
					voice.frequency.setValueAtTime(frequency, at);
					voice.gain.setTargetAtTime(LEVEL, at, EDGE);
				} else {
					voice.gain.setTargetAtTime(0, at, EDGE);
				}
			}
		}
		this.cursor = start + wall;
	}

	/** Stop every voice where it is: paused, stopped, or the run thrown away. */
	silence(): void {
		this.cursor = null;
		const context = this.context;
		if (!context) return;
		for (const voice of this.voices.values()) {
			voice.gain.cancelScheduledValues(context.currentTime);
			voice.gain.setTargetAtTime(0, context.currentTime, EDGE);
		}
	}

	/** Let go of the voices of a run that is over: the next run has its own buzzers. */
	release(): void {
		this.silence();
		for (const voice of this.voices.values()) voice.stop();
		this.voices.clear();
	}

	/** The frequency each buzzer's voice was last set to, for a test or a readout. */
	frequencies(): Map<string, number> {
		return new Map([...this.voices].map(([name, voice]) => [name, voice.frequency.value]));
	}
}
