/**
 * The parts this browser placed last, newest first.
 *
 * A drawing is mostly the same handful of parts over and over — resistors,
 * a source, ground — and with a catalog of hundreds, walking back to them
 * through the shelves every time is the cost that grows. So the palette keeps
 * them at the top.
 *
 * Recorded on placement, not on picking a part: a part picked and put back
 * was not a part used. Remembered per browser, like the symbol standard, and
 * not saved with the drawing: it is the reader's habit, not the circuit's.
 */

const KEY = 'repath.recentParts';
const LIMIT = 8;

function load(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string').slice(0, LIMIT) : [];
	} catch {
		return [];
	}
}

class RecentParts {
	kinds = $state<string[]>(typeof localStorage === 'undefined' ? [] : load());

	remember(kind: string): void {
		if (this.kinds[0] === kind) return;
		this.kinds = [kind, ...this.kinds.filter((k) => k !== kind)].slice(0, LIMIT);
		try {
			localStorage.setItem(KEY, JSON.stringify(this.kinds));
		} catch {
			// Without storage the list still lasts as long as the tab.
		}
	}
}

export const recentParts = new RecentParts();
