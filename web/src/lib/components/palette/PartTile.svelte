<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One part on a shelf: its symbol and its name.
	 *
	 * `content-visibility` lets the browser skip laying out and painting the
	 * tiles nobody can see — a chip icon is fifty-odd elements, and the shelves
	 * are most of them off screen. `auto` on the intrinsic size remembers the
	 * real height once measured, so the scrollbar does not jump.
	 */
	type Props = {
		label: string;
		title: string;
		active: boolean;
		onclick: () => void;
		oncontextmenu?: (event: MouseEvent) => void;
		icon: Snippet;
		dim?: boolean;
	};

	let { label, title, active, onclick, oncontextmenu, icon, dim = false }: Props = $props();
</script>

<button
	type="button"
	{title}
	{onclick}
	{oncontextmenu}
	aria-pressed={active}
	class="flex cursor-pointer flex-col items-center gap-0.5 rounded-md border px-0.5 pt-1.5 pb-1 text-center text-[0.62rem] leading-tight outline-none [contain-intrinsic-size:auto_56px] [content-visibility:auto] focus-visible:ring-2 focus-visible:ring-accent/60
		{active
		? 'border-accent bg-accent/15 text-fg [--symbol-stroke:var(--accent)]'
		: 'border-transparent bg-transparent text-muted [--symbol-stroke:var(--symbol)] hover:border-border hover:bg-hover hover:text-fg'}
		{dim ? 'opacity-70' : ''}"
>
	{@render icon()}
	<span class="line-clamp-2 break-words">{label}</span>
</button>
