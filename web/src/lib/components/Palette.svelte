<script lang="ts">
	import { app } from '$lib/state.svelte';
	import { CATALOG, SUBCIRCUIT_PREFIX, type Group } from '$lib/schematic/model';
	import Symbol from './Symbol.svelte';

	const GROUPS: Array<{ id: Group; label: string }> = [
		{ id: 'passive', label: 'Passive' },
		{ id: 'sources', label: 'Sources' },
		{ id: 'semiconductor', label: 'Semiconductors' },
		{ id: 'analog', label: 'Analog' },
		{ id: 'logic', label: 'Logic' }
	];

	function select(kind: string) {
		app.tool =
			app.tool.mode === 'place' && app.tool.kind === kind
				? { mode: 'select' }
				: { mode: 'place', kind };
	}

	function wire() {
		app.tool = app.tool.mode === 'wire' ? { mode: 'select' } : { mode: 'wire' };
	}

	/** The imported parts this drawing carries. */
	const imported = $derived(app.schematic.subcircuits ?? []);

	let importing = $state(false);
	let source = $state('');
	let outcome = $state<string | null>(null);

	function runImport() {
		const { added, error } = app.importSubcircuits(source);
		if (error) {
			outcome = error;
			return;
		}
		outcome = null;
		importing = false;
		source = '';
		// Straight into placing it. Importing a part and then having to find it in
		// the list is a step that exists only because the code was easier that way.
		if (added.length === 1) select(SUBCIRCUIT_PREFIX + added[0].toLowerCase().replace(/[^a-z0-9]+/g, '-'));
	}
</script>

<div class="palette">
	<section>
		<h3>Connect</h3>
		<div class="grid">
			<!--
				Dragging off a pin already draws a wire, so this is here for the one
				thing that cannot start: a branch off the middle of an existing wire.
			-->
			<button
				class="part"
				class:active={app.tool.mode === 'wire'}
				onclick={wire}
				title="Draw a wire between two pins, or off an existing wire"
			>
				<svg viewBox="-40 -40 80 80" aria-hidden="true">
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
				<span>Wire</span>
			</button>
		</div>
	</section>

	{#each GROUPS as group (group.id)}
		<section>
			<h3>{group.label}</h3>
			<div class="grid">
				{#each CATALOG.filter((c) => c.group === group.id) as def (def.kind)}
					<button
						class="part"
						class:active={app.tool.mode === 'place' && app.tool.kind === def.kind}
						onclick={() => select(def.kind)}
						title={def.label}
					>
						<svg viewBox="-40 -40 80 80" aria-hidden="true">
							<Symbol kind={def.kind} />
						</svg>
						<span>{def.label}</span>
					</button>
				{/each}
			</div>
		</section>
	{/each}

	<!--
		A library, not a group of the catalog: these parts arrived with the drawing
		and travel with it. Kept last so the palette above it does not move around
		as things are imported.
	-->
	<section>
		<h3>Imported</h3>
		<div class="grid">
			{#each imported as sub (sub.id)}
				<button
					class="part"
					class:active={app.tool.mode === 'place' && app.tool.kind === SUBCIRCUIT_PREFIX + sub.id}
					onclick={() => select(SUBCIRCUIT_PREFIX + sub.id)}
					oncontextmenu={(e) => {
						e.preventDefault();
						app.removeSubcircuit(sub.id);
					}}
					title="{sub.name} ({sub.ports.join(' ')}) — right-click to remove"
				>
					<svg viewBox="-40 -40 80 80" aria-hidden="true">
						<Symbol kind={SUBCIRCUIT_PREFIX + sub.id} />
					</svg>
					<span>{sub.name}</span>
				</button>
			{/each}
			<button class="part add" onclick={() => (importing = !importing)} title="Paste a SPICE .subckt">
				<svg viewBox="-40 -40 80 80" aria-hidden="true">
					<path d="M0 -18 V18 M-18 0 H18" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" />
				</svg>
				<span>Import</span>
			</button>
		</div>
		{#if importing}
			<div class="import">
				<textarea
					rows="4"
					spellcheck="false"
					placeholder={'.SUBCKT OPAMP1 1 2 3\nRIN 1 2 2MEG\nE1 4 0 1 2 100K\n…\n.ENDS'}
					bind:value={source}
					aria-label="SPICE subcircuit"
				></textarea>
				{#if outcome}<p class="problem" role="alert">{outcome}</p>{/if}
				<button class="go" onclick={runImport} disabled={!source.trim()}>Add part</button>
			</div>
		{/if}
	</section>
</div>

<style>
	.import {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0 0.15rem;
	}

	.import textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		font-family: var(--font-mono);
		font-size: 0.64rem;
		line-height: 1.5;
		padding: 0.35rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--label-strong);
	}

	.import .problem {
		margin: 0;
		font-size: 0.66rem;
		line-height: 1.4;
		color: var(--danger);
	}

	.import .go {
		align-self: flex-start;
		padding: 0.25rem 0.6rem;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text);
		font-size: 0.68rem;
		cursor: pointer;
	}

	.import .go:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* Dimmer than a part: it is a way in, not a thing to place. */
	.part.add {
		opacity: 0.7;
	}

	.palette {
		height: 100%;
		min-height: 0;
		overflow-y: auto;
		padding: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}


	h3 {
		margin: 0.4rem 0 0.3rem;
		font-size: 0.66rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--label-dim);
		font-weight: 600;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
		gap: 0.3rem;
	}

	.part {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
		padding: 0.3rem 0.15rem 0.25rem;
		border: 1px solid transparent;
		border-radius: 6px;
		background: transparent;
		color: var(--label-dim);
		cursor: pointer;
		font-size: 0.62rem;
		line-height: 1.15;
		text-align: center;
		--symbol-stroke: var(--symbol);
	}

	.part:hover {
		background: var(--hover);
		border-color: var(--border);
		color: var(--text);
	}

	.part.active {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		color: var(--text);
		--symbol-stroke: var(--accent);
	}

	.part svg {
		width: 46px;
		height: 34px;
	}
</style>
