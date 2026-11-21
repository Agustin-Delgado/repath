/**
 * Where on the drawing a failed solve went wrong.
 *
 * The engine names what it blames in the netlist's words: `n3` for a net the
 * compiler numbered, `D1` for a part, and for the pieces a part is built from
 * the part's name with a suffix — `DS1:b`, `K1__coil`, `X1.Q2` inside an
 * imported subcircuit, `B1.R1` inside a block. None of those is something the
 * person drawing chose except the part's own name, so each is matched back to
 * the net or the part on the canvas it belongs to.
 */

import type { SolveFailure } from '$lib/engine';
import type { CompileResult } from './netlist';
import type { Instance, Schematic } from './model';
import { netLabel } from './nets';

export interface LocatedFailure {
	kind: SolveFailure['kind'];
	time: number | null;
	/** Net indices to mark, most to blame first. */
	nets: number[];
	/** Ids of drawn parts to mark, most to blame first. */
	parts: string[];
	/** What to call each of `nets`, in the same order. */
	netLabels: string[];
	/** What to call each of `parts`, in the same order. */
	partNames: string[];
	/** One sentence saying what went wrong and where, in the drawing's names. */
	message: string;
}

/** Characters that join a part's name to the name of a piece of it. */
const JOINS = new Set([':', '.', '_']);

/**
 * The drawn part an engine name belongs to: the part with that exact name or
 * id, or the one whose name or id is the longest that the engine name begins
 * with, followed by a join. `X1.Q2` is X1's, `B1.X2.R1` is B1's when only B1 is
 * on the page, and `n3` is nobody's.
 */
export function partOf(name: string, instances: readonly Instance[]): Instance | null {
	let best: Instance | null = null;
	let length = 0;
	for (const instance of instances) {
		for (const key of [instance.name, instance.id]) {
			if (!key || key.length <= length) continue;
			if (name === key) return instance;
			if (name.startsWith(key) && JOINS.has(name[key.length])) {
				best = instance;
				length = key.length;
			}
		}
	}
	return best;
}

/**
 * Match a failure's engine names to the nets and parts of the drawing.
 *
 * A node that is not one of the drawing's nets is a node inside a part — the
 * middle of a relay's coil, the base of a transistor in an imported model — and
 * the part is marked instead. A part blamed with no net of its own named gets
 * the nets on its pins: a source shorted by a wire has no node of its own in
 * the matrix, and the wire across it is exactly what wants pointing at.
 */
export function locateFailure(
	failure: SolveFailure,
	compiled: Pick<CompileResult, 'names' | 'connectivity'>,
	schematic: Schematic
): LocatedFailure {
	const netOfNode = new Map<string, number>();
	for (const [index, names] of compiled.names) {
		if (names.analog && names.analog !== 'gnd') netOfNode.set(names.analog, index);
	}

	const nets: number[] = [];
	const parts: Instance[] = [];
	const addNet = (index: number) => {
		if (!nets.includes(index)) nets.push(index);
	};
	const addPart = (instance: Instance) => {
		if (!parts.includes(instance)) parts.push(instance);
	};

	for (const element of failure.elements) {
		const instance = partOf(element, schematic.instances);
		if (instance) addPart(instance);
	}
	for (const node of failure.nodes) {
		const index = netOfNode.get(node);
		if (index !== undefined) addNet(index);
		else {
			const instance = partOf(node, schematic.instances);
			if (instance) addPart(instance);
		}
	}
	if (nets.length === 0) {
		for (const instance of parts) {
			const prefix = `${instance.id}:`;
			for (const [key, index] of compiled.connectivity.netOfPin) {
				if (key.startsWith(prefix) && !compiled.connectivity.nets[index]?.isGround) addNet(index);
			}
		}
	}

	const netLabels = nets.map((index) => {
		const net = compiled.connectivity.nets[index];
		const fallback = compiled.names.get(index)?.analog ?? `net ${index}`;
		return net ? netLabel(net, fallback) : fallback;
	});
	const partNames = parts.map((p) => p.name);
	return {
		kind: failure.kind,
		time: failure.time,
		nets,
		parts: parts.map((p) => p.id),
		netLabels,
		partNames,
		message: describe(failure, partNames, netLabels)
	};
}

function list(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? '';
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describe(failure: SolveFailure, parts: readonly string[], nets: readonly string[]): string {
	const where = [
		parts.length > 0 ? list(parts) : null,
		nets.length > 0 ? `${nets.length === 1 ? 'the net' : 'the nets'} ${list(nets)}` : null
	]
		.filter(Boolean)
		.join(', on ');
	const at = where ? ` at ${where}` : '';
	switch (failure.kind) {
		case 'singular':
			return (
				`No single solution${at}. ` +
				'Usual causes: two voltage sources in parallel, a source shorted by a wire or an inductor, ' +
				'or a part with one side not connected.'
			);
		case 'no_convergence':
			return `The solver did not converge${at}. Look for a part value far out of range, or feedback with no resistance.`;
		case 'timestep':
			return `The time step became too small${at}: the solver did not converge.`;
		case 'non_finite':
			return `The voltages went to infinity${at}. Look for a part value of zero or far out of range.`;
		default:
			return `Could not solve the circuit${at}.`;
	}
}
