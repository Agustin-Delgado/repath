<script lang="ts">
	import { ArrowDown, ArrowLeftRight, ArrowUp } from '@lucide/svelte';
	import { Button } from '$lib/ui';
	import { blockPorts } from '$lib/schematic/blocks';
	import type { BlockDef, Instance } from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import NameField from './NameField.svelte';
	import { hint, sectionTitle } from './styles';

	/**
	 * The box a block is drawn as: its name, and the name and place of each of
	 * its terminals. Every copy placed from the same definition changes with it.
	 */
	let { boxed }: { boxed: { instance: Instance; block: BlockDef } } = $props();

	const copies = $derived(app.copiesOf(boxed.block.id));
	const inside = $derived(boxed.block.instances.filter((i) => i.kind !== 'port').length);
</script>

<section class="flex flex-col gap-2.5 rounded-md border border-border bg-canvas/50 p-2">
	<NameField
		label="Block"
		value={boxed.block.name}
		commit={(raw) => app.renameBlock(boxed.block.id, raw)}
		aria-label="Block name"
	/>

	<h3 class={sectionTitle}>Ports</h3>
	<div class="flex flex-col gap-1.5">
		{#each blockPorts(boxed.block) as port (port.instance)}
			<div class="flex items-end gap-1">
				<div class="min-w-0 flex-1">
					<NameField
						label={port.side === 'left' ? 'in' : 'out'}
						value={port.name}
						commit={(raw) => app.renamePort(boxed.block.id, port.name, raw)}
						aria-label="Port {port.name}"
					/>
				</div>
				<!-- Where the pin goes on the box: a step along its column, or across. -->
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					title="Move {port.name} up"
					aria-label="Move {port.name} up"
					onclick={() => app.movePort(boxed.block.id, port.name, 'up')}
				>
					<ArrowUp />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					title="Move {port.name} down"
					aria-label="Move {port.name} down"
					onclick={() => app.movePort(boxed.block.id, port.name, 'down')}
				>
					<ArrowDown />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="size-7"
					title={port.side === 'left'
						? `Move ${port.name} to the right (output)`
						: `Move ${port.name} to the left (input)`}
					aria-label={port.side === 'left'
						? `Move ${port.name} to the right`
						: `Move ${port.name} to the left`}
					onclick={() =>
						app.setPortSide(boxed.block.id, port.name, port.side === 'left' ? 'right' : 'left')}
				>
					<ArrowLeftRight />
				</Button>
			</div>
		{/each}
	</div>

	<p class={hint}>
		{inside} parts inside.
		{#if copies > 1}
			One of {copies} copies. A change to the name or the inside changes every copy. To change only
			this copy, make it its own block.
		{:else}
			A change inside changes every copy. Each port is a pin on the box. The block stays in the
			palette after Open up.
		{/if}
	</p>

	<div class="flex flex-wrap gap-1.5">
		<Button onclick={() => app.enterBlock(boxed.block.id)}>Edit inside</Button>
		<Button onclick={() => app.unboxSelection()}>
			Open up <kbd class="font-mono text-3xs text-muted">U</kbd>
		</Button>
		{#if copies > 1}
			<Button
				title="Detach this copy from the other copies"
				onclick={() => app.detachBlock(boxed.instance.id)}
			>
				Make its own block
			</Button>
		{/if}
	</div>
</section>
