/**
 * Reading a `.model` card correctly, which mostly means reading its numbers
 * correctly.
 *
 * The cards below are the real ones — the 2N3904 and 1N4148 as they are
 * distributed — because a parser tested only against input its author invented
 * is a parser tested against its own assumptions.
 */

import { describe, expect, it } from 'vitest';
import {
	bjtFromCard,
	cardFor,
	diodeFromCard,
	kindForCard,
	mosfetFromCard,
	parseModelCards,
	parseSpiceNumber
} from './spice';

const Q2N3904 = `
.MODEL 2N3904 NPN(IS=6.734f XTI=3 EG=1.11 VAF=74.03 BF=416.4 NE=1.259
+ ISE=6.734f IKF=66.78m XTB=1.5 BR=.7371 NC=2 ISC=0 IKR=0 RC=1
+ CJC=3.638p MJC=.3085 VJC=.75 FC=.5 CJE=4.493p MJE=.2593 VJE=.75
+ TR=239.5n TF=301.2p ITF=.4 VTF=4 XTF=2 RB=10)
`;

const D1N4148 = `* Diode
.MODEL 1N4148 D(IS=2.52n RS=.568 N=1.752 CJO=4p M=.4 TT=20n BV=100 IBV=.1u)
`;

describe('numbers', () => {
	it('reads the scale suffixes', () => {
		expect(parseSpiceNumber('1k')).toBe(1e3);
		expect(parseSpiceNumber('4p')).toBe(4e-12);
		expect(parseSpiceNumber('239.5n')).toBeCloseTo(239.5e-9, 20);
		expect(parseSpiceNumber('.5u')).toBeCloseTo(0.5e-6, 20);
		expect(parseSpiceNumber('-2.5G')).toBe(-2.5e9);
	});

	it('tells mega from milli', () => {
		// The single most expensive letter in the format. `1M` is a billionth of
		// `1MEG`, and an Early voltage read as the wrong one turns an amplifier
		// into a device with no gain whatsoever.
		expect(parseSpiceNumber('1MEG')).toBe(1e6);
		expect(parseSpiceNumber('1M')).toBe(1e-3);
		expect(parseSpiceNumber('1meg')).toBe(1e6);
		expect(parseSpiceNumber('2.2MEGOHM')).toBe(2.2e6);
	});

	it('ignores whatever unit was written after the suffix', () => {
		// `4pF` is four picofarads and `4F` is four femtofarads. The rule is the
		// same both times — take the suffix once, treat the rest as a note to the
		// reader — which is what makes the pair consistent rather than a trap.
		expect(parseSpiceNumber('4pF')).toBe(4e-12);
		expect(parseSpiceNumber('4F')).toBe(4e-15);
		expect(parseSpiceNumber('10kohm')).toBe(1e4);
	});

	it('reads exponents, with or without a suffix', () => {
		expect(parseSpiceNumber('6.734e-15')).toBeCloseTo(6.734e-15, 25);
		expect(parseSpiceNumber('1E3')).toBe(1000);
	});

	it('refuses what is not a number', () => {
		expect(parseSpiceNumber('')).toBeNull();
		expect(parseSpiceNumber('poly')).toBeNull();
		expect(parseSpiceNumber('e9')).toBeNull();
	});
});

describe('cards', () => {
	it('reads a real 2N3904 across its continuation lines', () => {
		const [card] = parseModelCards(Q2N3904);
		expect(card.name).toBe('2N3904');
		expect(card.type).toBe('NPN');
		expect(card.params.get('IS')).toBeCloseTo(6.734e-15, 25);
		expect(card.params.get('BF')).toBeCloseTo(416.4, 6);
		expect(card.params.get('VAF')).toBeCloseTo(74.03, 6);
		// From the third and fourth continuation lines, so the join worked.
		expect(card.params.get('CJE')).toBeCloseTo(4.493e-12, 20);
		expect(card.params.get('TF')).toBeCloseTo(301.2e-12, 20);
		expect(card.params.get('RB')).toBe(10);
	});

	it('reads a real 1N4148 past its comment banner', () => {
		const [card] = parseModelCards(D1N4148);
		expect(card.name).toBe('1N4148');
		expect(card.type).toBe('D');
		expect(card.params.get('IS')).toBeCloseTo(2.52e-9, 20);
		expect(card.params.get('CJO')).toBeCloseTo(4e-12, 20);
		expect(card.params.get('BV')).toBe(100);
	});

	it('skips comments rather than reading what is in them', () => {
		const cards = parseModelCards(`
* .MODEL FAKE NPN(BF=1)
.MODEL REAL NPN(BF=250) ; BF=1 in a trailing note
`);
		expect(cards.length).toBe(1);
		expect(cards[0].name).toBe('REAL');
		expect(cards[0].params.get('BF')).toBe(250);
	});

	it('takes the spellings that are actually in the wild', () => {
		const cards = parseModelCards(`
.model lower d(is=1n n=1)
.MODEL SPACED NPN ( BF = 100 , IS = 1f )
.MODEL BARE PNP BF=50
`);
		expect(cards.map((c) => c.type)).toEqual(['D', 'NPN', 'PNP']);
		expect(cards[0].params.get('IS')).toBeCloseTo(1e-9, 20);
		expect(cards[1].params.get('BF')).toBe(100);
		expect(cards[2].params.get('BF')).toBe(50);
	});

	it('finds every card in a whole library', () => {
		const cards = parseModelCards(Q2N3904 + D1N4148);
		expect(cards.map((c) => c.name)).toEqual(['2N3904', '1N4148']);
	});

	it('is not upset by a file with no card in it', () => {
		expect(parseModelCards('just some words\n.subckt X 1 2\n.ends')).toEqual([]);
	});
});

describe('what a card becomes', () => {
	it('maps a 2N3904 onto the model, and says what it could not', () => {
		const [card] = parseModelCards(Q2N3904);
		const { model, ignored } = bjtFromCard(card);

		expect(model.is).toBeCloseTo(6.734e-15, 25);
		expect(model.bf).toBeCloseTo(416.4, 6);
		expect(model.vaf).toBeCloseTo(74.03, 6);
		expect(model.br).toBeCloseTo(0.7371, 8);
		expect(model.cjc).toBeCloseTo(3.638e-12, 20);
		expect(model.tf).toBeCloseTo(301.2e-12, 20);
		expect(model.vje).toBe(0.75);

		// The rest is not silently dropped. High-level injection and the base
		// resistance change what this transistor does, and a report that said
		// nothing would let someone believe they had the whole part.
		expect(ignored).toContain('IKF');
		expect(ignored).toContain('RB');
		expect(ignored).toContain('ISE');
		// Parameters we match anyway are not worth listing.
		expect(ignored).not.toContain('FC');
		expect(ignored).not.toContain('XTI');
		expect(ignored).not.toContain('CJC');
	});

	it('maps a 1N4148, breakdown and all', () => {
		const [card] = parseModelCards(D1N4148);
		const { model, ignored } = diodeFromCard(card);
		expect(model.is).toBeCloseTo(2.52e-9, 20);
		expect(model.n).toBeCloseTo(1.752, 6);
		expect(model.cj0).toBeCloseTo(4e-12, 20);
		expect(model.tt).toBeCloseTo(20e-9, 20);
		expect(model.bv).toBe(100);
		// Series resistance is not modelled yet and that is worth knowing; the
		// test current for the breakdown is, so it is not reported as lost.
		expect(ignored).toContain('RS');
		expect(ignored).not.toContain('IBV');
	});

	it('scales a MOSFET overlap capacitance by the width it is quoted against', () => {
		// CGSO is farads per metre of gate. It means nothing on its own.
		const [card] = parseModelCards('.model M1 NMOS(VTO=1.5 KP=20u W=2m L=2u CGSO=300p CGDO=100p)');
		const { model } = mosfetFromCard(card);
		expect(model.vto).toBe(1.5);
		expect(model.cgs).toBeCloseTo(300e-12 * 2e-3, 20);
		expect(model.cgd).toBeCloseTo(100e-12 * 2e-3, 20);
	});

	it('leaves an overlap capacitance alone when there is no width to scale it by', () => {
		const [card] = parseModelCards('.model M1 NMOS(VTO=1.5 CGSO=300p)');
		const { model, ignored } = mosfetFromCard(card);
		expect(model.cgs).toBeUndefined();
		expect(ignored).toContain('CGSO');
	});
});

describe('choosing a card', () => {
	it('names the part each type belongs to', () => {
		const kinds = parseModelCards(`
.model A D(IS=1n)
.model B NPN(BF=1)
.model C PMOS(VTO=-2)
.model D SW(RON=1)
`).map(kindForCard);
		expect(kinds).toEqual(['diode', 'npn', 'pmos', null]);
	});

	it('picks the card that suits the part out of a whole library', () => {
		const library = Q2N3904 + D1N4148;
		expect(cardFor(library, 'npn')?.name).toBe('2N3904');
		expect(cardFor(library, 'diode')?.name).toBe('1N4148');
		// An LED and a zener are diodes as far as a card is concerned.
		expect(cardFor(library, 'led')?.name).toBe('1N4148');
		expect(cardFor(library, 'pmos')).toBeNull();
	});

	it('has nothing to say about empty text', () => {
		expect(cardFor('', 'npn')).toBeNull();
		expect(cardFor('   \n  ', 'npn')).toBeNull();
	});
});
