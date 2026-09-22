<script lang="ts">
	import { Button } from '$lib/ui';
	import { app } from '$lib/state.svelte';

	/** Where a freshly imported part goes: straight into the hand, when there is one. */
	type Props = { onImported: (ids: string[]) => void };

	let { onImported }: Props = $props();

	let source = $state('');
	let outcome = $state<string | null>(null);

	function run() {
		const { ids, error } = app.importSubcircuits(source);
		if (error) {
			outcome = error;
			return;
		}
		outcome = null;
		source = '';
		onImported(ids);
	}
</script>

<div class="flex flex-col gap-1.5 px-0.5">
	<textarea
		rows="4"
		spellcheck="false"
		placeholder={'.SUBCKT OPAMP1 1 2 3\nRIN 1 2 2MEG\nE1 4 0 1 2 100K\n…\n.ENDS'}
		bind:value={source}
		aria-label="SPICE subcircuit"
		class="w-full resize-y rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-[0.64rem] leading-normal text-fg outline-none focus:border-accent/70"
	></textarea>
	{#if outcome}<p class="m-0 text-2xs text-danger" role="alert">{outcome}</p>{/if}
	<Button size="sm" class="self-start" onclick={run} disabled={!source.trim()}>Add part</Button>
</div>
