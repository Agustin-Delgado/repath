<script lang="ts">
	import { SearchField } from '@human-kit/ui';
	import { Search, X } from '@lucide/svelte';
	import type { ComponentProps, Snippet } from 'svelte';

	/**
	 * A box for narrowing a list down: the parts, the examples.
	 *
	 * Escape empties it, and a cross does the same once there is text. An
	 * Escape that had nothing to empty goes on to the caller's `onkeydown`
	 * with `defaultPrevented` unset, so the caller can let go of the focus
	 * then; one that emptied the box arrives prevented.
	 */
	type Props = Omit<ComponentProps<typeof SearchField.Input>, 'class'> & {
		value: string;
		/** Shown at the end while the box is empty: the key that gets here. */
		hint?: Snippet;
		class?: string;
	};

	let {
		value = $bindable(''),
		element = $bindable(null),
		hint,
		class: className = '',
		...rest
	}: Props = $props();
</script>

<!-- A label, so a press anywhere in the frame lands in the box. -->
<label
	class="flex h-7 items-center gap-1.5 rounded-control border border-border bg-control px-2 text-muted field {className}"
>
	<Search class="size-3.5 shrink-0" />
	<SearchField.Root bind:value class="contents">
		<SearchField.Input
			bind:element
			autocomplete="off"
			spellcheck="false"
			class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ui text-fg outline-none [&::-webkit-search-cancel-button]:hidden"
			{...rest}
		/>
		{#if value}
			<SearchField.Clear
				aria-label="Clear the search"
				class="flex cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-fg"
			>
				<X class="size-3.5" />
			</SearchField.Clear>
		{:else}
			{@render hint?.()}
		{/if}
	</SearchField.Root>
</label>
