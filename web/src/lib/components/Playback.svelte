<script lang="ts">
	/**
	 * The instrument's front panel.
	 *
	 * Run, Stop, Single — a scope's transport, and deliberately not a player's.
	 * There is no scrubber, because there is nothing to scrub: the run is going
	 * on now, the newest instant is the only one that exists while it is, and the
	 * way to look at something that has already happened is to stop.
	 */
	import { VOLTAGE_SCALE } from '$lib/schematic/animate';
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';

	const SPEEDS = [0.25, 1, 4];

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
</script>

<div class="playback">
	<button
		class="play"
		onclick={() => app.togglePlay()}
		title={app.playing ? 'Stop the sweep (Space)' : 'Run (Space)'}
		aria-label={app.playing ? 'Stop' : 'Run'}
	>
		{#if app.playing}
			<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="2.5" width="7" height="7" /></svg>
			Stop
		{:else}
			<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2l6 4-6 4z" /></svg>
			Run
		{/if}
	</button>

	<button
		onclick={() => app.single()}
		disabled={app.playing}
		title="Sweep one window and stop there"
	>
		Single
	</button>

	<span class="clock" class:running={app.playing}>
		{formatValue(app.playbackTime, 3)}s
	</span>
	{#if !started}
		<span class="hint">nothing running</span>
	{:else if lagging}
		<span class="hint lag" title="The circuit is being solved slower than the timebase asks for">
			{Math.round(keeping * 100)}% of the timebase
		</span>
	{:else if !app.playing}
		<span class="hint">stopped &middot; drag the scope to look around</span>
	{/if}

	<span class="spacer"></span>

	<div class="speeds" role="group" aria-label="Sweep speed">
		{#each SPEEDS as speed (speed)}
			<button
				class:active={app.playbackSpeed === speed}
				onclick={() => (app.playbackSpeed = speed)}
				title="{speed}× — a window every {formatValue(4 / speed, 2)} seconds">{speed}×</button
			>
		{/each}
	</div>

	<div class="layers" role="group" aria-label="Live overlay">
		<button
			class:active={app.showVoltage}
			onclick={() => (app.showVoltage = !app.showVoltage)}
			title="Colour wires by voltage"
		>
			<span
				class="ramp"
				style:background="linear-gradient(90deg, {VOLTAGE_SCALE.negative}, {VOLTAGE_SCALE.neutral}, {VOLTAGE_SCALE.positive})"
			></span>
			Voltage
		</button>
		<button
			class:active={app.showCurrent}
			onclick={() => (app.showCurrent = !app.showCurrent)}
			title="Animate current along the wires"
		>
			<span class="dots" aria-hidden="true">•••</span>
			Current
		</button>
		<button
			class:active={app.showValues}
			onclick={() => (app.showValues = !app.showValues)}
			title="Print the voltage on each net and the current through each part"
		>
			<span class="figures" aria-hidden="true">5V</span>
			Values
		</button>
		<button
			class:active={app.showLight}
			onclick={() => (app.showLight = !app.showLight)}
			title="Light the LEDs from the current through them"
		>
			<span class="bulb" aria-hidden="true">●</span>
			Light
		</button>
	</div>
</div>

<style>
	.playback {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		padding: 0.3rem 0.7rem;
		background: var(--panel-bg);
		border-bottom: 1px solid var(--border);
		font-size: 0.75rem;
	}

	button {
		border: 1px solid var(--border);
		background: var(--control-bg);
		color: var(--text);
		border-radius: 5px;
		cursor: pointer;
		padding: 0.25rem 0.5rem;
		font-size: 0.72rem;
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}

	button:hover:not(:disabled) {
		background: var(--hover);
	}

	button:disabled {
		opacity: 0.45;
		cursor: default;
	}

	.play {
		padding: 0.25rem 0.45rem;
	}

	.play svg {
		width: 12px;
		height: 12px;
		fill: currentColor;
	}

	.spacer {
		flex: 1;
	}

	.hint {
		color: var(--label-dim);
		white-space: nowrap;
	}

	.hint.lag {
		color: #ffb066;
	}

	.clock {
		font-family: var(--font-mono);
		color: var(--label-dim);
		min-width: 4.5rem;
		text-align: right;
	}

	/* Running, the clock is the one number on the panel that is moving. */
	.clock.running {
		color: var(--text);
	}

	.speeds,
	.layers {
		display: flex;
		gap: 0.2rem;
	}

	.speeds button {
		padding: 0.25rem 0.35rem;
		font-family: var(--font-mono);
	}

	button.active {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.ramp {
		width: 22px;
		height: 8px;
		border-radius: 2px;
		display: inline-block;
	}

	.dots {
		color: #ffe9a8;
		letter-spacing: -1px;
	}

	.figures {
		font-family: var(--font-mono);
		font-size: 0.62rem;
		color: #7fe3a0;
	}

	.bulb {
		color: #ff4e3e;
		text-shadow: 0 0 5px #ff4e3e;
	}
</style>
