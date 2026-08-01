<script lang="ts">
	import Inspector from '$lib/components/Inspector.svelte';
	import Palette from '$lib/components/Palette.svelte';
	import Playback from '$lib/components/Playback.svelte';
	import Schematic from '$lib/components/Schematic.svelte';
	import Scope from '$lib/components/Scope.svelte';
	import { ensureEngine, engineVersion } from '$lib/engine';
	import { EXAMPLES } from '$lib/examples';
	import { decodeCircuit, shareUrl } from '$lib/share';
	import { app } from '$lib/state.svelte';
	import { formatValue, parseValue } from '$lib/units';

	let version = $state('');
	let stopField = $state(formatValue(app.stopTime, 3));
	let fileInput = $state<HTMLInputElement | null>(null);
	let shareState = $state<'idle' | 'copied' | 'failed'>('idle');

	$effect(() => {
		// Keep the field in sync when an example changes the run length.
		stopField = formatValue(app.stopTime, 3);
	});

	$effect(() => {
		ensureEngine().then(async () => {
			version = engineVersion();

			// A circuit in the fragment wins over the default example: someone
			// following a link wants the circuit in the link.
			if (location.hash.length > 2) {
				try {
					app.loadShared(await decodeCircuit(location.hash));
				} catch (cause) {
					app.error = cause instanceof Error ? cause.message : String(cause);
				}
			}
			// Show a working circuit rather than an empty scope on first load.
			app.run();
		});
	});

	async function share() {
		try {
			const url = await shareUrl(
				{ schematic: app.schematic, stopTime: app.stopTime },
				new URL(location.href)
			);
			history.replaceState(null, '', url);
			await navigator.clipboard.writeText(url);
			shareState = 'copied';
		} catch {
			// Clipboard access can be refused; the URL bar still holds the link.
			shareState = 'failed';
		}
		setTimeout(() => (shareState = 'idle'), 2500);
	}

	function commitStopTime(value: string) {
		const parsed = parseValue(value);
		if (parsed !== null && parsed > 0) app.stopTime = parsed;
		stopField = formatValue(app.stopTime, 3);
	}

	function save() {
		const blob = new Blob([app.toJSON()], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'circuit.repath.json';
		link.click();
		URL.revokeObjectURL(url);
	}

	async function load(event: Event) {
		const file = (event.target as HTMLInputElement).files?.[0];
		if (!file) return;
		try {
			app.fromJSON(await file.text());
			app.run();
		} catch (cause) {
			app.error = cause instanceof Error ? cause.message : String(cause);
		}
		if (fileInput) fileInput.value = '';
	}
</script>

<svelte:head>
	<title>repath — free circuit simulator</title>
	<meta
		name="description"
		content="A free and open source mixed-signal circuit simulator that runs entirely in your browser."
	/>
</svelte:head>

<div class="app">
	<header>
		<div class="brand">
			<strong>repath</strong>
			<span class="tag">mixed-signal circuit simulator</span>
		</div>

		<div class="controls">
			<button class="run" onclick={() => app.run()} disabled={app.running}>
				{app.running ? 'Running…' : 'Run'}
			</button>

			<label class="stop">
				<span>for</span>
				<input
					bind:value={stopField}
					onblur={(e) => commitStopTime(e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Enter') e.currentTarget.blur();
					}}
					aria-label="Simulation length"
				/>
				<span class="unit">s</span>
			</label>

			<span class="divider"></span>

			<button onclick={() => app.undo()} title="Undo (Ctrl+Z)">Undo</button>
			<button onclick={() => app.redo()} title="Redo (Ctrl+Shift+Z)">Redo</button>

			<span class="divider"></span>

			<select
				value={app.exampleId}
				onchange={(e) => {
					app.loadExample(e.currentTarget.value);
					app.run();
				}}
				aria-label="Load an example"
			>
				{#each EXAMPLES as example (example.id)}
					<option value={example.id}>{example.name}</option>
				{/each}
			</select>

			<button onclick={share} title="Copy a link that contains this circuit">
				{shareState === 'copied' ? 'Copied' : shareState === 'failed' ? 'In the URL bar' : 'Share'}
			</button>
			<button onclick={save} title="Download this circuit">Save</button>
			<button onclick={() => fileInput?.click()} title="Open a saved circuit">Open</button>
			<input
				bind:this={fileInput}
				type="file"
				accept="application/json,.json"
				onchange={load}
				hidden
			/>
		</div>

		<div class="meta">
			{#if version}<span title="Engine version">engine {version}</span>{/if}
		</div>
	</header>

	{#if app.error}
		<div class="banner error" role="alert">
			<strong>Could not simulate.</strong>
			{app.error}
		</div>
	{:else if app.compiled.errors.length > 0}
		<div class="banner warn" role="status">{app.compiled.errors[0]}</div>
	{/if}

	<main>
		<aside class="left"><Palette /></aside>
		<section class="canvas"><Schematic /></section>
		<aside class="right"><Inspector /></aside>
	</main>

	<section class="bottom">
		<Playback />
		<Scope />
	</section>
</div>

<style>
	.app {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) 300px;
		height: 100vh;
		height: 100dvh;
	}

	/* Rows are assigned explicitly. The banner is conditional, and with automatic
	   placement its absence shifts everything below it up a row — which silently
	   collapses the scope to nothing. */
	header {
		grid-row: 1;
	}
	.banner {
		grid-row: 2;
	}
	main {
		grid-row: 3;
	}
	.bottom {
		grid-row: 4;
	}

	header {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.45rem 0.75rem;
		background: var(--panel-bg);
		border-bottom: 1px solid var(--border);
	}

	.brand {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.brand strong {
		font-size: 1rem;
		letter-spacing: -0.01em;
	}

	.tag {
		color: var(--label-dim);
		font-size: 0.72rem;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-left: auto;
	}

	.controls button,
	.controls select {
		padding: 0.32rem 0.6rem;
		font-size: 0.78rem;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text);
		cursor: pointer;
	}

	.controls button:hover,
	.controls select:hover {
		background: var(--hover);
	}

	.run {
		background: var(--accent) !important;
		border-color: var(--accent) !important;
		color: var(--accent-text) !important;
		font-weight: 600;
		min-width: 4.5rem;
	}

	.run:disabled {
		opacity: 0.6;
		cursor: progress;
	}

	.stop {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.75rem;
		color: var(--label-dim);
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		padding: 0 0.45rem;
	}

	.stop input {
		width: 4.5rem;
		border: none;
		background: transparent;
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.78rem;
		padding: 0.32rem 0;
	}

	.stop input:focus {
		outline: none;
	}

	.divider {
		width: 1px;
		height: 1.2rem;
		background: var(--border);
		margin: 0 0.15rem;
	}

	.meta {
		font-size: 0.68rem;
		color: var(--label-dim);
		font-family: var(--font-mono);
	}

	.banner {
		padding: 0.4rem 0.75rem;
		font-size: 0.78rem;
		border-bottom: 1px solid var(--border);
	}

	.banner.error {
		background: color-mix(in srgb, var(--danger) 16%, var(--panel-bg));
		color: var(--text);
	}

	.banner.warn {
		background: color-mix(in srgb, var(--selection) 14%, var(--panel-bg));
		color: var(--text);
	}

	main {
		display: grid;
		grid-template-columns: 200px minmax(0, 1fr) 250px;
		min-height: 0;
	}

	/* `overflow: hidden` is doing real work here: without it the palette's own
	   scroll container has no height to scroll within, so it grows to fit its
	   content and spills over the scope below. */
	.left,
	.right {
		background: var(--panel-bg);
		min-height: 0;
		overflow: hidden;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
	}

	.left {
		border-right: 1px solid var(--border);
	}

	.right {
		border-left: 1px solid var(--border);
	}

	.canvas {
		min-width: 0;
		min-height: 0;
	}

	.bottom {
		border-top: 1px solid var(--border);
		min-height: 0;
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
	}

	@media (max-width: 900px) {
		main {
			grid-template-columns: 150px minmax(0, 1fr);
		}
		.right {
			display: none;
		}
	}
</style>
