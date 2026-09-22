<script lang="ts">
	import { Check } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { toasts } from './toasts.svelte';
</script>

<div
	class="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
	role="status"
	aria-live="polite"
>
	{#each toasts.list as toast (toast.id)}
		<div
			transition:fly={{ y: 8, duration: 140 }}
			class="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-1.5 text-ui text-fg shadow-xl shadow-black/40"
		>
			<Check class="size-3.5 text-accent" />
			{toast.text}
		</div>
	{/each}
</div>
