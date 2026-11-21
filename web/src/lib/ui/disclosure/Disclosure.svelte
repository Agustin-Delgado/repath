<script lang="ts">
	import { Collapsible } from '@human-kit/ui';
	import type { Snippet } from 'svelte';

	/**
	 * A heading that folds what is under it: a shelf of parts, the settings
	 * most people never touch. The owner keeps the state — a folded shelf is
	 * remembered per browser — so it is always given `open` and told of a
	 * change. Folded, the panel is not in the page at all.
	 */
	type Props = {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		/** What the heading says. */
		trigger: Snippet;
		triggerClass?: string;
		/** On the panel's own content, which is where a layout like a gap goes. */
		panelClass?: string;
		class?: string;
		children: Snippet;
	};

	let { open, onOpenChange, trigger, triggerClass, panelClass, class: className, children }: Props =
		$props();
</script>

<Collapsible.Root {open} controlledOpen {onOpenChange} class={className}>
	<Collapsible.Trigger class={triggerClass}>
		{@render trigger()}
	</Collapsible.Trigger>
	<Collapsible.Panel>
		<div class={panelClass}>{@render children()}</div>
	</Collapsible.Panel>
</Collapsible.Root>
