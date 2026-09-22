<script lang="ts">
	import { Flame, TriangleAlert } from '@lucide/svelte';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';

	/**
	 * What is wrong with the circuit as a whole, whatever is selected: parts
	 * that burnt out during the run, and wiring that cannot be what was meant.
	 *
	 * Not "loose ends" any more: a part shorted by a wire drawn past it is the
	 * opposite problem, and belongs in the same list.
	 */
	const SHOWN = 6;
	const warnings = $derived(app.compiled.warnings);
	const burnouts = $derived(app.burnouts);
</script>

{#if burnouts.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-danger">
			<Flame class="size-3.5" /> Burnt out
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
			{#each burnouts as burnout (burnout.instanceId)}
				<li>
					<strong class="text-fg">{burnout.name}</strong> reached {formatWithUnit(burnout.peak, 'A')}
					against a {formatWithUnit(burnout.rated, 'A')} rating, and went at
					{formatWithUnit(burnout.time, 's')}.
				</li>
			{/each}
		</ul>
		<p class="m-0 text-[0.68rem] text-muted">
			{burnouts.length === 1 ? 'It is' : 'They are'} open from then on, and the rest of the run is the
			circuit without {burnouts.length === 1 ? 'it' : 'them'}. Add a series resistor to keep
			{burnouts.length === 1 ? 'it' : 'them'} alive.
		</p>
	</section>
{/if}

{#if warnings.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-selection/25 bg-selection/5 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-selection">
			<TriangleAlert class="size-3.5" /> Check the wiring
			<span class="ml-auto font-mono text-[0.62rem] font-normal opacity-70">{warnings.length}</span>
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
			{#each warnings.slice(0, SHOWN) as warning, i (i)}
				<li>{warning}</li>
			{/each}
			{#if warnings.length > SHOWN}
				<li class="text-muted">…and {warnings.length - SHOWN} more</li>
			{/if}
		</ul>
	</section>
{/if}
