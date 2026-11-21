<script lang="ts">
	import Examples from './Examples.svelte';
	import Palette from './Palette.svelte';
	import { findsPart } from '$lib/shortcuts';
	import { Tabs } from '$lib/ui';

	/**
	 * The left panel: parts to draw with, or whole circuits to start from.
	 *
	 * Both are things taken from a shelf and put on the drawing, so they share
	 * the panel rather than one of them living in a menu. The tab is remembered
	 * per browser, like the folded shelves.
	 */
	type Tab = 'parts' | 'examples';
	const KEY = 'repath.sidebarTab';

	function load(): Tab {
		try {
			return localStorage.getItem(KEY) === 'examples' ? 'examples' : 'parts';
		} catch {
			return 'parts';
		}
	}

	let tab = $state<Tab>(load());

	function choose(next: Tab) {
		tab = next;
		if (next !== 'parts') searching = false;
		try {
			localStorage.setItem(KEY, next);
		} catch {
			// The choice still holds for this tab.
		}
	}

	/** Whether the parts list should take the focus when it next comes up. */
	let searching = $state(false);

	/**
	 * `/` on the examples tab: the parts list is not mounted there to hear it,
	 * so the sidebar turns to it, and the list puts its search box in focus.
	 * On the parts tab the list hears it itself.
	 */
	function onWindowKey(event: KeyboardEvent) {
		if (tab !== 'examples' || !findsPart(event, event.target as HTMLElement | null)) return;
		event.preventDefault();
		searching = true;
		choose('parts');
	}

	const TABS: Array<{ id: Tab; label: string }> = [
		{ id: 'parts', label: 'Parts' },
		{ id: 'examples', label: 'Examples' }
	];
</script>

<svelte:window onkeydown={onWindowKey} />

<Tabs items={TABS} value={tab} onChange={choose} aria-label="Sidebar" class="h-full w-full">
	{#snippet panel(id)}
		{#if id === 'parts'}
			<Palette focusSearch={searching} />
		{:else}
			<Examples />
		{/if}
	{/snippet}
</Tabs>
