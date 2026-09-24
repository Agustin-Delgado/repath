<script lang="ts">
	import { Menu } from '@human-kit/ui';
	import { ChevronDown } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { buttonVariants, type ButtonVariants } from '../button/recipe';
	import { floatingSurface } from '../surface';

	/** A button that opens a list of actions. Fill it with `MenuItem`s. */
	type Props = {
		/** What the trigger says: text, or a snippet for an icon and text. */
		label: Snippet | string;
		title?: string;
		variant?: ButtonVariants['variant'];
		size?: ButtonVariants['size'];
		class?: string;
		/** Hide the chevron, for a trigger that is only an icon. */
		bare?: boolean;
		'aria-label'?: string;
		children: Snippet;
	};

	let {
		label,
		title,
		variant,
		size,
		class: className,
		bare = false,
		children,
		...rest
	}: Props = $props();
</script>

<Menu.Root>
	<Menu.Trigger
		{title}
		aria-label={rest['aria-label']}
		class={buttonVariants({ variant, size, class: ['gap-1', className] })}
	>
		{#if typeof label === 'string'}{label}{:else}{@render label()}{/if}
		{#if !bare}<ChevronDown class="text-muted" />{/if}
	</Menu.Trigger>
	<Menu.Content
		placement="bottom-end"
		offset={4}
		class="{floatingSurface} flex max-h-96 flex-col overflow-y-auto"
	>
		{@render children()}
	</Menu.Content>
</Menu.Root>
