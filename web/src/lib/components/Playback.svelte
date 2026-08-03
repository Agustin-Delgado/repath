<script lang="ts">
	/**
	 * Transport for the live overlay.
	 *
	 * The scrubber is the same time axis as the scope below it, so dragging here
	 * moves the playhead there and the schematic shows that instant.
	 */
	import { VOLTAGE_SCALE } from '$lib/schematic/animate';
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';

	const SPEEDS = [0.25, 1, 4];

	const disabled = $derived(!app.result);
	const progress = $derived(app.stopTime > 0 ? app.playbackTime / app.stopTime : 0);
</script>

<div class="playback">
	<button
		class="play"
		onclick={() => app.togglePlay()}
		{disabled}
		title={app.playing ? 'Pause (Space)' : 'Play (Space)'}
		aria-label={app.playing ? 'Pause' : 'Play'}
	>
		{#if app.playing}
			<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2h2.2v8H3zM6.8 2H9v8H6.8z" /></svg>
		{:else}
			<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2l6 4-6 4z" /></svg>
		{/if}
	</button>

	<input
		class="scrub"
		type="range"
		min="0"
		max="1"
		step="0.0005"
		value={progress}
		{disabled}
		oninput={(e) => app.seek(Number(e.currentTarget.value) * app.stopTime)}
		aria-label="Playback position"
		style:--progress="{progress * 100}%"
	/>

	<span class="clock">{formatValue(app.playbackTime, 3)}s</span>

	<div class="speeds" role="group" aria-label="Playback speed">
		{#each SPEEDS as speed (speed)}
			<button
				class:active={app.playbackSpeed === speed}
				onclick={() => (app.playbackSpeed = speed)}
				{disabled}>{speed}×</button
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

	.scrub {
		flex: 1;
		min-width: 5rem;
		appearance: none;
		height: 4px;
		border-radius: 2px;
		/* The filled part shows how far through the run the overlay is. */
		background: linear-gradient(
			90deg,
			var(--accent) var(--progress, 0%),
			var(--border) var(--progress, 0%)
		);
		cursor: pointer;
	}

	.scrub::-webkit-slider-thumb {
		appearance: none;
		width: 11px;
		height: 11px;
		border-radius: 50%;
		background: var(--accent);
		border: none;
	}

	.scrub::-moz-range-thumb {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		background: var(--accent);
		border: none;
	}

	.scrub:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.clock {
		font-family: var(--font-mono);
		color: var(--label-dim);
		min-width: 4.5rem;
		text-align: right;
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
