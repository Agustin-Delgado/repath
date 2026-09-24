<script lang="ts">
	import { Button } from '$lib/ui';
	import { app } from '$lib/state.svelte';

	/*
		One button for the whole thing. Running is a state you are in or out of,
		and having to hunt for a different control to leave it is what made a
		stopped sweep sit there looking like a live one.

		Run always starts a new sweep from zero, the way pressing it on a scope
		restarts the acquisition. Picking a stopped one back up is the transport
		underneath the drawing, which is where the timebase lives.
	*/
	const stopping = $derived(app.playing && !app.running);
</script>

<Button
	variant="primary"
	active={stopping}
	class="min-w-[5.6rem]"
	pending={app.running}
	onclick={() => (stopping ? app.stop() : app.run())}
	title={app.playing ? 'Stop the sweep and freeze what is on screen' : 'Start a new sweep from zero'}
>
	<svg viewBox="0 0 12 12" aria-hidden="true" class="fill-current">
		{#if app.running}
			<circle
				cx="6"
				cy="6"
				r="4.2"
				fill="none"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-dasharray="6 20"
				stroke-linecap="round"
			/>
		{:else if app.playing}
			<rect x="2.5" y="2.5" width="7" height="7" />
		{:else}
			<path d="M3.5 2l6 4-6 4z" />
		{/if}
	</svg>
	{app.running ? 'Starting…' : app.playing ? 'Stop' : 'Run'}
</Button>
