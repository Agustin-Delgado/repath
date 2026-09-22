<script lang="ts">
	import { ToolbarSeparator } from '$lib/ui';
	import AnalysisControls from './AnalysisControls.svelte';
	import DocumentControls from './DocumentControls.svelte';
	import RunButton from './RunButton.svelte';

	type Props = {
		/** The engine's version, once it has loaded. */
		version: string;
		share: () => Promise<void>;
	};

	let { version, share }: Props = $props();
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
		<ToolbarSeparator />

		<DocumentControls {share} />
	</div>

	{#if version}
		<span class="shrink-0 font-mono text-2xs text-muted max-[900px]:hidden" title="Engine version">
			engine {version}
		</span>
	{/if}
</header>
