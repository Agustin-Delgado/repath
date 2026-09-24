<script lang="ts">
	import { Check } from '@lucide/svelte';
	import { Toast } from '@human-kit/ui';
	import { toastManager } from './toasts.svelte';
</script>

<!--
	The library's toast, dressed as the one it replaced: a chip at the bottom
	centre that rises in and fades out. The one leaving and the one arriving
	sit in the same place, since a second replaces the first. Hovering holds it, Escape or a swipe
	dismisses it, and a screen reader hears it from the library's live region.
-->
<Toast.Provider manager={toastManager} timeout={2400} limit={1}>
	<Toast.Viewport
		class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex justify-center outline-none"
	>
		{#snippet children(toast)}
			<Toast.Root
				{toast}
				class="pointer-events-auto absolute bottom-0 flex items-center gap-2 rounded-md whitespace-nowrap border border-border bg-panel px-3 py-1.5 text-ui text-fg shadow-xl shadow-black/40 outline-none
					[translate:var(--toast-swipe-movement-x)_var(--toast-swipe-movement-y)]
					transition-[opacity,translate] duration-150 ease-out
					focus-visible:ring-2 focus-visible:ring-accent/60
					data-[entering]:[translate:0_8px] data-[entering]:opacity-0
					data-[exiting]:[translate:0_8px] data-[exiting]:opacity-0
					data-[swiping]:transition-none"
			>
				<Check class="size-3.5 text-accent" />
				<Toast.Content>
					<Toast.Title />
				</Toast.Content>
			</Toast.Root>
		{/snippet}
	</Toast.Viewport>
</Toast.Provider>
