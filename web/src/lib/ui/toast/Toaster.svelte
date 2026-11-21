<script lang="ts">
	import { Check } from '@lucide/svelte';
	import { Toast } from '@human-kit/ui';
	import { toastManager } from './toasts.svelte';
</script>

<!--
	The library's toast, dressed as the one it replaced: a chip at the top
	centre of the drawing, just under the header, that drops in and fades out.
	At the bottom it sat on the scope's time axis and hid the labels there. The one leaving and the one arriving
	sit in the same place, since a second replaces the first. Hovering holds it, Escape or a swipe
	dismisses it, and a screen reader hears it from the library's live region.
-->
<Toast.Provider manager={toastManager} timeout={2400} limit={1}>
	<Toast.Viewport
		class="pointer-events-none fixed inset-x-0 top-14 z-[60] flex justify-center outline-none"
	>
		{#snippet children(toast)}
			<Toast.Root
				{toast}
				class="pointer-events-auto absolute top-0 flex items-center gap-2 rounded-lg whitespace-nowrap border border-border bg-raised px-3 py-1.5 text-ui text-fg shadow-popover outline-none
					[translate:var(--toast-swipe-movement-x)_var(--toast-swipe-movement-y)]
					transition-[opacity,translate] duration-(--duration-base) ease-out
					focus-visible:focus-ring
					data-[entering]:[translate:0_-8px] data-[entering]:opacity-0
					data-[exiting]:[translate:0_-8px] data-[exiting]:opacity-0
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
