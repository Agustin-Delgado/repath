<script lang="ts">
	import { ChevronRight, Plus, Search, X } from '@lucide/svelte';
	import { BLOCK_PREFIX, SUBCIRCUIT_PREFIX } from '$lib/schematic/model';
	import { SECTIONS, searchParts, sectionLabel, type PartEntry, type SectionId } from '$lib/parts/library';
	import { allParts, isArmed, pickPart } from '$lib/parts/drawing';
	import { recentParts } from '$lib/parts/recent.svelte';
	import { app } from '$lib/state.svelte';
	import Symbol from '../Symbol.svelte';
	import PartIcon from './PartIcon.svelte';
	import PartTile from './PartTile.svelte';
	import SubcircuitImport from './SubcircuitImport.svelte';

	/**
	 * Where parts are picked from.
	 *
	 * Two ways in, because there are two kinds of looking. Somebody who knows
	 * what they want types it — "7400", "npn", "cap" — and the list narrows to
	 * it; arrows and Enter pick it without the mouse. Somebody browsing walks
	 * the shelves, which fold away so a long one does not bury the rest. The
	 * parts used last sit on top either way, since a drawing is mostly the same
	 * handful of parts over and over.
	 */

	const parts = $derived(allParts(app));
	const byKind = $derived(new Map(parts.map((part) => [part.kind, part])));

	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);
	let active = $state(0);
	const results = $derived(query.trim() ? searchParts(parts, query) : []);
	$effect(() => {
		void results;
		active = 0;
	});
	$effect(() => {
		// The arrows move a highlight the list may have scrolled away from.
		document.getElementById(`part-result-${active}`)?.scrollIntoView({ block: 'nearest' });
	});

	const recent = $derived(
		recentParts.kinds.map((kind) => byKind.get(kind)).filter((part): part is PartEntry => !!part)
	);

	// --- Folded shelves, remembered per browser -------------------------------

	const FOLDED_KEY = 'repath.foldedShelves';
	/** Chips start folded: dozens of DIPs would otherwise bury the rest. */
	const FOLDED_BY_DEFAULT: SectionId[] = ['ic'];

	function loadFolded(): Set<string> {
		try {
			const raw = localStorage.getItem(FOLDED_KEY);
			if (raw) return new Set(JSON.parse(raw));
		} catch {
			// Fall through to the defaults.
		}
		return new Set(FOLDED_BY_DEFAULT);
	}

	let folded = $state(loadFolded());

	function toggleShelf(id: string) {
		const next = new Set(folded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		folded = next;
		try {
			localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
		} catch {
			// Folding still works for this tab.
		}
	}

	let importing = $state(false);

	// --- Picking --------------------------------------------------------------

	const pick = (kind: string) => pickPart(app, kind);

	function wire() {
		app.tool = app.tool.mode === 'wire' ? { mode: 'select' } : { mode: 'wire' };
	}

	function pickResult(part: PartEntry | undefined) {
		if (!part) return;
		pick(part.kind);
		query = '';
		searchInput?.blur();
	}

	function onSearchKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			active = Math.min(active + 1, results.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			pickResult(results[active]);
		} else if (event.key === 'Escape') {
			if (query) query = '';
			else searchInput?.blur();
		}
	}

	/** `/` finds a part from anywhere, the way it finds things on most of the web. */
	function onWindowKey(event: KeyboardEvent) {
		if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
		const target = event.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable]')) return;
		// Hidden in a closed drawer on a phone: nothing to focus there.
		if (!searchInput || searchInput.offsetParent === null) return;
		event.preventDefault();
		searchInput.focus();
	}

	/** Blocks and imported parts go with the drawing, and right-click is how they go. */
	function removable(part: PartEntry): ((event: MouseEvent) => void) | undefined {
		if (part.section === 'blocks') {
			return (event) => {
				event.preventDefault();
				app.removeBlock(part.kind.slice(BLOCK_PREFIX.length));
			};
		}
		if (part.section === 'imported') {
			return (event) => {
				event.preventDefault();
				app.removeSubcircuit(part.kind.slice(SUBCIRCUIT_PREFIX.length));
			};
		}
		return undefined;
	}

	const tip = (part: PartEntry) =>
		[part.label, part.description, part.caveat, removable(part) ? 'Right-click to remove' : '']
			.filter(Boolean)
			.join(' — ');
</script>

<svelte:window onkeydown={onWindowKey} />

{#snippet tile(part: PartEntry)}
	<PartTile
		label={part.label}
		title={tip(part)}
		active={isArmed(app, part.kind)}
		onclick={() => pick(part.kind)}
		oncontextmenu={removable(part)}
	>
		{#snippet icon()}
			<PartIcon kind={part.kind} class="h-[34px] w-[46px]" />
		{/snippet}
	</PartTile>
{/snippet}

{#snippet shelfHeading(id: string, label: string, count: number)}
	<button
		type="button"
		class="group flex w-full cursor-pointer items-center gap-1 rounded border-0 bg-transparent px-0.5 py-1 text-left text-[0.66rem] font-semibold tracking-[0.08em] text-muted uppercase hover:text-fg"
		aria-expanded={!folded.has(id)}
		onclick={() => toggleShelf(id)}
	>
		<ChevronRight class="size-3 transition-transform {folded.has(id) ? '' : 'rotate-90'}" />
		{label}
		<span class="ml-auto font-mono text-[0.6rem] font-normal tracking-normal opacity-60">{count}</span>
	</button>
{/snippet}

<div class="flex h-full min-h-0 w-full min-w-0 flex-col">
	<!-- Search stays put while the shelves scroll under it. -->
	<div class="border-b border-border p-2">
		<label
			class="flex h-7 items-center gap-1.5 rounded-control border border-border bg-control px-2 text-muted focus-within:border-accent/70"
		>
			<Search class="size-3.5 shrink-0" />
			<input
				bind:this={searchInput}
				bind:value={query}
				onkeydown={onSearchKey}
				type="search"
				placeholder="Find a part…"
				aria-label="Find a part"
				aria-controls="part-results"
				aria-activedescendant={results.length ? `part-result-${active}` : undefined}
				autocomplete="off"
				spellcheck="false"
				class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ui text-fg outline-none [&::-webkit-search-cancel-button]:hidden"
			/>
			{#if query}
				<button
					type="button"
					class="flex cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-fg"
					aria-label="Clear the search"
					onclick={() => {
						query = '';
						searchInput?.focus();
					}}
				>
					<X class="size-3.5" />
				</button>
			{:else}
				<kbd class="rounded border border-border px-1 font-mono text-[0.6rem] leading-4">/</kbd>
			{/if}
		</label>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-2">
		{#if query.trim()}
			<!--
				A list rather than tiles: a result has to say what it is, and a name
				under a 46-pixel icon cannot tell a 7400 from a 7402.
			-->
			<div id="part-results" role="listbox" aria-label="Parts found" class="flex flex-col gap-0.5">
				{#each results as part, i (part.kind)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						id="part-result-{i}"
						role="option"
						tabindex="-1"
						aria-selected={i === active}
						title={tip(part)}
						onclick={() => pickResult(part)}
						onpointermove={() => (active = i)}
						class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 [--symbol-stroke:var(--symbol)]
							{i === active ? 'bg-hover text-fg' : 'text-strong'}"
					>
						<PartIcon kind={part.kind} class="h-[26px] w-[34px]" />
						<div class="flex min-w-0 flex-col">
							<span class="truncate text-ui">{part.label}</span>
							<span class="truncate text-[0.64rem] text-muted">
								{sectionLabel(part.section)}{part.description ? ` · ${part.description}` : ''}
							</span>
						</div>
					</div>
				{:else}
					<p class="m-0 px-1 py-4 text-center text-2xs text-muted">
						No part matches “{query.trim()}”.
					</p>
				{/each}
			</div>
		{:else}
			<div class="flex flex-col gap-2">
				<section>
					<div class="grid grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-1">
						<!--
							Dragging off a pin already draws a wire, so this is here for the one
							thing that cannot start: a branch off the middle of an existing wire.
						-->
						<PartTile
							label="Wire"
							title="Draw a wire between two pins, or off an existing wire (W)"
							active={app.tool.mode === 'wire'}
							onclick={wire}
						>
							{#snippet icon()}
								<svg viewBox="-40 -40 80 80" class="h-[34px] w-[46px]" aria-hidden="true">
									<path
										d="M-28 14 H0 V-14 H28"
										fill="none"
										stroke="currentColor"
										stroke-width="3"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
									<circle cx="-28" cy="14" r="5" fill="currentColor" />
									<circle cx="28" cy="-14" r="5" fill="currentColor" />
								</svg>
							{/snippet}
						</PartTile>
						<!--
							Only inside a block, where a port means something: it is how a pin
							in here becomes a pin on the box.
						-->
						{#if app.inside}
							<PartTile
								label="Port"
								title="A terminal of this block: wire a pin to it and the box gets a pin under its name"
								active={isArmed(app, 'port')}
								onclick={() => pick('port')}
							>
								{#snippet icon()}
									<svg viewBox="-40 -40 80 80" class="h-[34px] w-[46px]" aria-hidden="true">
										<Symbol kind="port" />
									</svg>
								{/snippet}
							</PartTile>
						{/if}
					</div>
				</section>

				{#if recent.length > 0}
					<section>
						<h3 class="m-0 px-0.5 py-1 text-[0.66rem] font-semibold tracking-[0.08em] text-muted uppercase">
							Recent
						</h3>
						<div class="grid grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-1">
							{#each recent as part (part.kind)}
								{@render tile(part)}
							{/each}
						</div>
					</section>
				{/if}

				{#each SECTIONS as section (section.id)}
					{@const shelf = parts.filter((part) => part.section === section.id)}
					<!--
						Blocks only once there is one: a heading over nothing would be a
						promise about a gesture the palette does not explain. Imported is
						always there, because it is also the way in.
					-->
					{#if shelf.length > 0 || section.id === 'imported'}
						<section>
							{@render shelfHeading(section.id, section.label, shelf.length)}
							{#if !folded.has(section.id)}
								<div class="grid grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-1">
									{#each shelf as part (part.kind + ':' + part.label + ':' + part.description)}
										{@render tile(part)}
									{/each}
									{#if section.id === 'imported'}
										<PartTile
											label="Import"
											title="Paste a SPICE .subckt"
											active={importing}
											dim
											onclick={() => (importing = !importing)}
										>
											{#snippet icon()}
												<Plus class="h-[34px] w-[46px] p-2" strokeWidth={1.5} />
											{/snippet}
										</PartTile>
									{/if}
								</div>
								{#if section.id === 'imported' && importing}
									<SubcircuitImport
										onImported={(ids) => {
											importing = false;
											// Straight into placing it. Importing a part and then having to
											// find it in the list is a step that exists only because the
											// code was easier that way.
											if (ids.length === 1) pick(SUBCIRCUIT_PREFIX + ids[0]);
										}}
									/>
								{/if}
							{/if}
						</section>
					{/if}
				{/each}
			</div>
		{/if}
	</div>
</div>
