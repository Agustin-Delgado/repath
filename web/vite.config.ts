import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// repath is a fully static app: the simulation runs in the browser, so
			// there is no server to deploy and it can be hosted anywhere for free.
			adapter: adapter({ fallback: 'index.html' })
		})
	]
});
