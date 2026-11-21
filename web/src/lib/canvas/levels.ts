/**
 * Where to look on each level of blocks the editor is down.
 *
 * Going into a block, the view goes to the block; coming back out, the level
 * is looked at from where it was left. A level can also be arrived on without
 * ever having been looked at — a draft restored several blocks deep goes down
 * all of them at once — and such a level has no view to come back to: it is
 * fitted instead, rather than shown from wherever the deepest one was.
 */

/** What the canvas should do after the editor's depth changed. */
export interface LevelView<T> {
	/** A view to put back, or null for none. */
	restore: T | null;
	/** Whether to fit the drawing instead. */
	fit: boolean;
}

/**
 * Bring `views` — one per level above the drawing being looked at, null for
 * one never looked at — to `depth`, and say what the canvas should do.
 * `current` is the view now, kept for the level being left on the way down.
 */
export function followDepth<T>(views: (T | null)[], depth: number, current: () => T): LevelView<T> {
	if (depth > views.length) {
		views.push(current());
		while (views.length < depth) views.push(null);
		return { restore: null, fit: true };
	}
	if (depth === views.length) return { restore: null, fit: false };
	let back: T | null = null;
	while (views.length > depth) back = views.pop() ?? null;
	return back === null ? { restore: null, fit: true } : { restore: back, fit: false };
}
