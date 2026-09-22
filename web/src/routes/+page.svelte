<script lang="ts">
	import Inspector from '$lib/components/Inspector.svelte';
	import Palette from '$lib/components/Palette.svelte';
	import Playback from '$lib/components/Playback.svelte';
	import Schematic from '$lib/components/Schematic.svelte';
	import Scope from '$lib/components/Scope.svelte';
	import { ensureEngine, engineVersion } from '$lib/engine';
	import { EXAMPLES } from '$lib/examples';
	import {
		Autosaver,
		chooseStart,
		newDraftId,
		openDraftStore,
		staleDrafts,
		type DraftRecord,
		type DraftStore
	} from '$lib/draft';
	import { decodeCircuit, shareUrl } from '$lib/share';
	import { definitionFor } from '$lib/schematic/model';
	import { LOGIC_FAMILIES } from '$lib/schematic/logic';
	import { SYMBOL_STANDARDS } from '$lib/schematic/symbols';
	import { app } from '$lib/state.svelte';
	import { formatValue, parseValue } from '$lib/units';

	let version = $state('');
	let schematic = $state<ReturnType<typeof Schematic> | null>(null);
	/**
	 * Which side panel is out, on a screen too narrow to keep both open.
	 *
	 * On a phone the palette and the inspector slide over the drawing rather
	 * than sitting beside it, one at a time, and go back when a part is picked:
	 * the next thing after choosing a part is tapping the drawing, and the panel
	 * would be covering it.
	 */
	let panel = $state<'parts' | 'details' | null>(null);
	/** Whether the scope has its share of a small screen, or the drawing has it all. */
	let scopeShown = $state(true);

	$effect(() => {
		if (app.tool.mode !== 'select') panel = null;
	});
	let stopField = $state(formatValue(app.stopTime, 3));
	let acStartField = $state(formatValue(app.acStart, 3));
	let acStopField = $state(formatValue(app.acStop, 3));
	let fileInput = $state<HTMLInputElement | null>(null);
	let traceState = $state<'idle' | 'copied' | 'failed'>('idle');
	let shareState = $state<'idle' | 'copied' | 'failed'>('idle');
	let tempField = $state(String(app.temperature));

	$effect(() => {
		// Keep the fields in sync when an example, a file or a draft changes them.
		stopField = formatValue(app.stopTime, 3);
	});
	$effect(() => {
		acStartField = formatValue(app.acStart, 3);
		acStopField = formatValue(app.acStop, 3);
	});
	$effect(() => {
		tempField = String(app.temperature);
	});

	/** The name of this tab's draft, kept where a reload of the same tab finds it. */
	const TAB_DRAFT_KEY = 'repath.draft';

	function tabDraft(): string | null {
		try {
			return sessionStorage.getItem(TAB_DRAFT_KEY);
		} catch {
			return null;
		}
	}

	function setTabDraft(id: string) {
		try {
			sessionStorage.setItem(TAB_DRAFT_KEY, id);
		} catch {
			// Without it a reload still finds the newest draft, which is usually this one.
		}
	}

	/**
	 * Hold a draft for as long as this tab is open, or say that another tab does.
	 *
	 * Two tabs writing one draft would each overwrite the other's work on every
	 * change, so a tab that finds its draft taken — a duplicated tab, the app
	 * opened twice — carries on from it under a new name instead.
	 */
	function claim(id: string): Promise<boolean> {
		if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(true);
		return new Promise((resolve) => {
			navigator.locks
				.request(`repath.draft.${id}`, { ifAvailable: true }, (lock) => {
					resolve(lock !== null);
					return lock ? new Promise<void>(() => {}) : undefined;
				})
				.catch(() => resolve(true));
		});
	}

	let saver: Autosaver | null = null;
	/** Which arrival the draft being written belongs to; a new one starts a new draft. */
	let draftArrivals = -1;
	/** Where the next whole circuit to arrive came from, for the draft it starts. */
	let arrivingFrom = '';
	/** A link that was followed but set aside for a newer draft of it, to open on request. */
	let linkBehind = $state<string | null>(null);

	/** Drop a fragment that no longer describes what is on screen, keeping the router's history state. */
	function forgetLink() {
		if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);
	}

	async function openLink(hash: string): Promise<boolean> {
		try {
			arrivingFrom = hash;
			app.loadShared(await decodeCircuit(hash));
			return true;
		} catch (cause) {
			arrivingFrom = '';
			// A notice, not an error: someone who followed a link needs to be told
			// that what they are looking at is not what they were sent.
			const why = cause instanceof Error ? cause.message : String(cause);
			app.notice = `That link could not be read, so this is not the circuit it holds. ${why}`;
			return false;
		}
	}

	async function start(store: DraftStore | null) {
		const records: DraftRecord[] = store ? await store.all().catch(() => []) : [];
		const hash = location.hash.length > 2 ? location.hash : '';
		const choice = chooseStart(records, tabDraft(), hash);

		let resumed: DraftRecord | null = null;
		if (choice.kind === 'draft') {
			try {
				app.restoreDraft(JSON.parse(choice.record.doc));
				resumed = choice.record;
				if (choice.over) {
					linkBehind = choice.over;
					app.notice =
						'This is the circuit from the link with the changes you made since, which were kept. The link as it was sent is one click away.';
				}
			} catch {
				// A draft this build cannot read is left where it is, not deleted: a
				// newer build may well read it. Fall through as though there were none.
			}
		}
		let origin = resumed?.origin ?? '';
		if (!resumed && hash) origin = (await openLink(hash)) ? hash : '';

		if (!store) return;
		const id = resumed && (await claim(resumed.id)) ? resumed.id : newDraftId();
		if (id !== resumed?.id) await claim(id);
		setTabDraft(id);
		draftArrivals = app.arrivals;
		arrivingFrom = '';
		saver = new Autosaver(
			store,
			{
				id,
				origin,
				edited: resumed?.edited ?? false,
				doc: id === resumed?.id ? resumed.doc : null
			},
			{
				onError: () => {
					app.notice =
						'Your work could not be saved in this browser, so a reload would lose it. Save it to a file to be safe.';
				},
				isEmpty: (doc) => {
					const levels = (doc as ReturnType<typeof app.draft>).levels;
					return levels.length === 1 && levels[0].schematic.instances.length === 0;
				}
			}
		);
		for (const stale of staleDrafts(records, new Set([id]))) void store.remove(stale).catch(() => {});
		saverReady = true;
	}

	$effect(() => {
		ensureEngine().then(async () => {
			version = engineVersion();
			// Nothing simulates until it is asked to. Opening on a circuit that is
			// already running gives no moment to look at it before it moves.
			await start(await openDraftStore());
		});
	});

	/**
	 * Write the work down as it changes.
	 *
	 * A whole circuit arriving — an example, a file, a link — starts a new
	 * draft rather than overwriting the one on screen, which was somebody's
	 * work. And it drops the old link from the address bar, which described
	 * the circuit that just left.
	 */
	let saverReady = $state(false);
	$effect(() => {
		if (!saverReady || !saver) return;
		const arrivals = app.arrivals;
		const doc = app.draft();
		if (arrivals !== draftArrivals) {
			draftArrivals = arrivals;
			const id = newDraftId();
			void claim(id);
			setTabDraft(id);
			saver.fork(id, arrivingFrom, doc);
			linkBehind = null;
			if (!arrivingFrom) forgetLink();
			arrivingFrom = '';
			return;
		}
		saver.schedule(doc);
	});

	$effect(() => {
		// The debounce is for drags; leaving the page is not the moment to wait.
		const flush = () => void saver?.flush();
		const hidden = () => {
			if (document.visibilityState === 'hidden') flush();
		};
		// A link pasted into this tab's address bar changes only the fragment,
		// which does not reload the page; it is still a circuit being opened.
		const followed = () => {
			if (location.hash.length > 2 && location.hash !== saver?.origin) void openLink(location.hash);
		};
		window.addEventListener('pagehide', flush);
		document.addEventListener('visibilitychange', hidden);
		window.addEventListener('hashchange', followed);
		return () => {
			window.removeEventListener('pagehide', flush);
			document.removeEventListener('visibilitychange', hidden);
			window.removeEventListener('hashchange', followed);
		};
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
			// A different circuit is a different run: the samples on screen were
			// solved for the old one, and carrying them over would be a chart of two
			// circuits spliced together. So this starts again from zero — which is
			// also why operating a switch deliberately does not come through here.
			app.run({ quiet: true });
		}, 120);

		return () => clearTimeout(pending);
	});

	async function share() {
		try {
			const url = await shareUrl(
				{ schematic: app.schematic, stopTime: app.stopTime, probes: app.probes },
				new URL(location.href)
			);
			history.replaceState(history.state, '', url);
			// The draft now continues this link: a reload finds the draft, and
			// the link on its own is what anyone else gets.
			void saver?.setOrigin(new URL(url).hash, app.draft());
			await navigator.clipboard.writeText(url);
			shareState = 'copied';
		} catch {
			// Clipboard access can be refused; the URL bar still holds the link.
			shareState = 'failed';
		}
		setTimeout(() => (shareState = 'idle'), 2500);
	}

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
		// After the click has been dispatched, not during it. Revoking inside the
		// same turn is a race the common browsers happen to win and Safari does
		// not, and losing it means the Save button doing nothing at all.
		setTimeout(() => URL.revokeObjectURL(url), 0);
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
				One button for the whole thing. Running is a state you are in or out of,
				and having to hunt for a different control to leave it is what made a
				stopped sweep sit there looking like a live one.

				Run always starts a new sweep from zero, the way pressing it on a scope
				restarts the acquisition. Picking a stopped one back up is the transport
				underneath the drawing, which is where the timebase lives.
			-->
			<button
				class="run"
				class:stopping={app.playing && !app.running}
				onclick={() => (app.playing && !app.running ? app.stop() : app.run())}
				disabled={app.running}
				title={app.playing
					? 'Stop the sweep and freeze what is on screen'
					: 'Start a new sweep from zero'}
			>
				<svg viewBox="0 0 12 12" aria-hidden="true">
					{#if app.running}
						<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"
							stroke-dasharray="6 20" stroke-linecap="round" />
					{:else if app.playing}
						<rect x="2.5" y="2.5" width="7" height="7" />
					{:else}
						<path d="M3.5 2l6 4-6 4z" />
					{/if}
				</svg>
				{app.running ? 'Starting…' : app.playing ? 'Stop' : 'Run'}
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
				<!--
					The timebase: how much simulated time the screen covers. Not a length
					any more — the run does not have one — but the width of the window it
					is watched through, and what Single captures one of.
				-->
				<label class="stop" title="How much simulated time the screen covers">
					<span>window</span>
					<input
						bind:value={stopField}
						onblur={(e) => commitStopTime(e.currentTarget.value)}
						onkeydown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur();
						}}
						aria-label="Timebase: seconds across the screen"
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
				How the symbols are drawn, which is the reader's habit rather than a
				property of the circuit: not shared, not saved with the drawing.
			-->
			<select
				aria-label="Symbol standard"
				title="How the parts are drawn: zigzag or box resistors, shaped or boxed gates"
				value={app.symbolStandard}
				onchange={(e) => app.setSymbolStandard(e.currentTarget.value)}
			>
				{#each SYMBOL_STANDARDS as option (option.value)}
					<option value={option.value} title={option.description}>{option.label}</option>
				{/each}
			</select>

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
				<!--
					Selected on an empty sheet and on anything drawn since, so the menu
					never claims one of these is what is on screen. Disabled because
					there is nothing to go back to: clearing the drawing is what Clear
					is for, and doing it by accident from a menu would be worse.
				-->
				<option value="" disabled>Examples</option>
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
			{#if linkBehind}
				<button
					class="link-behind"
					onclick={async () => {
						const hash = linkBehind!;
						linkBehind = null;
						if (await openLink(hash)) app.notice = null;
					}}
				>
					Open the link as sent
				</button>
			{/if}
			<button
				class="dismiss"
				onclick={() => {
					app.notice = null;
					linkBehind = null;
				}}
				aria-label="Dismiss">×</button
			>
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
		<aside class="left" class:open={panel === 'parts'}><Palette /></aside>
		<section class="canvas"><Schematic bind:this={schematic} /></section>
		<aside class="right" class:open={panel === 'details'}><Inspector /></aside>
		{#if panel}
			<button class="backdrop" aria-label="Close the panel" onclick={() => (panel = null)}></button>
		{/if}
	</main>

	<!--
		What a phone has no room or keys for. The panels are one tap away instead
		of always open; Rotate, Delete and Fit stand in for R, Del and F; and the
		scope can be put away so the drawing gets the whole screen.
	-->
	<nav class="phone-bar" aria-label="Phone controls">
		<button
			class:active={panel === 'parts'}
			onclick={() => (panel = panel === 'parts' ? null : 'parts')}
		>
			Parts
		</button>
		<button
			class:active={panel === 'details'}
			onclick={() => (panel = panel === 'details' ? null : 'details')}
		>
			Details
		</button>
		<span class="gap"></span>
		<button
			disabled={app.selection.length === 0}
			onclick={() => app.rotateSelection()}
			title="Turn a quarter turn; wires follow"
		>
			Rotate
		</button>
		<button
			class="danger"
			disabled={app.selection.length === 0}
			onclick={() => app.deleteSelection()}
		>
			Delete
		</button>
		<span class="gap"></span>
		<button onclick={() => schematic?.fitToContent()} title="Fit the drawing on screen">Fit</button>
		<button
			class:active={scopeShown}
			onclick={() => (scopeShown = !scopeShown)}
			title={scopeShown ? 'Put the scope away' : 'Bring the scope back'}
		>
			Scope
		</button>
	</nav>

	<section class="bottom" class:collapsed={!scopeShown}>
		{#if app.analysis === 'transient'}
			<Playback />
		{/if}
		<div class="scope-host"><Scope /></div>
	</section>
</div>

<style>
	.app {
		display: grid;
		/* The one column is sized by the window, not by the widest row in it. */
		grid-template-columns: minmax(0, 1fr);
		grid-template-rows: auto auto minmax(0, 1fr) auto 300px;
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
	.phone-bar {
		grid-row: 4;
	}
	.bottom {
		grid-row: 5;
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
		/* The tagline yields before the controls do: a header short on room
		   dropped it onto three lines and pushed the toolbar down with it. */
		white-space: nowrap;
	}

	@media (max-width: 1500px) {
		.tag {
			display: none;
		}
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
		position: relative;
	}

	/* Phone-only, and folded away on anything wider. */
	.phone-bar,
	.backdrop {
		display: none;
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

	/*
		A phone, or a tablet held upright. The drawing takes the whole width; the
		palette and inspector become drawers over it; the keys that have no key
		become a row of buttons; and the header scrolls sideways rather than
		wrapping into a wall of controls.
	*/
	@media (max-width: 900px) {
		.app {
			grid-template-rows: auto auto minmax(0, 1fr) auto auto;
		}

		header {
			gap: 0.5rem;
			padding: 0.4rem 0.6rem;
		}

		.tag,
		.meta {
			display: none;
		}

		.controls {
			margin-left: 0;
			min-width: 0;
			flex: 1;
			overflow-x: auto;
			scrollbar-width: none;
			/* Room for the focus ring, which overflow would otherwise clip. */
			padding: 2px;
		}

		.controls::-webkit-scrollbar {
			display: none;
		}

		.controls > * {
			flex: none;
		}

		main {
			grid-template-columns: minmax(0, 1fr);
			/* The drawers wait just outside; the page must not scroll to them. */
			overflow: hidden;
		}

		.left,
		.right {
			position: absolute;
			top: 0;
			bottom: 0;
			width: min(300px, 85%);
			z-index: 3;
			transition: transform 0.18s ease-out;
			box-shadow: 0 0 24px rgba(0, 0, 0, 0.45);
		}

		.left {
			left: 0;
			transform: translateX(-100%);
		}

		.right {
			right: 0;
			transform: translateX(100%);
		}

		.left.open,
		.right.open {
			transform: none;
		}

		.backdrop {
			display: block;
			position: absolute;
			inset: 0;
			z-index: 2;
			border: none;
			padding: 0;
			background: rgba(0, 0, 0, 0.35);
			cursor: pointer;
		}

		.phone-bar {
			display: flex;
			align-items: center;
			gap: 0.3rem;
			padding: 0.3rem 0.5rem;
			background: var(--panel-bg);
			border-top: 1px solid var(--border);
			overflow-x: auto;
			scrollbar-width: none;
		}

		.phone-bar .gap {
			flex: 1;
		}

		.phone-bar button {
			flex: none;
			/* A finger's width, whatever the label says. */
			min-height: 2.4rem;
			padding: 0.3rem 0.7rem;
			font-size: 0.78rem;
			border: 1px solid var(--border);
			border-radius: 6px;
			background: var(--control-bg);
			color: var(--text);
		}

		.phone-bar button:disabled {
			opacity: 0.45;
		}

		.phone-bar button.active {
			border-color: var(--accent);
			background: color-mix(in srgb, var(--accent) 14%, transparent);
		}

		.phone-bar button.danger:not(:disabled) {
			color: var(--danger);
		}

		.scope-host {
			flex: none;
			height: 200px;
		}

		.bottom.collapsed .scope-host {
			display: none;
		}
	}
</style>
