import { BLOCK_PREFIX, SUBCIRCUIT_PREFIX } from '$lib/schematic/model';
import { blockPorts } from '$lib/schematic/blocks';
import type { App } from '$lib/state.svelte';
import { BUILT_IN, type PartEntry } from './library';

/**
 * The parts this drawing brings with it: blocks boxed up from a piece of it,
 * and subcircuits pasted in as SPICE. Same shape as the built-in ones, so they
 * are searched and placed the same way.
 *
 * Inside a block, every block open around it and anything built from one are
 * kept out of reach: placed in there, a block would contain itself.
 */
export function drawingParts(app: App): PartEntry[] {
	const blocks = (app.schematic.blocks ?? [])
		.filter((block) => !app.wouldContainItself(block.id))
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

/**
 * Take a block or an imported part out of the drawing, from the palette.
 * Returns what to tell the person, or null when it was refused — the editor's
 * notice says why.
 */
export function removeDrawingPart(app: App, part: PartEntry): string | null {
	const removed =
		part.section === 'blocks'
			? app.removeBlock(part.kind.slice(BLOCK_PREFIX.length))
			: part.section === 'imported'
				? app.removeSubcircuit(part.kind.slice(SUBCIRCUIT_PREFIX.length))
				: false;
	return removed ? `Removed ${part.label} — Ctrl+Z brings it back` : null;
}
