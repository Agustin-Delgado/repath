<script lang="ts">
	import { Menu } from '@human-kit/ui';
	import type { Snippet } from 'svelte';

	/** Items of a menu under a small heading, which names them as a group. */
	let { label, children }: { label: string; children: Snippet } = $props();
</script>

<Menu.Group class="flex flex-col">
	<Menu.GroupLabel class="px-2 pt-1.5 pb-1 text-2xs font-medium tracking-wider text-muted uppercase">
		{label}
	</Menu.GroupLabel>
	{@render children()}
</Menu.Group>
