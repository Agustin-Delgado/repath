<script lang="ts">
	import { FileDown, FolderOpen, ListOrdered, Redo2, Share2, Undo2 } from '@lucide/svelte';
	import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, Select, ToolbarSeparator } from '$lib/ui';
	import { EXAMPLES, exampleDomain, type ExampleDomain } from '$lib/examples';
	import { SYMBOL_STANDARDS } from '$lib/schematic/symbols';
	import { copyStepsAndReport, openFromFile, saveToFile, shareAndReport } from '$lib/document';
	import { app } from '$lib/state.svelte';

	type Props = {
		/**
		 * Put the circuit in a link and copy it. The page does this rather than
		 * the toolbar, because the draft that is being autosaved has to learn
		 * that it now continues the link. Rejects when the clipboard refuses.
		 */
		share: () => Promise<void>;
	};

	let { share }: Props = $props();

	const SHELVES: ExampleDomain[] = ['Analog', 'Logic', 'Mixed signal'];
</script>

<Button variant="ghost" size="icon" onclick={() => app.undo()} title="Undo (Ctrl+Z)" aria-label="Undo">
	<Undo2 />
</Button>
<Button
	variant="ghost"
	size="icon"
	onclick={() => app.redo()}
	title="Redo (Ctrl+Shift+Z)"
	aria-label="Redo"
>
	<Redo2 />
</Button>

<ToolbarSeparator />

<!--
	How the symbols are drawn, which is the reader's habit rather than a
	property of the circuit: not shared, not saved with the drawing.
-->
<Select
	items={SYMBOL_STANDARDS}
	value={app.symbolStandard}
	onChange={(value) => app.setSymbolStandard(value)}
	aria-label="Symbol standard"
	title="How the parts are drawn: zigzag or box resistors, shaped or boxed gates"
/>

<!--
	A menu of things to open, not a select: nothing in it is "the current
	example" once the drawing has been touched, and loading one replaces the
	drawing, which is an action rather than a setting.
-->
<Menu label="Examples" title="Open a circuit that shows something off">
	{#each SHELVES as shelf, i (shelf)}
		{#if i > 0}<MenuSeparator />{/if}
		<MenuLabel>{shelf}</MenuLabel>
		{#each EXAMPLES.filter((example) => exampleDomain(example) === shelf) as example (example.id)}
			<MenuItem
				textValue={example.name}
				title={example.description}
				onAction={() => {
					app.loadExample(example.id);
					app.run();
				}}
			>
				{example.name}
			</MenuItem>
		{/each}
	{/each}
</Menu>

<Menu label="File" title="Save, open, or hand over this circuit">
	<MenuItem onAction={() => saveToFile(app)} shortcut="Ctrl+S"><FileDown /> Save to a file</MenuItem>
	<MenuItem onAction={() => openFromFile(app)} shortcut="Ctrl+O"><FolderOpen /> Open a file…</MenuItem>
	<MenuSeparator />
	<MenuItem
		onAction={() => copyStepsAndReport(app)}
		title="Copy every step taken here, as text, so it can be replayed"
	>
		<ListOrdered /> Copy the steps taken
	</MenuItem>
</Menu>

<Button onclick={() => shareAndReport(share)} title="Copy a link that contains this circuit">
	<Share2 /> Share
</Button>
