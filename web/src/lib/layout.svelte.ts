/**
 * How the screen is shared out: the widths of the two side panels, the height
 * of the scope, and whether the scope is out at all.
 *
 * The reader's arrangement rather than a property of the circuit, so it is kept
 * per browser and never saved with a drawing or put in a link.
 */

const KEY = 'repath.layout';

export const PANEL_LIMITS = {
	left: { min: 180, max: 520, initial: 240 },
	right: { min: 220, max: 560, initial: 260 },
	scope: { min: 140, max: 900, initial: 300 }
} as const;

export type Panel = keyof typeof PANEL_LIMITS;

export function clampPanel(panel: Panel, size: number): number {
	const { min, max } = PANEL_LIMITS[panel];
	return Math.round(Math.min(max, Math.max(min, size)));
}

interface Saved {
	left?: number;
	right?: number;
	scope?: number;
	scopeOpen?: boolean;
}

function load(): Saved {
	// All of it inside the try, the check for storage included: with site data
	// blocked, merely naming `localStorage` throws, and that used to stop the
	// whole app loading.
	try {
		if (typeof localStorage === 'undefined') return {};
		const raw = localStorage.getItem(KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		// Anything but an object — `null`, a number, a list — is not a layout.
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Saved;
	} catch {
		// A private window, or storage turned off: the defaults will do.
	}
	return {};
}

class Layout {
	left = $state<number>(PANEL_LIMITS.left.initial);
	right = $state<number>(PANEL_LIMITS.right.initial);
	scope = $state<number>(PANEL_LIMITS.scope.initial);
	scopeOpen = $state(true);

	constructor() {
		const saved = load();
		for (const panel of ['left', 'right', 'scope'] as const) {
			const size = saved[panel];
			if (typeof size === 'number' && Number.isFinite(size)) this[panel] = clampPanel(panel, size);
		}
		if (typeof saved.scopeOpen === 'boolean') this.scopeOpen = saved.scopeOpen;
	}

	resize(panel: Panel, size: number): void {
		this[panel] = clampPanel(panel, size);
	}

	toggleScope(): void {
		this.scopeOpen = !this.scopeOpen;
		this.save();
	}

	/** Written when a drag ends rather than on every step of it. */
	save(): void {
		try {
			localStorage.setItem(
				KEY,
				JSON.stringify({
					left: this.left,
					right: this.right,
					scope: this.scope,
					scopeOpen: this.scopeOpen
				} satisfies Saved)
			);
		} catch {
			// The arrangement still holds for this tab.
		}
	}
}

export const layout = new Layout();
