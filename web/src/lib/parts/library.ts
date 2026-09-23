import { CATALOG, chipDefinition, type Group } from '$lib/schematic/model';
import { CHIP_ROLES, CHIPS } from '$lib/schematic/chips';
import { search } from '$lib/search';
import { PART_INFO } from './info';

/**
 * Everything that can be placed, the way the palette and the command palette
 * see it: a name, where it is filed, and how it is found.
 *
 * One list for both, so a part cannot be findable by search and missing from
 * the shelf, or the other way round. The drawing adds its own blocks and
 * imported parts at runtime with the same shape.
 */
export interface PartEntry {
	kind: string;
	label: string;
	section: SectionId;
	description: string;
	keywords: readonly string[];
	/** Something the model leaves out, shown where the part is chosen. */
	caveat?: string;
	/** A heading inside its section, for a section too long to read as one grid. */
	shelf?: string;
}

export type SectionId = Group | 'blocks' | 'imported';

export const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
	{ id: 'passive', label: 'Passive' },
	{ id: 'sources', label: 'Sources' },
	{ id: 'semiconductor', label: 'Semiconductors' },
	{ id: 'analog', label: 'Analog' },
	{ id: 'logic', label: 'Logic' },
	{ id: 'ic', label: 'Chips' },
	{ id: 'blocks', label: 'Blocks' },
	{ id: 'imported', label: 'Imported' }
];

export const sectionLabel = (id: SectionId): string =>
	SECTIONS.find((section) => section.id === id)?.label ?? id;

/**
 * Parts the palette does not offer on its shelves.
 *
 * A port only means something inside a block, where the palette offers it
 * next to the wire; out on the drawing it would be a label and nothing more.
 */
const OFF_SHELF = new Set(['port']);

export const BUILT_IN: readonly PartEntry[] = [
	...CATALOG.filter((def) => !OFF_SHELF.has(def.kind)).map((def) => ({
		kind: def.kind,
		label: def.label,
		section: def.group,
		description: PART_INFO[def.kind]?.description ?? '',
		keywords: PART_INFO[def.kind]?.keywords ?? []
	})),
	// Filed by job, in the order the roles are listed, and by number within one.
	...CHIP_ROLES.flatMap((role) => CHIPS.filter((chip) => chip.role === role.id)).map((chip) => {
		const def = chipDefinition(chip);
		const role = CHIP_ROLES.find((r) => r.id === chip.role)!;
		return {
			kind: def.kind,
			label: def.label,
			section: 'ic' as const,
			description: chip.description,
			// The bare number is how these are spoken of, and the family is how they
			// are bought: "7400" and "74HC00" should both land on the SN7400.
			keywords: [
				chip.id,
				chip.id.replace(/^74/, '74hc'),
				chip.id.replace(/^74/, '74ls'),
				role.label,
				'ic',
				'chip',
				'dip'
			],
			caveat: chip.caveat,
			shelf: role.label
		};
	})
];

/** The parts that fit a query, best first. See `$lib/search` for how they are ranked. */
export function searchParts(entries: readonly PartEntry[], query: string): PartEntry[] {
	return search(entries, query, (entry) => ({
		label: entry.label,
		id: entry.kind.replace(/^[a-z]+:/, ''),
		keywords: entry.keywords,
		group: sectionLabel(entry.section),
		description: entry.description
	}));
}
