<script lang="ts">
	import { Dialog } from '@human-kit/ui';
	import { CornerDownLeft, Search } from '@lucide/svelte';
	import PartIcon from '$lib/components/palette/PartIcon.svelte';
	import { allParts, pickPart } from '$lib/parts/drawing';
	import { sectionLabel, type PartEntry } from '$lib/parts/library';
	import { recentParts } from '$lib/parts/recent.svelte';
	import { fold, search } from '$lib/search';
	import { app } from '$lib/state.svelte';
	import { buildCommands, type Command, type CommandContext } from './commands';

	/**
	 * One box that does everything: Ctrl+K, type, Enter.
	 *
	 * Parts and commands in one list, because somebody looking for "7400" and
	 * somebody looking for "bode" are doing the same thing — naming what they
	 * want instead of hunting for where it is kept. That is the only way in
	 * that keeps working as the catalog and the feature list grow.
	 */

	let { context, open = $bindable(false) }: { context: CommandContext; open?: boolean } = $props();
	let query = $state('');
	let active = $state(0);

	type Row =
		| { type: 'command'; key: string; command: Command }
		| { type: 'part'; key: string; part: PartEntry };

	const commands = $derived(
		buildCommands(app, context).filter((command) => command.available?.() ?? true)
	);

	/**
	 * With nothing typed: the parts used last, then every command. With a
	 * query: the best of both, commands first when they tie with a part, since
	 * a command's name is what it does and a part is one of many.
	 */
	const rows = $derived.by((): Row[] => {
		const parts = allParts(app);
		const q = query.trim();
		if (!q) {
			const byKind = new Map(parts.map((part) => [part.kind, part]));
			const recent = recentParts.kinds
				.map((kind) => byKind.get(kind))
				.filter((part): part is PartEntry => !!part)
				.slice(0, 5);
			return [
				...recent.map((part): Row => ({ type: 'part', key: 'p:' + part.kind, part })),
				...commands.map((command): Row => ({ type: 'command', key: 'c:' + command.id, command }))
			];
		}
		const matchedCommands = search(commands, q, (command) => ({
			label: command.label,
			keywords: command.keywords,
			group: command.group,
			description: command.description
		}));
		const matchedParts = search(parts, q, (part) => ({
			label: part.label,
			id: part.kind.replace(/^[a-z]+:/, ''),
			keywords: part.keywords,
			group: sectionLabel(part.section),
			description: part.description
		}));
		// A command whose name starts with the query goes first; otherwise parts
		// lead, since most typing in here is somebody naming a part.
		const token = fold(q);
		const [leading, trailing] = partition(matchedCommands, (c) => fold(c.label).startsWith(token));
		return [
			...leading.map((command): Row => ({ type: 'command', key: 'c:' + command.id, command })),
			...matchedParts.slice(0, 30).map((part): Row => ({ type: 'part', key: 'p:' + part.kind, part })),
			...trailing.map((command): Row => ({ type: 'command', key: 'c:' + command.id, command }))
		];
	});

	function partition<T>(items: T[], test: (item: T) => boolean): [T[], T[]] {
		const yes: T[] = [];
		const no: T[] = [];
		for (const item of items) (test(item) ? yes : no).push(item);
		return [yes, no];
	}

	$effect(() => {
		void rows;
		active = 0;
	});
	$effect(() => {
		document.getElementById(`command-row-${active}`)?.scrollIntoView({ block: 'nearest' });
	});

	function choose(row: Row | undefined) {
		if (!row) return;
		open = false;
		query = '';
		// After the dialog has let go of the focus, so what runs gets it back.
		queueMicrotask(() => {
			if (row.type === 'part') pickPart(app, row.part.kind);
			else row.command.run();
		});
	}

	function onKey(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			active = Math.min(active + 1, rows.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			active = Math.max(active - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			choose(rows[active]);
		}
	}

	/**
	 * The shortcuts that belong to the app as a whole rather than to the
	 * drawing: finding things, and the document keys every editor has.
	 */
	function onWindowKey(event: KeyboardEvent) {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
		const key = event.key.toLowerCase();
		if (key === 'k' || (key === 'p' && event.shiftKey)) {
			event.preventDefault();
			open = !open;
			query = '';
			return;
		}
		if (event.shiftKey) return;
		const id = key === 's' ? 'save' : key === 'o' ? 'open' : null;
		if (!id) return;
		event.preventDefault();
		buildCommands(app, context)
			.find((command) => command.id === id)
			?.run();
	}

	/** Group headings, shown where the group changes. */
	const heading = (row: Row) =>
		row.type === 'part' ? (query.trim() ? 'Parts' : 'Recent parts') : row.command.group;
</script>

<svelte:window onkeydown={onWindowKey} />

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay class="fixed inset-0 z-50 bg-black/45" />
		<Dialog.Content
			class="fixed top-[12vh] left-1/2 z-50 flex max-h-[70vh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-panel text-fg shadow-2xl shadow-black/60 outline-none"
		>
			<Dialog.Title class="sr-only">Find a part or a command</Dialog.Title>
			<label class="flex items-center gap-2 border-b border-border px-3">
				<Search class="size-4 shrink-0 text-muted" />
				<input
					bind:value={query}
					onkeydown={onKey}
					placeholder="Find a part, a command, an example…"
					aria-label="Find a part or a command"
					aria-controls="command-rows"
					aria-activedescendant={rows.length ? `command-row-${active}` : undefined}
					autocomplete="off"
					spellcheck="false"
					class="h-11 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-fg outline-none placeholder:text-muted"
				/>
				<kbd class="rounded border border-border px-1.5 font-mono text-[0.6rem] leading-4 text-muted">Esc</kbd>
			</label>

			<div id="command-rows" role="listbox" aria-label="Results" class="min-h-0 flex-1 overflow-y-auto p-1.5">
				{#each rows as row, i (row.key)}
					{#if i === 0 || heading(rows[i - 1]) !== heading(row)}
						<div class="px-2 pt-2 pb-1 text-[0.62rem] font-semibold tracking-[0.08em] text-muted uppercase">
							{heading(row)}
						</div>
					{/if}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<div
						id="command-row-{i}"
						role="option"
						tabindex="-1"
						aria-selected={i === active}
						onclick={() => choose(row)}
						onpointermove={() => (active = i)}
						class="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 [--symbol-stroke:var(--symbol)]
							{i === active ? 'bg-hover' : ''}"
					>
						{#if row.type === 'part'}
							<PartIcon kind={row.part.kind} class="h-[22px] w-[30px]" />
							<div class="flex min-w-0 flex-1 flex-col">
								<span class="truncate text-ui">Place {row.part.label}</span>
								<span class="truncate text-[0.64rem] text-muted">
									{sectionLabel(row.part.section)}{row.part.description ? ` · ${row.part.description}` : ''}
								</span>
							</div>
						{:else}
							<div class="flex min-w-0 flex-1 flex-col">
								<span class="truncate text-ui">{row.command.label}</span>
								{#if row.command.description}
									<span class="truncate text-[0.64rem] text-muted">{row.command.description}</span>
								{/if}
							</div>
							{#if row.command.shortcut}
								<kbd class="shrink-0 font-mono text-[0.62rem] text-muted">{row.command.shortcut}</kbd>
							{/if}
						{/if}
						{#if i === active}<CornerDownLeft class="size-3.5 shrink-0 text-muted" />{/if}
					</div>
				{:else}
					<p class="m-0 px-2 py-6 text-center text-ui text-muted">Nothing called “{query.trim()}”.</p>
				{/each}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
