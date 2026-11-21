<script lang="ts" generics="Id extends string">
	import { Tabs } from '@human-kit/ui';
	import type { Snippet } from 'svelte';

	/**
	 * A strip of tabs over the one panel they switch, underlined in the accent
	 * colour where it is. The arrow keys walk the strip and Home and End go to
	 * its ends. Only the chosen panel is mounted.
	 */
	type Props = {
		items: ReadonlyArray<{ id: Id; label: string }>;
		value: Id;
		onChange: (id: Id) => void;
		'aria-label': string;
		/** The panel of the chosen tab. */
		panel: Snippet<[Id]>;
		class?: string;
	};

	let { items, value, onChange, panel, class: className = '', ...rest }: Props = $props();
</script>

<Tabs.Root
	{value}
	controlledValue
	onChange={(next) => {
		if (typeof next === 'string' && next !== value) onChange(next as Id);
	}}
	class="flex min-h-0 min-w-0 flex-col {className}"
>
	<Tabs.List aria-label={rest['aria-label']} class="flex shrink-0 gap-1 border-b border-border px-2 pt-2">
		{#each items as { id, label } (id)}
			<Tabs.Tab
				value={id}
				class="-mb-px cursor-pointer border-0 border-b-2 border-transparent bg-transparent px-2 pb-1.5 text-ui text-muted hover:text-fg data-[selected]:border-accent data-[selected]:text-fg"
			>
				{label}
			</Tabs.Tab>
		{/each}
	</Tabs.List>
	{#each items as { id } (id)}
		<!-- Not a tab stop of its own: what is in it is. -->
		<Tabs.Panel value={id} tabindex={-1} class="min-h-0 flex-1 outline-none">
			{@render panel(id)}
		</Tabs.Panel>
	{/each}
</Tabs.Root>
