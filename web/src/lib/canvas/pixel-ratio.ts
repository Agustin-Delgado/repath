/**
 * Be told when the screen's pixel density changes.
 *
 * A canvas sized for one density and shown at another is blurry, and the
 * density changes without the canvas changing size at all: the window is
 * dragged to a monitor with a different scale, or the page is zoomed. A
 * `resolution` media query matches only the density it was written for, so it
 * fires once on the way out, and is then written again for the new one.
 *
 * Returns the function that stops watching.
 */
export function watchPixelRatio(
	win: Pick<Window, 'devicePixelRatio' | 'matchMedia'>,
	onChange: (ratio: number) => void
): () => void {
	let query: MediaQueryList | null = null;
	const listen = () => {
		query = win.matchMedia?.(`(resolution: ${win.devicePixelRatio || 1}dppx)`) ?? null;
		query?.addEventListener('change', changed);
	};
	const changed = () => {
		query?.removeEventListener('change', changed);
		onChange(win.devicePixelRatio || 1);
		listen();
	};
	listen();
	return () => query?.removeEventListener('change', changed);
}
