import { BLOCK_PREFIX, SUBCIRCUIT_PREFIX } from '$lib/schematic/model';
import { blockPorts, contains } from '$lib/schematic/blocks';
import type { App } from '$lib/state.svelte';
import { BUILT_IN, type PartEntry } from './library';

/**
 * The parts this drawing brings with it: blocks boxed up from a piece of it,
 * and subcircuits pasted in as SPICE. Same shape as the built-in ones, so they
 * are searched and placed the same way.
 *
 * Inside a block, the block itself and anything built from it are kept out of
 * reach: placed in there, it would contain itself.
 */
export function drawingParts(app: App): PartEntry[] {
	const blocks = (app.schematic.blocks ?? [])
		.filter((block) => !app.inside || !contains(app.schematic, block.id, app.inside.id))
		.map(
			(block): PartEntry => ({
				kind: BLOCK_PREFIX + block.id,
				label: block.name,
				section: 'blocks',
				description: `Block · ${blockPorts(block)
					.map((port) => port.name)
					.join(' ')}`,
				keywords: ['block']
			})
		);
	const imported = (app.schematic.subcircuits ?? []).map(
		(sub): PartEntry => ({
			kind: SUBCIRCUIT_PREFIX + sub.id,
			label: sub.name,
			section: 'imported',
			description: `SPICE subcircuit · ${sub.ports.join(' ')}`,
			keywords: ['subckt', 'spice', 'imported']
		})
	);
	return [...blocks, ...imported];
}

/** Every part that can be placed right now. */
export function allParts(app: App): PartEntry[] {
	return [...BUILT_IN, ...drawingParts(app)];
}

/**
 * Put a part in the hand, or put it back if it already is.
 *
 * Picking the part that is already armed is how people put it down, so it
 * toggles rather than re-arming.
 */
export function pickPart(app: App, kind: string): void {
	app.tool =
		app.tool.mode === 'place' && app.tool.kind === kind ? { mode: 'select' } : { mode: 'place', kind };
}

export const isArmed = (app: App, kind: string): boolean =>
	app.tool.mode === 'place' && app.tool.kind === kind;
