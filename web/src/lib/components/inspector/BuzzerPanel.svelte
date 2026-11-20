<script lang="ts">
	import { Volume2, VolumeX } from '@lucide/svelte';
	import { Button } from '$lib/ui';
	import { audible, noteName, toneAt } from '$lib/schematic/buzzer';
	import type { Instance } from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import { formatValue, formatWithUnit } from '$lib/units';
	import { hint, sectionTitle } from './styles';

	/**
	 * What a buzzer is sounding at the instant on the drawing, and the switch
	 * that lets it be heard.
	 */
	let { instance }: { instance: Instance } = $props();

	const ran = $derived(app.capture !== null);
	const tone = $derived.by(() => {
		// The tracks are not reactive; the clock is, and moves every frame a run does.
		void app.playbackTime;
		return toneAt(app.buzzerTracks.get(instance.name), app.playbackTime);
	});
	const note = $derived(tone ? noteName(tone.frequency) : null);
	/** How much longer a note lasts aloud than in the sketch, when that is far from once. */
	const stretch = $derived.by(() => {
		const rate = app.playbackRate;
		return Math.abs(rate - 1) < 0.02 ? null : 1 / rate;
	});

	let unavailable = $state(false);
	async function toggle() {
		unavailable = !(await app.setSound(!app.soundOn));
	}
</script>

<section class="flex flex-col gap-1.5">
	<h3 class={sectionTitle}>Sound</h3>
	<p class="{hint} rounded-md border border-border bg-canvas px-2 py-1.5">
		{#if !ran}
			Run the circuit to hear what drives it: a sketch's <code>tone()</code>, a pin toggled by hand, a
			PWM output.
		{:else if tone}
			Sounding at <strong class="text-fg">{formatWithUnit(tone.frequency, 'Hz', 4)}</strong
			>{#if note}, {note}{/if}.
			{#if !audible(tone.frequency)}Outside hearing, so not played.{/if}
		{:else}
			Silent: nothing is driving it at a pitch at this instant.
		{/if}
	</p>
	<Button
		size="sm"
		active={app.soundOn}
		aria-pressed={app.soundOn}
		onclick={toggle}
		title={app.soundOn ? 'Stop playing the buzzers' : 'Play the buzzers through the speakers'}
	>
		{#if app.soundOn}<Volume2 /> Sound on{:else}<VolumeX /> Sound off{/if}
	</Button>
	{#if unavailable}
		<p class={hint}>This browser cannot play sound from a page.</p>
	{:else if app.soundOn && stretch !== null}
		<p class={hint}>
			Each note keeps its pitch and lasts {stretch > 1
				? `${formatValue(stretch, 3)}× as long`
				: `1/${formatValue(1 / stretch, 3)} as long`} as in the sketch, at this speed. Pick 1:1
			to hear it at its tempo.
		</p>
	{:else if !app.soundOn}
		<p class={hint}>Off until you turn it on: a page may only make sound after a click.</p>
	{/if}
</section>
