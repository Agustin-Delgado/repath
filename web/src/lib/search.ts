/**
 * Ranking things by how well they fit what somebody typed.
 *
 * Shared by the part finder and the command palette, so "cap" means the
 * same in both. Every word of the query has to land somewhere — "npn
 * transistor" is not every transistor — and each thing is ranked by how well
 * its words landed: typing the start of a name beats matching a word buried
 * in a description. Ties keep the order the things were given in, which is
 * the order people learnt them in.
 */

export interface SearchFields {
	/** The name, which is what matches best. */
	label: string;
	/** Another exact name: a part's kind, a chip's number. */
	id?: string;
	keywords?: readonly string[];
	/** Where it is filed: matching this narrows to a whole shelf. */
	group?: string;
	description?: string;
}

/** Lower case, no accents: "Réglage" is found by "reglage". */
export function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

/** Without spacing or dashes too: "Op-amp" and "opamp" are one word. */
const squash = (text: string) => fold(text).replace(/[\s\-_.]/g, '');

interface Indexed {
	label: string;
	labelWords: string[];
	squashedLabel: string;
	id: string;
	keywords: string[];
	group: string;
	description: string;
}

function build(fields: SearchFields): Indexed {
	const label = fold(fields.label);
	return {
		label,
		labelWords: label.split(/[\s\-·:]+/).filter(Boolean),
		squashedLabel: squash(fields.label),
		id: fold(fields.id ?? ''),
		keywords: (fields.keywords ?? []).map(fold),
		group: fold(fields.group ?? ''),
		description: fold(fields.description ?? '')
	};
}

/** How well one word of the query fits one thing, or 0 when it does not. */
function scoreToken(item: Indexed, token: string): number {
	const squashed = token.replace(/[\s\-_.]/g, '');
	if (item.label === token || item.squashedLabel === squashed) return 100;
	if (item.id && item.id === token) return 90;
	if (item.label.startsWith(token) || item.squashedLabel.startsWith(squashed)) return 80;
	if (item.labelWords.some((word) => word.startsWith(token))) return 60;
	if (item.keywords.some((keyword) => keyword === token)) return 55;
	if (item.keywords.some((keyword) => keyword.startsWith(token))) return 40;
	if (item.label.includes(token) || (item.id && item.id.includes(token))) return 30;
	if (item.keywords.some((keyword) => keyword.includes(token))) return 20;
	if (item.group.startsWith(token)) return 15;
	if (item.description.includes(token)) return 10;
	return 0;
}

/**
 * The items that fit a query, best first; all of them, in order, for an empty one.
 *
 * `fields` is asked once per item and remembered, since a catalog only grows
 * and the query changes on every keystroke. Items are therefore expected to
 * be objects that are not mutated while being searched.
 */
export function search<T extends object>(
	items: readonly T[],
	query: string,
	fields: (item: T) => SearchFields
): T[] {
	const tokens = fold(query).split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [...items];

	const scored: Array<{ item: T; score: number; order: number }> = [];
	items.forEach((item, order) => {
		let indexed = CACHE.get(item);
		if (!indexed) CACHE.set(item, (indexed = build(fields(item))));
		let score = 0;
		for (const token of tokens) {
			const fit = scoreToken(indexed, token);
			if (fit === 0) return;
			score += fit;
		}
		scored.push({ item, score, order });
	});
	return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.item);
}

const CACHE = new WeakMap<object, Indexed>();
