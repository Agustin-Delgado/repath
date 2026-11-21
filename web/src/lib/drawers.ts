/**
 * The side panels on a narrow screen, where they are drawers.
 *
 * Below this width the palette and the inspector slide in over the drawing
 * one at a time, and the closed one waits just off the screen. Off the
 * screen is not out of reach: it was still in the Tab order, so the
 * keyboard walked through a hundred-odd parts nobody could see, and a
 * screen reader read them out as though they were there.
 */

/** The width the drawers start at: the `max-width` of the page's own media query. */
export const DRAWER_QUERY = '(max-width: 900px)';

export type Drawer = 'parts' | 'details';

/** Whether `side` is a drawer that is closed, and so to be made inert. */
export function drawerClosed(narrow: boolean, open: Drawer | null, side: Drawer): boolean {
	return narrow && open !== side;
}
