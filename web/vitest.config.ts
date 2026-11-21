import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The Svelte plugin is here for one reason: `state.svelte.ts` uses runes, and the
// editor's move, rotate and clipboard logic lives in it. That logic is where the
// connection-preserving rules are, so it has to be testable without a browser.
export default defineConfig({
	plugins: [svelte()],
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		},
		// Vitest must load the browser build of Svelte, not the SSR one, or the
		// runes in a plain `.svelte.ts` module never become reactive.
		conditions: ['browser']
	},
	test: {
		// The suite lives in its own repository, mounted at `tests/` in the root
		// of this one; see CONTRIBUTING.md. Without the mount there is nothing to
		// run, and vitest says so rather than passing an empty suite.
		include: ['../tests/web/**/*.test.ts'],
		// Nothing under test touches the DOM; jsdom costs seconds per run for nothing.
		environment: 'node',
		// A timeout here catches a hang, not a slow test. The microcontroller tests
		// emulate seconds of a sketch — millions of instructions — and take four to
		// six seconds each on an idle machine, so vitest's 5 s default failed them
		// whenever the machine was busy with anything else, while the answer they
		// check was right. A few already carried their own 30 s; this makes it the
		// rule, so whether the suite passes no longer depends on the load.
		testTimeout: 30_000
	}
});
