import { defineConfig } from 'vite';

/**
 * `vite preview` over the deployed site, for the browser checks.
 *
 * Not the app's own config: under the SvelteKit plugin, preview serves
 * `.svelte-kit/output`, which is an intermediate the deploy never sees. This
 * serves `build/` — what adapter-static writes and what goes to Vercel — with
 * the same fallback to `index.html` the deploy routes everything else to. So
 * CI can check the very artifact it is about to publish, without building it
 * a second time.
 */
export default defineConfig({
	appType: 'spa',
	build: { outDir: 'build' },
	preview: { host: 'localhost' }
});
