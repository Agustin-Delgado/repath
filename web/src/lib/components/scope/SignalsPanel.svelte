<script lang="ts">
	import { ArrowDown, ArrowUp, Minus, Plus, Search, X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { Button } from '$lib/ui';
	import { netLabel } from '$lib/schematic/nets';
	import { search } from '$lib/search';
	import { app } from '$lib/state.svelte';

	/**
	 * Which nets the scope plots, and the knobs on each.
	 *
	 * Plotted signals first, each with its knobs; everything else is found by
	 * name underneath. The list used to be every net in the circuit with a box
	 * beside it, which is a list nobody reads past a few dozen — and a real
	 * circuit has hundreds.
	 */
	type Props = {
		measuring: boolean;
		separate: boolean;
		/** How many analog traces are up, which is when a shared axis is a choice. */
		traceCount: number;
		/** The measurement rows, drawn by the scope that computes them. */
		measures?: Snippet;
		footer?: Snippet;
	};

	let {
		measuring = $bindable(),
		separate = $bindable(),
		traceCount,
		measures,
		footer
	}: Props = $props();

	interface Candidate {
		index: number;
		point: string;
		label: string;
		mixed: boolean;
		logic: boolean;
	}

	/** Every net worth plotting: named, and not ground. */
	const candidates = $derived.by((): Candidate[] => {
		const list: Candidate[] = [];
		for (const net of app.compiled.connectivity.nets) {
			const names = app.compiled.names.get(net.index);
			const signal = names?.analog ?? names?.digital;
			if (!signal || net.isGround) continue;
			const probe = app.activeProbes.find((p) => p.netIndex === net.index);
			list.push({
				index: net.index,
				point: net.points[0],
				label: probe?.label ?? netLabel(net, signal),
				mixed: !!(names?.analog && names?.digital),
				logic: !names?.analog && !!names?.digital
			});
		}
		return list;
	});

	const byIndex = $derived(new Map(candidates.map((c) => [c.index, c])));
	const probed = $derived(new Set(app.activeProbes.map((p) => p.netIndex)));
	const unplotted = $derived(candidates.filter((c) => !probed.has(c.index)));

	let query = $state('');
	/** Up to this many are listed without asking; past it, typing narrows them. */
	const SHOWN = 10;
	const found = $derived(
		search(unplotted, query, (c) => ({ label: c.label, keywords: c.logic ? ['logic'] : [] }))
	);
	const listed = $derived(query.trim() ? found.slice(0, 40) : found.slice(0, SHOWN));

	const chip =
		'rounded px-1 text-[0.58rem] font-medium leading-4 whitespace-nowrap';
</script>

{#snippet badge(c: Candidate)}
	{#if c.mixed}
		<span
			class="{chip} bg-[var(--badge-mixed)] text-[var(--badge-mixed-text)]"
			title="This net is bridged between the analog and digital domains">mixed</span
		>
	{:else if c.logic}
		<span class="{chip} bg-[var(--badge-logic)] text-[var(--badge-logic-text)]">logic</span>
	{/if}
{/snippet}

<aside class="flex h-full min-h-0 flex-col overflow-y-auto border-l border-border bg-panel text-[0.72rem]">
	<header class="flex items-center gap-1 px-2.5 pt-2 pb-1">
		<h3 class="m-0 mr-auto text-[0.62rem] font-semibold tracking-[0.08em] text-muted uppercase">
			Signals
		</h3>
		<Button
			size="sm"
			class="h-5 px-1.5 text-[0.62rem]"
			active={measuring}
			aria-pressed={measuring}
			onclick={() => (measuring = !measuring)}
			title="Read off frequency, period, duty, RMS, rise time and overshoot — logic lanes too"
		>
			measure
		</Button>
		{#if traceCount > 1}
			<Button
				size="sm"
				class="h-5 px-1.5 text-[0.62rem]"
				active={separate}
				aria-pressed={separate}
				onclick={() => (separate = !separate)}
				title={separate
					? 'One axis for everything'
					: 'Give each signal its own scale, so a small one is not flattened by a large one'}
			>
				{separate ? 'split' : 'shared'}
			</Button>
		{/if}
	</header>

	<!--
		Pointing at a name lights that net up on the schematic: a label can only
		say so much in the width of a sidebar, and the drawing says the rest.
	-->
	<ul class="m-0 flex list-none flex-col gap-0.5 px-1.5 py-0">
		{#each app.activeProbes as probe (probe.key)}
			{@const c = byIndex.get(probe.netIndex)}
			{@const knob = app.channels[probe.key] ?? { gain: 1, offset: 0 }}
			{@const turned = (probe.analog && knob.gain !== 1) || knob.offset !== 0}
			<li
				class="group rounded-md px-1 py-1 hover:bg-hover"
				onpointerenter={() => (app.hoverNet = probe.netIndex)}
				onpointerleave={() => (app.hoverNet = null)}
			>
				<div class="flex items-center gap-1.5">
					<span class="size-2.5 shrink-0 rounded-sm" style:background={probe.colour}></span>
					<span class="min-w-0 flex-1 truncate font-mono text-fg" title={probe.label}>{probe.label}</span>
					{#if c}{@render badge(c)}{/if}
					{#if c}
						<button
							type="button"
							class="flex cursor-pointer border-0 bg-transparent p-0 text-muted opacity-60 group-hover:opacity-100 hover:text-fg"
							title="Stop plotting {probe.label}"
							aria-label="Stop plotting {probe.label}"
							onclick={() => app.toggleProbe(c.point)}
						>
							<X class="size-3.5" />
						</button>
					{/if}
				</div>
				<!--
					The knobs. Automatic is the right default — nobody wants to set up a
					scope before seeing anything — but a scope you cannot turn is a
					picture of a scope. Gain only where there is an amplitude: a logic
					lane is two levels, and a knob that moves nothing on screen teaches
					you that the panel lies.
				-->
				<!-- Out of the way until wanted, unless they are turned: then they say so. -->
				<div
					class="mt-0.5 items-center gap-0.5 pl-4 text-muted group-focus-within:flex group-hover:flex [@media(pointer:coarse)]:flex {turned
						? 'flex'
						: 'hidden'}"
				>
					{#if probe.analog}
						<Button variant="ghost" size="icon" class="size-5" onclick={() => app.adjustGain(probe.key, -1)} title="Less gain" aria-label="Less gain">
							<Minus />
						</Button>
						<span class="min-w-6 text-center font-mono text-[0.62rem]">×{knob.gain}</span>
						<Button variant="ghost" size="icon" class="size-5" onclick={() => app.adjustGain(probe.key, 1)} title="More gain" aria-label="More gain">
							<Plus />
						</Button>
					{/if}
					<Button variant="ghost" size="icon" class="size-5" onclick={() => app.adjustOffset(probe.key, 1)} title="Move up" aria-label="Move up">
						<ArrowUp />
					</Button>
					<Button variant="ghost" size="icon" class="size-5" onclick={() => app.adjustOffset(probe.key, -1)} title="Move down" aria-label="Move down">
						<ArrowDown />
					</Button>
					{#if turned}
						<button
							type="button"
							class="ml-auto cursor-pointer border-0 bg-transparent p-0 font-mono text-[0.6rem] text-accent hover:underline"
							onclick={() => app.resetChannel(probe.key)}
							title="Back to automatic">auto</button
						>
					{/if}
				</div>
			</li>
		{:else}
			<li class="px-1 py-1 text-muted">Nothing plotted yet. Add a signal below.</li>
		{/each}
	</ul>

	{#if unplotted.length > 0}
		<section class="mt-2 flex flex-col gap-1 border-t border-border px-1.5 pt-2">
			<label
				class="mx-1 flex h-6 items-center gap-1.5 rounded-control border border-border bg-control px-1.5 text-muted focus-within:border-accent/70"
			>
				<Search class="size-3 shrink-0" />
				<input
					bind:value={query}
					placeholder="Add a signal…"
					aria-label="Find a net to plot"
					spellcheck="false"
					class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 font-mono text-[0.68rem] text-fg outline-none"
					onkeydown={(e) => {
						if (e.key === 'Enter' && listed[0]) {
							app.toggleProbe(listed[0].point);
							query = '';
						} else if (e.key === 'Escape') query = '';
					}}
				/>
			</label>
			<ul class="m-0 flex list-none flex-col p-0">
				{#each listed as c (c.index)}
					<li>
						<button
							type="button"
							class="flex w-full cursor-pointer items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-strong hover:bg-hover hover:text-fg"
							onpointerenter={() => (app.hoverNet = c.index)}
							onpointerleave={() => (app.hoverNet = null)}
							onclick={() => app.toggleProbe(c.point)}
							title="Plot {c.label}"
						>
							<Plus class="size-3 shrink-0 text-muted" />
							<span class="min-w-0 flex-1 truncate font-mono">{c.label}</span>
							{@render badge(c)}
						</button>
					</li>
				{:else}
					<li class="px-1 py-0.5 text-muted">No net called “{query.trim()}”.</li>
				{/each}
			</ul>
			{#if found.length > listed.length}
				<p class="m-0 px-1 text-[0.64rem] text-muted">
					{found.length - listed.length} more — type to narrow them down.
				</p>
			{/if}
		</section>
	{/if}

	{@render measures?.()}
	<div class="mt-auto">{@render footer?.()}</div>
</aside>
