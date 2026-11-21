/**
 * A row that scrolls sideways, and says so.
 *
 * On a narrow screen the header and the transport bar scroll rather than
 * wrap, with the scrollbar hidden because it covers the buttons. Hidden, it
 * also hid the fact that there was anything more: at 390 px half the header —
 * File and Share among it — was off the right edge with nothing to say it was
 * there. This marks the row with which ends have more past them, and the
 * stylesheet fades those ends out (`.scroll-row` in `app.css`).
 */

/** Which ends of a scrolled row have content beyond them. */
export function scrollEdges(scroll: {
	scrollLeft: number;
	scrollWidth: number;
	clientWidth: number;
}): { before: boolean; after: boolean } {
	// A pixel of slack: fractional widths leave a sub-pixel "overflow" that is
	// nothing a person could scroll to.
	const slack = 1;
	return {
		before: scroll.scrollLeft > slack,
		after: scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - slack
	};
}

/** Svelte action: keep `data-more-before` / `data-more-after` true to the row. */
export function overflowHint(node: HTMLElement): { destroy(): void } {
	const update = () => {
		const { before, after } = scrollEdges(node);
		node.toggleAttribute('data-more-before', before);
		node.toggleAttribute('data-more-after', after);
	};
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
	observer?.observe(node);
	for (const child of node.children) observer?.observe(child);
	node.addEventListener('scroll', update, { passive: true });
	update();
	return {
		destroy() {
			observer?.disconnect();
			node.removeEventListener('scroll', update);
		}
	};
}
