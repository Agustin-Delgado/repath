<script lang="ts">
	import type { ChipDef } from '$lib/schematic/chips';
	import { parseContents } from '$lib/schematic/memory';
	import type { Instance } from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import { hint, problem, sectionTitle } from './styles';

	/**
	 * What a programmable memory holds, as the hex dump it would be burnt from.
	 *
	 * The count of words written is said back, because the fields of a part do
	 * not change when this does: text in the box and a chip reading FF everywhere
	 * would otherwise look the same.
	 */
	let { instance, chip }: { instance: Instance; chip: ChipDef } = $props();

	const block = $derived(chip.blocks.find((b) => b.kind === 'memory'));
	const count = $derived(2 ** (block?.address?.length ?? 0));
	const width = $derived(block?.dataOut?.length ?? 8);
	const text = $derived(String(instance.params.contents ?? ''));
	const parsed = $derived(parseContents(text, count, width));
	const written = $derived(parsed.words.filter((word) => word !== undefined).length);
	const erased = $derived(
		(chip.contents?.erased ?? 0).toString(16).toUpperCase().padStart(Math.ceil(width / 4), '0')
	);

	/** On the same timer as the model card, for the same reason. */
	let settling: ReturnType<typeof setTimeout> | undefined;
</script>

<section class="flex flex-col gap-1.5">
	<h3 class={sectionTitle}>Contents</h3>
	<p class={hint}>
		What it holds when a run starts, as hex words from address 0; <code>@7F0</code> jumps to an
		address and <code>;</code> starts a comment. A write during the run does not change this.
		{written === 0
			? `Nothing written yet: every address reads ${erased}.`
			: `${written} of ${count} words written; the rest read ${erased}.`}
	</p>
	<textarea
		rows="5"
		spellcheck="false"
		placeholder={'3F 06 5B 4F 66 6D 7D 07 7F 6F\n@10 77 7C 39 5E 79 71 ; A to F'}
		value={text}
		oninput={(e) => {
			const raw = e.currentTarget.value;
			const id = instance.id;
			clearTimeout(settling);
			settling = setTimeout(() => app.setParam(id, 'contents', raw), 350);
		}}
		onblur={(e) => {
			clearTimeout(settling);
			app.setParam(instance.id, 'contents', e.currentTarget.value);
		}}
		aria-label="Memory contents"
		class="w-full resize-y rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-[0.64rem] leading-normal text-fg outline-none focus:border-accent/70"
	></textarea>
	{#each parsed.problems.slice(0, 3) as message (message)}
		<p class={problem} role="alert">{message}</p>
	{/each}
</section>
