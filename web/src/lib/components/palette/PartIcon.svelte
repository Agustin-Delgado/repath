<script lang="ts">
	import { symbolExtent } from '$lib/schematic/symbols';
	import { app } from '$lib/state.svelte';
	import Symbol from '../Symbol.svelte';

	type Props = { kind: string; class?: string };

	let { kind, class: className = '' }: Props = $props();

	/**
	 * The frame follows the symbol rather than the other way round: a chip is
	 * taller than it is wide, and the wide slot the rest of the catalogue uses
	 * cut its body off at both edges.
	 */
	const reach = $derived.by(() => {
		void app.symbolStandard;
		return symbolExtent(kind);
	});
</script>

<svg
	viewBox="{-reach.x} {-reach.y} {reach.x * 2} {reach.y * 2}"
	class="shrink-0 {className}"
	aria-hidden="true"
>
	<Symbol {kind} />
</svg>
