/**
 * Logic families: what a digital one and a digital zero are, in volts.
 *
 * The digital side of the simulator works in Low/High/Unknown and has no
 * opinion about voltage at all. It only becomes a number where the two domains
 * meet — a gate driving an analog node, or an analog node read by a gate — and
 * that number is a property of the family the part belongs to, not of the gate.
 * A 74HC and a 74LS with the same truth table put out different voltages and
 * decide on different thresholds, and a circuit that works with one can fail
 * with the other. Picking the family is therefore a real choice, and one number
 * per drawing rather than per part, because a board is normally built out of
 * one family.
 *
 * The fields match the engine's `LogicFamily` exactly, and go over the wire as
 * `logic_family`.
 */

export interface LogicFamily {
	/** Volts a driven Low produces. */
	v_low: number;
	/** Volts a driven High produces. */
	v_high: number;
	/** At or below this, an input reads Low. */
	v_il: number;
	/** At or above this, an input reads High. The gap to `v_il` is hysteresis. */
	v_ih: number;
	/** Output impedance of a driven output. Nothing drives a load for free. */
	r_out: number;
	rise: number;
	fall: number;
}

export interface FamilyOption {
	value: string;
	label: string;
	family: LogicFamily;
}

export const LOGIC_FAMILIES: FamilyOption[] = [
	{
		value: 'cmos5',
		label: 'CMOS 5 V',
		// 74HC. A CMOS output pulls all the way to each rail, and decides at a
		// third and two thirds of the supply — which is the wide noise margin that
		// makes the family forgiving.
		family: { v_low: 0, v_high: 5, v_il: 1.5, v_ih: 3.5, r_out: 50, rise: 2e-9, fall: 2e-9 }
	},
	{
		value: 'cmos3v3',
		label: 'CMOS 3.3 V',
		// The same silicon on a lower rail: faster, and with proportionally less
		// room between a one and a zero.
		family: { v_low: 0, v_high: 3.3, v_il: 0.99, v_ih: 2.31, r_out: 50, rise: 1e-9, fall: 1e-9 }
	},
	{
		value: 'ttl',
		label: 'TTL 5 V',
		// 74LS. Neither output level reaches its rail — a high is a diode drop or
		// two below 5 V — and the thresholds sit low and close together, which is
		// why TTL is the family that gets upset by noise on the ground.
		//
		// One output impedance is a simplification worth naming: a real LS output
		// sinks hard and sources weakly, so a high sags under load in a way a low
		// does not. This is a single number, closer to the sourcing case, because
		// that is the one that catches people out.
		family: { v_low: 0.25, v_high: 3.4, v_il: 0.8, v_ih: 2.0, r_out: 100, rise: 5e-9, fall: 4e-9 }
	}
];

const BY_VALUE = new Map(LOGIC_FAMILIES.map((f) => [f.value, f]));

export const DEFAULT_FAMILY = LOGIC_FAMILIES[0].value;

/** The numbers for a family name, falling back to 5 V CMOS. */
export function logicFamily(value: string): LogicFamily {
	return (BY_VALUE.get(value) ?? LOGIC_FAMILIES[0]).family;
}

/** Whether a name is one this build knows, for replaying a trace. */
export function isLogicFamily(value: string): boolean {
	return BY_VALUE.has(value);
}
