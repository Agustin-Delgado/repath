<script lang="ts">
	import { Boxes, Group, Ungroup } from '@lucide/svelte';
	import { Button } from '$lib/ui';
	import { app } from '$lib/state.svelte';
	import CircuitIssues from './CircuitIssues.svelte';
	import NameField from './NameField.svelte';
	import PartPanel from './PartPanel.svelte';
	import { hint, sectionTitle } from './styles';

	/**
	 * The right-hand panel: whatever is selected, and what is wrong with the
	 * circuit whatever is selected.
	 *
	 * Each kind of selection has its own panel, so this file only decides which.
	 */
	const instance = $derived(app.selectedInstances.length === 1 ? app.selectedInstances[0] : null);
	const count = $derived(app.selectedInstances.length);
	const parts = $derived(app.schematic.instances.filter((i) => i.kind !== 'port').length);
	const wires = $derived(app.schematic.wires.length);

	const kbd = 'rounded border border-border px-1 font-mono text-[0.6rem] text-strong';
</script>

<div class="flex h-full min-h-0 w-full min-w-0 flex-col gap-3 overflow-y-auto p-3">
	{#if app.selectedGroup && !instance}
		<!--
			A group is a name over its parts, and the name is the one thing about it
			to edit here. Everything else — moving, turning, removing — is done to
			the parts, which are what is selected.
		-->
		<NameField
			label="Group"
			value={app.selectedGroup.name}
			commit={(raw) => (app.selectedGroup ? app.renameGroup(app.selectedGroup.id, raw) : null)}
			aria-label="Group name"
		/>
		<p class={hint}>
			{app.selectedGroup.members.length} components. Drag the name to move them together, or a part out
			of the frame to take it out of the group.
		</p>
		<div class="flex gap-1.5">
			<Button class="flex-1" onclick={() => app.ungroupSelection()}>
				<Ungroup /> Ungroup <kbd class="font-mono text-[0.6rem] text-muted">U</kbd>
			</Button>
			<Button class="flex-1" onclick={() => app.boxSelection()}>
				<Boxes /> Box up <kbd class="font-mono text-[0.6rem] text-muted">B</kbd>
			</Button>
		</div>
	{:else if instance}
		{#key instance.id}
			<PartPanel {instance} />
		{/key}
	{:else if count > 1}
		<h3 class={sectionTitle}>{count} components selected</h3>
		<div class="flex gap-1.5">
			<Button class="flex-1" onclick={() => app.groupSelection()}>
				<Group /> Group <kbd class="font-mono text-[0.6rem] text-muted">G</kbd>
			</Button>
			<Button class="flex-1" onclick={() => app.boxSelection()}>
				<Boxes /> Box up <kbd class="font-mono text-[0.6rem] text-muted">B</kbd>
			</Button>
		</div>
		<!-- Keys are no help on a touch screen; the phone bar has Rotate and Delete. -->
		<p class="{hint} [@media(pointer:coarse)]:hidden">
			<kbd class={kbd}>R</kbd> rotates them together, <kbd class={kbd}>Del</kbd> removes them, and
			<kbd class={kbd}>Ctrl</kbd>+<kbd class={kbd}>D</kbd> makes a copy.
		</p>
	{:else}
		<!--
			Nothing selected is the state the app opens in, so it says what the
			drawing holds and how to get going, rather than only what to click.
		-->
		<section class="flex flex-col gap-2">
			<h3 class={sectionTitle}>{app.inside ? `Inside ${app.inside.name}` : 'This circuit'}</h3>
			<div class="grid grid-cols-2 gap-1.5">
				<div class="rounded-md border border-border bg-canvas px-2 py-1.5">
					<div class="font-mono text-base text-fg">{parts}</div>
					<div class="text-[0.64rem] text-muted">{parts === 1 ? 'part' : 'parts'}</div>
				</div>
				<div class="rounded-md border border-border bg-canvas px-2 py-1.5">
					<div class="font-mono text-base text-fg">{wires}</div>
					<div class="text-[0.64rem] text-muted">{wires === 1 ? 'wire' : 'wires'}</div>
				</div>
			</div>
			<p class={hint}>Select a part to edit its values.</p>
		</section>

		<!-- Keys are no help on a touch screen. -->
		<section class="flex flex-col gap-1.5 [@media(pointer:coarse)]:hidden">
			<h3 class={sectionTitle}>Getting around</h3>
			<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] text-muted">
				<li><kbd class={kbd}>/</kbd> find a part</li>
				<li><kbd class={kbd}>Ctrl</kbd>+<kbd class={kbd}>K</kbd> find any part or command</li>
				<li>Drag from a pin to draw a wire</li>
				<li><kbd class={kbd}>R</kbd> rotate · <kbd class={kbd}>Shift</kbd>-click keeps placing</li>
				<li><kbd class={kbd}>Space</kbd> run or pause · <kbd class={kbd}>F</kbd> fit on screen</li>
			</ul>
		</section>
	{/if}

	<CircuitIssues />
</div>
