<script lang="ts">
	import type { Instance } from '$lib/schematic/model';
	import { bjtFromCard, cardFor, diodeFromCard, mosfetFromCard, parseModelCards } from '$lib/spice';
	import { app } from '$lib/state.svelte';
	import { hint, problem, sectionTitle } from './styles';

	/**
	 * A part as a paste from the manufacturer rather than a row of numbers
	 * transcribed by hand.
	 *
	 * What the card could not be used for is named rather than dropped quietly:
	 * a 2N3904 without its high-level injection keeps its gain at currents where
	 * the real part has lost most of it, and the gap between a simplification
	 * and a lie is whether it is stated.
	 */
	let { instance, label }: { instance: Instance; label: string } = $props();

	const text = $derived(String(instance.params.spice ?? ''));

	const card = $derived.by(() => {
		const found = cardFor(text, instance.kind);
		if (!found) return null;
		const fold =
			instance.kind === 'npn' || instance.kind === 'pnp'
				? bjtFromCard
				: instance.kind === 'nmos' || instance.kind === 'pmos'
					? mosfetFromCard
					: diodeFromCard;
		return { name: found.name, ignored: fold(found).ignored };
	});

	/**
	 * Why a paste did nothing. Silence here reads as "it worked": the fields do
	 * not change when a card is applied — they are what it overrides — so text
	 * in the box and a part still behaving like the generic one look the same.
	 */
	const cardProblem = $derived.by(() => {
		if (card || !text.trim()) return null;
		const cards = parseModelCards(text);
		if (cards.length === 0) return 'No .model card found in that text.';
		const types = [...new Set(cards.map((c) => c.type))].join(', ');
		return `That card is a ${types}, which does not fit a ${label}.`;
	});

	/**
	 * On the same timer as every other field: a card typed or corrected by hand
	 * would otherwise be one undo step and one trace line per keystroke.
	 */
	let settling: ReturnType<typeof setTimeout> | undefined;
</script>

<section class="flex flex-col gap-1.5">
	<h3 class={sectionTitle}>SPICE model</h3>
	{#if card}
		<p class={hint}>
			Using <strong class="text-fg">{card.name}</strong>. Its values override the fields above.
		</p>
		{#if card.ignored.length > 0}
			<p class={hint}>Not modelled here: {card.ignored.join(', ')}.</p>
		{/if}
	{/if}
	<textarea
		rows="3"
		spellcheck="false"
		placeholder=".model 2N3904 NPN(IS=6.734f BF=416.4 VAF=74.03 …)"
		value={text}
		oninput={(e) => {
			const raw = e.currentTarget.value;
			// Captured now: the timer may fire after the selection has moved on.
			const id = instance.id;
			clearTimeout(settling);
			settling = setTimeout(() => app.setParam(id, 'spice', raw), 350);
		}}
		onblur={(e) => {
			// Read from the field, not from what the last keystroke left behind:
			// focusing this box and leaving it without typing has to be a no-op.
			clearTimeout(settling);
			app.setParam(instance.id, 'spice', e.currentTarget.value);
		}}
		aria-label="SPICE model card"
		class="w-full resize-y rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-[0.64rem] leading-normal text-fg outline-none focus:border-accent/70"
	></textarea>
	{#if cardProblem}<p class={problem} role="alert">{cardProblem}</p>{/if}
</section>
