<script lang="ts">
	import { Dialog } from '@human-kit/ui';
	import type { Snippet } from 'svelte';

	/**
	 * A modal panel over a dimmed app. Escape and a press outside close it,
	 * the focus stays inside while it is open, and it goes back where it came
	 * from when it closes.
	 */
	type Props = {
		open: boolean;
		/** Its accessible name. Read out, not shown: the panel says it already. */
		title: string;
		/** On the panel, for its size and place. */
		class?: string;
		children: Snippet;
	};

	let { open = $bindable(false), title, class: className = '', children }: Props = $props();
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-50 bg-black/45" />
		<Dialog.Content
			class="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-panel text-fg shadow-2xl shadow-black/60 outline-none {className}"
		>
			<Dialog.Title class="sr-only">{title}</Dialog.Title>
			{@render children()}
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
