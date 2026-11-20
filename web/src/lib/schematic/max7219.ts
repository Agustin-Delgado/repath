/**
 * The 8×8 LED matrix module on a MAX7219: how it is drawn, and what a run
 * reports about it.
 *
 * The board everybody buys: a 1088AS matrix of red LEDs on a MAX7219 driver,
 * with VCC, GND, DIN, CS and CLK on a header at one end and DOUT at the other,
 * for chaining the next module. The engine simulates the driver on the wires
 * (`spi` in repath-core): it shifts DIN in on CLK's rising edge and latches
 * the last sixteen bits as CS rises, whether the bits come from the
 * microcontroller's SPI or from `shiftOut()`. The editor places it, wires it,
 * and paints the dots the driver lights.
 */

import type { Rect } from '$lib/canvas';

export const MATRIX_KIND = 'max7219';

/** Rows and columns of dots. */
export const MATRIX_SIZE = 8;

// ---- geometry ------------------------------------------------------------

/** The input header, top to bottom, as printed on the board. */
export const MATRIX_LEGS = ['VCC', 'GND', 'DIN', 'CS', 'CLK'] as const;
/** Where the input legs end, left of the board, and DOUT, right of it. */
export const MATRIX_LEG_X = -80;
export const MATRIX_OUT_X = 80;
/** Ten apart, on the grid, centred on the board. */
export const matrixLegY = (index: number) => (index - 2) * 10;

/** The circuit board, and the matrix sitting on it. */
export const MATRIX_BOARD: Rect = { x: -62, y: -50, w: 124, h: 100 };
export const MATRIX_FACE: Rect = { x: -42, y: -42, w: 84, h: 84 };

/** From one dot to the next, and how big each LED is. */
const PITCH = 10;
export const DOT_RADIUS = 3.6;

/** The centre of the dot at `row` (0 at the top) and `column` (0 at the left). */
export function matrixDot(row: number, column: number): { x: number; y: number } {
	const first = -((MATRIX_SIZE - 1) / 2) * PITCH;
	return { x: first + column * PITCH, y: first + row * PITCH };
}

/**
 * Whether the dot at `row` and `column` is lit in a digit's byte. Digit 0 is
 * the top row and D7 its leftmost dot, as LedControl's `setRow()` and
 * `setLed()` have it.
 */
export function dotLit(lit: readonly number[], row: number, column: number): boolean {
	return ((lit[row] ?? 0) >> (7 - column)) & 1 ? true : false;
}

// ---- what a run reports --------------------------------------------------

/** The matrix at one instant, as the engine's `max7219State` gives it. */
export interface MatrixFrame {
	/** The instant the driver's registers last changed, in simulated seconds. */
	time: number;
	version: number;
	/** The eight rows as driven, after shutdown, the display test, the scan limit and decoding. */
	lit: number[];
	/** The intensity register's duty cycle, 1/32 to 31/32. */
	duty: number;
}

/** How many changes of one matrix a run keeps, oldest dropped first. */
export const MATRIX_HISTORY = 4000;

/** Whether two frames light the same dots as brightly. */
export function sameMatrix(a: MatrixFrame, b: MatrixFrame): boolean {
	return a.duty === b.duty && a.lit.every((row, i) => row === b.lit[i]);
}
