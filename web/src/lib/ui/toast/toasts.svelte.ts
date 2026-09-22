/**
 * A word of confirmation that goes away by itself: "Link copied", "Saved".
 *
 * For things that worked. Something that went wrong, or that the user has to
 * act on, is a notice under the toolbar, which stays until it is dismissed.
 */
export interface Toast {
	id: number;
	text: string;
}

class Toasts {
	list = $state<Toast[]>([]);
	#next = 0;

	show(text: string, ms = 2400): void {
		const id = ++this.#next;
		// One at a time is enough to read; a second replaces the first.
		this.list = [{ id, text }];
		setTimeout(() => (this.list = this.list.filter((toast) => toast.id !== id)), ms);
	}
}

export const toasts = new Toasts();
