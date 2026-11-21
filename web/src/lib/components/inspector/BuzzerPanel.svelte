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
			Sounds on <code>tone()</code>, a toggled pin or PWM.
		{:else if tone}
			<strong class="text-fg">{formatWithUnit(tone.frequency, 'Hz', 4)}</strong
			>{#if note}, {note}{/if}.
			{#if !audible(tone.frequency)}Inaudible: not played.{/if}
		{:else}
			Silent.
		{/if}
	</p>
	<Button
		size="sm"
		active={app.soundOn}
		aria-pressed={app.soundOn}
		onclick={toggle}
		title={app.soundOn ? 'Mute buzzers' : 'Play buzzers'}
	>
		{#if app.soundOn}<Volume2 /> Sound on{:else}<VolumeX /> Sound off{/if}
	</Button>
	{#if unavailable}
		<p class={hint}>This browser cannot play sound.</p>
	{:else if app.soundOn && stretch !== null}
		<p class={hint}>
			At this speed each note lasts {stretch > 1
				? `${formatValue(stretch, 3)}×`
				: `1/${formatValue(1 / stretch, 3)}`} as long, at the same pitch. Set 1:1 for the real tempo.
		</p>
	{/if}
</section>
