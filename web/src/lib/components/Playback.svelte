<script lang="ts">
	/**
	 * The instrument's front panel, under the drawing.
	 *
	 * Run and Stop live in the toolbar and nowhere else: two Run buttons that
	 * did different things — one started over, one carried on — was one too
	 * many. What is here is what a scope has beside them: carry on from where a
	 * stopped sweep got to, capture one window, put the run away. There is no
	 * scrubber, because there is nothing to scrub: the newest instant is the
	 * only one that exists while it runs, and the way to look back is to stop.
	 *
	 * It is also the scope's title bar, so it stays when the scope is folded
	 * away: the overlays and the transport are what a folded scope still needs.
	 */
	import { ChevronDown, Play, RotateCcw, StepForward } from '@lucide/svelte';
	import { Button } from '$lib/ui';
	import { VOLTAGE_SCALE } from '$lib/schematic/animate';
	import { layout } from '$lib/layout.svelte';
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';

	/** A multiple of the four-second sweep, or a second per second. */
	const SPEEDS: Array<number | 'real'> = [0.25, 1, 4, 'real'];

	/** What a setting comes to, against the clock on the wall, with this window. */
	function against(speed: number | 'real'): string {
		const rate = speed === 'real' ? 1 : (app.stopTime / 4) * speed;
		if (Math.abs(rate - 1) < 1e-9) return 'real time';
		return rate > 1 ? `${formatValue(rate, 3)}× real time` : `1/${formatValue(1 / rate, 3)} real time`;
	}

	function describe(speed: number | 'real'): string {
		if (speed === 'real') return 'A simulated second per real second, whatever the window';
		return `${speed}× — a window every ${formatValue(4 / speed, 2)} seconds, which here is ${against(speed)}`;
	}

	const started = $derived(app.acquiring !== null);
	/**
	 * How far behind the timebase the engine is running, once it is far enough
	 * behind to be worth saying. A stiff circuit cannot always be solved as fast
	 * as it is being asked for, and that shows up as slow motion — better named
	 * than left for somebody to discover by timing it against a clock.
	 */
	const keeping = $derived.by(() => {
		// The clock is what changes every frame; the acquisition object is the same
		// one throughout, and a plain field on it would never announce itself.
		void app.playbackTime;
		return app.acquiring?.keeping ?? 1;
	});
	const lagging = $derived(app.playing && keeping < 0.85);

	const LAYERS = [
		{ key: 'showVoltage', label: 'Voltage', title: 'Colour wires by voltage' },
		{ key: 'showCurrent', label: 'Current', title: 'Animate current along the wires' },
		{
			key: 'showValues',
			label: 'Values',
			title: 'Print the voltage on each net and the current through each part'
		},
		{ key: 'showLight', label: 'Light', title: 'Light the LEDs from the current through them' }
	] as const;
</script>

<div
	class="flex items-center gap-1.5 bg-panel px-2.5 py-1 text-[0.75rem] max-[900px]:overflow-x-auto max-[900px]:[scrollbar-width:none] max-[900px]:*:shrink-0 {layout.scopeOpen
		? 'border-b border-border'
		: ''}"
>
	{#if app.analysis !== 'transient'}
		<span class="text-[0.62rem] font-semibold tracking-[0.08em] text-muted uppercase">
			Frequency response
		</span>
		<span class="flex-1"></span>
	{:else}
		{#if started && !app.playing}
			<Button size="sm" class="h-6.5" onclick={() => app.togglePlay()} title="Carry on from where the sweep stopped (Space)">
				<Play class="fill-current" /> Resume
			</Button>
		{/if}
		<Button
			size="sm"
			class="h-6.5"
			onclick={() => app.single()}
			disabled={app.playing}
			title="Sweep one window and stop there"
		>
			<StepForward /> Single
		</Button>
		<!--
			The way out that Stop is not. Stop freezes the sweep to be looked at; this
			puts the run away altogether — clock at zero, scope empty, switches back
			where they are drawn.
		-->
		<Button
			size="sm"
			class="h-6.5"
			onclick={() => app.reset()}
			disabled={!started}
			title="Throw the run away and go back to the drawing at rest"
		>
			<RotateCcw /> Reset
		</Button>

		<!-- Running, the clock is the one number on the panel that is moving. -->
		<span class="min-w-[4.5rem] text-right font-mono {app.playing ? 'text-fg' : 'text-muted'}">
			{formatValue(app.playbackTime, 3)}s
		</span>
		{#if !started}
			<span class="whitespace-nowrap text-muted max-[900px]:hidden">nothing running — press Run</span>
		{:else if lagging}
			<span
				class="whitespace-nowrap text-[#ffb066] max-[900px]:hidden"
				title="The circuit is being solved slower than the timebase asks for"
			>
				{Math.round(keeping * 100)}% of the timebase
			</span>
		{:else if !app.playing}
			<span class="whitespace-nowrap text-muted max-[900px]:hidden">
				stopped · drag the scope to look around
			</span>
		{/if}

		<span class="flex-1"></span>

		<!--
			How fast the sweep goes, and what that comes to against a clock: a wide
			window at 1× runs many times faster than real time, a narrow one many
			times slower, and the number is the only way to know which.
		-->
		<span
			class="font-mono text-[0.66rem] whitespace-nowrap text-muted"
			title="Simulated time against real time at this speed and window"
		>
			{against(app.playbackSpeed)}
		</span>
		<div class="flex" role="group" aria-label="Sweep speed">
			{#each SPEEDS as speed, i (speed)}
				<Button
					size="sm"
					active={app.playbackSpeed === speed}
					aria-pressed={app.playbackSpeed === speed}
					onclick={() => (app.playbackSpeed = speed)}
					title={describe(speed)}
					class="h-6.5 px-1.5 font-mono {app.playbackSpeed === speed ? 'z-10' : ''} {i > 0
						? '-ml-px rounded-l-none'
						: ''} {i < SPEEDS.length - 1
						? 'rounded-r-none'
						: ''}"
				>
					{speed === 'real' ? '1:1' : `${speed}×`}
				</Button>
			{/each}
		</div>

		<span class="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

		<div class="flex gap-1" role="group" aria-label="Live overlay">
			{#each LAYERS as layer (layer.key)}
				<Button
					size="sm"
					class="h-6.5"
					active={app[layer.key]}
					aria-pressed={app[layer.key]}
					onclick={() => (app[layer.key] = !app[layer.key])}
					title={layer.title}
				>
					{#if layer.key === 'showVoltage'}
						<span
							class="inline-block h-2 w-5 rounded-[2px]"
							style:background="linear-gradient(90deg, {VOLTAGE_SCALE.negative}, {VOLTAGE_SCALE.neutral}, {VOLTAGE_SCALE.positive})"
						></span>
					{:else if layer.key === 'showCurrent'}
						<span class="tracking-[-1px] text-[#ffe9a8]" aria-hidden="true">•••</span>
					{:else if layer.key === 'showValues'}
						<span class="font-mono text-[0.62rem] text-[#7fe3a0]" aria-hidden="true">5V</span>
					{:else}
						<span class="text-[#ff4e3e] [text-shadow:0_0_5px_#ff4e3e]" aria-hidden="true">●</span>
					{/if}
					{layer.label}
				</Button>
			{/each}
		</div>
	{/if}

	<span class="mx-0.5 h-5 w-px shrink-0 bg-border max-[900px]:hidden" aria-hidden="true"></span>
	<!-- The phone bar has its own Scope button, and the scope its own row there. -->
	<Button
		variant="ghost"
		size="icon"
		class="size-6.5 max-[900px]:hidden"
		aria-expanded={layout.scopeOpen}
		onclick={() => layout.toggleScope()}
		title={layout.scopeOpen ? 'Fold the scope away' : 'Bring the scope back'}
		aria-label={layout.scopeOpen ? 'Fold the scope away' : 'Bring the scope back'}
	>
		<ChevronDown class="transition-transform {layout.scopeOpen ? '' : 'rotate-180'}" />
	</Button>
</div>
