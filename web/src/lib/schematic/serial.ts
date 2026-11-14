/**
 * The serial monitor's sending half: what typing into it puts on the chip's RX.
 *
 * On an Uno the monitor talks to a second chip, the USB-serial converter, whose
 * TX reaches the 328P's RXD (D0) through a 1 kΩ resistor. The netlist builds
 * that converter beside every microcontroller (`usb_serial` in the engine), and
 * what is typed goes out of it as UART frames at the baud rate chosen here —
 * which, as in the Arduino IDE, is the person's choice and not read off the
 * sketch, so a monitor left at the wrong rate garbles what it sends exactly as
 * a real one does. The panel compares the two and says so.
 */

/** What the monitor adds after the text, as the Arduino IDE offers it. */
export type LineEnding = 'none' | 'newline' | 'cr' | 'both';

export const LINE_ENDINGS: readonly { id: LineEnding; label: string; bytes: string }[] = [
	{ id: 'none', label: 'No line ending', bytes: '' },
	{ id: 'newline', label: 'Newline', bytes: '\n' },
	{ id: 'cr', label: 'Carriage return', bytes: '\r' },
	{ id: 'both', label: 'Both NL & CR', bytes: '\r\n' }
];

/** The IDE's default, and what a monitor opens with. */
export const DEFAULT_LINE_ENDING: LineEnding = 'newline';

/** The rates the IDE's monitor offers. */
export const BAUD_RATES: readonly number[] = [
	300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 500000,
	1000000, 2000000
];

export const DEFAULT_BAUD = 9600;

/** The resistor between the converter's TX and D0 on an Uno. */
export const USB_SERIAL_OHMS = 1e3;

/** The engine's name for a microcontroller's converter. */
export function usbSerialName(mcu: string): string {
	return `${mcu}:usb`;
}

/** The bytes sent for `text`: UTF-8, as the IDE sends it, then the line ending. */
export function serialBytes(text: string, ending: LineEnding): Uint8Array {
	const tail = LINE_ENDINGS.find((e) => e.id === ending)?.bytes ?? '';
	return new TextEncoder().encode(text + tail);
}

/**
 * The rate the converter really sends at when asked for `baud`: the 16U2's
 * divider is a whole number of ticks, as in `UsbSerial::bit_time`.
 */
export function converterBaud(baud: number): number {
	const b = Math.max(1, Math.round(baud));
	const cycles =
		b === 57600
			? 16 * Math.floor((1_000_000 + Math.floor(b / 2)) / b)
			: 8 * Math.floor((2_000_000 + Math.floor(b / 2)) / b);
	return 16e6 / Math.max(cycles, 8);
}

/**
 * How far apart the monitor's rate and the chip's are, as a fraction, past
 * which they are worth a warning. The datasheet recommends a receiver see no
 * more than about 2 % between the two for 8-bit frames; past that bytes start
 * to come out wrong, and well past it every one does.
 */
export const BAUD_TOLERANCE = 0.02;

/** Whether a chip listening at `listening` baud will garble what the monitor sends at `baud`. */
export function baudMismatch(baud: number, listening: number): boolean {
	return Math.abs(converterBaud(baud) / listening - 1) > BAUD_TOLERANCE;
}
