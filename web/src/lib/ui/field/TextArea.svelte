<script lang="ts">
	import { TextArea } from '@human-kit/ui';
	import type { ComponentProps } from 'svelte';

	/** Text over several lines: a program, a memory image, a SPICE card. */
	type Props = ComponentProps<typeof TextArea>;

	let { value = $bindable(), element = $bindable(null), ...rest }: Props = $props();
</script>

<TextArea bind:value bind:element {...rest} />
