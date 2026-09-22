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
						? `Put ${port.name} on the right, as an output`
						: `Put ${port.name} on the left, as an input`}
					aria-label={port.side === 'left'
						? `Put ${port.name} on the right`
						: `Put ${port.name} on the left`}
					onclick={() =>
						app.setPortSide(boxed.block.id, port.name, port.side === 'left' ? 'right' : 'left')}
				>
					<ArrowLeftRight />
				</Button>
			</div>
		{/each}
	</div>

	<p class={hint}>
		{inside} components inside.
		{#if copies > 1}
			This is one of {copies} copies of the block: rename it or edit it inside and every copy
			follows. To change just this one, make it its own block first.
		{:else}
			Edit them in there — every copy follows, and a port added or removed is a pin on the box — or
			open the box up here into its parts. The block stays in the palette either way.
		{/if}
	</p>

	<div class="flex flex-wrap gap-1.5">
		<Button onclick={() => app.enterBlock(boxed.block.id)}>Edit inside</Button>
		<Button onclick={() => app.unboxSelection()}>
			Open up <kbd class="font-mono text-[0.6rem] text-muted">U</kbd>
		</Button>
		{#if copies > 1}
			<Button
				title="Copy the block for this box alone, so it can be renamed and edited without the other copies following"
				onclick={() => app.detachBlock(boxed.instance.id)}
			>
				Make its own block
			</Button>
		{/if}
	</div>
</section>
