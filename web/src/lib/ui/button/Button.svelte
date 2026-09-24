<script lang="ts">
	import { Button } from '@human-kit/ui';
	import type { ComponentProps, Snippet } from 'svelte';
	import { buttonVariants, type ButtonVariants } from './recipe';

	type Props = Omit<ComponentProps<typeof Button.Root>, 'class' | 'children'> &
		ButtonVariants & {
			class?: string;
			children?: Snippet;
			element?: HTMLButtonElement | null;
		};

	let {
		variant,
		size,
		active,
		class: className,
		children,
		element = $bindable(null),
		...rest
	}: Props = $props();
</script>

<Button.Root
	bind:element
	class={buttonVariants({ variant, size, active, class: className })}
	{...rest}
>
	{@render children?.()}
</Button.Root>
