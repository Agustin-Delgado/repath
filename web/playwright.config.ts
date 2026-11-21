import { defineConfig, devices } from '@playwright/test';

/**
 * The browser checks: the built site, served the way it is deployed, driven by
 * a real Chromium.
 *
 * The specs live with the rest of the suite in the private `tests/` mount, at
 * `tests/e2e`. They are run against `build/`, not against the dev server: the
 * dev server compiles on demand and does not tree-shake, and the bugs these
 * checks exist for were in the shipped bundle.
 */

/** Fixed rather than picked: a port that moves cannot be reused by a second run. */
const PORT = 5202;
const CI = !!process.env.CI;

export default defineConfig({
	testDir: '../tests/e2e',
	// Each spec gets a browser context of its own, so nothing — a draft in
	// IndexedDB, a folded shelf in localStorage — leaks from one to the next.
	fullyParallel: true,
	forbidOnly: CI,
	// None, deliberately. A check that passes on its second try is a check that
	// fails some of the time, and a retry would hide exactly that.
	retries: 0,
	// The engine solves on the main thread; four pages at once on a two-core
	// runner is a test of the runner.
	workers: CI ? 2 : 3,
	// Quiet in CI for the same reason as the unit suite: the log of a public
	// repository is public, and a verbose reporter names every check in a
	// private suite. A failure is still reported in full.
	reporter: CI ? 'dot' : 'list',
	timeout: 60_000,
	expect: { timeout: 15_000 },
	outputDir: 'test-results',
	use: {
		baseURL: `http://localhost:${PORT}`,
		viewport: { width: 1440, height: 900 },
		// Kept only when something failed, and without the spec sources in it:
		// the trace is uploaded from a public repository, the specs are private.
		trace: { mode: 'retain-on-failure', sources: false },
		screenshot: 'only-on-failure'
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
	webServer: {
		// `vite preview` over `build/`, which is what `vite build` leaves and what
		// is deployed. Bound to localhost only, which is vite's default.
		command: `npx vite preview --config e2e.vite.config.ts --port ${PORT} --strictPort`,
		url: `http://localhost:${PORT}`,
		reuseExistingServer: !CI,
		timeout: 60_000
	}
});
