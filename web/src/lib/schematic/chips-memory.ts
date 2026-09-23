/**
 * Memory: static RAM, and EEPROM read the way a ROM is.
 *
 * All four are the JEDEC byte-wide parts, which share one way of being wired:
 * address in, eight data legs that are inputs and outputs both, and three
 * active-low controls. Chip enable picks the part, output enable lets it drive
 * the data legs, write enable stores what is on them. The cells are the
 * engine's `memory` device; the controls and the three-state legs around it are
 * gates and buffers, the same way they sit around the cell array on the die.
 *
 * The RAMs come up holding nothing anybody can know, and read as undetermined
 * until written. The EEPROMs start from whatever the inspector says they hold,
 * which is how one is programmed here, and read FF where it says nothing.
 */

import type { ChipBlock, ChipDef } from './chips';

const DATA = [0, 1, 2, 3, 4, 5, 6, 7].map((bit) => `IO${bit}`);

/**
 * The inside of a byte-wide memory with `bits` address lines.
 *
 * Written while CE and WE are both low. Driving while CE and OE are low and WE
 * is high — a write takes the data legs over as inputs whatever OE says, which
 * is what lets a part be written with its outputs left enabled.
 */
function byteWide(bits: number, delay: number): ChipBlock[] {
	return [
		{ kind: 'not', inputs: ['CE'], output: 'selected' },
		{ kind: 'not', inputs: ['OE'], output: 'reading' },
		{ kind: 'not', inputs: ['WE'], output: 'writing' },
		{ kind: 'and', inputs: ['selected', 'writing'], output: 'store' },
		{ kind: 'and', inputs: ['selected', 'reading', 'WE'], output: 'drive' },
		{
			kind: 'memory',
			address: Array.from({ length: bits }, (_, bit) => `A${bit}`),
			dataIn: DATA,
			dataOut: DATA.map((_, bit) => `cell${bit}`),
			write: 'store',
			delay
		},
		...DATA.map(
			(leg, bit): ChipBlock => ({
				kind: 'tristate',
				inputs: [`cell${bit}`],
				enable: 'drive',
				output: leg
			})
		)
	];
}

/** The 24-pin 2K × 8 package, shared by the 6116 and the 28C16. */
const DIP24 = [
	'A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'IO0', 'IO1', 'IO2', 'GND',
	'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'CE', 'A10', 'OE', 'WE', 'A9', 'A8', 'VCC'
];

/** The 28-pin 32K × 8 package, shared by the 62256 and the 28C256. */
const DIP28 = [
	'A14', 'A12', 'A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'IO0', 'IO1', 'IO2', 'GND',
	'IO3', 'IO4', 'IO5', 'IO6', 'IO7', 'CE', 'A10', 'OE', 'A11', 'A9', 'A8', 'A13', 'WE', 'VCC'
];

const EEPROM_CAVEAT =
	'A byte is stored the moment WE is low, as in a RAM. The real part takes a millisecond or more to write it, and reads back the complement of bit 7 on I/O7 until it has.';

const RAM_CAVEAT =
	'It powers up holding nothing in particular, and reads as undetermined until each byte has been written.';

export const MEMORY_CHIPS: ChipDef[] = [
	{
		id: '6116',
		role: 'memory',
		description: '2K × 8 static RAM',
		aliases: ['hm6116', 'sram', 'ram', '2k'],
		layout: DIP24,
		blocks: byteWide(11, 150e-9),
		caveat: RAM_CAVEAT
	},
	{
		id: '62256',
		role: 'memory',
		description: '32K × 8 static RAM',
		aliases: ['as6c62256', 'hm62256', 'sram', 'ram', '32k'],
		layout: DIP28,
		blocks: byteWide(15, 70e-9),
		caveat: RAM_CAVEAT
	},
	{
		id: '28C16',
		role: 'memory',
		description: '2K × 8 EEPROM, programmed from the inspector',
		aliases: ['at28c16', 'eeprom', 'rom', 'eprom', '2716', 'lookup table'],
		layout: DIP24,
		blocks: byteWide(11, 150e-9),
		contents: { erased: 0xff },
		caveat: EEPROM_CAVEAT
	},
	{
		id: '28C256',
		role: 'memory',
		description: '32K × 8 EEPROM, programmed from the inspector',
		aliases: ['at28c256', 'eeprom', 'rom', 'eprom', '27256', 'lookup table'],
		layout: DIP28,
		blocks: byteWide(15, 150e-9),
		contents: { erased: 0xff },
		caveat: EEPROM_CAVEAT
	}
];
