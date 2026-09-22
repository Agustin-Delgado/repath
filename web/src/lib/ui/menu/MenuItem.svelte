<script lang="ts">
	import { Menu } from '@human-kit/ui';
	import type { ComponentProps, Snippet } from 'svelte';
	import { floatingItem } from '../surface';

	type Props = Omit<ComponentProps<typeof Menu.Item>, 'class' | 'children'> & {
		/** A key hint, drawn dim at the end of the row. */
		shortcut?: string;
		class?: string;
		children: Snippet;
	};

	let { shortcut, class: className = '', children, ...rest }: Props = $props();
</script>

<Menu.Item class="{floatingItem} {className}" {...rest}>
	<span class="flex flex-1 items-center gap-2">{@render children()}</span>
	{#if shortcut}<kbd class="font-mono text-2xs text-muted">{shortcut}</kbd>{/if}
</Menu.Item>
