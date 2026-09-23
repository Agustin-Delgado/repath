<script lang="ts">
	import { Search, X } from '@lucide/svelte';
	import { EXAMPLES, exampleDomain, type Example, type ExampleDomain } from '$lib/examples';
	import { search } from '$lib/search';
	import { app } from '$lib/state.svelte';

	/**
	 * Circuits to open, filed the way the parts are: by what they are made of.
	 *
	 * Each says what it shows in a line or two, because the name alone — "RC
	 * low-pass" — says what is on the page, not why it is worth opening. Typing
	 * narrows them by name and by description both, and keeps the shelves, so
	 * "counter" still says which ones are logic and which are mixed.
	 */

	const SHELVES: ExampleDomain[] = ['Analog', 'Logic', 'Mixed signal'];

	let query = $state('');
	let searchInput = $state<HTMLInputElement | null>(null);

	const found = $derived(
		search(EXAMPLES, query, (example) => ({
			label: example.name,
			id: example.id,
			group: exampleDomain(example),
			description: example.description,
			keywords: example.analysis === 'frequency' ? ['frequency', 'bode', 'ac'] : []
		}))
	);
	/** On their shelves, in the order the search ranked them within each. */
	const shelves = $derived(
		SHELVES.map((shelf) => ({
			shelf,
			examples: found.filter((example) => exampleDomain(example) === shelf)
		})).filter((group) => group.examples.length > 0)
	);

	function open(example: Example) {
		app.loadExample(example.id);
		void app.run();
	}
</script>

<div class="flex h-full min-h-0 w-full min-w-0 flex-col">
	<div class="border-b border-border p-2">
		<label
			class="flex h-7 items-center gap-1.5 rounded-control border border-border bg-control px-2 text-muted focus-within:border-accent/70"
		>
			<Search class="size-3.5 shrink-0" />
			<input
				bind:this={searchInput}
				bind:value={query}
				onkeydown={(event) => {
					if (event.key === 'Enter' && found[0]) open(found[0]);
					else if (event.key === 'Escape') {
						if (query) query = '';
						else searchInput?.blur();
					}
				}}
				type="search"
				placeholder="Find an example…"
				aria-label="Find an example"
				autocomplete="off"
				spellcheck="false"
				class="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-ui text-fg outline-none [&::-webkit-search-cancel-button]:hidden"
			/>
			{#if query}
				<button
					type="button"
					class="flex cursor-pointer border-0 bg-transparent p-0 text-muted hover:text-fg"
					aria-label="Clear the search"
					onclick={() => {
						query = '';
						searchInput?.focus();
					}}
				>
					<X class="size-3.5" />
				</button>
			{/if}
		</label>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto p-2">
		{#each shelves as { shelf, examples } (shelf)}
			<section class="mb-2">
				<h3
					class="m-0 flex items-center px-0.5 py-1 text-[0.66rem] font-semibold tracking-[0.08em] text-muted uppercase"
				>
					{shelf}
					<span class="ml-auto font-mono text-[0.6rem] font-normal tracking-normal opacity-60">
						{examples.length}
					</span>
				</h3>
				<ul class="m-0 flex list-none flex-col gap-0.5 p-0">
					{#each examples as example (example.id)}
						<li>
							<button
								type="button"
								onclick={() => open(example)}
								title="Open {example.name}; it replaces the drawing, and Ctrl+Z brings the drawing back"
								class="flex w-full cursor-pointer flex-col gap-0.5 rounded-md border-0 bg-transparent px-1.5 py-1.5 text-left hover:bg-hover"
							>
								<span class="flex items-center gap-1.5 text-ui text-fg">
									<span class="min-w-0 truncate">{example.name}</span>
									{#if example.analysis === 'frequency'}
										<span
											class="ml-auto shrink-0 rounded bg-control px-1 font-mono text-[0.56rem] leading-4 text-muted"
											>AC</span
										>
									{/if}
								</span>
								<span class="line-clamp-2 text-[0.66rem] leading-snug text-muted">
									{example.description}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{:else}
			<p class="m-0 px-1 py-4 text-center text-2xs text-muted">No example matches “{query.trim()}”.</p>
		{/each}
	</div>
</div>
