<script lang="ts">
	import Examples from './Examples.svelte';
	import Palette from './Palette.svelte';
	import { findsPart } from '$lib/shortcuts';

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

<div class="flex h-full min-h-0 w-full min-w-0 flex-col">
	<div role="tablist" aria-label="Sidebar" class="flex shrink-0 gap-1 border-b border-border px-2 pt-2">
		{#each TABS as { id, label } (id)}
			<button
				type="button"
				role="tab"
				id="sidebar-tab-{id}"
				aria-selected={tab === id}
				aria-controls="sidebar-panel"
				onclick={() => choose(id)}
				class="-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-2 pb-1.5 text-ui {tab === id
					? 'border-accent text-fg'
					: 'border-transparent text-muted hover:text-fg'}"
			>
				{label}
			</button>
		{/each}
	</div>
	<div id="sidebar-panel" role="tabpanel" aria-labelledby="sidebar-tab-{tab}" class="min-h-0 flex-1">
		{#if tab === 'parts'}
			<Palette focusSearch={searching} />
		{:else}
			<Examples />
		{/if}
	</div>
</div>
