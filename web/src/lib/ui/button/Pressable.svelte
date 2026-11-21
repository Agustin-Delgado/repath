<script lang="ts">
	import { Button } from '@human-kit/ui';
	import type { ComponentProps, Snippet } from 'svelte';

	/**
	 * A button that brings no look of its own: a name in a list that selects
	 * the part, a row that plots a net, a tile on a shelf. It is still the
	 * library's button — the focus ring follows the keyboard, and it reports
	 * `data-hovered` and `data-pressed` — but how it looks is up to the caller.
	 * Anything that should look like a button is a `Button`.
	 */
	type Props = Omit<ComponentProps<typeof Button.Root>, 'children'> & {
		children?: Snippet;
		element?: HTMLButtonElement | null;
	};

	let { children, element = $bindable(null), ...rest }: Props = $props();
</script>

<Button.Root bind:element {...rest}>
	{@render children?.()}
</Button.Root>
