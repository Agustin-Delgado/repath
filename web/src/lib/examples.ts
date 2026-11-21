/**
 * Circuits that ship with the app.
 *
 * The first thing a simulator has to do is show you something working. An empty
 * canvas asks you to already know how to use it.
 */

import type { Schematic } from './schematic/model';
import { defaultParams, definitionOf } from './schematic/model';
import { SEGMENTS } from './schematic/led';
import { intelHex } from './schematic/firmware';

export interface Example {
	id: string;
	name: string;
	description: string;
	stopTime: number;
	/** Which analysis shows this circuit off. Defaults to transient. */
	analysis?: 'transient' | 'frequency';
	/** Sweep range, for the ones meant to be looked at in the frequency domain. */
	frequencyRange?: { start: number; stop: number };
	build: () => Schematic;
}

let counter = 0;
const nextId = () => `x${++counter}`;

interface Placed {
	kind: string;
	name: string;
	x: number;
	y: number;
	rotation?: 0 | 90 | 180 | 270;
	params?: Record<string, number | string>;
}

function build(parts: Placed[], wires: Array<[number, number, number, number]>): Schematic {
	return {
		instances: parts.map((p) => ({
			id: nextId(),
			kind: p.kind,
			name: p.name,
			x: p.x,
			y: p.y,
			rotation: p.rotation ?? 0,
			params: { ...defaultParams(p.kind), ...(p.params ?? {}) }
		})),
		// Written as plain runs and stored as short polylines; connectivity joins
		// them where their ends meet, exactly as if they had been drawn that way.
		wires: wires.map(([x1, y1, x2, y2]) => ({
			id: nextId(),
			points: [
				{ x: x1, y: y1 },
				{ x: x2, y: y2 }
			]
		}))
	};
}

/**
 * The program the microcontroller example runs, assembled by hand: each row is
 * an instruction as the AVR Instruction Set Manual encodes it, beside what it
 * is. Hand-written rather than compiled, so the example carries nothing of the
 * Arduino core with it; the file a toolchain would write is built from these
 * rows, so the source and the program cannot drift apart.
 *
 * D13 (PB5) toggles every 8 000 000 cycles, half a second at 16 MHz, so it
 * blinks once a second. Each time it comes on the program sends the next digit
 * of a count, and each time it goes off a newline, at 9600 baud. All the while
 * it copies D2 (PD2, read with its pull-up on) onto D12 (PB4), lit while the
 * button holds D2 low.
 *
 * The half period, counted from the manual's cycle times: 16 cycles from the
 * start of the toggle to the end of the byte's write, the same whichever way
 * the LED went; 3 of padding; 17 passes of the outer loop at 9 · 52 287 + 4
 * cycles each, the button copy taking 5 cycles whether it is pressed or not;
 * and 2 back to the top — 16 + 3 + 17 · 470 587 + 2 = 8 000 000. A press or a
 * release that lands between the copy's two reads of D2 makes that one pass a
 * cycle longer or shorter, which nobody watching an LED will notice.
 */
const BLINK_PROGRAM: ReadonlyArray<readonly [words: readonly number[], source: string]> = [
	[[0xe300], 'ldi  r16, 0x30        ; D13 and D12 are outputs'],
	[[0xb904], 'out  DDRB, r16'],
	[[0x9a5a], 'sbi  PORTD, 2         ; D2 an input, its pull-up on'],
	[[0xe607], 'ldi  r16, 103         ; 9600 baud at 16 MHz'],
	[[0x9300, 0x00c4], 'sts  UBRR0L, r16'],
	[[0xe008], 'ldi  r16, 0x08'],
	[[0x9300, 0x00c1], 'sts  UCSR0B, r16      ; transmitter on'],
	[[0xe330], "ldi  r19, '0'         ; the count's last digit"],
	[[0x9a1d], 'loop: sbi PINB, 5     ; toggle D13'],
	[[0xe00a], "ldi  r16, '\n'        ; going off: a newline"],
	[[0x992d], 'sbic PORTB, 5         ; coming on: the next digit'],
	[[0x9533], 'inc  r19'],
	[[0x333a], "cpi  r19, '9' + 1"],
	[[0xf409], 'brne digit'],
	[[0xe330], "ldi  r19, '0'"],
	[[0x992d], 'digit: sbic PORTB, 5'],
	[[0x2f03], 'mov  r16, r19'],
	[[0x9110, 0x00c0], 'send: lds r17, UCSR0A'],
	[[0xff15], 'sbrs r17, UDRE0       ; wait for room to send'],
	[[0xcffc], 'rjmp send'],
	[[0x9300, 0x00c6], 'sts  UDR0, r16'],
	[[0x0000, 0x0000, 0x0000], 'nop ×3                ; to make the half period exact'],
	[[0xe121], 'ldi  r18, 17'],
	[[0xe38f], 'outer: ldi r24, lo8(52287)'],
	[[0xec9c], 'ldi  r25, hi8(52287)'],
	[[0x994a], 'inner: sbic PIND, 2   ; D2 high: D12 off'],
	[[0x982c], 'cbi  PORTB, 4'],
	[[0x9b4a], 'sbis PIND, 2          ; D2 low: D12 on'],
	[[0x9a2c], 'sbi  PORTB, 4'],
	[[0x9701], 'sbiw r24, 1'],
	[[0xf7d1], 'brne inner'],
	[[0x952a], 'dec  r18'],
	[[0xf7b1], 'brne outer'],
	[[0xcfe2], 'rjmp loop']
];

/**
 * The LED matrix example's program, assembled by hand like the blink's: what
 * a sketch with SPI.h and LedControl's register writes does, with nothing of
 * the Arduino core in it. As a sketch:
 *
 *     void send(byte address, byte value) {
 *       digitalWrite(10, LOW);
 *       SPI.transfer(address);
 *       SPI.transfer(value);
 *       digitalWrite(10, HIGH);
 *     }
 *     void setup() {
 *       pinMode(10, OUTPUT);
 *       digitalWrite(10, HIGH);
 *       SPI.begin();
 *       SPI.beginTransaction(SPISettings(8000000, MSBFIRST, SPI_MODE0));
 *       send(0x0F, 0); send(0x0B, 7); send(0x09, 0); send(0x0A, 8); send(0x0C, 1);
 *     }
 *     void loop() {
 *       for (byte row = 0; row < 8; row++) send(row + 1, SMILEY[row]);
 *       delay(500);
 *       for (byte row = 0; row < 8; row++) send(row + 1, HEART[row]);
 *       delay(500);
 *     }
 *
 * Each word is CS low, the register's address and its value through the SPI
 * at 8 MHz, and CS high, on whose rising edge the MAX7219 latches it. The
 * tables are address-value pairs in flash, read with `lpm`.
 */
const MATRIX_PROGRAM: ReadonlyArray<readonly [words: readonly number[], source: string]> = [
	[[0xe20c], 'ldi  r16, 0x2C         ; D10 (CS), D11 (MOSI) and D13 (SCK) are outputs'],
	[[0xb904], 'out  DDRB, r16'],
	[[0x9a2a], 'sbi  PORTB, 2          ; CS high: the module ignores the clock'],
	[[0xe500], 'ldi  r16, 0x50         ; SPE | MSTR: a master, mode 0, MSB first'],
	[[0xbd0c], 'out  SPCR, r16'],
	[[0xe001], 'ldi  r16, 1            ; SPI2X: fosc/2, as SPISettings(8000000) sets'],
	[[0xbd0d], 'out  SPSR, r16'],
	[[0xe5e6], "ldi  r30, lo8(SETUP)   ; LedControl's five set-up words"],
	[[0xe0f0], 'ldi  r31, hi8(SETUP)'],
	[[0xe045], 'ldi  r20, 5'],
	[[0xd011], 'rcall words'],
	[[0xe6e0], 'loop: ldi r30, lo8(SMILEY)'],
	[[0xe0f0], 'ldi  r31, hi8(SMILEY)'],
	[[0xd004], 'rcall picture'],
	[[0xe7e0], 'ldi  r30, lo8(HEART)'],
	[[0xe0f0], 'ldi  r31, hi8(HEART)'],
	[[0xd001], 'rcall picture'],
	[[0xcff9], 'rjmp loop'],
	[[0xe048], 'picture: ldi r20, 8    ; eight rows from Z, then half a second'],
	[[0xd008], 'rcall words'],
	[[0xe228], 'ldi  r18, 40'],
	[[0xe580], 'outer: ldi r24, lo8(50000)'],
	[[0xec93], 'ldi  r25, hi8(50000)'],
	[[0x9701], 'inner: sbiw r24, 1'],
	[[0xf7f1], 'brne inner             ; 4 cycles a pass: 40 × 50 000 × 4 = 8 000 000'],
	[[0x952a], 'dec  r18'],
	[[0xf7d1], 'brne outer'],
	[[0x9508], 'ret'],
	[[0x982a], 'words: cbi PORTB, 2    ; r20 address-value pairs from Z: CS low'],
	[[0x9105], 'lpm  r16, Z+'],
	[[0xd006], 'rcall transfer'],
	[[0x9105], 'lpm  r16, Z+'],
	[[0xd004], 'rcall transfer'],
	[[0x9a2a], 'sbi  PORTB, 2          ; CS high: the word is latched'],
	[[0x954a], 'dec  r20'],
	[[0xf7c1], 'brne words'],
	[[0x9508], 'ret'],
	[[0xbd0e], 'transfer: out SPDR, r16 ; SPI.transfer(r16)'],
	[[0xb51d], 'wait: in r17, SPSR'],
	[[0xff17], 'sbrs r17, SPIF         ; until the byte is out'],
	[[0xcffd], 'rjmp wait'],
	[[0xb51e], 'in   r17, SPDR         ; reading SPDR clears SPIF'],
	[[0x9508], 'ret'],
	[
		[0x000f, 0x070b, 0x0009, 0x080a, 0x010c],
		'SETUP: .db 0x0F, 0, 0x0B, 7, 9, 0, 0x0A, 8, 0x0C, 1 ; test off, 8 rows, no decode, intensity 8, on'
	],
	[
		[0x3c01, 0x4202, 0xa503, 0x8104, 0xa505, 0x9906, 0x4207, 0x3c08],
		'SMILEY: .db 1, 0x3C, 2, 0x42, 3, 0xA5, 4, 0x81, 5, 0xA5, 6, 0x99, 7, 0x42, 8, 0x3C'
	],
	[
		[0x0001, 0x6602, 0xff03, 0xff04, 0xff05, 0x7e06, 0x3c07, 0x1808],
		'HEART: .db 1, 0, 2, 0x66, 3, 0xFF, 4, 0xFF, 5, 0xFF, 6, 0x7E, 7, 0x3C, 8, 0x18'
	]
];

/**
 * The program the buzzer example runs, assembled by hand like the blink's.
 *
 * A hardware tone: Timer2 in CTC mode with OC2A — the Uno's pin 11 — set to
 * toggle on every compare match, so the pin is a square wave at 16 MHz / 64 /
 * 2 / (OCR2A + 1), 125 000 / (OCR2A + 1) Hz, with no interrupt in the way.
 * Each note writes its count to OCR2A, zeroes the timer and connects OC2A; at
 * its end OC2A is let go, which hands the pin back to PORTB3, low, for 50 ms
 * of silence before the next. A rest only waits. The wait is 39 998 turns of a
 * four-cycle loop and six cycles more, 10 ms less a quarter of a microsecond,
 * a unit.
 *
 * The tune is the first line of Twinkle, Twinkle, Little Star, in the fifth
 * octave, where the counts land within five cents of every note: C 238
 * (523.0 Hz), D 212 (586.9), E 189 (657.9), F 178 (698.3), G 158 (786.2), A
 * 141 (880.3). A beat is 250 ms of note and 50 of gap, a half note 550 and 50,
 * and the line ends on 700 ms of rest before it starts again.
 */
const MELODY_PROGRAM: ReadonlyArray<readonly [words: readonly number[], source: string]> = [
	[[0xe008], 'ldi  r16, 0x08        ; D11 (PB3) an output, low'],
	[[0xb904], 'out  DDRB, r16'],
	[[0xe004], 'ldi  r16, 0x04        ; Timer2 counts at 16 MHz / 64'],
	[[0x9300, 0x00b1], 'sts  TCCR2B, r16'],
	[[0x2733], 'clr  r19'],
	[[0xe4e6], 'restart: ldi r30, lo8(melody)'],
	[[0xe0f0], 'ldi  r31, hi8(melody)'],
	[[0x9115], "next: lpm r17, Z+     ; the note's count; 0 for a rest"],
	[[0x9125], 'lpm  r18, Z+          ; how long, in 10 ms; 0 to start over'],
	[[0x2322], 'tst  r18'],
	[[0xf3d1], 'breq restart'],
	[[0x2311], 'tst  r17'],
	[[0xf039], 'breq rest'],
	[[0x9310, 0x00b3], 'sts  OCR2A, r17'],
	[[0x9330, 0x00b2], 'sts  TCNT2, r19       ; from the bottom'],
	[[0xe402], 'ldi  r16, 0x42        ; CTC, OC2A toggling on each match'],
	[[0x9300, 0x00b0], 'sts  TCCR2A, r16'],
	[[0xd006], 'rest: rcall wait'],
	[[0xe002], 'ldi  r16, 0x02        ; CTC, OC2A let go: the pin low'],
	[[0x9300, 0x00b0], 'sts  TCCR2A, r16'],
	[[0xe025], 'ldi  r18, 5           ; 50 ms between notes'],
	[[0xd001], 'rcall wait'],
	[[0xcfec], 'rjmp next'],
	[[0xe38e], 'wait: ldi r24, lo8(39998)'],
	[[0xe99c], 'ldi  r25, hi8(39998)'],
	[[0x9701], 'tick: sbiw r24, 1'],
	[[0xf7f1], 'brne tick'],
	[[0x952a], 'dec  r18'],
	[[0xf7d1], 'brne wait'],
	[[0x9508], 'ret'],
	// The tune, a count and a length a note: the count in the low byte of
	// each word, which is the one `lpm` reads first.
	[[0x19ee, 0x19ee, 0x199e, 0x199e, 0x198d, 0x198d, 0x379e], 'melody: C C G G A A G-'],
	[[0x19b2, 0x19b2, 0x19bd, 0x19bd, 0x19d4, 0x19d4, 0x37ee], 'F F E E D D C-'],
	[[0x4600, 0x0000], 'rest 700 ms, then start over']
];

/**
 * The program the Uno counting example runs, assembled by hand the same way:
 * `shiftOut()` into a 74HC595 and a pulse on its latch, the next digit every
 * half second, 0 to 9 and round again.
 *
 * D8 (PB0) is the 595's SER, D12 (PB4) its SRCLK and D10 (PB2) its RCLK. A
 * pattern goes out top bit first, so bit 7 lands on QH and bit 0 on QA: bit 0
 * is segment a, bit 6 is g and bit 7, the point, is never set.
 *
 * Every path is the same length, so the half second is exact: 7 cycles to
 * fetch the pattern, 8 · 10 − 1 to shift it out, 4 to latch it, 88 passes of
 * the delay at 4 · 22 726 + 4 each and 6 to step to the next digit, wrapping
 * or not — 7 + 79 + 4 + 7 999 904 + 6 = 8 000 000.
 */
const COUNT_PROGRAM: ReadonlyArray<readonly [words: readonly number[], source: string]> = [
	[[0xe105], 'ldi  r16, 0x15        ; D8, D10 and D12 are outputs'],
	[[0xb904], 'out  DDRB, r16'],
	[[0xe030], 'ldi  r19, 0           ; the digit on show'],
	[[0xe4e0], 'next: ldi r30, lo8(table)'],
	[[0xe0f0], 'ldi  r31, hi8(table)  ; the table is inside one 256-byte page'],
	[[0x0fe3], 'add  r30, r19'],
	[[0x9144], 'lpm  r20, Z           ; that digit\'s segments'],
	[[0xe028], 'ldi  r18, 8'],
	[[0x2755], 'bit: clr r21'],
	[[0xfb47], 'bst  r20, 7           ; the top bit onto D8,'],
	[[0xf950], 'bld  r21, 0'],
	[[0xb955], 'out  PORTB, r21       ; with D10 and D12 low'],
	[[0x9a2c], 'sbi  PORTB, 4         ; D12 rises: the 595 takes it'],
	[[0x0f44], 'lsl  r20'],
	[[0x952a], 'dec  r18'],
	[[0xf7c1], 'brne bit'],
	[[0xe054], 'ldi  r21, 0x04'],
	[[0xb955], 'out  PORTB, r21       ; D10 rises: all eight reach the outputs'],
	[[0x2755], 'clr  r21'],
	[[0xb955], 'out  PORTB, r21'],
	[[0xe568], 'ldi  r22, 88'],
	[[0xec86], 'outer: ldi r24, lo8(22726)'],
	[[0xe598], 'ldi  r25, hi8(22726)'],
	[[0x9701], 'inner: sbiw r24, 1'],
	[[0xf7f1], 'brne inner'],
	[[0x956a], 'dec  r22'],
	[[0xf7d1], 'brne outer'],
	[[0x9533], 'inc  r19'],
	[[0x303a], 'cpi  r19, 10'],
	[[0xf409], 'brne same'],
	[[0xe030], 'ldi  r19, 0'],
	[[0xcfe3], 'same: rjmp next'],
	[
		[0x063f, 0x4f5b, 0x6d66, 0x077d, 0x6f7f, 0x0000],
		'table: 3F 06 5B 4F 66 6D 7D 07 7F 6F  ; 0 to 9, and two bytes of padding'
	]
];

/**
 * The program the servo example runs, assembled by hand the same way: what the
 * Servo library's Knob sketch does, without the library. It reads A0 over and
 * over and sends the servo on D9 a pulse of 544 to 2400 µs every 20 ms.
 *
 * Timer1 makes the pulses in hardware, in fast PWM with ICR1 as TOP (mode 14)
 * at 16 MHz / 8: a tick is 0.5 µs and 40 000 of them are 20 ms. OC1A, which is
 * D9, goes high at BOTTOM and low when the count reaches OCR1A. The pulse in
 * ticks is 1088 + ADC · 29 / 8, 1088 (544 µs) to 4796 (2398 µs): the
 * library's map() to 0–180° and back, within half a degree, and no division.
 * One conversion a period, started each time Timer1 reaches TOP: OCR1A takes
 * a new value only at BOTTOM, so a pulse is never cut short. The timer is
 * started once the first conversion has set the width; writing TCCR1B again
 * on every pass changes nothing.
 */
const KNOB_PROGRAM: ReadonlyArray<readonly [words: readonly number[], source: string]> = [
	[[0xe400], 'ldi  r16, 0x40        ; AVCC the reference, A0 the input'],
	[[0x9300, 0x007c], 'sts  ADMUX, r16'],
	[[0xe807], 'ldi  r16, 0x87        ; converter on, its clock 16 MHz / 128'],
	[[0x9300, 0x007a], 'sts  ADCSRA, r16'],
	[[0x9a21], 'sbi  DDRB, 1          ; D9 an output'],
	[[0xe90c], 'ldi  r16, hi8(39999)  ; TOP: 20 ms of 0.5 µs ticks'],
	[[0x9300, 0x0087], 'sts  ICR1H, r16'],
	[[0xe30f], 'ldi  r16, lo8(39999)'],
	[[0x9300, 0x0086], 'sts  ICR1L, r16'],
	[[0xe802], 'ldi  r16, 0x82        ; OC1A high at BOTTOM, low at OCR1A'],
	[[0x9300, 0x0080], 'sts  TCCR1A, r16'],
	[[0xe14d], 'ldi  r20, 29'],
	[[0xec07], 'loop: ldi r16, 0xC7   ; start a conversion'],
	[[0x9300, 0x007a], 'sts  ADCSRA, r16'],
	[[0x9100, 0x007a], 'wait: lds r16, ADCSRA'],
	[[0xfd06], 'sbrc r16, ADSC        ; until it is done'],
	[[0xcffc], 'rjmp wait'],
	[[0x9180, 0x0078], 'lds  r24, ADCL        ; low byte first'],
	[[0x9190, 0x0079], 'lds  r25, ADCH'],
	[[0x9f84], 'mul  r24, r20         ; ADC · 29'],
	[[0x01d0], 'movw r26, r0'],
	[[0x9f94], 'mul  r25, r20'],
	[[0x0db0], 'add  r27, r0'],
	[[0x95b6, 0x95a7, 0x95b6, 0x95a7, 0x95b6, 0x95a7], 'lsr r27 / ror r26 ×3 ; / 8'],
	[[0x5ca0], 'subi r26, lo8(-1088)  ; + 1088'],
	[[0x4fbb], 'sbci r27, hi8(-1088)'],
	[[0x93b0, 0x0089], 'sts  OCR1AH, r27      ; high byte first'],
	[[0x93a0, 0x0088], 'sts  OCR1AL, r26'],
	[[0xe10a], 'ldi  r16, 0x1A        ; mode 14, clock / 8: the timer runs'],
	[[0x9300, 0x0081], 'sts  TCCR1B, r16'],
	[[0x9bb0], 'period: sbis TIFR1, TOV1 ; wait for TOP, every 20 ms'],
	[[0xcffe], 'rjmp period'],
	[[0x9ab0], 'sbi  TIFR1, TOV1      ; a one clears it'],
	[[0xcfde], 'rjmp loop']
];

export const EXAMPLES: Example[] = [
	{
		id: 'rc-lowpass',
		name: 'RC low-pass',
		description: 'A square wave through a first-order filter, and the exponential it charges along.',
		stopTime: 5e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 500, duty: 0.5 }
					},
					{ kind: 'resistor', name: 'R1', x: 200, y: 170 },
					{
						kind: 'capacitor',
						name: 'C1',
						x: 300,
						y: 230,
						rotation: 90,
						params: { capacitance: 1e-6 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 170, 170],
					[230, 170, 300, 170],
					[300, 170, 300, 200],
					[300, 260, 300, 290],
					[100, 290, 300, 290],
					[100, 230, 100, 290]
				]
			)
	},
	{
		id: 'rectifier',
		name: 'Half-wave rectifier',
		description:
			'A diode and a smoothing capacitor turning AC into lumpy DC — a nonlinear circuit that has to converge on every step.',
		stopTime: 60e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 10, offset: 0, frequency: 50 }
					},
					{ kind: 'diode', name: 'D1', x: 200, y: 170 },
					{
						kind: 'capacitor',
						name: 'C1',
						x: 300,
						y: 230,
						rotation: 90,
						params: { capacitance: 100e-6 }
					},
					{
						kind: 'resistor',
						name: 'R1',
						x: 390,
						y: 230,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 170, 170],
					[230, 170, 390, 170],
					[300, 170, 300, 200],
					[390, 170, 390, 200],
					[300, 260, 300, 290],
					[390, 260, 390, 290],
					[100, 290, 390, 290],
					[100, 230, 100, 290]
				]
			)
	},
	{
		id: 'led-driver',
		name: 'LED driver',
		description:
			'Two LEDs across the same 5 V. One through 330 Ω lights and stays lit; one through 33 Ω — a decimal point in the wrong place — lights brighter and lasts about half a millisecond.',
		stopTime: 2e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'dc', value: 5 }
					},
					{ kind: 'resistor', name: 'R1', x: 260, y: 220, rotation: 90, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 260, y: 300, rotation: 90, params: { colour: 'red' } },
					{ kind: 'resistor', name: 'R2', x: 400, y: 220, rotation: 90, params: { resistance: 33 } },
					{ kind: 'led', name: 'D2', x: 400, y: 300, rotation: 90, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND1', x: 100, y: 340 }
				],
				[
					[100, 170, 260, 170],
					[260, 170, 400, 170],
					[260, 170, 260, 190],
					[400, 170, 400, 190],
					[260, 250, 260, 270],
					[400, 250, 400, 270],
					[260, 330, 400, 330],
					[100, 330, 260, 330],
					[100, 230, 100, 330]
				]
			)
	},
	{
		id: 'common-emitter',
		name: 'Common-emitter amplifier',
		description:
			'A BJT biased into its active region by RB, amplifying and inverting a 10 mV signal coupled in through C1.',
		stopTime: 5e-3,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'V1', x: 60, y: 120, params: { waveform: 'dc', value: 12 } },
					{
						kind: 'vsource',
						name: 'V2',
						x: 120,
						y: 250,
						params: { waveform: 'sine', value: 0.01, offset: 0, frequency: 1000 }
					},
					{ kind: 'capacitor', name: 'C1', x: 220, y: 220, params: { capacitance: 1e-6 } },
					{
						kind: 'resistor',
						name: 'RB',
						// Sized so the collector rests near half the supply. At 470 k it
						// sat at 1.4 V, which leaves 1.4 V of room below and 10 V above:
						// the stage described here as amplifying a 10 mV signal wants
						// ±2 V, so it was clipping flat against ground on every negative
						// half cycle. An amplifier example that visibly distorts teaches
						// the wrong thing twice over.
						x: 340,
						y: 150,
						rotation: 90,
						params: { resistance: 820000 }
					},
					{
						kind: 'resistor',
						name: 'RC',
						x: 440,
						y: 150,
						rotation: 90,
						params: { resistance: 2200 }
					},
					{ kind: 'npn', name: 'Q1', x: 430, y: 250 },
					{ kind: 'ground', name: 'GND1', x: 120, y: 350 },
					{ kind: 'ground', name: 'GND2', x: 440, y: 350 }
				],
				[
					// Supply rail across the top.
					[60, 90, 440, 90],
					[340, 90, 340, 120],
					[440, 90, 440, 120],
					// Bias resistor down to the base.
					[340, 180, 340, 250],
					[340, 250, 400, 250],
					// Collector load.
					[440, 180, 440, 220],
					// Emitter to ground.
					[440, 280, 440, 340],
					// Signal in through the coupling capacitor.
					[120, 220, 190, 220],
					[250, 220, 300, 220],
					[300, 220, 300, 250],
					[300, 250, 340, 250],
					// Returns.
					[120, 280, 120, 340],
					[60, 150, 60, 340],
					[60, 340, 120, 340]
				]
			)
	},
	{
		id: 'mixed-signal',
		name: 'Analog into logic',
		description:
			'A sine crosses the logic thresholds, drives a NOT gate, and comes back out into an RC load. The analog-digital bridges are inserted for you.',
		stopTime: 400e-6,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 90,
						y: 220,
						params: { waveform: 'sine', value: 2.4, offset: 2.5, frequency: 10000 }
					},
					{ kind: 'not', name: 'U1', x: 250, y: 190 },
					{
						kind: 'resistor',
						name: 'R1',
						x: 400,
						y: 250,
						rotation: 90,
						params: { resistance: 10000 }
					},
					{
						kind: 'capacitor',
						name: 'C1',
						x: 480,
						y: 250,
						rotation: 90,
						params: { capacitance: 1e-9 }
					},
					{ kind: 'ground', name: 'GND1', x: 90, y: 320 },
					{ kind: 'ground', name: 'GND2', x: 440, y: 330 }
				],
				[
					[90, 190, 220, 190],
					[280, 190, 480, 190],
					[400, 190, 400, 220],
					[480, 190, 480, 220],
					[400, 280, 400, 310],
					[480, 280, 480, 310],
					[400, 310, 480, 310],
					[440, 310, 440, 320],
					[90, 250, 90, 310]
				]
			)
	},
	{
		id: 'rlc-bandpass',
		name: 'RLC band-pass',
		description:
			'A series resonant circuit, meant to be looked at in the frequency domain. V1 carries the AC drive, so the sweep measures the response from it.',
		stopTime: 2e-3,
		analysis: 'frequency',
		frequencyRange: { start: 10, stop: 1e6 },
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 1, offset: 0, frequency: 1590, ac: 1 }
					},
					{ kind: 'resistor', name: 'R1', x: 200, y: 170, params: { resistance: 50 } },
					{ kind: 'inductor', name: 'L1', x: 320, y: 170, params: { inductance: 10e-3 } },
					{
						kind: 'capacitor',
						name: 'C1',
						x: 420,
						y: 230,
						rotation: 90,
						params: { capacitance: 1e-6 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 170, 170],
					[230, 170, 290, 170],
					[350, 170, 420, 170],
					[420, 170, 420, 200],
					[420, 260, 420, 290],
					[100, 290, 420, 290],
					[100, 230, 100, 290]
				]
			)
	},
	{
		id: 'bcd-display',
		name: 'BCD to a digit',
		description:
			'Four switches, a 4511 and a seven-segment digit: the chain every counter ends in. The switches spell a number in binary, the decoder turns four bits into seven bars, and the display is the bars. It arrives showing 5. The resistors are not optional even though the 4511 is called a driver — it drives, it does not limit — and the three control pins are held at the levels that mean "no latch, no blanking, no lamp test", because on a real board they cannot be left in the air.',
		stopTime: 20e-6,
		build: () => {
			/** Where the decoder sits; its sixteen legs are 20 apart down each side. */
			const DEC_X = 500;
			const DEC_Y = 300;
			/** And the digit, whose eight are 10 apart. */
			const DIGIT_X = 1100;
			const DIGIT_Y = 300;

			// Pin 16 is VDD and the seven segment outputs run down from pin 15.
			const OUT_Y: Record<string, number> = {
				f: DEC_Y - 50,
				g: DEC_Y - 30,
				a: DEC_Y - 10,
				b: DEC_Y + 10,
				c: DEC_Y + 30,
				d: DEC_Y + 50,
				e: DEC_Y + 70
			};
			// The digit takes them in alphabetical order, which is not the order they
			// leave the decoder in — so each run steps across in a column of its own.
			const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
			const inY = (seg: string) => DIGIT_Y + (SEGMENTS.indexOf(seg) - 3.5) * 10;

			const parts: Placed[] = [
				{ kind: 'ic:4511', name: 'U1', x: DEC_X, y: DEC_Y },
				{ kind: 'display7', name: 'DS1', x: DIGIT_X, y: DIGIT_Y, params: { colour: 'red' } },
				{ kind: 'supply', name: 'PWR1', x: 300, y: 150, params: { voltage: 5 } },
				{ kind: 'supply', name: 'PWR2', x: 700, y: 220, params: { voltage: 5 } },
				{ kind: 'ground', name: 'GND1', x: 400, y: 440 },
				{ kind: 'ground', name: 'GND2', x: DIGIT_X, y: 420 }
			];
			const wires: Array<[number, number, number, number]> = [
				// Lamp test and blanking are active low, so both sit high: nothing to
				// test and nothing to blank.
				[300, 160, 300, 290],
				[300, 270, 440, 270],
				[300, 290, 440, 290],
				// Latch enable is active high, and held down the latches stay open.
				[340, 310, 440, 310],
				[340, 310, 340, 430],
				[340, 430, 400, 430],
				// VSS, on the same ground.
				[400, 370, 440, 370],
				[400, 370, 400, 430],
				// VDD, above the segment outputs.
				[560, 230, 700, 230],
				// The digit's common pin is its cathode: this one lights on a high.
				[DIGIT_X, DIGIT_Y + 62, DIGIT_X, 410]
			];

			// The four data bits. 0101 is a 5, which uses six of the seven bars and
			// leaves one off — a digit where a wrong equation would show.
			const BITS: Array<[string, number, 'high' | 'low']> = [
				['B', DEC_Y - 70, 'low'],
				['C', DEC_Y - 50, 'high'],
				['D', DEC_Y + 30, 'low'],
				['A', DEC_Y + 50, 'high']
			];
			for (const [pin, y, state] of BITS) {
				parts.push({ kind: 'toggle', name: pin, x: 150, y, params: { state } });
				wires.push([180, y, 440, y]);
			}

			// One resistor per segment, then across to the digit. The decoder drives
			// the bars; nothing in it limits what they draw.
			for (const [i, seg] of SEGMENTS.entries()) {
				const from = OUT_Y[seg];
				const to = inY(seg);
				const column = 880 + i * 15;
				parts.push({
					kind: 'resistor',
					name: `R${i + 1}`,
					x: 800,
					y: from,
					params: { resistance: 330 }
				});
				wires.push(
					[560, from, 770, from],
					[830, from, column, from],
					[column, from, column, to],
					[column, to, DIGIT_X - 50, to]
				);
			}

			return build(parts, wires);
		}
	},

	{
		id: 'cd4027',
		name: 'CD4027 divider',
		description:
			'Half a CD4027 wired the way its datasheet says to make a divide-by-two: J and K both high, set and reset held down, and the output changes on every rising edge and on no other. The chip is the part rather than the gates inside it, so it has two legs it cannot do without — leave VDD or VSS unwired and the drawing tells you — and a whole second flip-flop nobody is using, whose inputs are tied to ground rather than left in the air. That is not tidiness: a CMOS input floating between the rails turns the stage into an amplifier and it draws current and oscillates. The buffer before the lamp is not decoration either, since Q feeds back into the flip-flop and a lamp hung straight on it stops the pair settling.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'clock', name: 'CLK1', x: 300, y: 270, params: { frequency: 1e6, duty: 0.5 } },
					// J and K tied high is the toggle: the identity behind a JK reduces to
					// D = Q-bar, and a flip-flop told to become what it is not divides.
					{ kind: 'supply', name: 'PWR1', x: 400, y: 180, params: { voltage: 5 } },
					{ kind: 'ic:4027', name: 'U1', x: 600, y: 300 },
					{ kind: 'supply', name: 'PWR2', x: 760, y: 220, params: { voltage: 5 } },
					{ kind: 'ground', name: 'GND1', x: 470, y: 470 },
					// Q is an input of the flip-flop as well as its output, and a lamp on a
					// net inside a loop leaves the pair unable to settle. The buffer is what
					// a board would have anyway.
					{ kind: 'buffer', name: 'B1', x: 690, y: 120 },
					{ kind: 'resistor', name: 'R1', x: 890, y: 120, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 990, y: 120, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND2', x: 1060, y: 180 },
					{ kind: 'ground', name: 'GND3', x: 720, y: 510 }
				],
				[
					// The clock, into pin 3.
					[330, 270, 540, 270],
					// The supply rail down to J and K.
					[400, 190, 400, 330],
					[400, 310, 540, 310],
					[400, 330, 540, 330],
					// Set and reset held down, and VSS on the same ground.
					[470, 290, 540, 290],
					[470, 350, 540, 350],
					[470, 370, 540, 370],
					[470, 290, 470, 460],
					// VDD, on pin 16.
					[660, 230, 760, 230],
					// Q up and over to the lamp, through a buffer.
					[510, 230, 540, 230],
					[510, 120, 510, 230],
					[510, 120, 660, 120],
					[720, 120, 860, 120],
					[920, 120, 960, 120],
					[1020, 120, 1060, 120],
					[1060, 120, 1060, 170],
					// The half of the chip nobody is using: every input of it held down.
					// An unused CMOS input left floating sits between the rails, which
					// turns the stage into an amplifier that draws current and oscillates.
					[660, 290, 720, 290],
					[660, 310, 720, 310],
					[660, 330, 720, 330],
					[660, 350, 720, 350],
					[660, 370, 720, 370],
					[720, 290, 720, 500]
				]
			)
	},

	{
		id: 'ne555-blinker',
		name: '555 blinker',
		description:
			'The most built circuit there is: a 555 wired astable, blinking an LED about twice a second. The capacitor charges through both resistors and discharges through the lower one only, between a third and two thirds of the supply — which is why the rate is 1.44 / ((R1 + 2·R2)·C) whatever the supply is, and why the LED is on a little longer than it is off. RESET is tied high because a 555 with RESET left floating is a 555 that does nothing, and CONT gets its 10 nF so that noise on the supply does not move the thresholds. Probe the capacitor to watch it swing between the two thresholds.',
		stopTime: 2,
		build: () =>
			build(
				[
					{ kind: 'ic:NE555', name: 'U1', x: 600, y: 300 },
					{ kind: 'supply', name: 'PWR1', x: 760, y: 130, params: { voltage: 9 } },
					{ kind: 'resistor', name: 'R1', x: 760, y: 190, rotation: 90, params: { resistance: 1000 } },
					{ kind: 'resistor', name: 'R2', x: 760, y: 270, rotation: 90, params: { resistance: 33000 } },
					{ kind: 'capacitor', name: 'C1', x: 760, y: 360, rotation: 90, params: { capacitance: 10e-6 } },
					{ kind: 'capacitor', name: 'C2', x: 700, y: 380, rotation: 90, params: { capacitance: 10e-9 } },
					{ kind: 'resistor', name: 'R3', x: 370, y: 310, params: { resistance: 680 } },
					{ kind: 'led', name: 'D1', x: 280, y: 310, rotation: 180, params: { colour: 'red' } },
					{ kind: 'ground', name: 'GND1', x: 480, y: 290 },
					{ kind: 'ground', name: 'GND2', x: 760, y: 460 },
					{ kind: 'ground', name: 'GND3', x: 700, y: 440 },
					{ kind: 'ground', name: 'GND4', x: 250, y: 360 },
					{ kind: 'probe', name: 'OUT', x: 400, y: 310 },
					{ kind: 'probe', name: 'CAP', x: 760, y: 330 }
				],
				[
					// The supply, down to VCC on pin 8 and through R1.
					[760, 140, 760, 160],
					[700, 150, 760, 150],
					[660, 270, 700, 270],
					[700, 150, 700, 270],
					// DIS, pin 7, between the two resistors.
					[760, 220, 760, 240],
					[660, 290, 720, 290],
					[720, 230, 720, 290],
					[720, 230, 760, 230],
					// THR, pin 6, on the capacitor.
					[760, 300, 760, 330],
					[660, 310, 760, 310],
					[760, 390, 760, 450],
					// TRIG, pin 2, round the bottom to the same capacitor.
					[540, 290, 515, 290],
					[515, 290, 515, 480],
					[515, 480, 820, 480],
					[820, 315, 820, 480],
					[760, 315, 820, 315],
					// CONT, pin 5, decoupled.
					[660, 330, 700, 330],
					[700, 330, 700, 350],
					[700, 410, 700, 430],
					// GND, pin 1.
					[480, 270, 540, 270],
					[480, 270, 480, 280],
					// RESET, pin 4, held high from the supply.
					[460, 330, 540, 330],
					[460, 150, 460, 330],
					[460, 150, 700, 150],
					// OUT, pin 3, through the resistor and the LED to ground.
					[400, 310, 540, 310],
					[310, 310, 340, 310],
					[250, 310, 250, 350]
				]
			)
	},

	{
		id: 'eeprom-display',
		name: 'EEPROM and a scanned display',
		description:
			'Four digits on twelve pins, lit one at a time. Two clocks count 0 to 3 over and over; the 74139 turns that count into which digit\'s common pin is pulled low, and the same count is the address of a 28C16 whose first four bytes are the segment patterns for 1, 2, 3 and 4 — the EEPROM is the lookup table a 7447 would otherwise be, and changing the digits is editing its contents in the inspector. Each digit is lit a quarter of the time and looks a quarter as bright. The decoder sinks a whole digit through one output, which is why the resistors are no smaller: at 100 Ω a digit with seven bars lit drops so much inside the 74139 that it goes dim beside a 1, and a board meant to be bright puts a transistor on each digit pin. Slow the playback right down and the digits take turns.',
		stopTime: 20e-3,
		build: () => {
			const parts: Placed[] = [
				{
					kind: 'ic:28C16',
					name: 'U1',
					x: 500,
					y: 400,
					params: { contents: '; the segment patterns for 1, 2, 3 and 4\n06 5B 4F 66' }
				},
				{ kind: 'ic:74139', name: 'U2', x: 1000, y: 650 },
				{ kind: 'display7x4', name: 'DS1', x: 1000, y: 400, params: { colour: 'red' } },
				{ kind: 'clock', name: 'CLK2', x: 300, y: 350, params: { frequency: 1000 } },
				{ kind: 'clock', name: 'CLK1', x: 300, y: 470, params: { frequency: 2000 } },
				{ kind: 'supply', name: 'PWR1', x: 560, y: 280, params: { voltage: 5 } },
				{ kind: 'supply', name: 'PWR2', x: 1060, y: 570, params: { voltage: 5 } },
				{ kind: 'ground', name: 'GND1', x: 380, y: 300 },
				{ kind: 'ground', name: 'GND2', x: 440, y: 520 },
				{ kind: 'ground', name: 'GND3', x: 620, y: 320 },
				{ kind: 'ground', name: 'GND4', x: 870, y: 730 },
				{ kind: 'ground', name: 'GND5', x: 1120, y: 750 },
				// The spare half's outputs, on probes rather than on nothing.
				...[0, 1, 2, 3].map(
					(n): Placed => ({ kind: 'probe', name: `S${n}`, x: 1080, y: 660 + n * 20, rotation: 90 })
				)
			];
			const wires: Array<[number, number, number, number]> = [
				// A2 to A7 held low: only the bottom two address lines count.
				[420, 290, 440, 290],
				[420, 310, 440, 310],
				[420, 330, 440, 330],
				[420, 350, 440, 350],
				[420, 370, 440, 370],
				[420, 390, 440, 390],
				[420, 290, 420, 310],
				[420, 310, 420, 330],
				[420, 330, 420, 350],
				[420, 350, 420, 370],
				[420, 370, 420, 390],
				[380, 290, 420, 290],
				// A8 to A10, CE and OE low: selected and always driving.
				[560, 310, 600, 310],
				[560, 330, 600, 330],
				[560, 370, 600, 370],
				[560, 390, 600, 390],
				[560, 410, 600, 410],
				[600, 310, 600, 330],
				[600, 330, 600, 370],
				[600, 370, 600, 390],
				[600, 390, 600, 410],
				[600, 310, 620, 310],
				// WE high, so nothing is ever written.
				[560, 350, 580, 350],
				[580, 350, 580, 290],
				[580, 290, 560, 290],
				// The count: CLK1 is the low bit, CLK2 the high one, into the EEPROM's
				// address and the decoder's select alike.
				[330, 350, 340, 350],
				[340, 350, 340, 410],
				[340, 410, 440, 410],
				[330, 470, 350, 470],
				[350, 470, 350, 430],
				[350, 430, 440, 430],
				[350, 470, 350, 640],
				[350, 640, 860, 640],
				[860, 640, 860, 600],
				[860, 600, 940, 600],
				[340, 410, 340, 660],
				[340, 660, 850, 660],
				[850, 660, 850, 620],
				[850, 620, 940, 620],
				// I/O0 to I/O2 leave on the left and come round underneath.
				[440, 450, 400, 450],
				[400, 450, 400, 560],
				[400, 560, 670, 560],
				[440, 470, 390, 470],
				[390, 470, 390, 580],
				[390, 580, 670, 580],
				[440, 490, 380, 490],
				[380, 490, 380, 600],
				[380, 600, 670, 600],
				// I/O3 to I/O7 go straight across.
				[560, 430, 670, 430],
				[560, 450, 670, 450],
				[560, 470, 670, 470],
				[560, 490, 670, 490],
				[560, 510, 670, 510],
				// The decoder's other half, held off; its first half enabled.
				[1060, 600, 1080, 600],
				[1080, 600, 1080, 580],
				[1080, 580, 1060, 580],
				[1060, 620, 1120, 620],
				[1060, 640, 1120, 640],
				[1120, 620, 1120, 640],
				[1120, 640, 1120, 740],
				[940, 580, 870, 580],
				[870, 580, 870, 720],
				[940, 720, 870, 720],
				[1060, 660, 1080, 660],
				[1060, 680, 1080, 680],
				[1060, 700, 1080, 700],
				[1060, 720, 1080, 720],
				// Each of its outputs pulls one digit's common pin low.
				[940, 640, 910, 640],
				[910, 640, 910, 520],
				[910, 520, 940, 520],
				[940, 520, 940, 450],
				[940, 660, 900, 660],
				[900, 660, 900, 510],
				[900, 510, 980, 510],
				[980, 510, 980, 450],
				[940, 680, 890, 680],
				[890, 680, 890, 500],
				[890, 500, 1020, 500],
				[1020, 500, 1020, 450],
				[940, 700, 880, 700],
				[880, 700, 880, 490],
				[880, 490, 1060, 490],
				[1060, 490, 1060, 450]
			];
			// A resistor per segment line, I/O0 on segment a through I/O7 on the
			// point, each stepping across to its pin in a column of its own.
			const rows = [560, 580, 600, 510, 490, 470, 450, 430];
			for (let i = 0; i < SEGMENTS.length; i++) {
				const y = rows[i];
				const pin = 360 + i * 10;
				parts.push({
					kind: 'resistor',
					name: `R${i + 1}`,
					x: 700,
					y,
					params: { resistance: 330 }
				});
				if (y === pin) {
					wires.push([730, y, 900, y]);
				} else {
					const column = 750 + i * 10;
					wires.push([730, y, column, y], [column, y, column, pin], [column, pin, 900, pin]);
				}
			}
			return build(parts, wires);
		}
	},

	{
		id: 'atmega-blink',
		name: 'Microcontroller blink',
		description:
			"An ATmega328P, the chip on an Arduino Uno, running a program. D13 blinks once a second and D12 lights while the button on D2 is held down — with no resistor on D2, because the program turns on the pin's own pull-up, the way INPUT_PULLUP does in a sketch. Each time D13 comes on the chip sends the next digit of a count over serial; select it to read them. The other button pulls RESET low, which starts the program, and the count, again. The program is a few dozen instructions assembled by hand; to run a sketch of your own, export its .hex from the Arduino IDE and load it from the chip's inspector.",
		stopTime: 4,
		build: () =>
			build(
				[
					{
						kind: 'ic:ATmega328P',
						name: 'U1',
						x: 500,
						y: 300,
						params: { firmware: intelHex(BLINK_PROGRAM.flatMap(([words]) => words)) }
					},
					{ kind: 'supply', name: 'PWR1', x: 400, y: 270, params: { voltage: 5 } },
					{ kind: 'supply', name: 'PWR2', x: 660, y: 320, params: { voltage: 5 } },
					{ kind: 'ground', name: 'GND1', x: 400, y: 330 },
					{ kind: 'ground', name: 'GND2', x: 290, y: 260 },
					{ kind: 'ground', name: 'GND3', x: 620, y: 300 },
					{ kind: 'ground', name: 'GND4', x: 880, y: 370 },
					{ kind: 'ground', name: 'GND5', x: 880, y: 450 },
					{ kind: 'pushbutton', name: 'S1', x: 350, y: 170 },
					{ kind: 'pushbutton', name: 'S2', x: 350, y: 230 },
					{ kind: 'resistor', name: 'R1', x: 730, y: 350, params: { resistance: 330 } },
					{ kind: 'resistor', name: 'R2', x: 730, y: 430, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 820, y: 350, params: { colour: 'red' } },
					{ kind: 'led', name: 'D2', x: 820, y: 430, params: { colour: 'green' } },
					{ kind: 'probe', name: 'BUTTON', x: 410, y: 230 },
					{ kind: 'probe', name: 'D13', x: 620, y: 350 },
					{ kind: 'probe', name: 'D12', x: 620, y: 430 }
				],
				[
					// VCC and GND, pins 7 and 8; AVCC and AGND, pins 20 and 22, the same.
					[400, 280, 400, 290],
					[400, 290, 440, 290],
					[440, 310, 400, 310],
					[400, 310, 400, 320],
					[560, 290, 620, 290],
					[560, 330, 660, 330],
					// RESET, pin 1, and D2, pin 4, each to ground through a button.
					[380, 170, 440, 170],
					[380, 230, 410, 230],
					[410, 230, 440, 230],
					[320, 170, 290, 170],
					[290, 170, 290, 230],
					[320, 230, 290, 230],
					[290, 230, 290, 250],
					// D13, pin 19, through a resistor and an LED to ground.
					[560, 350, 620, 350],
					[620, 350, 700, 350],
					[760, 350, 790, 350],
					[850, 350, 880, 350],
					[880, 350, 880, 360],
					// D12, pin 18, the same, round below.
					[560, 370, 580, 370],
					[580, 370, 580, 430],
					[580, 430, 620, 430],
					[620, 430, 700, 430],
					[760, 430, 790, 430],
					[850, 430, 880, 430],
					[880, 430, 880, 440]
				]
			)
	},

	{
		id: 'uno-blink',
		name: 'Arduino Uno blink',
		description:
			"The same program as the microcontroller blink, on the board instead of the bare chip — so there is nothing to wire for it to run: the board is powered from USB, and its own L LED blinks on pin 13 once a second. The LED on pin 12 lights while the button on pin 2 is held down, with no resistor on pin 2 because the program turns on the pin's pull-up, the way INPUT_PULLUP does. The other button is a reset button: RESET has the board's pull-up on it, so pressing it starts the program, and the count it sends over serial, again. Select the board to read the count, or to load a .hex of your own from the Arduino IDE.",
		stopTime: 4,
		build: () =>
			build(
				[
					{
						kind: 'ic:ArduinoUno',
						name: 'U1',
						x: 500,
						y: 400,
						params: { firmware: intelHex(BLINK_PROGRAM.flatMap(([words]) => words)) }
					},
					{ kind: 'resistor', name: 'R1', x: 450, y: 100, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 540, y: 100, params: { colour: 'red' } },
					{ kind: 'ground', name: 'GND1', x: 600, y: 110 },
					{ kind: 'pushbutton', name: 'S2', x: 670, y: 140 },
					{ kind: 'ground', name: 'GND2', x: 730, y: 150 },
					{ kind: 'pushbutton', name: 'S1', x: 470, y: 660 },
					{ kind: 'ground', name: 'GND3', x: 530, y: 670 },
					{ kind: 'probe', name: 'D13', x: 400, y: 170 },
					{ kind: 'probe', name: 'D12', x: 420, y: 150 },
					{ kind: 'probe', name: 'BUTTON', x: 640, y: 160 }
				],
				[
					// Pin 13 has the board's own LED, and a probe to watch it by.
					[400, 190, 400, 170],
					// Pin 12, up through a resistor and an LED to ground.
					[420, 190, 420, 100],
					[480, 100, 510, 100],
					[570, 100, 600, 100],
					// Pin 2, through a button to ground.
					[640, 190, 640, 140],
					[700, 140, 730, 140],
					// RESET, on the power header, through a button to ground.
					[440, 610, 440, 660],
					[500, 660, 530, 660]
				]
			)
	},

	{
		id: 'uno-led-matrix',
		name: 'Arduino Uno and an SPI LED matrix',
		description:
			"An 8×8 LED matrix module on a MAX7219, driven from the Uno's SPI: DIN on pin 11 (MOSI), CLK on pin 13 (SCK) and CS on pin 10, the wiring of every LedControl tutorial. The program sets the driver up and then shows a smiley and a heart in turn, half a second each, sending each row as a two-byte word — the register, then its dots — between CS going low and coming back up. The probes are on the three wires: zoom the scope in to a few microseconds round a picture change to see SCK clock at 8 MHz, MOSI change on its falling edges, and CS rise after every sixteenth bit. The program is assembled by hand to do what the same sketch with SPI.h does; load a .hex of your own from the board's inspector to run yours.",
		stopTime: 2,
		build: () =>
			build(
				[
					{
						kind: 'ic:ArduinoUno',
						name: 'U1',
						x: 500,
						y: 400,
						params: { firmware: intelHex(MATRIX_PROGRAM.flatMap(([words]) => words)) }
					},
					{ kind: 'max7219', name: 'MX1', x: 200, y: 0 },
					{ kind: 'supply', name: 'PWR1', x: 40, y: -30, params: { voltage: 5 } },
					{ kind: 'ground', name: 'GND1', x: 60, y: 0 },
					{ kind: 'probe', name: 'SCK', x: 400, y: 170 },
					{ kind: 'probe', name: 'MOSI', x: 440, y: 140 },
					{ kind: 'probe', name: 'CS', x: 460, y: 170 }
				],
				[
					// The module's own 5 V and ground.
					[120, -20, 40, -20],
					[120, -10, 60, -10],
					// Pin 13 (SCK) up, across and in to CLK.
					[400, 190, 400, 170],
					[400, 170, 400, 150],
					[400, 150, 100, 150],
					[100, 150, 100, 20],
					[100, 20, 120, 20],
					// Pin 10 to CS.
					[460, 190, 460, 170],
					[460, 170, 460, 130],
					[460, 130, 90, 130],
					[90, 130, 90, 10],
					[90, 10, 120, 10],
					// Pin 11 (MOSI) to DIN.
					[440, 190, 440, 170],
					[440, 170, 440, 140],
					[440, 140, 80, 140],
					[80, 140, 80, 0],
					[80, 0, 120, 0]
				]
			)
	},

	{
		id: 'uno-buzzer',
		name: 'Arduino Uno melody',
		description:
			"A piezo buzzer on pin 11 playing the first line of Twinkle, Twinkle, Little Star, over and over. The program drives the pin straight from Timer2, toggling it on every compare match — what tone() does with an interrupt, done in hardware — so each note is a square wave at the frequency the timer's count gives: C 523 Hz up to A 880 Hz. The buzzer shows the pitch it is being driven at while it sounds; turn Sound on below the drawing to hear it. A 4-second window at 1× is real time, so the tune plays at its tempo; at 0.25× each note keeps its pitch and lasts four times as long. The probe on pin 11 shows the square wave on the scope.",
		stopTime: 4,
		build: () =>
			build(
				[
					{
						kind: 'ic:ArduinoUno',
						name: 'U1',
						x: 500,
						y: 400,
						params: { firmware: intelHex(MELODY_PROGRAM.flatMap(([words]) => words)) }
					},
					{ kind: 'buzzer', name: 'BZ1', x: 450, y: 110 },
					{ kind: 'ground', name: 'GND1', x: 500, y: 150 },
					{ kind: 'probe', name: 'D11', x: 440, y: 170 }
				],
				[
					// Pin 11 up to the buzzer's + leg, its other leg to ground.
					[440, 190, 440, 170],
					[440, 170, 440, 140],
					[460, 140, 500, 140]
				]
			)
	},

	{
		id: 'uno-servo-knob',
		name: 'Servo on a knob',
		description:
			"What the Servo library's Knob sketch does: an Uno reads the potentiometer on A0 and sends the servo on pin 9 to the matching angle, 0° with the wiper at ground and 180° at 5V. Timer1 makes the pulses in hardware, one every 20 ms, and the servo reads their width — 544 µs for 0°, 2400 µs for 180° — and its horn swings there at the motor's speed, a tenth of a second for 60°. It starts at 90°, so the first thing it does is turn to the quarter the knob is set at. Set the wiper somewhere else in the potentiometer's inspector while it runs and the horn follows it from that instant, the way it would follow a hand on the knob, with everything before the turn left as it was; select the servo to read its angle, the last pulse and the 10 mA it draws from the board's 5V. The program is a few dozen instructions assembled by hand; a sketch using the Servo library runs the same way, loaded as a .hex from the board's inspector.",
		stopTime: 2,
		build: () =>
			build(
				[
					{ kind: 'ic:ArduinoUno', name: 'U1', x: 500, y: 400, params: { firmware: intelHex(KNOB_PROGRAM.flatMap(([words]) => words)) } },
					{ kind: 'servo', name: 'SV1', x: 700, y: 80 },
					{ kind: 'potentiometer', name: 'RV1', x: 580, y: 700, params: { position: 0.25 } },
					{ kind: 'ground', name: 'GND1', x: 530, y: 710 },
					{ kind: 'probe', name: 'PIN9', x: 460, y: 130 }
				],
				[
					// Pin 9 to the servo's signal wire, with a probe on it to see the
					// pulses by, and the board's other GND to its ground wire.
					[480, 190, 480, 130],
					[480, 130, 480, 90],
					[480, 130, 460, 130],
					[480, 90, 640, 90],
					[380, 190, 380, 70],
					[380, 70, 640, 70],
					// The wiper to A0, the track across ground and 5V.
					[580, 610, 580, 670],
					[550, 700, 530, 700],
					[480, 610, 480, 760],
					[480, 760, 640, 760],
					[640, 760, 640, 700],
					[640, 700, 610, 700],
					// 5V on round to the servo's supply wire.
					[640, 760, 800, 760],
					[800, 760, 800, 80],
					[800, 80, 640, 80]
				]
			)
	},

	{
		id: 'seven-segment',
		name: 'Seven-segment digit',
		description:
			'Eight LEDs in the shape of a number, a switch each, and a resistor per segment because they are still LEDs. It arrives showing 4 — b, c, f and g — and every other digit is a matter of which switches are down. The common pin goes to ground, which is what common-cathode means: a segment lights when its own switch drives it high. One resistor on the common pin instead of eight would have been cheaper and wrong: the digit would dim as more bars came on.',
		stopTime: 20e-6,
		build: () => {
			// b, c, f and g lit is a 4.
			const lit = new Set(['b', 'c', 'f', 'g']);
			/** Where the digit sits; its eight pins are 20 apart down the left of it. */
			const DIGIT_X = 900;
			const DIGIT_Y = 190;

			const parts: Placed[] = [
				{ kind: 'display7', name: 'DS1', x: DIGIT_X, y: DIGIT_Y, params: { colour: 'red' } },
				{ kind: 'ground', name: 'GND1', x: DIGIT_X, y: 340 }
			];
			const wires: Array<[number, number, number, number]> = [
				[DIGIT_X, DIGIT_Y + 62, DIGIT_X, 330]
			];

			for (const [i, segment] of SEGMENTS.entries()) {
				// The switches need room the digit's own pins do not, so each run steps
				// across in its own column on the way in. Crossing the others costs
				// nothing; landing on one would be another matter.
				const y = 100 + i * 60;
				const pin = DIGIT_Y + (i - 3.5) * 10;
				const column = 620 + i * 10;
				parts.push(
					{
						kind: 'toggle',
						name: segment.toUpperCase(),
						x: 120,
						y,
						params: { state: lit.has(segment) ? 'high' : 'low' }
					},
					// One per segment, and not shared.
					{ kind: 'resistor', name: `R${i + 1}`, x: 380, y, params: { resistance: 330 } }
				);
				wires.push(
					[150, y, 350, y],
					[410, y, column, y],
					[column, y, column, pin],
					[column, pin, DIGIT_X - 50, pin]
				);
			}

			return build(parts, wires);
		}
	},

	{
		id: 'uno-count-digit',
		name: 'Uno counting on a digit',
		description:
			"An Arduino Uno counting 0 to 9 on a seven-segment digit, a number every half second, through a 74HC595 — which is how a sketch drives eight segments from three pins. The program shifts each digit's pattern into the 595 a bit at a time on D8 and D12, then pulses D10, and the outputs take all eight bits at once, so the digit never shows the bits passing through. Each segment is still an LED with a resistor of its own: the 595 drives, it does not limit. OE is held low so the outputs are on, and SRCLR high so nothing clears them. The program is a few dozen instructions assembled by hand; select the board to load a sketch of your own.",
		stopTime: 5.25,
		build: () => {
			/** The 595's legs: 20 apart, pin 1 at the top left, pin 16 at the top right. */
			const CHIP_X = 1000;
			const CHIP_Y = 400;
			const LEFT = CHIP_X - 60;
			const RIGHT = CHIP_X + 60;
			const leg = (fromTop: number) => CHIP_Y - 70 + fromTop * 20;
			/** The digit, whose eight segment pins are 10 apart down its left. */
			const DIGIT_X = 1450;
			const DIGIT_Y = 250;
			/** Where each segment's resistor sits, one row per output. */
			const RES_X = 1250;
			/** The Uno's top header: D12 at x 1120, D10 at 1160, D8 at 1200. */
			const HEADER = 620;

			const parts: Placed[] = [
				{
					kind: 'ic:ArduinoUno',
					name: 'U1',
					x: 1200,
					y: 830,
					params: { firmware: intelHex(COUNT_PROGRAM.flatMap(([words]) => words)) }
				},
				{ kind: 'ic:74595', name: 'U2', x: CHIP_X, y: CHIP_Y },
				{ kind: 'display7', name: 'DS1', x: DIGIT_X, y: DIGIT_Y, params: { colour: 'red' } },
				{ kind: 'supply', name: 'PWR1', x: RIGHT + 20, y: leg(0) - 10, params: { voltage: 5 } },
				{ kind: 'supply', name: 'PWR2', x: RIGHT + 40, y: 540, params: { voltage: 5 } },
				{ kind: 'ground', name: 'GND1', x: LEFT - 20, y: leg(7) + 10 },
				{ kind: 'ground', name: 'GND2', x: 1180, y: 510 },
				{ kind: 'ground', name: 'GND3', x: DIGIT_X, y: 340 }
			];
			const wires: Array<[number, number, number, number]> = [
				// VCC, pin 16, and GND, pin 8.
				[RIGHT, leg(0), RIGHT + 20, leg(0)],
				[LEFT, leg(7), LEFT - 20, leg(7)],
				// SER, pin 14, from D8.
				[1200, HEADER, 1200, leg(2)],
				[1200, leg(2), RIGHT, leg(2)],
				// OE, pin 13, is active low: held down, the outputs drive.
				[RIGHT, leg(3), 1180, leg(3)],
				[1180, leg(3), 1180, 500],
				// RCLK, pin 12, from D10, and SRCLK, pin 11, from D12.
				[1160, HEADER, 1160, leg(4)],
				[1160, leg(4), RIGHT, leg(4)],
				[1120, HEADER, 1120, leg(5)],
				[1120, leg(5), RIGHT, leg(5)],
				// SRCLR, pin 10, is active low too: held up, nothing clears the register.
				[RIGHT, leg(6), RIGHT + 20, leg(6)],
				[RIGHT + 20, leg(6), RIGHT + 20, 550],
				[RIGHT + 20, 550, RIGHT + 40, 550],
				// The digit's common pin is its cathode, so a high output lights a bar.
				[DIGIT_X, DIGIT_Y + 62, DIGIT_X, 330]
			];

			// QA is pin 15, on the right beside SER; QB to QH are pins 1 to 7 down the
			// left, so each of those goes out in a column of its own and over the top
			// of the chip, the highest leg innermost so that none of them cross.
			const rowOf = (k: number) => (k === 0 ? leg(1) : 290 - 20 * k);
			for (const k of SEGMENTS.keys()) {
				const row = rowOf(k);
				if (k === 0) {
					wires.push([RIGHT, row, RES_X - 30, row]);
				} else {
					const column = LEFT - 10 - 10 * k;
					const y = leg(k - 1);
					wires.push([LEFT, y, column, y], [column, y, column, row], [column, row, RES_X - 30, row]);
				}
				parts.push({
					kind: 'resistor',
					name: `R${k + 1}`,
					x: RES_X,
					y: row,
					params: { resistance: 330 }
				});
				// Then across to the digit's pin for that segment, in a column each.
				const pin = DIGIT_Y + (k - 3.5) * 10;
				const column = 1300 + 10 * k;
				wires.push(
					[RES_X + 30, row, column, row],
					[column, row, column, pin],
					[column, pin, DIGIT_X - 50, pin]
				);
			}

			return build(parts, wires);
		}
	},

	{
		id: 'd-latch',
		name: 'D latch, level-triggered',
		description:
			'Four NAND gates and no flip-flop part in sight, because a flip-flop is not a part — it is a pair of gates each holding the other up. While Enable is high the output follows D straight through, which is what level-triggered means. Drop Enable and it keeps whatever D was at that moment, however much D moves afterwards, and that keeping is the whole of the memory. Compare it with the edge-triggered one, which is two of these back to back.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'toggle', name: 'D', x: 100, y: 120, params: { state: 'high' } },
					{ kind: 'toggle', name: 'EN', x: 100, y: 400, params: { state: 'high' } },
					// The input pair. With Enable low both of these sit high, which is the
					// combination the cross-coupled pair reads as "hold whatever you have".
					{ kind: 'nand', name: 'U1', x: 350, y: 170 },
					{ kind: 'nand', name: 'U2', x: 350, y: 310 },
					// And the pair that remembers.
					{ kind: 'nand', name: 'Q', x: 600, y: 150 },
					{ kind: 'nand', name: 'QN', x: 600, y: 330 },
					// The lamps hang off buffers rather than off the loop itself. A gate
					// output feeding a lamp is 8 mA out of something built to drive other
					// gates, and here it is worse than untidy: an LED on a net that is also
					// an input of the loop leaves the pair unable to settle at all.
					{ kind: 'buffer', name: 'B1', x: 760, y: 150 },
					{ kind: 'buffer', name: 'B2', x: 760, y: 330 },
					{ kind: 'resistor', name: 'R1', x: 900, y: 150, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 1000, y: 150, params: { colour: 'green' } },
					{ kind: 'resistor', name: 'R2', x: 900, y: 330, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 1000, y: 330, params: { colour: 'red' } },
					{ kind: 'ground', name: 'GND1', x: 1070, y: 400 }
				],
				[
					// D reaches the first gate only.
					[130, 120, 200, 120],
					[200, 120, 200, 160],
					[200, 160, 320, 160],
					// Enable reaches both, which is what makes it the gate on the whole
					// thing rather than an input like any other.
					[130, 400, 230, 400],
					[230, 180, 230, 400],
					[230, 180, 320, 180],
					[230, 320, 320, 320],
					[380, 170, 420, 170],
					[420, 170, 420, 300],
					[420, 300, 320, 300],
					[420, 140, 570, 140],
					[420, 140, 420, 170],
					[380, 310, 450, 310],
					[450, 310, 450, 320],
					[450, 320, 570, 320],
					// The cross-coupling: each output is an input of the other, and that is
					// the entire mechanism.
					[630, 150, 680, 150],
					[680, 150, 680, 220],
					[500, 220, 680, 220],
					[500, 220, 500, 340],
					[500, 340, 570, 340],
					[630, 330, 710, 330],
					[710, 260, 710, 330],
					[540, 260, 710, 260],
					[540, 160, 540, 260],
					[540, 160, 570, 160],
					// Out through the buffers to the lamps.
					[680, 150, 730, 150],
					[790, 150, 870, 150],
					[930, 150, 970, 150],
					[1030, 150, 1070, 150],
					[710, 330, 730, 330],
					[790, 330, 870, 330],
					[930, 330, 970, 330],
					[1030, 330, 1070, 330],
					[1070, 150, 1070, 390]
				]
			)
	},

	{
		id: 'master-slave',
		name: 'D flip-flop, edge-triggered',
		description:
			'Two of the level-triggered latches back to back on opposite halves of the clock, which is where the edge comes from. While the clock is low the first one follows D and the second holds; when the clock rises the first stops listening and the second copies what it caught. The two are never transparent at the same time, so a change on D can never run straight through to the output — and that, rather than any part called a flip-flop, is what edge-triggered means.',
		stopTime: 20e-6,
		build: () => {
			// Both latches sit at the same height, so the cascade is one straight wire
			// and the two enable rails stay clear of everything else.
			const Y = 120;
			const MASTER = 360;
			const SLAVE = 1060;
			/** Where each latch takes its enable from, to the left of its own gates. */
			const MASTER_EN = 320;
			const SLAVE_EN = 1020;

			const parts: Placed[] = [
				{ kind: 'toggle', name: 'D', x: 100, y: 120, params: { state: 'high' } },
				{ kind: 'clock', name: 'CLK1', x: 100, y: 640, params: { frequency: 1e6, duty: 0.5 } },
				// The master listens while the clock is low and the slave while it is
				// high. One inverter is the entire difference between this and two
				// latches wired in series, which would just be transparent twice over.
				{ kind: 'not', name: 'INV', x: 260, y: 640 },
				{ kind: 'buffer', name: 'B1', x: 1740, y: Y + 30 },
				{ kind: 'buffer', name: 'B2', x: 1740, y: Y + 210 },
				{ kind: 'resistor', name: 'R1', x: 1880, y: Y + 30, params: { resistance: 330 } },
				{ kind: 'led', name: 'D1', x: 1980, y: Y + 30, params: { colour: 'green' } },
				{ kind: 'resistor', name: 'R2', x: 1880, y: Y + 210, params: { resistance: 330 } },
				{ kind: 'led', name: 'D2', x: 1980, y: Y + 210, params: { colour: 'red' } },
				{ kind: 'ground', name: 'GND1', x: 2050, y: Y + 300 }
			];
			const wires: Array<[number, number, number, number]> = [];

			/**
			 * One four-NAND latch, the same drawing as the level-triggered example.
			 *
			 * Returns the points its d input is reached at and its two outputs leave
			 * from, because the second latch is wired to the first.
			 */
			const latch = (tag: string, x: number, enable: number) => {
				parts.push(
					{ kind: 'nand', name: `${tag}1`, x: x + 250, y: Y + 50 },
					{ kind: 'nand', name: `${tag}2`, x: x + 250, y: Y + 190 },
					{ kind: 'nand', name: `${tag}Q`, x: x + 500, y: Y + 30 },
					{ kind: 'nand', name: `${tag}N`, x: x + 500, y: Y + 210 }
				);
				wires.push(
					// Enable to both input gates, which is what makes it the gate on the
					// whole latch rather than an input like any other.
					[enable, Y + 60, x + 220, Y + 60],
					[enable, Y + 200, x + 220, Y + 200],
					// The first gate feeds the second as well as the pair, so an enable of
					// low leaves both of them high and the pair holds what it has.
					[x + 280, Y + 50, x + 320, Y + 50],
					[x + 320, Y + 50, x + 320, Y + 180],
					[x + 220, Y + 180, x + 320, Y + 180],
					[x + 320, Y + 20, x + 320, Y + 50],
					[x + 320, Y + 20, x + 470, Y + 20],
					[x + 280, Y + 190, x + 350, Y + 190],
					[x + 350, Y + 190, x + 350, Y + 200],
					[x + 350, Y + 200, x + 470, Y + 200],
					// Cross-coupled, which is the part that remembers.
					[x + 530, Y + 30, x + 580, Y + 30],
					[x + 580, Y + 30, x + 580, Y + 100],
					[x + 400, Y + 100, x + 580, Y + 100],
					[x + 400, Y + 100, x + 400, Y + 220],
					[x + 400, Y + 220, x + 470, Y + 220],
					[x + 530, Y + 210, x + 610, Y + 210],
					[x + 610, Y + 140, x + 610, Y + 210],
					[x + 440, Y + 140, x + 610, Y + 140],
					[x + 440, Y + 40, x + 440, Y + 140],
					[x + 440, Y + 40, x + 470, Y + 40]
				);
				return { d: x + 220, q: x + 580, qn: x + 610 };
			};

			const master = latch('M', MASTER, MASTER_EN);
			const slave = latch('S', SLAVE, SLAVE_EN);

			wires.push(
				// D into the master, above the enable rail rather than across it.
				[130, 120, 200, 120],
				[200, 120, 200, Y + 40],
				[200, Y + 40, master.d, Y + 40],
				// The clock into the inverter, and on to the slave's rail the long way
				// round, under everything.
				[130, 640, 230, 640],
				[180, 640, 180, 940],
				[180, 940, SLAVE_EN, 940],
				[SLAVE_EN, Y + 60, SLAVE_EN, 940],
				// The inverted clock up to the master's rail.
				[290, 640, MASTER_EN, 640],
				[MASTER_EN, Y + 60, MASTER_EN, 640],
				// The cascade: the master's q is the slave's d, on one straight line.
				[master.q, Y + 30, 980, Y + 30],
				[980, Y + 30, 980, Y + 40],
				[980, Y + 40, slave.d, Y + 40],
				// And the slave's outputs are the flip-flop's, out through the buffers.
				[slave.q, Y + 30, 1710, Y + 30],
				[slave.qn, Y + 210, 1710, Y + 210],
				[1770, Y + 30, 1850, Y + 30],
				[1910, Y + 30, 1950, Y + 30],
				[2010, Y + 30, 2050, Y + 30],
				[1770, Y + 210, 1850, Y + 210],
				[1910, Y + 210, 1950, Y + 210],
				[2010, Y + 210, 2050, Y + 210],
				[2050, Y + 30, 2050, Y + 290]
			);

			return build(parts, wires);
		}
	},

	{
		id: 'flip-flop',
		name: 'D flip-flop',
		description:
			'A latch that only listens on the edge of a clock. Flip the input while it is running and nothing happens until the next rising edge, which is the point of it: everything on the board changes at the same instant instead of whenever its own gates finish. The two lamps are Q and its opposite.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'toggle', name: 'IN', x: 100, y: 120, params: { state: 'high' } },
					{ kind: 'clock', name: 'CLK1', x: 100, y: 220, params: { frequency: 1e6, duty: 0.5 } },
					{ kind: 'dff', name: 'FF1', x: 330, y: 200 },
					{ kind: 'resistor', name: 'R1', x: 470, y: 120, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 570, y: 120, params: { colour: 'green' } },
					{ kind: 'resistor', name: 'R2', x: 470, y: 280, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 570, y: 280, params: { colour: 'red' } },
					{ kind: 'ground', name: 'GND1', x: 640, y: 350 }
				],
				[
					// The level waiting at d, and the clock that decides when it is taken.
					[130, 120, 180, 120],
					[180, 120, 180, 180],
					[180, 180, 300, 180],
					[130, 220, 300, 220],
					// q up and qn down, far enough apart that their readings do not sit on
					// each other.
					[360, 180, 420, 180],
					[420, 120, 420, 180],
					[420, 120, 440, 120],
					[500, 120, 540, 120],
					[600, 120, 640, 120],
					[360, 220, 420, 220],
					[420, 220, 420, 280],
					[420, 280, 440, 280],
					[500, 280, 540, 280],
					[600, 280, 640, 280],
					[640, 120, 640, 340]
				]
			)
	},

	{
		id: 'divider',
		name: 'Clock divider',
		description:
			'A toggle flip-flop halving a clock. Purely digital, so it runs on the event queue with no matrix at all.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					{ kind: 'clock', name: 'CLK1', x: 120, y: 220, params: { frequency: 1e6, duty: 0.5 } },
					{ kind: 'dff', name: 'FF1', x: 300, y: 200 }
				],
				[
					// Clock into the flip-flop.
					[150, 220, 270, 220],
					// qn wrapped back around to d, which is what makes it toggle.
					[330, 220, 380, 220],
					[380, 140, 380, 220],
					[240, 140, 380, 140],
					[240, 140, 240, 180],
					[240, 180, 270, 180]
				]
			)
	},

	{
		id: 'ripple-counter',
		name: '4-bit ripple counter',
		description:
			'Four toggle flip-flops in a row, each clocked by the one above it, counting 0 to 15 in binary on the lamps. Ripple, because nothing here shares a clock: each stage waits for the one before it to fall, so the count arrives at the top a few gate delays after it arrives at the bottom and the number is briefly wrong on the way past.',
		stopTime: 40e-6,
		build: () => {
			// Bit 0 on top, halving the clock; each one below halves again.
			const PITCH = 190;
			const parts: Placed[] = [
				{ kind: 'clock', name: 'CLK1', x: 100, y: 160, params: { frequency: 1e6, duty: 0.5 } },
				{ kind: 'ground', name: 'GND1', x: 900, y: 760 }
			];
			const wires: Array<[number, number, number, number]> = [
				// The clock, into the first stage only.
				[130, 160, 270, 160],
				// One return rail for all four lamps.
				[900, 120, 900, 750]
			];

			for (let k = 0; k < 4; k++) {
				const y = 140 + k * PITCH;
				parts.push(
					{ kind: 'dff', name: `FF${k}`, x: 300, y },
					{ kind: 'resistor', name: `R${k}`, x: 730, y: y - 20, params: { resistance: 330 } },
					{ kind: 'led', name: `D${k}`, x: 830, y: y - 20, params: { colour: 'red' } }
				);
				wires.push(
					// qn back around to d, which is what makes a D flip-flop toggle: it is
					// told to become whatever it is not.
					[330, y + 20, 380, y + 20],
					[380, y + 20, 380, y + 80],
					[250, y + 80, 380, y + 80],
					[250, y - 20, 250, y + 80],
					[250, y - 20, 270, y - 20],
					// q out to its lamp, clear of the rail carrying qn back.
					[330, y - 20, 700, y - 20],
					[760, y - 20, 800, y - 20],
					[860, y - 20, 900, y - 20]
				);
				if (k < 3) {
					// And qn on down to clock the next stage. Taken from qn rather than q
					// so the stage above ticks as this one falls, which is what counts up
					// rather than down.
					wires.push(
						[380, y + 80, 380, y + 130],
						[210, y + 130, 380, y + 130],
						[210, y + 130, 210, y + PITCH + 20],
						[210, y + PITCH + 20, 270, y + PITCH + 20]
					);
				}
			}

			return build(parts, wires);
		}
	},

	{
		id: 'switch-bounce',
		name: 'Switch and contact bounce',
		description:
			'A supply, a switch and an RC. The switch closes at two milliseconds and the contacts chatter for one more before they settle — which is why anything counting edges has to be debounced. The 100 kΩ is not decoration: without a path to ground the capacitor would charge through the open switch.',
		stopTime: 10e-3,
		build: () =>
			build(
				[
					{ kind: 'supply', name: 'PWR1', x: 200, y: 100, params: { voltage: 5 } },
					{
						kind: 'switch',
						name: 'S1',
						x: 200,
						y: 170,
						rotation: 90,
						params: { action: 'toggle', start: 'open', at: 2e-3, bounce: 1e-3 }
					},
					{ kind: 'resistor', name: 'R1', x: 200, y: 260, rotation: 90, params: { resistance: 1000 } },
					{
						kind: 'resistor',
						name: 'R2',
						x: 200,
						y: 350,
						rotation: 90,
						params: { resistance: 100000 }
					},
					{ kind: 'capacitor', name: 'C1', x: 320, y: 350, rotation: 90, params: { capacitance: 1e-6 } },
					{ kind: 'probe', name: 'P1', x: 400, y: 290, params: { label: 'out' } },
					{ kind: 'ground', name: 'GND1', x: 200, y: 440 }
				],
				[
					[200, 110, 200, 140],
					[200, 200, 200, 230],
					[200, 290, 200, 320],
					[200, 290, 320, 290],
					[320, 290, 320, 320],
					[320, 290, 400, 290],
					[200, 380, 200, 430],
					[200, 410, 320, 410],
					[320, 380, 320, 410]
				]
			)
	},

	{
		id: 'half-adder',
		name: 'Half adder',
		description:
			'Two bits in, two bits out: the XOR is the sum and the AND is the carry. Half, because it has no way to accept a carry from the column to its right — that is the one thing the full adder adds. Both switches start high, so the sum is zero and the carry is one. Click either to flip it.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					// Logic toggles, not switches. A switch is a contact: it joins a net to
					// something or leaves it joined to nothing, and nothing is not a logic
					// level, so feeding a gate from one needs a resistor holding the input
					// down while the contact is open. These drive the net in both positions.
					{ kind: 'toggle', name: 'A', x: 100, y: 140, params: { state: 'high' } },
					{ kind: 'toggle', name: 'B', x: 100, y: 300, params: { state: 'high' } },
					{ kind: 'xor', name: 'SUM', x: 330, y: 150 },
					{ kind: 'and', name: 'CARRY', x: 330, y: 250 },
					// Each answer ends on a lamp. A gate output has to drive something —
					// a wire trailing off into space is not a load, and the compiler says so
					// — and a lit LED is the reading, without going to the scope for it.
					{ kind: 'resistor', name: 'R1', x: 470, y: 150, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 570, y: 150, params: { colour: 'red' } },
					{ kind: 'resistor', name: 'R2', x: 470, y: 250, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 570, y: 250, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND1', x: 640, y: 320 }
				],
				[
					// A down its own rail, tapped at both gates.
					[130, 140, 170, 140],
					[170, 140, 170, 240],
					[170, 140, 300, 140],
					[170, 240, 300, 240],
					// B likewise, one rail further right. Where the two cross, nothing
					// happens: wires only join where one of them has a corner on the other.
					[130, 300, 200, 300],
					[200, 160, 200, 300],
					[200, 160, 300, 160],
					[200, 260, 300, 260],
					// Sum, then carry, each through its own resistor and lamp.
					[360, 150, 440, 150],
					[500, 150, 540, 150],
					[600, 150, 640, 150],
					[360, 250, 440, 250],
					[500, 250, 540, 250],
					[600, 250, 640, 250],
					// One return rail down to the single ground symbol.
					[640, 150, 640, 310]
				]
			)
	},

	{
		id: 'full-adder',
		name: 'Full adder',
		description:
			'The circuit inside every processor, three gates wide. Sum is the parity of the three inputs, so it is one XOR with three inputs rather than two in a row; the carry is the majority of them. All three switches arrive high — one and one and one is three, which is a one and a carry — and both lamps are lit. Click any of them to work through the other seven combinations.',
		stopTime: 20e-6,
		build: () =>
			build(
				[
					// A, B and the carry in, each one set by hand. Logic toggles rather than
					// switches: a switch is a contact, and an open contact leaves a gate input
					// on nothing at all, which is not a logic level and needs a resistor to
					// hold it. These drive the net in both positions.
					{ kind: 'toggle', name: 'A', x: 100, y: 100, params: { state: 'high' } },
					{ kind: 'toggle', name: 'B', x: 100, y: 180, params: { state: 'high' } },
					{ kind: 'toggle', name: 'CIN', x: 100, y: 260, params: { state: 'high' } },
					// Sum. Parity of three, which is one decision and one delay.
					{ kind: 'xor', name: 'U1', x: 330, y: 120, params: { inputs: 3 } },
					// Carry out: any two of the three.
					{ kind: 'and', name: 'U2', x: 330, y: 220 },
					{ kind: 'and', name: 'U3', x: 330, y: 290 },
					{ kind: 'and', name: 'U4', x: 330, y: 360 },
					{ kind: 'or', name: 'U5', x: 470, y: 290, params: { inputs: 3 } },
					// Sum and carry each end on a lamp. A gate output has to drive something:
					// a wire trailing off into space is not a load, and the compiler says so.
					{ kind: 'resistor', name: 'R1', x: 560, y: 120, params: { resistance: 330 } },
					{ kind: 'led', name: 'D1', x: 660, y: 120, params: { colour: 'red' } },
					{ kind: 'resistor', name: 'R2', x: 560, y: 290, params: { resistance: 330 } },
					{ kind: 'led', name: 'D2', x: 660, y: 290, params: { colour: 'green' } },
					{ kind: 'ground', name: 'GND1', x: 730, y: 360 }
				],
				[
					// Three vertical rails down the left, tapped where each gate needs
					// them, and each one stopping at its last tap. Crossing one costs
					// nothing: two wires only join where one of them has a corner on the
					// other.
					[130, 100, 170, 100],
					[170, 100, 170, 350],
					[130, 180, 190, 180],
					[190, 120, 190, 280],
					[130, 260, 210, 260],
					[210, 140, 210, 370],
					// A
					[170, 100, 300, 100],
					[170, 210, 300, 210],
					[170, 350, 300, 350],
					// B
					[190, 120, 300, 120],
					[190, 230, 300, 230],
					[190, 280, 300, 280],
					// Cin
					[210, 140, 300, 140],
					[210, 300, 300, 300],
					[210, 370, 300, 370],
					// The three partial carries into the OR.
					[360, 220, 400, 220],
					[400, 220, 400, 270],
					[400, 270, 440, 270],
					[360, 290, 440, 290],
					[360, 360, 410, 360],
					[410, 310, 410, 360],
					[410, 310, 440, 310],
					// Sum and carry, each through its own resistor and lamp.
					[360, 120, 530, 120],
					[590, 120, 630, 120],
					[690, 120, 730, 120],
					[500, 290, 530, 290],
					[590, 290, 630, 290],
					[690, 290, 730, 290],
					// One return rail down to the single ground symbol.
					[730, 120, 730, 350]
				]
			)
	},

	{
		id: 'adder-4bit',
		name: '4-bit adder',
		description:
			'Four columns of an addition, each handing its carry down to the next. The first column has nothing carried into it, so it is a half adder; the other three are full adders written as propagate and generate. A and B start at 7 and 3, which makes the carry ripple through three stages before it dies — flip any switch on the left and watch where it stops.',
		stopTime: 20e-6,
		build: () => {
			// Bit 0 on top, so the carry runs downwards and every stage looks the same.
			const a = ['high', 'high', 'high', 'low'];
			const b = ['high', 'high', 'low', 'low'];
			/** Vertical distance between one bit and the next. */
			const PITCH = 190;

			const parts: Placed[] = [];
			const wires: Array<[number, number, number, number]> = [];

			/**
			 * One bit of the answer, on a lamp.
			 *
			 * A gate output has to drive something. A wire trailing off into space is
			 * not a load — the compiler says so, and rightly — and five lit or unlit
			 * lamps are the answer read straight off the drawing.
			 */
			const lamp = (bit: number, from: number, y: number) => {
				parts.push(
					{ kind: 'resistor', name: `R${bit}`, x: 730, y, params: { resistance: 330 } },
					{
						kind: 'led',
						name: `D${bit}`,
						x: 830,
						y,
						// The carry out is the fifth bit and a different kind of answer, so it
						// gets a different colour.
						params: { colour: bit === 4 ? 'green' : 'red' }
					}
				);
				wires.push([from, y, 700, y], [760, y, 800, y], [860, y, 900, y]);
			};

			for (let k = 0; k < 4; k++) {
				const y = 120 + k * PITCH;
				parts.push(
					{ kind: 'toggle', name: `A${k}`, x: 100, y: y - 10, params: { state: a[k] } },
					{ kind: 'toggle', name: `B${k}`, x: 100, y: y + 90, params: { state: b[k] } },
					// Propagate and generate: what this column knows on its own, before
					// anything arrives from the one above it.
					{ kind: 'xor', name: `P${k}`, x: 300, y },
					{ kind: 'and', name: `G${k}`, x: 300, y: y + 70 }
				);
				wires.push(
					// A down its own rail, tapped at both gates.
					[130, y - 10, 170, y - 10],
					[170, y - 10, 170, y + 60],
					[170, y - 10, 270, y - 10],
					[170, y + 60, 270, y + 60],
					// B likewise, one rail further right.
					[130, y + 90, 200, y + 90],
					[200, y + 10, 200, y + 90],
					[200, y + 10, 270, y + 10],
					[200, y + 80, 270, y + 80]
				);

				if (k === 0) {
					// Nothing carries into the first column, so P0 is already the sum and G0
					// is already the carry. That is a half adder, and this is the only column
					// where one is enough.
					lamp(0, 330, y);
					wires.push([330, y + 70, 395, y + 70], [395, y + 70, 395, y + PITCH - 10]);
					continue;
				}

				parts.push(
					{ kind: 'xor', name: `S${k}`, x: 450, y: y - 20 },
					{ kind: 'and', name: `PC${k}`, x: 450, y: y + 40 },
					{ kind: 'or', name: `CO${k}`, x: 600, y: y + 50 }
				);
				wires.push(
					// P reaches over the carry rail to the sum and under it to the AND, so
					// the two rails run side by side without ever crossing.
					[330, y, 370, y],
					[370, y - 30, 370, y + 50],
					[370, y - 30, 420, y - 30],
					[370, y + 50, 420, y + 50],
					// The carry that arrived from the bit above.
					[395, y - 10, 395, y + 30],
					[395, y - 10, 420, y - 10],
					[395, y + 30, 420, y + 30],
					// Carry out: either this column generated one, or it propagated the one
					// it was given.
					[480, y + 40, 570, y + 40],
					[330, y + 70, 540, y + 70],
					[540, y + 60, 540, y + 70],
					[540, y + 60, 570, y + 60]
				);
				// Every sum bit ends on the same column, so the answer reads down the
				// right-hand edge in the order it is written.
				lamp(k, 480, y - 20);

				if (k < 3) {
					// Down the right and back to the next bit's carry rail.
					wires.push(
						[630, y + 50, 660, y + 50],
						[660, y + 50, 660, y + 130],
						[395, y + 130, 660, y + 130],
						[395, y + 130, 395, y + PITCH - 10]
					);
				} else {
					// The carry out of the last column is the fifth bit of the answer,
					// dropped clear of the sum above it so the two readings do not overlap.
					wires.push([630, y + 50, 660, y + 50], [660, y + 50, 660, y + 120]);
					lamp(4, 660, y + 120);
				}
			}

			// One return rail for all five lamps, and one ground symbol on it.
			parts.push({ kind: 'ground', name: 'GND1', x: 900, y: 860 });
			wires.push([900, 120, 900, 850]);

			return build(parts, wires);
		}
	},

	{
		id: 'voltage-divider',
		name: 'Voltage divider',
		description:
			'Two resistors and nothing else. 12 V across 2 kΩ and 1 kΩ puts exactly 4 V on the join — the simplest circuit whose answer you can check in your head.',
		stopTime: 1e-3,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'V1', x: 100, y: 200, params: { waveform: 'dc', value: 12 } },
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 2000 } },
					{
						kind: 'resistor',
						name: 'R2',
						x: 350,
						y: 230,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'rc-highpass',
		name: 'RC high-pass',
		description:
			'The low-pass turned around: the capacitor is in the way, so an edge gets through and a steady level does not. The output jumps with each transition and decays over one RC.',
		stopTime: 5e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 500, duty: 0.5 }
					},
					{ kind: 'capacitor', name: 'C1', x: 250, y: 170, params: { capacitance: 1e-6 } },
					{
						kind: 'resistor',
						name: 'R1',
						x: 350,
						y: 230,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'rl-step',
		name: 'RL step',
		description:
			'Current through an inductor cannot change instantly. It climbs towards V/R along an exponential of time constant L/R — 100 µs here, against a 250 µs half-period, so it very nearly gets there.',
		stopTime: 1e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 2000, duty: 0.5 }
					},
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 100 } },
					{
						kind: 'inductor',
						name: 'L1',
						x: 350,
						y: 230,
						rotation: 90,
						params: { inductance: 10e-3 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'diode-clipper',
		name: 'Diode clipper',
		description:
			'Two diodes back to back across the output. Anything past a forward drop in either direction finds a path to ground, so a 5 V sine comes out flattened at about ±0.7 V.',
		stopTime: 3e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 5, offset: 0, frequency: 1000 }
					},
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 1000 } },
					{ kind: 'diode', name: 'D1', x: 350, y: 230, rotation: 90 },
					// Turned the other way, so the pair covers both halves of the swing.
					{ kind: 'diode', name: 'D2', x: 430, y: 230, rotation: 270 },
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 430, 170],
					[350, 170, 350, 200],
					[430, 170, 430, 200],
					[350, 260, 350, 290],
					[430, 260, 430, 290],
					[100, 290, 430, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'zener-shunt',
		name: 'Zener regulator',
		description:
			'A zener across the load, cathode to the positive side, fed through a resistor. Past its breakdown voltage it conducts backwards and pins the rail there, however the supply wanders above it.',
		stopTime: 2e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 200,
						params: { waveform: 'sine', value: 3, offset: 12, frequency: 1000 }
					},
					{ kind: 'resistor', name: 'R1', x: 250, y: 170, params: { resistance: 470 } },
					{
						kind: 'diode',
						name: 'D1',
						x: 350,
						y: 230,
						rotation: 270,
						params: { model: 'zener', breakdown: 5.1 }
					},
					{ kind: 'ground', name: 'GND1', x: 100, y: 300 }
				],
				[
					[100, 170, 220, 170],
					[280, 170, 350, 170],
					[350, 170, 350, 200],
					[350, 260, 350, 290],
					[100, 290, 350, 290],
					[100, 230, 100, 290]
				]
			)
	},

	{
		id: 'opamp-inverting',
		name: 'Inverting amplifier',
		description:
			'The feedback resistor over the input resistor sets the gain and nothing else does: 47 kΩ over 10 kΩ is −4.7, upside down. The op-amp only has to be good enough to hold its two inputs together.',
		stopTime: 3e-3,
		build: () =>
			build(
				[
					{
						kind: 'vsource',
						name: 'V1',
						x: 100,
						y: 240,
						params: { waveform: 'sine', value: 0.5, offset: 0, frequency: 1000 }
					},
					{ kind: 'resistor', name: 'RIN', x: 250, y: 210, params: { resistance: 10000 } },
					{ kind: 'resistor', name: 'RF', x: 400, y: 100, params: { resistance: 47000 } },
					{ kind: 'opamp', name: 'U1', x: 400, y: 200 },
					{ kind: 'ground', name: 'GND1', x: 100, y: 340 },
					{ kind: 'ground', name: 'GND2', x: 320, y: 200 }
				],
				[
					[100, 210, 220, 210],
					[280, 210, 330, 210],
					[330, 210, 370, 210],
					[330, 100, 330, 210],
					[330, 100, 370, 100],
					[430, 100, 470, 100],
					[470, 100, 470, 200],
					[430, 200, 470, 200],
					[320, 190, 370, 190],
					[100, 270, 100, 330]
				]
			)
	},

	{
		id: 'emitter-follower',
		name: 'Emitter follower',
		description:
			'No voltage gain at all — the emitter sits a diode drop below the base and copies whatever it does. What it buys is current: a stiff output from a source that could not have driven the load itself.',
		stopTime: 3e-3,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'VCC', x: 120, y: 150, params: { waveform: 'dc', value: 10 } },
					{
						kind: 'vsource',
						name: 'V1',
						x: 200,
						y: 330,
						params: { waveform: 'sine', value: 2, offset: 5, frequency: 1000 }
					},
					{ kind: 'npn', name: 'Q1', x: 400, y: 250 },
					{
						kind: 'resistor',
						name: 'RE',
						x: 410,
						y: 340,
						rotation: 90,
						params: { resistance: 1000 }
					},
					{ kind: 'ground', name: 'GND1', x: 120, y: 410 }
				],
				[
					[120, 120, 410, 120],
					[410, 120, 410, 220],
					[200, 300, 370, 300],
					[370, 250, 370, 300],
					[410, 280, 410, 310],
					[410, 370, 410, 400],
					[120, 400, 410, 400],
					[120, 180, 120, 400],
					[200, 360, 200, 400]
				]
			)
	},

	{
		id: 'cmos-inverter',
		name: 'CMOS inverter',
		description:
			'One MOSFET of each kind, gates tied together. Whichever way the input goes one device is on and the other is off, so the output reaches both rails and neither transistor passes any current once it has settled. Watch the spike on each edge: the gate is coupled to the drain through its own capacitance, and with nothing loading the output that charge pushes it past the supply until the body diodes catch it.',
		stopTime: 4e-4,
		build: () =>
			build(
				[
					{ kind: 'vsource', name: 'VDD', x: 120, y: 150, params: { waveform: 'dc', value: 5 } },
					{
						kind: 'vsource',
						name: 'V1',
						x: 200,
						y: 330,
						params: { waveform: 'pulse', value: 5, offset: 0, frequency: 10000, duty: 0.5 }
					},
					{ kind: 'pmos', name: 'M1', x: 400, y: 180 },
					{ kind: 'nmos', name: 'M2', x: 400, y: 320 },
					{ kind: 'ground', name: 'GND1', x: 120, y: 410 }
				],
				[
					[120, 120, 410, 120],
					[410, 120, 410, 150],
					[410, 210, 410, 290],
					[410, 350, 410, 400],
					[120, 400, 410, 400],
					[120, 180, 120, 400],
					[200, 360, 200, 400],
					[200, 300, 300, 300],
					[300, 180, 300, 320],
					[300, 180, 370, 180],
					[300, 320, 370, 320]
				]
			)
	}
];

export function exampleById(id: string): Example {
	return EXAMPLES.find((e) => e.id === id) ?? EXAMPLES[0];
}

export type ExampleDomain = 'Analog' | 'Logic' | 'Mixed signal';

/** Parts that join a circuit without making it analog or digital. */
const NEUTRAL = new Set(['ground', 'supply', 'probe', 'port']);
/**
 * What a logic circuit shows its state with. An adder lighting LEDs through
 * resistors is a logic example, not a mixed-signal one.
 */
const INDICATORS = new Set(['led', 'display7', 'display7x4', 'resistor']);

const domains = new Map<string, ExampleDomain>();

/**
 * Which shelf an example goes on, read off the parts it is built from.
 *
 * Read rather than written on each example, so a new one cannot be filed on
 * the wrong shelf: a part with a digital pin is logic, anything else that is
 * not a rail, a marker or an indicator is analog, and a circuit with both is the thing
 * repath is for.
 */
export function exampleDomain(example: Example): ExampleDomain {
	let domain = domains.get(example.id);
	if (domain) return domain;
	let digital = false;
	let analog = false;
	for (const instance of example.build().instances) {
		if (NEUTRAL.has(instance.kind)) continue;
		// A block or an imported part is not in the catalog; its insides decide.
		if (instance.kind.includes(':') && !instance.kind.startsWith('ic:')) continue;
		if (definitionOf(instance.kind).pins.some((pin) => pin.domain === 'digital')) digital = true;
		else if (!INDICATORS.has(instance.kind)) analog = true;
	}
	domain = !digital ? 'Analog' : analog ? 'Mixed signal' : 'Logic';
	domains.set(example.id, domain);
	return domain;
}
