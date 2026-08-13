<script lang="ts">
	import Inspector from '$lib/components/Inspector.svelte';
	import Palette from '$lib/components/Palette.svelte';
	import Playback from '$lib/components/Playback.svelte';
	import Schematic from '$lib/components/Schematic.svelte';
	import Scope from '$lib/components/Scope.svelte';
	import { ensureEngine, engineVersion } from '$lib/engine';
	import { EXAMPLES } from '$lib/examples';
	import { decodeCircuit, shareUrl } from '$lib/share';
	import { definitionFor } from '$lib/schematic/model';
	import { LOGIC_FAMILIES } from '$lib/schematic/logic';
	import { app } from '$lib/state.svelte';
	import { formatValue, parseValue } from '$lib/units';

	let version = $state('');
	let stopField = $state(formatValue(app.stopTime, 3));
	let acStartField = $state(formatValue(app.acStart, 3));
	let acStopField = $state(formatValue(app.acStop, 3));
	let fileInput = $state<HTMLInputElement | null>(null);
	let traceState = $state<'idle' | 'copied' | 'failed'>('idle');
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
					// A notice, not an error: the default circuit is about to load and
					// simulate, and someone who followed a link needs to be told that
					// what they are looking at is not what they were sent.
					const why = cause instanceof Error ? cause.message : String(cause);
					app.notice = `That link could not be read, so this is the default circuit instead. ${why}`;
				}
			}
			// Nothing simulates until it is asked to. Opening on a circuit that is
			// already running gives no moment to look at it before it moves.
		});
	});

	/**
	 * Keep the results in step with the circuit, once there are results.
	 *
	 * Only after a deliberate Run — before that the scope is empty on purpose —
	 * and only when the netlist really differs, since the drawing changes on every
	 * frame of a drag while the circuit it describes usually does not.
	 *
	 * Debounced, or turning a value with the arrow keys would queue a simulation
	 * per keystroke and the answers would arrive behind the input.
	 */
	let lastSignature = '';
	let pending: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const signature = app.netlistSignature;
		if (!app.live) {
			lastSignature = signature;
			return;
		}
		if (signature === lastSignature) return;

		clearTimeout(pending);
		pending = setTimeout(() => {
			if (!app.live || app.running) return;
			lastSignature = app.netlistSignature;
			app.run({ keepPlayback: true });
		}, 120);

		return () => clearTimeout(pending);
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

	let tempField = $state(String(app.temperature));

	/** Whether anything on the drawing has a digital pin to speak of. */
	const hasDigital = $derived(
		app.schematic.instances.some((instance) =>
			definitionFor(instance).pins.some((pin) => pin.domain === 'digital')
		)
	);

	function commitTemperature(value: string) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) app.setTemperature(parsed);
		tempField = String(app.temperature);
	}

	function commitStopTime(value: string) {
		const parsed = parseValue(value);
		if (parsed !== null && parsed > 0) app.setStopTime(parsed);
		stopField = formatValue(app.stopTime, 3);
	}

	/**
	 * Hand over what has been done here, as text.
	 *
	 * A share link carries the circuit; this carries the *route* to it, which for
	 * anything involving a drag is the part that is hard to describe and easy to
	 * get wrong when it is described. Paste it into a bug report and the exact
	 * sequence can be replayed rather than guessed at.
	 */
	async function copyTrace() {
		const text = app.trace.toText();
		if (!text) {
			app.notice = 'Nothing has been done yet, so there is nothing to hand over.';
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			traceState = 'copied';
		} catch {
			traceState = 'failed';
			app.notice = text;
		}
		setTimeout(() => (traceState = 'idle'), 2500);
	}

	function commitAc(which: 'start' | 'stop', value: string) {
		const parsed = parseValue(value);
		if (parsed !== null && parsed > 0) {
			if (which === 'start') app.acStart = parsed;
			else app.acStop = parsed;
		}
		acStartField = formatValue(app.acStart, 3);
		acStopField = formatValue(app.acStop, 3);
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
			app.notice = cause instanceof Error ? cause.message : String(cause);
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
			<!--
				One button for the whole thing. Running is a state you are in or out
				of, and having to hunt for a different control to leave it is what made
				a paused overlay sit there looking like a live one.
			-->
			<button
				class="run"
				class:stopping={app.live && !app.running}
				onclick={() => (app.live && !app.running ? app.stop() : app.run())}
				disabled={app.running}
				title={app.live
					? 'Stop simulating and put the drawing back'
					: 'Simulate and show it on the schematic'}
			>
				<svg viewBox="0 0 12 12" aria-hidden="true">
					{#if app.running}
						<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"
							stroke-dasharray="6 20" stroke-linecap="round" />
					{:else if app.live}
						<path d="M3 2.5h2.2v7H3zM6.8 2.5H9v7H6.8z" />
					{:else}
						<path d="M3.5 2l6 4-6 4z" />
					{/if}
				</svg>
				{app.running ? 'Running…' : app.live ? 'Stop' : 'Run'}
			</button>

			<select
				value={app.analysis}
				onchange={(e) => app.setAnalysis(e.currentTarget.value as 'transient' | 'frequency')}
				aria-label="Analysis"
				title="Which analysis Run performs"
			>
				<option value="transient">Transient</option>
				<option value="frequency">Frequency</option>
			</select>

			{#if app.analysis === 'frequency'}
				<label class="stop">
					<span>from</span>
					<input
						bind:value={acStartField}
						onblur={(e) => commitAc('start', e.currentTarget.value)}
						onkeydown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur();
						}}
						aria-label="Sweep start frequency"
					/>
					<span>to</span>
					<input
						bind:value={acStopField}
						onblur={(e) => commitAc('stop', e.currentTarget.value)}
						onkeydown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur();
						}}
						aria-label="Sweep stop frequency"
					/>
					<span class="unit">Hz</span>
				</label>
			{:else}
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
			{/if}

			<!--
				One temperature for the drawing, because that is the question people
				ask of a circuit: does it still work in a cold car, or inside a hot
				enclosure. Every junction drop, every gain and every resistor moves
				with it.
			-->
			<label class="stop">
				<span>at</span>
				<input
					bind:value={tempField}
					onblur={(e) => commitTemperature(e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Enter') e.currentTarget.blur();
					}}
					aria-label="Circuit temperature"
				/>
				<span class="unit">°C</span>
			</label>

			<!--
				Only where it means something. On a purely analog drawing the family
				decides nothing, and a control that changes nothing is worse than no
				control: it invites the reader to believe it matters here.
			-->
			{#if hasDigital}
				<select
					aria-label="Logic family"
					title="What a digital one and a digital zero are, in volts"
					value={app.logicFamily}
					onchange={(e) => app.setLogicFamily(e.currentTarget.value)}
				>
					{#each LOGIC_FAMILIES as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
			{/if}

			<!--
				One sample says nothing; half a dozen say whether the corner of a
				filter is a property of the design or of the parts that happened to be
				in the drawer. So the button rerolls rather than toggling.
			-->
			<button
				class="sample"
				class:on={app.sample > 0}
				onclick={() => app.setSample(app.sample > 0 ? app.sample + 1 : 1)}
				oncontextmenu={(e) => {
					e.preventDefault();
					app.setSample(0);
				}}
				title={app.sample > 0
					? `Sample #${app.sample} — click for another, right-click for nominal`
					: 'Draw every part from inside its tolerance instead of using its marking'}
			>
				{app.sample > 0 ? `sample #${app.sample}` : 'nominal'}
			</button>

			<!--
				One sample answers "does it work with these parts". This answers the
				question anyone actually has: does it work with the parts I am going
				to be sent.
			-->
			<button
				class="sample"
				class:on={app.sweepCount > 0}
				onclick={() => app.setSweep(app.sweepCount > 0 ? 0 : 25)}
				title={app.sweepCount > 0
					? `Running ${app.sweepCount} samples and shading where they all went`
					: 'Run many samples and shade the band they cover'}
			>
				{app.sweepCount > 0 ? `×${app.sweepCount}` : 'sweep'}
			</button>

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
			<button
				onclick={copyTrace}
				title="Copy every step taken here, as text, so it can be replayed"
			>
				{traceState === 'copied'
					? `Copied ${app.trace.steps.length}`
					: traceState === 'failed'
						? 'See the notice'
						: 'Steps'}
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

	{#if app.notice}
		<div class="banner warn" role="alert">
			{app.notice}
			<button class="dismiss" onclick={() => (app.notice = null)} aria-label="Dismiss">×</button>
		</div>
	{:else if app.error}
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
		{#if app.analysis === 'transient'}
			<Playback />
		{/if}
		<div class="scope-host"><Scope /></div>
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
		min-width: 5.6rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
	}

	.run svg {
		width: 11px;
		height: 11px;
		fill: currentColor;
	}

	/* Running reads as the live state; leaving it should not look like the same
	   invitation, so the button steps back to an outline while it is on. */
	.run.stopping {
		background: transparent !important;
		color: var(--accent) !important;
	}

	.run:disabled {
		opacity: 0.6;
		cursor: progress;
	}

	.sample {
		font-size: 0.72rem;
		color: var(--label-dim);
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		padding: 0.22rem 0.5rem;
		cursor: pointer;
		font-family: var(--font-mono);
	}

	.sample:hover {
		color: var(--text);
	}

	/* Lit while the circuit being simulated is not the one that is drawn. */
	.sample.on {
		border-color: var(--accent);
		color: var(--text);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
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
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.4rem 0.75rem;
		font-size: 0.78rem;
		border-bottom: 1px solid var(--border);
	}

	.dismiss {
		margin-left: auto;
		border: none;
		background: none;
		color: var(--label-dim);
		font-size: 1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.25rem;
	}

	.dismiss:hover {
		color: var(--text);
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

	/* Flex rather than fixed grid rows: the transport bar is conditional, and with
	   `grid-template-rows` its absence would hand the scope an auto-sized row and
	   collapse it to nothing. */
	.bottom {
		border-top: 1px solid var(--border);
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.scope-host {
		flex: 1;
		min-height: 0;
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
