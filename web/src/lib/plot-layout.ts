/**
 * Where things go on the scope and the Bode plot, worked out apart from the
 * canvas that draws them.
 *
 * Every number here used to be arithmetic inline in a draw function, which is
 * why nobody noticed when it went wrong: a lane name pushed off the left edge,
 * eight logic lanes squeezing the analog plot down to ten pixels, the grid
 * following one channel's gain knob. Pulled out, each is a function of a few
 * numbers and can be held to what it should give.
 */

import { measure, type Measurements } from './measure';
import { visibleRange } from './plot';

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** Heights of a logic lane, in CSS pixels. */
export const LANE = {
	/** What a lane gets when there is room. */
	full: 26,
	/** Below this a lane's two levels can no longer be told apart. */
	least: 14,
	/** A purely digital scope stretches its lanes up to this. */
	most: 64
} as const;

/** The least the analog plot is squeezed to when logic lanes want its room. */
export const ANALOG_LEAST = 48;

export interface ScopeLayout {
	plot: Rect;
	/** Height of one logic lane. */
	lane: number;
	/** How many lanes are drawn, from the first. */
	shown: number;
	/** How many lanes there was no room for. */
	hidden: number;
}

/**
 * Split the scope between the analog plot and the logic lanes.
 *
 * Lanes shrink before the analog plot does, and the analog plot keeps a floor
 * of its own — a third of the height or `ANALOG_LEAST`, whichever is more —
 * rather than being handed whatever the lanes left. When even the smallest
 * lanes do not fit, the ones that do are drawn and the rest are counted, so
 * the scope can say how many it could not show instead of drawing them over
 * the time axis.
 */
export function scopeLayout(options: {
	width: number;
	height: number;
	padding: { left: number; right: number; top: number; bottom: number };
	analog: boolean;
	lanes: number;
}): ScopeLayout {
	const { width, height, padding, analog, lanes } = options;
	const available = Math.max(height - padding.top - padding.bottom, 20);
	const plotWidth = Math.max(width - padding.left - padding.right, 10);
	const at = (h: number, lane: number, shown: number): ScopeLayout => ({
		plot: { x: padding.left, y: padding.top, w: plotWidth, h },
		lane,
		shown,
		hidden: lanes - shown
	});

	if (lanes === 0) return at(analog ? available : 0, LANE.full, 0);

	if (!analog) {
		const lane = Math.min(LANE.most, available / lanes);
		if (lane >= LANE.least) return at(0, lane, lanes);
		return at(0, LANE.least, Math.min(lanes, Math.floor(available / LANE.least)));
	}

	const floor = Math.min(available, Math.max(ANALOG_LEAST, available / 3));
	const room = available - floor;
	const lane = Math.min(LANE.full, Math.max(LANE.least, room / lanes));
	const shown = Math.min(lanes, Math.floor(room / lane + 1e-9));
	return at(available - shown * lane, lane, shown);
}

/**
 * How wide the left margin has to be for the widest name in it.
 *
 * Never narrower than the volts need (`least`), and never more than a share of
 * the scope's width: past that a name is shortened rather than the plot.
 */
export function marginFor(
	labels: readonly string[],
	measureText: (text: string) => number,
	options: { least: number; width: number; share?: number; gap?: number }
): number {
	const { least, width, share = 0.3, gap = 16 } = options;
	let widest = 0;
	for (const label of labels) widest = Math.max(widest, measureText(label));
	const most = Math.max(least, width * share);
	return Math.min(Math.max(least, Math.ceil(widest + gap)), most);
}

/**
 * Shorten a name to fit, by taking characters out of its middle.
 *
 * The middle rather than the end, because both ends carry the meaning: a probe
 * label is `y · U1.B` and a net is `BUTTON.p+1`, and the part that tells two
 * lanes apart is as often the tail as the head.
 */
export function fitLabel(text: string, room: number, measureText: (text: string) => number): string {
	if (measureText(text) <= room) return text;
	const chars = [...text];
	for (let keep = chars.length - 1; keep > 0; keep--) {
		const head = Math.ceil(keep / 2);
		const tail = keep - head;
		const candidate = chars.slice(0, head).join('') + '…' + (tail ? chars.slice(-tail).join('') : '');
		if (measureText(candidate) <= room) return candidate;
	}
	return '…';
}

/**
 * Where a voltage falls on the shared axis, with no channel's knobs applied.
 *
 * The grid and its labels describe the axis itself. Mapping them through the
 * first trace's gain and offset made them follow that one channel's knob —
 * pushed out of the plot and over the lanes, and labelled for a scale only one
 * of the traces was drawn at.
 */
export function axisY(range: { lo: number; hi: number }, plot: Rect, v: number): number {
	return plot.y + plot.h - ((v - range.lo) / (range.hi - range.lo)) * plot.h;
}

/**
 * Below this, a reading is the solver's rounding rather than the circuit.
 *
 * Relative to the size of the signal it came from, with an absolute floor for
 * a signal that is itself nothing: a node sitting at zero reported a
 * peak-to-peak of 8.88 fV, which is the last bits of a double and reads as a
 * measurement.
 */
export function settleReading(value: number, scale: number): number {
	if (!Number.isFinite(value)) return value;
	const floor = Math.max(Math.abs(scale) * 1e-9, 1e-12);
	return Math.abs(value) < floor ? 0 : value;
}

/**
 * The scope's measurements of what is on screen.
 *
 * Taken over the window, not the whole memory: zoomed into one cycle, a
 * peak-to-peak taken over everything held disagreed with the trace beside it.
 * Rounding noise is settled to zero against the signal's own size.
 */
export function measureVisible(
	time: Float64Array,
	samples: Float64Array,
	from: number,
	to: number
): Measurements | null {
	// The drawing's range takes one sample either side so the line reaches the
	// frame; a measurement takes only what is inside it.
	let { start, end } = visibleRange(time, from, to);
	if (start < end && time[start] < from) start++;
	if (end > start && time[end - 1] > to) end--;
	const m = measure(time.subarray(start, end), samples.subarray(start, end));
	if (!m) return null;
	const scale = Math.max(Math.abs(m.max), Math.abs(m.min));
	return {
		...m,
		peakToPeak: settleReading(m.peakToPeak, scale),
		mean: settleReading(m.mean, scale),
		rms: settleReading(m.rms, scale)
	};
}

/**
 * Where the playhead is, in whole pixels across the plot.
 *
 * Relative to the window on screen, which is what the line is drawn against;
 * the redraw is keyed on this, so the scope repaints when the line moves a
 * pixel and not on every sub-pixel step of the animation.
 */
export function playheadPixel(at: number, span: { from: number; to: number }, plotWidth: number): number {
	const width = Math.max(span.to - span.from, 1e-15);
	const clamped = Math.min(Math.max(at, span.from), span.to);
	return Math.round(((clamped - span.from) / width) * plotWidth);
}

/**
 * The two panels of a Bode plot: magnitude above, phase below, a gap between.
 *
 * Each is a clip as well as a frame. A deep null is floored far below the
 * magnitude axis, and drawn unclipped it ran down through the phase panel.
 */
export function bodePanels(
	size: { width: number; height: number },
	padding: { left: number; right: number; top: number; bottom: number },
	share = 0.62,
	gap = 10
): { magnitude: Rect; phase: Rect } {
	const w = Math.max(size.width - padding.left - padding.right, 10);
	const total = Math.max(size.height - padding.top - padding.bottom, 20);
	const magH = total * share;
	const phaseTop = padding.top + magH + gap;
	return {
		magnitude: { x: padding.left, y: padding.top, w, h: magH },
		phase: { x: padding.left, y: phaseTop, w, h: Math.max(total - magH - gap, 10) }
	};
}

/**
 * A step for the phase axis, in degrees a reader expects.
 *
 * The decade ladder that suits volts and decibels gives a phase axis marked at
 * 0° and −100°, which no one reads a phase in. Steps here are the divisions of
 * a turn: 15°, 30°, 45°, 90°, 180°.
 */
export function phaseStep(span: number, target = 4): number {
	const raw = Math.abs(span) / Math.max(target, 1);
	for (const step of [1, 2, 5, 10, 15, 30, 45, 90, 180]) if (step >= raw) return step;
	return 360;
}

/** Multiples of `step` inside [lo, hi]. */
export function stepsWithin(lo: number, hi: number, step: number): number[] {
	const out: number[] = [];
	if (!(step > 0) || !Number.isFinite(lo) || !Number.isFinite(hi)) return out;
	for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + 1e-9; k++) {
		// `+ 0` turns a -0 into a 0, which would otherwise be labelled "-0°".
		out.push(k * step + 0);
	}
	return out;
}
