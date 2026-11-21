/**
 * The side panels on a narrow screen, where they are drawers.
 *
 * Below this width the palette and the inspector slide in over the drawing
 * one at a time, and the closed one waits just off the screen. Off the
 * screen is not out of reach: it was still in the Tab order, so the
 * keyboard walked through a hundred-odd parts nobody could see, and a
 * screen reader read them out as though they were there.
 */

/**
 * The width the drawers start at, and the page's own media queries with it.
 *
 * Below 900 px, not up to it: Tailwind's `max-[900px]:`, which folds the
 * toolbar into its More menu, means `width < 900px`, and the hand-written
 * queries used to say `max-width: 900px`. At exactly 900 px the page had the
 * phone bar and drawers of a narrow screen under the toolbar of a wide one,
 * with the More menu nowhere.
 */
export const DRAWER_QUERY = '(width < 900px)';

export type Drawer = 'parts' | 'details';

/** Whether `side` is a drawer that is closed, and so to be made inert. */
export function drawerClosed(narrow: boolean, open: Drawer | null, side: Drawer): boolean {
	return narrow && open !== side;
}
