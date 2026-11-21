<script lang="ts">
	import {
		Ellipsis,
		Eraser,
		FileDown,
		FolderOpen,
		ListOrdered,
		Redo2,
		Search,
		Share2,
		Undo2
	} from '@lucide/svelte';
	import { Button, Menu, MenuGroup, MenuItem, MenuSeparator, ToolbarSeparator } from '$lib/ui';
	import { overflowHint } from '$lib/ui/overflow';
	import { SYMBOL_STANDARDS } from '$lib/schematic/symbols';
	import { clearAndReport, copyStepsAndReport, openFromFile, saveToFile, shareAndReport } from '$lib/document';
	import { app } from '$lib/state.svelte';
	import AnalysisControls from './AnalysisControls.svelte';
	import DocumentControls from './DocumentControls.svelte';

	type Props = {
		share: () => Promise<string>;
		/** Open the command palette. */
		onFind: () => void;
	};

	let { share, onFind }: Props = $props();
</script>

<!--
	Two halves: what the simulation is set up to do on the left, and what
	happens to the document on the right. Run itself is under the drawing, with
	the rest of the transport.

	On a narrow screen the simulation settings scroll sideways, faded at the
	edge that has more, and the document's controls fold into one menu that
	never scrolls away. Scrolling the whole row hid File and Share off the right
	edge at 768 px, with nothing to say they were there.
-->
<header
	class="flex items-center gap-4 border-b border-border bg-panel px-3 py-1.5 max-[900px]:gap-2 max-[900px]:px-2.5"
>
	<strong class="shrink-0 text-base tracking-tight">repath</strong>

	<div
		use:overflowHint
		class="scroll-row relative flex min-w-0 flex-1 items-center gap-1.5 max-[900px]:p-0.5"
	>
		<AnalysisControls />

		<span class="flex-1"></span>
		<!-- Where everything else is: every part, every command, by name. -->
		<Button
			class="w-44 justify-start text-muted max-[1200px]:w-auto max-[900px]:hidden"
			onclick={onFind}
			title="Find a part or a command (Ctrl+K)"
		>
			<Search />
			<span class="max-[1200px]:hidden">Find anything…</span>
			<kbd class="ml-auto font-mono text-3xs max-[1200px]:hidden">Ctrl K</kbd>
		</Button>
		<span class="contents max-[900px]:hidden"><ToolbarSeparator /></span>

		<div class="contents max-[900px]:hidden">
			<DocumentControls {share} />
		</div>
	</div>

	<div class="hidden shrink-0 items-center gap-1 max-[900px]:flex">
		<Button variant="ghost" size="icon" onclick={onFind} title="Find a part or a command" aria-label="Find a part or a command">
			<Search />
		</Button>
		{#snippet more()}<Ellipsis />{/snippet}
		<Menu label={more} bare size="icon" variant="ghost" aria-label="File, share and edit" title="File, share and edit">
			<MenuItem onAction={() => shareAndReport(app, share)}><Share2 /> Copy a link to this circuit</MenuItem>
			<MenuItem onAction={() => saveToFile(app)}><FileDown /> Save to a file</MenuItem>
			<MenuItem onAction={() => openFromFile(app)}><FolderOpen /> Open a file…</MenuItem>
			<MenuItem onAction={() => copyStepsAndReport(app)}><ListOrdered /> Copy the steps taken</MenuItem>
			<MenuSeparator />
			<MenuItem onAction={() => app.undo()}><Undo2 /> Undo</MenuItem>
			<MenuItem onAction={() => app.redo()}><Redo2 /> Redo</MenuItem>
			<MenuItem
				disabled={app.schematic.instances.length === 0 && app.schematic.wires.length === 0}
				onAction={() => clearAndReport(app)}
			>
				<Eraser /> Clear the drawing
			</MenuItem>
			<MenuSeparator />
			<MenuGroup label="Symbols">
				{#each SYMBOL_STANDARDS as standard (standard.value)}
					<MenuItem onAction={() => app.setSymbolStandard(standard.value)}>
						<span class="w-3 text-accent">{app.symbolStandard === standard.value ? '✓' : ''}</span>
						{standard.label}
					</MenuItem>
				{/each}
			</MenuGroup>
		</Menu>
	</div>
</header>
