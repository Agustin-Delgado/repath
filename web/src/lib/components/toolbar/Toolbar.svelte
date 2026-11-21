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
	class="flex items-center gap-4 border-b border-border bg-panel px-3 py-1.5 narrow:gap-2 narrow:px-2.5"
>
	<!--
		The mark from brand/mark/repath-mark.svg, drawn with the small cut's
		stroke (10.5 for 7): at this size the full weight thins to a hairline.
		Sized and set as in the logo: 1.16 times as tall as the h, standing on
		the baseline, which the box's margin under the stroke would lift. Its
		two colours are the brand's Signal blue and Settled green, which are the
		accent and the overlay's volts ink.
	-->
	<strong class="flex shrink-0 items-baseline text-md font-semibold tracking-[-0.035em]">
		<svg class="size-[0.95em] translate-y-[0.065em]" viewBox="24 16 96 96" aria-hidden="true">
			<defs>
				<linearGradient id="toolbar-signal" x1="40" x2="104" gradientUnits="userSpaceOnUse">
					<stop offset=".25" style:stop-color="var(--accent)" />
					<stop offset="1" style:stop-color="var(--overlay-volts)" />
				</linearGradient>
			</defs>
			<path
				d="M36 102V66c0-26 6-40 14-40s9 30 17 30 8-18 15-18 7 9 14 9 5-4 12-4"
				fill="none"
				stroke="url(#toolbar-signal)"
				stroke-width="10.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
		repath
	</strong>

	<div
		use:overflowHint
		class="scroll-row relative flex min-w-0 flex-1 items-center gap-1.5 narrow:p-0.5"
	>
		<AnalysisControls />

		<span class="flex-1"></span>
		<!-- Where everything else is: every part, every command, by name. -->
		<Button
			class="w-52 justify-start font-normal text-muted max-[1200px]:w-auto narrow:hidden"
			onclick={onFind}
			title="Find part or command (Ctrl+K)"
		>
			<Search />
			<span class="max-[1200px]:hidden">Find…</span>
			<kbd class="ml-auto font-mono text-3xs max-[1200px]:hidden">Ctrl K</kbd>
		</Button>
		<span class="contents narrow:hidden"><ToolbarSeparator /></span>

		<div class="contents narrow:hidden">
			<DocumentControls {share} />
		</div>
	</div>

	<div class="hidden shrink-0 items-center gap-1 narrow:flex">
		<Button variant="ghost" size="icon" onclick={onFind} title="Find part or command" aria-label="Find part or command">
			<Search />
		</Button>
		{#snippet more()}<Ellipsis />{/snippet}
		<Menu label={more} bare size="icon" variant="ghost" aria-label="File, share and edit" title="File, share and edit">
			<MenuItem onAction={() => shareAndReport(app, share)}><Share2 /> Copy link</MenuItem>
			<MenuItem onAction={() => saveToFile(app)}><FileDown /> Save to file</MenuItem>
			<MenuItem onAction={() => openFromFile(app)}><FolderOpen /> Open file…</MenuItem>
			<MenuItem onAction={() => copyStepsAndReport(app)}><ListOrdered /> Copy edit steps</MenuItem>
			<MenuSeparator />
			<MenuItem onAction={() => app.undo()}><Undo2 /> Undo</MenuItem>
			<MenuItem onAction={() => app.redo()}><Redo2 /> Redo</MenuItem>
			<MenuItem
				disabled={app.schematic.instances.length === 0 && app.schematic.wires.length === 0}
				onAction={() => clearAndReport(app)}
			>
				<Eraser /> Clear circuit
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
