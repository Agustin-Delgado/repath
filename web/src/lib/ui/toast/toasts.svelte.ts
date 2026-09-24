import { createToastManager } from '@human-kit/ui';

/**
 * A word of confirmation that goes away by itself: "Link copied", "Saved".
 *
 * For things that worked. Something that went wrong, or that the user has to
 * act on, is a notice under the toolbar, which stays until it is dismissed.
 *
 * The list and its timers are `@human-kit/ui`'s. The manager is made here
 * rather than by the provider so that code outside any component — saving,
 * sharing — can show one.
 */
export const toastManager = createToastManager({ timeout: () => 2400, limit: () => 1 });

class Toasts {
	show(text: string): void {
		// The same message again — Share pressed twice — stays where it is and
		// gets its full time back, rather than leaving and coming straight back.
		const same = toastManager.toasts.find((t) => t.status === 'open' && t.title === text);
		if (same) {
			toastManager.update(same.id, { title: text });
			return;
		}
		// One at a time is enough to read; a different one replaces it.
		toastManager.close();
		toastManager.add({ title: text, type: 'success' });
	}
}

export const toasts = new Toasts();
