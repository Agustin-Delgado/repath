<script lang="ts">
	import { fieldBox, fieldInput, fieldLabel, problem as problemClass } from './styles';

	/**
	 * A name that the model may refuse: a designator already taken, a port
	 * name that collides.
	 *
	 * A refusal puts the name that is actually in effect back in the field,
	 * so what is on screen is what the circuit says, and says why underneath.
	 */
	type Props = {
		value: string;
		/** Apply it; the reason it was refused, or null. */
		commit: (raw: string) => string | null;
		'aria-label': string;
		label?: string;
		/** Big and bold, for the designator at the top of the panel. */
		prominent?: boolean;
	};

	let { value, commit, label, prominent = false, ...rest }: Props = $props();

	let refusal = $state<string | null>(null);
</script>

<label class="flex min-w-0 flex-col gap-1">
	{#if label}<span class={fieldLabel}>{label}</span>{/if}
	<span class={prominent ? 'flex' : fieldBox} data-rejected={refusal ? '' : undefined}>
		<input
			{value}
			aria-label={rest['aria-label']}
			spellcheck="false"
			class={prominent
				? 'w-full min-w-0 rounded-control border border-transparent bg-transparent px-1 py-0.5 font-mono text-sm font-semibold text-fg outline-none hover:border-border focus:border-accent/70'
				: fieldInput}
			onchange={(e) => {
				const field = e.currentTarget;
				refusal = commit(field.value);
				// Written to the element: the value prop has not changed — the model
				// refused — so Svelte will not touch the node to set it back.
				if (refusal) field.value = value;
			}}
			onkeydown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur();
				if (e.key === 'Escape') {
					e.currentTarget.value = value;
					e.currentTarget.blur();
				}
			}}
		/>
	</span>
	{#if refusal}<span class={problemClass} role="alert">{refusal}</span>{/if}
</label>
