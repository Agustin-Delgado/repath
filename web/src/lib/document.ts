import type { App } from '$lib/state.svelte';
import { toasts } from '$lib/ui/toast/toasts.svelte';

/**
 * What can be done to the drawing as a whole — save it, open one, hand over
 * the steps that made it — written once, so the toolbar and the command
 * palette do the same thing and report it the same way.
 */

export function saveToFile(app: App): void {
	const blob = new Blob([app.toJSON()], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = 'circuit.repath.json';
	link.click();
	// After the click has been dispatched, not during it. Revoking inside the
	// same turn is a race the common browsers happen to win and Safari does
	// not, and losing it means the Save button doing nothing at all.
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Ask for a saved circuit and open it.
 *
 * The file input is made on the spot rather than kept in the page, so
 * anything can offer Open without owning a hidden element for it.
 */
export function openFromFile(app: App): void {
	const input = document.createElement('input');
	input.type = 'file';
	input.accept = 'application/json,.json';
	input.onchange = async () => {
		const file = input.files?.[0];
		if (!file) return;
		try {
			app.fromJSON(await file.text());
			app.run();
		} catch (cause) {
			app.notice = cause instanceof Error ? cause.message : String(cause);
		}
	};
	input.click();
}

/**
 * Hand over what has been done here, as text.
 *
 * A share link carries the circuit; this carries the *route* to it, which for
 * anything involving a drag is the part that is hard to describe and easy to
 * get wrong when it is described. Paste it into a bug report and the exact
 * sequence can be replayed rather than guessed at.
 *
 * Resolves to how many steps were copied, or null when there was nothing to
 * copy or the clipboard refused — in which case the notice says why, or
 * holds the text to be copied by hand.
 */
export async function copySteps(app: App): Promise<number | null> {
	const text = app.trace.toText();
	if (!text) {
		app.notice = 'Nothing has been done yet, so there is nothing to hand over.';
		return null;
	}
	try {
		await navigator.clipboard.writeText(text);
		return app.trace.steps.length;
	} catch {
		app.notice = text;
		return null;
	}
}

/**
 * Share, and say how it went.
 *
 * The share itself belongs to the page, which has to tell the autosaved
 * draft that it now continues the link; this is the part everyone who offers
 * Share has in common.
 */
export async function shareAndReport(share: () => Promise<void>): Promise<void> {
	try {
		await share();
		toasts.show('Link copied — it holds the whole circuit');
	} catch {
		// Clipboard access can be refused; the URL bar still holds the link.
		toasts.show('The link is in the address bar');
	}
}

export async function copyStepsAndReport(app: App): Promise<void> {
	const count = await copySteps(app);
	if (count !== null) toasts.show(`Copied ${count} step${count === 1 ? '' : 's'}`);
}
