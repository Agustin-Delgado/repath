/**
 * Keyboard decisions that do not need a component to make, kept apart so
 * they can be checked without one.
 */

/** The parts of a key event a decision here reads. */
export interface KeyPress {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
}

/** Whether `target` takes typing, so a shortcut letter is text there. */
export function typingTarget(target: { closest?: (selector: string) => unknown } | null): boolean {
	return !!target?.closest?.('input, textarea, select, [contenteditable]');
}

/**
 * Whether a key press is `/` asking to find a part.
 *
 * From anywhere but a field being typed in, and from either of the
 * sidebar's tabs: it used to be heard by the parts list itself, which is
 * not there while the examples are showing, so on that tab the shortcut
 * the inspector and the README promise did nothing.
 */
export function findsPart(event: KeyPress, target: { closest?: (selector: string) => unknown } | null): boolean {
	if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return false;
	return !typingTarget(target);
}
