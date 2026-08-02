<script lang="ts">
	import { app } from '$lib/state.svelte';
	import { CATALOG, type Group } from '$lib/schematic/model';
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
</script>

<div class="palette">
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
</div>

<style>
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
