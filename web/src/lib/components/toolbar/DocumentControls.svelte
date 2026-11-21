<script lang="ts">
	import { Eraser, FileDown, FolderOpen, ListOrdered, Redo2, Share2, Undo2 } from '@lucide/svelte';
	import { Button, Menu, MenuItem, MenuSeparator, Select, ToolbarSeparator } from '$lib/ui';
	import { SYMBOL_STANDARDS } from '$lib/schematic/symbols';
	import { clearAndReport, copyStepsAndReport, openFromFile, saveToFile, shareAndReport } from '$lib/document';
	import { app } from '$lib/state.svelte';

	type Props = {
		/**
		 * Put the circuit in a link and resolve to it. The page does this rather
		 * than the toolbar, because the draft that is being autosaved has to
		 * learn that it now continues the link.
		 */
		share: () => Promise<string>;
	};

	let { share }: Props = $props();

	const empty = $derived(app.schematic.instances.length === 0 && app.schematic.wires.length === 0);
</script>

<Button
	variant="ghost"
	size="icon"
	disabled={!app.canUndo}
	onclick={() => app.undo()}
	title="Undo (Ctrl+Z)"
	aria-label="Undo"
>
	<Undo2 />
</Button>
<Button
	variant="ghost"
	size="icon"
	disabled={!app.canRedo}
	onclick={() => app.redo()}
	title="Redo (Ctrl+Shift+Z)"
	aria-label="Redo"
>
	<Redo2 />
</Button>
<!-- No confirmation: it is one undo away, and the toast says so. -->
<Button
	variant="ghost"
	size="icon"
	disabled={empty}
	onclick={() => clearAndReport(app)}
	title="Clear circuit"
	aria-label="Clear circuit"
>
	<Eraser />
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
/>

<Menu label="File">
	<MenuItem onAction={() => saveToFile(app)} shortcut="Ctrl+S"><FileDown /> Save to file</MenuItem>
	<MenuItem onAction={() => openFromFile(app)} shortcut="Ctrl+O"><FolderOpen /> Open file…</MenuItem>
	<MenuSeparator />
	<MenuItem
		onAction={() => copyStepsAndReport(app)}
		title="Copy the edit steps as text, for replay"
	>
		<ListOrdered /> Copy edit steps
	</MenuItem>
</Menu>

<Button onclick={() => shareAndReport(app, share)} title="Copy a link that contains the circuit">
	<Share2 /> Share
</Button>
