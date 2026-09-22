<script lang="ts">
	import Inspector from '$lib/components/inspector/Inspector.svelte';
	import Palette from '$lib/components/palette/Palette.svelte';
	import Playback from '$lib/components/Playback.svelte';
	import Schematic from '$lib/components/Schematic.svelte';
	import Scope from '$lib/components/Scope.svelte';
	import Toolbar from '$lib/components/toolbar/Toolbar.svelte';
	import CommandPalette from '$lib/commands/CommandPalette.svelte';
	import { Button, Toaster } from '$lib/ui';
	import { ensureEngine, engineVersion } from '$lib/engine';
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
	import { app } from '$lib/state.svelte';

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
	/** Whether the command palette is open. */
	let finding = $state(false);

	$effect(() => {
		if (app.tool.mode !== 'select') panel = null;
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
			} catch (cause) {
				// A draft this build cannot read is left where it is, not deleted: a
				// newer build may well read it. Fall through as though there were none.
				console.warn('The saved draft could not be restored.', cause);
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
		// The drawing does not wait for the engine. Restoring a draft or opening a
		// link needs nothing from it, and waiting meant that an engine which failed
		// to load took the link and the saved work down with it, unexplained.
		// Nothing simulates until it is asked to, either: opening on a circuit that
		// is already running gives no moment to look at it before it moves.
		const started = openDraftStore()
			.then(start)
			.catch((cause) => {
				const why = cause instanceof Error ? cause.message : String(cause);
				app.notice = `Your saved work could not be opened. ${why}`;
			});
		ensureEngine().then(
			() => (version = engineVersion()),
			async (cause) => {
				// After the start, which clears notices as it loads.
				await started;
				const why = cause instanceof Error ? cause.message : String(cause);
				app.notice = `The simulation engine could not be loaded, so nothing can be run. Reloading the page usually fixes it. ${why}`;
			}
		);
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
	/** Whether the effect below has seen the results live, so it knows the run they started from. */
	let wasLive = false;
	let pending: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		// `live` first: the signature is the whole netlist as text, and reading it
		// while nothing is running cost a stringify on every frame of every drag.
		if (!app.live) {
			wasLive = false;
			return;
		}
		const signature = app.netlistSignature;
		// Run was just pressed: that run is of this circuit.
		if (!wasLive) {
			wasLive = true;
			lastSignature = signature;
			return;
		}
		if (signature === lastSignature) return;

		const rerun = () => {
			if (!app.live) return;
			// A run still starting — the first one waits for the engine to load —
			// is waited for rather than skipped, or this edit would never be run.
			if (app.running) {
				pending = setTimeout(rerun, 120);
				return;
			}
			lastSignature = app.netlistSignature;
			// A different circuit is a different run: the samples on screen were
			// solved for the old one, and carrying them over would be a chart of two
			// circuits spliced together. So this starts again from zero — which is
			// also why operating a switch deliberately does not come through here.
			app.run({ quiet: true });
		};
		clearTimeout(pending);
		pending = setTimeout(rerun, 120);

		return () => clearTimeout(pending);
	});

	/**
	 * Put the circuit in a link, copy it, and make the draft continue that link.
	 * Rejects when the clipboard refuses; the URL bar holds the link either way.
	 */
	async function share() {
		const url = await shareUrl(
			{
				schematic: app.schematic,
				stopTime: app.stopTime,
				probes: app.probes,
				settings: app.settings()
			},
			new URL(location.href)
		);
		history.replaceState(history.state, '', url);
		// The draft now continues this link: a reload finds the draft, and
		// the link on its own is what anyone else gets.
		void saver?.setOrigin(new URL(url).hash, app.draft());
		await navigator.clipboard.writeText(url);
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
	<div class="top"><Toolbar {version} {share} onFind={() => (finding = true)} /></div>

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
		<Button size="touch" active={panel === 'parts'} onclick={() => (panel = panel === 'parts' ? null : 'parts')}>
			Parts
		</Button>
		<Button
			size="touch"
			active={panel === 'details'}
			onclick={() => (panel = panel === 'details' ? null : 'details')}
		>
			Details
		</Button>
		<span class="flex-1"></span>
		<Button
			size="touch"
			disabled={app.selection.length === 0}
			onclick={() => app.rotateSelection()}
			title="Turn a quarter turn; wires follow"
		>
			Rotate
		</Button>
		<Button
			size="touch"
			class="text-danger"
			disabled={app.selection.length === 0}
			onclick={() => app.deleteSelection()}
		>
			Delete
		</Button>
		<span class="flex-1"></span>
		<Button size="touch" onclick={() => schematic?.fitToContent()} title="Fit the drawing on screen">Fit</Button>
		<Button
			size="touch"
			active={scopeShown}
			onclick={() => (scopeShown = !scopeShown)}
			title={scopeShown ? 'Put the scope away' : 'Bring the scope back'}
		>
			Scope
		</Button>
	</nav>

	<section class="bottom" class:collapsed={!scopeShown}>
		{#if app.analysis === 'transient'}
			<Playback />
		{/if}
		<div class="scope-host"><Scope /></div>
	</section>
</div>

<CommandPalette
	bind:open={finding}
	context={{ share, fitToContent: () => schematic?.fitToContent() }}
/>
<Toaster />

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
	.top {
		grid-row: 1;
		/* Or the toolbar's own width sets the column's, and the page scrolls sideways. */
		min-width: 0;
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
		grid-template-columns: 224px minmax(0, 1fr) 260px;
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
		grid-template-columns: minmax(0, 1fr);
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

		.scope-host {
			flex: none;
			height: 200px;
		}

		.bottom.collapsed .scope-host {
			display: none;
		}
	}
</style>
