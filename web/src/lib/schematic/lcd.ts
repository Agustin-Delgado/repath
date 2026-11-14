/**
 * The 16×2 character LCD on an I2C backpack: how it is drawn, and what a run
 * reports about it.
 *
 * The module is the HD44780 display with a PCF8574 expander soldered to its
 * back, which is how nearly everybody buys one — four wires, GND, VCC, SDA
 * and SCL, instead of sixteen. The engine simulates both chips (`i2c` in
 * repath-core); the editor only places it, wires it, and paints what the
 * engine says the glass shows.
 */

import type { Rect } from '$lib/canvas';

export const LCD_KIND = 'lcd1602';

/** Columns and lines of the glass. */
export const LCD_COLUMNS = 16;
export const LCD_LINES = 2;

const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;

function address(chip: string, value: number, jumpers: number) {
	const open = [2, 1, 0].filter((bit) => jumpers & (1 << bit)).map((bit) => `A${bit}`);
	const state =
		open.length === 3 ? 'jumpers open' : open.length === 0 ? 'all bridged' : `${open.join(' ')} open`;
	return { value: hex(value), label: `${hex(value)} — ${chip}, ${state}` };
}

/**
 * The addresses a backpack can be set to. The A0–A2 jumpers on its back are
 * pulled up, so all three open is 0x27 on the PCF8574T and 0x3F on the
 * PCF8574AT, the two chips the boards come with; bridging a pair pulls that
 * bit low.
 */
export const LCD_ADDRESSES: ReadonlyArray<{ value: string; label: string }> = [
	...[7, 6, 5, 4, 3, 2, 1, 0].map((a) => address('PCF8574T', 0x20 + a, a)),
	...[7, 6, 5, 4, 3, 2, 1, 0].map((a) => address('PCF8574AT', 0x38 + a, a))
];

export const DEFAULT_LCD_ADDRESS = '0x27';

/** The 7-bit address a module's parameter names; the default for anything unreadable. */
export function lcdAddress(value: unknown): number {
	const parsed = Number.parseInt(String(value ?? DEFAULT_LCD_ADDRESS), 16);
	return Number.isInteger(parsed) && parsed >= 0 && parsed < 0x80 ? parsed : 0x27;
}

// ---- geometry ------------------------------------------------------------

/** The header on the backpack, top to bottom, as printed beside its pins. */
export const LCD_LEGS = ['GND', 'VCC', 'SDA', 'SCL'] as const;
/** Where the legs end, left of the board. */
export const LCD_LEG_X = -120;
/** Ten apart, on the grid: the header is 2.54 mm on a board 36 mm tall. */
export const lcdLegY = (index: number) => (index - 1) * 10;

/** The circuit board, the bezel round the glass, and the glass. */
export const LCD_BOARD: Rect = { x: -100, y: -40, w: 200, h: 80 };
export const LCD_BEZEL: Rect = { x: -76, y: -26, w: 160, h: 52 };
export const LCD_GLASS: Rect = { x: -72, y: -20, w: 152, h: 40 };

/** From one dot to the next, and the gaps between characters and lines. */
const DOT = 1.6;
const CHAR_GAP = 1.2;
const LINE_GAP = 2.4;
const CELL_W = 5 * DOT + CHAR_GAP;
const CELL_H = 8 * DOT + LINE_GAP;
/** Each dot is a little smaller than its pitch, as on the glass. */
export const DOT_SIZE = DOT * 0.82;

const MATRIX_W = LCD_COLUMNS * CELL_W - CHAR_GAP;
const MATRIX_H = LCD_LINES * CELL_H - LINE_GAP;
const MATRIX_X = LCD_GLASS.x + (LCD_GLASS.w - MATRIX_W) / 2;
const MATRIX_Y = LCD_GLASS.y + (LCD_GLASS.h - MATRIX_H) / 2;

/** The top-left corner of dot (`row`, `column`) of character position `cell`. */
export function dotAt(cell: number, row: number, column: number): { x: number; y: number } {
	const line = Math.floor(cell / LCD_COLUMNS);
	const position = cell % LCD_COLUMNS;
	return {
		x: MATRIX_X + position * CELL_W + column * DOT,
		y: MATRIX_Y + line * CELL_H + row * DOT
	};
}

// ---- what a run reports --------------------------------------------------

/** The glass at one instant, as the engine's `lcdState` gives it. */
export interface LcdFrame {
	/** The instant it is as of, in simulated seconds. */
	time: number;
	version: number;
	backlight: boolean;
	/** 32 character positions, line by line; eight rows of five dots each, leftmost as bit 4. */
	cells: number[][];
	cursor: number | null;
	blink: number | null;
	/** The controller is in the 1-line mode it powers up in: the first line shows as blocks. */
	overdriven: boolean;
	blinkInterval: number;
}

/**
 * How many changes of one display a run keeps, oldest dropped first: a
 * counter ticking ten times a second can be scrubbed back through six
 * minutes of it.
 */
export const LCD_HISTORY = 4000;

/** Whether two frames show the same thing, whenever each was taken. */
export function sameGlass(a: LcdFrame, b: LcdFrame): boolean {
	return (
		a.backlight === b.backlight &&
		a.overdriven === b.overdriven &&
		a.cursor === b.cursor &&
		a.blink === b.blink &&
		a.cells.every((rows, cell) => rows.every((row, i) => row === b.cells[cell]?.[i]))
	);
}

/**
 * What the display showed at `time`: the newest frame as of then, or the
 * first there is for an instant before any — a display is read at the end
 * of each piece of a run, so the first frame stands for everything before.
 */
export function frameAt(history: readonly LcdFrame[], time: number): LcdFrame | null {
	if (history.length === 0) return null;
	let lo = 0;
	let hi = history.length - 1;
	if (history[0].time > time) return history[0];
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (history[mid].time <= time) lo = mid;
		else hi = mid - 1;
	}
	return history[lo];
}

/**
 * The dots of each character position as they show at `time`: the cursor's
 * underline on the eighth row, and the blinking position all dark on every
 * other interval.
 */
export function shownCells(frame: LcdFrame, time: number): number[][] {
	return frame.cells.map((rows, cell) => {
		if (cell === frame.blink && Math.floor(time / frame.blinkInterval) % 2 === 0) {
			return rows.map(() => 0x1f);
		}
		if (cell === frame.cursor) return rows.map((row, i) => (i === 7 ? 0x1f : row));
		return rows;
	});
}
