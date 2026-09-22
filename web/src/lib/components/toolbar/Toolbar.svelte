<script lang="ts">
	import { Search } from '@lucide/svelte';
	import { Button, ToolbarSeparator } from '$lib/ui';
	import AnalysisControls from './AnalysisControls.svelte';
	import DocumentControls from './DocumentControls.svelte';
	import RunButton from './RunButton.svelte';

	type Props = {
		/** The engine's version, once it has loaded. */
		version: string;
		share: () => Promise<void>;
		/** Open the command palette. */
		onFind: () => void;
	};

	let { version, share, onFind }: Props = $props();
</script>

<!--
	Two halves: what the simulation does on the left, next to Run, and what
	happens to the document on the right. On a phone the row scrolls sideways
	rather than wrapping into a wall of controls.
-->
<header
	class="flex items-center gap-4 border-b border-border bg-panel px-3 py-1.5 max-[900px]:gap-2 max-[900px]:px-2.5"
>
	<div class="flex shrink-0 items-baseline gap-2">
		<strong class="text-base tracking-tight">repath</strong>
		<!-- The tagline yields before the controls do. -->
		<span class="text-[0.72rem] whitespace-nowrap text-muted max-[1500px]:hidden">
			mixed-signal circuit simulator
		</span>
	</div>

	<div
		class="relative flex min-w-0 flex-1 items-center gap-1.5 [scrollbar-width:none] max-[900px]:overflow-x-auto max-[900px]:p-0.5"
	>
		<RunButton />
		<AnalysisControls />

		<span class="flex-1"></span>
		<!-- Where everything else is: every part, every command, by name. -->
		<Button
			class="w-44 justify-start text-muted max-[1200px]:w-auto"
			onclick={onFind}
			title="Find a part or a command (Ctrl+K)"
		>
			<Search />
			<span class="max-[1200px]:hidden">Find anything…</span>
			<kbd class="ml-auto font-mono text-[0.6rem] max-[1200px]:hidden">Ctrl K</kbd>
		</Button>
		<ToolbarSeparator />

		<DocumentControls {share} />
	</div>

	{#if version}
		<span class="shrink-0 font-mono text-2xs text-muted max-[900px]:hidden" title="Engine version">
			engine {version}
		</span>
	{/if}
</header>
