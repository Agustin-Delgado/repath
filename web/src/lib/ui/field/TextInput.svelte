<script lang="ts">
	import { Input } from '@human-kit/ui';
	import type { ComponentProps } from 'svelte';

	/**
	 * A one-line text box. The look stays with the caller, because the boxes
	 * in the app are dressed by what holds them: a field's frame in the
	 * inspector, a chip in the toolbar, a label sitting on the drawing.
	 */
	type Props = ComponentProps<typeof Input>;

	let { value = $bindable(), element = $bindable(null), ...rest }: Props = $props();
</script>

<Input bind:value bind:element {...rest} />
