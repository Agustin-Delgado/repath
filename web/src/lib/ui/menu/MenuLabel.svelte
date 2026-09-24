<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wider text-muted uppercase">
	{@render children()}
</div>
