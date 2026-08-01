import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Deliberately without the SvelteKit plugin: everything under test here is
// plain TypeScript, and keeping the test runner independent of the framework is
// half the point of having the canvas engine be its own library.
export default defineConfig({
	resolve: {
		alias: {
			$lib: fileURLToPath(new URL('./src/lib', import.meta.url))
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
