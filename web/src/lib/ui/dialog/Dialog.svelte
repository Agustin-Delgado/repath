<script lang="ts">
	import { Dialog } from '@human-kit/ui';
	import { untrack, type Snippet } from 'svelte';

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

	/**
	 * Where the focus was when it opened. The library hands the focus back to
	 * its trigger, and a dialog opened by a shortcut has none, so without this
	 * Escape left the focus on the page's body.
	 */
	let returnTo = $state<HTMLElement | null>(null);
	$effect.pre(() => {
		if (!open) return;
		untrack(() => {
			const focused = document.activeElement;
			returnTo = focused instanceof HTMLElement && focused !== document.body ? focused : null;
		});
	});
</script>

<Dialog.Root bind:open triggerRef={returnTo}>
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
