import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ViteDevServer } from 'vite';
import { handleArduinoCompileRequest } from './src/lib/arduino/compile-server.ts';

function serveArduinoCompiler({ middlewares }: Pick<ViteDevServer, 'middlewares'>) {
	middlewares.use((req, res, next) => {
		if (req.url?.split('?')[0] !== '/api/arduino/compile') return next();
		void handleArduinoCompileRequest(req, res).catch(next);
	});
}

export default defineConfig({
	plugins: [
		{
			name: 'repath-arduino-compiler',
			configureServer: serveArduinoCompiler,
			configurePreviewServer: serveArduinoCompiler
		},
		tailwindcss(),
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
