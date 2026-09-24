<script lang="ts">
	/**
	 * A value typed the way an engineer writes it — `10m`, `4.7k`, `-40` — with
	 * its unit beside it. What is typed is only a draft: `commit` gets it on
	 * Enter or on leaving the field, and whatever it did with it, the field goes
	 * back to showing `value`. That is how text that did not parse snaps back to
	 * the last good value.
	 */
	type Props = {
		/** The committed value, formatted. */
		value: string;
		commit: (text: string) => void;
		'aria-label': string;
		/** A word before the value: "window", "at", "from". */
		prefix?: string;
		unit?: string;
		title?: string;
		width?: string;
	};

	let { value, commit, prefix, unit, title, width = '4.5rem', ...rest }: Props = $props();

	let draft = $state('');
	let editing = $state(false);
</script>

<label
	{title}
	class="flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-border bg-control px-2 text-[0.75rem] text-muted focus-within:border-accent/70"
>
	{#if prefix}<span>{prefix}</span>{/if}
	<input
		value={editing ? draft : value}
		aria-label={rest['aria-label']}
		style:width
		class="h-full min-w-0 border-0 bg-transparent p-0 font-mono text-ui text-fg outline-none"
		onfocus={() => {
			draft = value;
			editing = true;
		}}
		oninput={(e) => (draft = e.currentTarget.value)}
		onblur={() => {
			if (!editing) return;
			editing = false;
			commit(draft);
		}}
		onkeydown={(e) => {
			if (e.key === 'Enter') e.currentTarget.blur();
			if (e.key === 'Escape') {
				editing = false;
				e.currentTarget.blur();
			}
		}}
	/>
	{#if unit}<span>{unit}</span>{/if}
</label>
