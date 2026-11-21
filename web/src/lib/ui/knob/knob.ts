/**
 * How a knob turns: from a drag, a wheel and the keys to a value, and from a
 * value to an angle. Kept apart from the component, so the canvas turns a
 * part with the same arithmetic as the inspector.
 */

export interface KnobRange {
	min: number;
	max: number;
	/** One arrow key, or one notch of a wheel. */
	step: number;
	/** PageUp and PageDown. */
	largeStep: number;
}

/** A position knob: 0 to 1, a hundredth a key, a tenth a page. */
export const UNIT_RANGE: KnobRange = { min: 0, max: 1, step: 0.01, largeStep: 0.1 };

/** A knob over `min` to `max`, a hundredth of it a key and a tenth a page. */
export function rangeOf(min = 0, max = 1): KnobRange {
	const span = max - min;
	return { min, max, step: span / 100, largeStep: span / 10 };
}

/** The arc the pointer travels, in degrees, centred on straight up. */
export const SWEEP = 270;

/** Pixels of vertical drag for the whole range. Shift makes a drag ten times finer. */
export const DRAG_PIXELS = 160;

/** Within range, and rounded clear of float noise: 0.1 + 0.2 lands on 0.3. */
export function settle(value: number, range: KnobRange): number {
	const clamped = Math.min(Math.max(value, range.min), range.max);
	return Number(clamped.toPrecision(10));
}

/** Where `value` sits in the range, from 0 to 1. */
export function fraction(value: number, range: KnobRange): number {
	const span = range.max - range.min;
	return span > 0 ? (settle(value, range) - range.min) / span : 0;
}

/** The pointer's angle for `value`, in degrees clockwise from straight up. */
export function angleOf(value: number, range: KnobRange): number {
	return -SWEEP / 2 + fraction(value, range) * SWEEP;
}

/**
 * The value a drag has turned to. `dy` is screen pixels since the press,
 * down positive, so dragging up turns the knob up — the way a hand reads a
 * knob whatever side it is on.
 */
export function dragTo(start: number, dy: number, range: KnobRange, fine = false): number {
	const span = range.max - range.min;
	const by = (-dy / DRAG_PIXELS) * span * (fine ? 0.1 : 1);
	return settle(start + by, range);
}

/** One notch of a wheel: a step, up for a wheel rolled away. */
export function wheelTo(value: number, deltaY: number, range: KnobRange, fine = false): number {
	if (deltaY === 0) return settle(value, range);
	const step = fine ? range.step / 10 : range.step;
	return settle(value + (deltaY < 0 ? step : -step), range);
}

/** What a key turns the knob to, or null for a key that does not turn it. */
export function keyTo(value: number, key: string, range: KnobRange, shift = false): number | null {
	const step = shift ? range.largeStep : range.step;
	switch (key) {
		case 'ArrowUp':
		case 'ArrowRight':
			return settle(value + step, range);
		case 'ArrowDown':
		case 'ArrowLeft':
			return settle(value - step, range);
		case 'PageUp':
			return settle(value + range.largeStep, range);
		case 'PageDown':
			return settle(value - range.largeStep, range);
		case 'Home':
			return range.min;
		case 'End':
			return range.max;
		default:
			return null;
	}
}

/** A fraction as a percentage, to a tenth where a tenth is there: 35 %, 12.5 %. */
export function percent(value: number, range: KnobRange): string {
	const p = Math.round(fraction(value, range) * 1000) / 10;
	return `${p} %`;
}

/**
 * Read a typed percentage: `35`, `35 %`, `12.5%`. Null for anything else.
 * Clamped to the range, as a turn would be.
 */
export function readPercent(text: string, range: KnobRange): number | null {
	const match = /^\s*(-?\d+(?:[.,]\d+)?)\s*%?\s*$/.exec(text);
	if (!match) return null;
	const p = Number(match[1].replace(',', '.'));
	if (!Number.isFinite(p)) return null;
	return settle(range.min + (p / 100) * (range.max - range.min), range);
}

/** An SVG arc around (`cx`, `cy`) from angle `from` to `to`, in the knob's degrees. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
	const point = (degrees: number) => {
		const radians = (degrees * Math.PI) / 180;
		return `${(cx + r * Math.sin(radians)).toFixed(2)} ${(cy - r * Math.cos(radians)).toFixed(2)}`;
	};
	const large = Math.abs(to - from) > 180 ? 1 : 0;
	const sweep = to >= from ? 1 : 0;
	return `M${point(from)} A${r} ${r} 0 ${large} ${sweep} ${point(to)}`;
}
