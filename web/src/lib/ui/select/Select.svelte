<script lang="ts" generics="T extends { value: string; label: string; description?: string }">
	import { Select } from '@human-kit/ui';
	import { Check, ChevronDown } from '@lucide/svelte';
	import { buttonVariants, type ButtonVariants } from '../button/recipe';
	import { floatingItem, floatingSurface } from '../surface';

	/**
	 * One value out of a short list. For choosing a thing to *do* rather than a
	 * value to hold, use a `Menu`: a select always shows what is chosen, and an
	 * action has nothing to show once it is done.
	 */
	type Props = {
		items: readonly T[];
		value: string;
		onChange: (value: string) => void;
		'aria-label': string;
		title?: string;
		size?: ButtonVariants['size'];
		class?: string;
	};

	let { items, value, onChange, title, size, class: className, ...rest }: Props = $props();
</script>

<Select.Root
	items={[...items]}
	{value}
	controlledValue
	onChange={(next) => {
		if (typeof next === 'string' && next !== value) onChange(next);
	}}
	aria-label={rest['aria-label']}
	class="relative inline-flex shrink-0"
>
	<Select.Trigger {title} class={buttonVariants({ size, class: ['gap-1', className] })}>
		<Select.Value />
		<ChevronDown class="text-muted" />
	</Select.Trigger>
	<Select.Popover placement="bottom-start" offset={4} class={floatingSurface}>
		<Select.List class="flex max-h-80 flex-col overflow-y-auto">
			{#each items as item (item.value)}
				<Select.Item
					id={item.value}
					textValue={item.label}
					title={item.description}
					class={floatingItem}
				>
					<span class="flex-1">{item.label}</span>
					<Select.ItemIndicator><Check class="text-accent" /></Select.ItemIndicator>
				</Select.Item>
			{/each}
		</Select.List>
	</Select.Popover>
</Select.Root>
