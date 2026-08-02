<script lang="ts">
	import { app } from '$lib/state.svelte';
	import { definitionOf, isParamVisible } from '$lib/schematic/model';
	import { formatValue, parseValue } from '$lib/units';

	const instance = $derived(app.selectedInstances.length === 1 ? app.selectedInstances[0] : null);
	const def = $derived(instance ? definitionOf(instance.kind) : null);

	/** Text currently in each field, so a half-typed value is not clobbered. */
	let editing = $state<Record<string, string>>({});
	/**
	 * Why the last edit to each field was refused.
	 *
	 * A refusal with no explanation is indistinguishable from a bug: the field
	 * kept whatever was typed while the model had rejected it, so the drawing and
	 * the screen disagreed and nothing said so.
	 */
	let problems = $state<Record<string, string>>({});

	function commit(key: string, raw: string, field: HTMLInputElement) {
		if (!instance) return;

		/**
		 * Put the value that is actually in effect back in the box.
		 *
		 * Written to the element rather than left to the binding: the rendered
		 * expression has not changed — the model refused the edit, so the value is
		 * what it always was — and Svelte will not touch a DOM node to set it to
		 * what it already believes is there. The typed text would sit in the field
		 * looking accepted.
		 */
		const restore = () => {
			delete editing[key];
			const current = instance.params[key];
			field.value = typeof current === 'number' ? formatValue(current, 4) : String(current);
		};

		const parsed = parseValue(raw);
		if (parsed === null) {
			problems[key] = `“${raw.trim()}” is not a value. Try 4k7, 100n, or 2.2e-3.`;
			restore();
			return;
		}
		const refusal = app.setParam(instance.id, key, parsed);
		if (refusal) {
			problems[key] = refusal;
			restore();
			return;
		}
		delete problems[key];
		delete editing[key];
	}

	function commitName(raw: string, field: HTMLInputElement) {
		if (!instance) return;
		const refusal = app.rename(instance.id, raw);
		if (refusal) {
			problems.name = refusal;
			// Put the name that is actually in effect back in the field, so what is
			// on screen is what the circuit says.
			field.value = instance.name;
			return;
		}
		delete problems.name;
	}

	// A different component means a clean slate; the old messages were about it.
	// Keyed on the id rather than the instance, so an unrelated edit elsewhere does
	// not wipe a message the moment it appears.
	const selectedId = $derived(instance?.id ?? null);
	$effect(() => {
		void selectedId;
		problems = {};
		editing = {};
	});

	function displayed(key: string, value: number | string): string {
		if (editing[key] !== undefined) return editing[key];
		return typeof value === 'number' ? formatValue(value, 4) : String(value);
	}
</script>

<div class="inspector">
	{#if !instance || !def}
		<p class="hint">
			{#if app.selectedInstances.length > 1}
				{app.selectedInstances.length} components selected. Press <kbd>R</kbd> to rotate or
				<kbd>Del</kbd> to remove them.
			{:else}
				Select a component to edit its values.
			{/if}
		</p>
	{:else}
		<header>
			<input
				class="ref"
				class:rejected={problems.name}
				value={instance.name}
				onchange={(e) => commitName(e.currentTarget.value, e.currentTarget)}
				aria-label="Reference designator"
			/>
			<span class="kind">{def.label}</span>
		</header>
		{#if problems.name}
			<p class="problem" role="alert">{problems.name}</p>
		{/if}

		<div class="fields">
			{#each def.params as param (param.key)}
				{#if isParamVisible(param, instance.params)}
					<label>
						<span class="field-label">{param.label}</span>
						{#if param.choices}
							<select
								value={String(instance.params[param.key])}
								onchange={(e) => app.setParam(instance.id, param.key, e.currentTarget.value)}
							>
								{#each param.choices as choice (choice.value)}
									<option value={choice.value}>{choice.label}</option>
								{/each}
							</select>
						{:else}
							<span class="value-field" class:rejected={problems[param.key]}>
								<input
									value={displayed(param.key, instance.params[param.key])}
									oninput={(e) => (editing[param.key] = e.currentTarget.value)}
									onblur={(e) => commit(param.key, e.currentTarget.value, e.currentTarget)}
									onkeydown={(e) => {
										if (e.key === 'Enter') e.currentTarget.blur();
									}}
								/>
								{#if param.unit}<span class="unit">{param.unit}</span>{/if}
							</span>
						{/if}
						{#if problems[param.key]}
							<span class="problem" role="alert">{problems[param.key]}</span>
						{:else if param.description}
							<span class="description">{param.description}</span>
						{/if}
					</label>
				{/if}
			{/each}
		</div>

		<div class="actions">
			<button onclick={() => app.rotateSelection()} title="Turn a quarter turn; wires follow"
				>Rotate <kbd>R</kbd></button
			>
			<button class="danger" onclick={() => app.deleteSelection()}>Delete <kbd>Del</kbd></button>
		</div>
	{/if}

	{#if app.compiled.warnings.length > 0}
		<section class="issues">
			<h3>Loose ends</h3>
			<ul>
				{#each app.compiled.warnings.slice(0, 6) as warning, i (i)}
					<li>{warning}</li>
				{/each}
				{#if app.compiled.warnings.length > 6}
					<li class="more">…and {app.compiled.warnings.length - 6} more</li>
				{/if}
			</ul>
		</section>
	{/if}
</div>

<style>
	.inspector {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		padding: 0.75rem;
		height: 100%;
		min-height: 0;
		overflow-y: auto;
	}

	.hint {
		margin: 0;
		color: var(--label-dim);
		font-size: 0.8rem;
		line-height: 1.5;
	}

	header {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}

	.ref {
		font-family: var(--font-mono);
		font-size: 0.95rem;
		font-weight: 600;
		width: 5rem;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		padding: 0.15rem 0.3rem;
		color: var(--text);
	}

	.ref:hover,
	.ref:focus {
		border-color: var(--border);
		background: var(--control-bg);
		outline: none;
	}

	.kind {
		color: var(--label-dim);
		font-size: 0.78rem;
	}

	.fields {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.field-label {
		font-size: 0.7rem;
		color: var(--label-dim);
	}

	.description {
		font-size: 0.66rem;
		color: var(--label-dim);
		line-height: 1.4;
		opacity: 0.85;
	}

	.value-field {
		display: flex;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		overflow: hidden;
	}

	.value-field:focus-within {
		border-color: var(--accent);
	}

	.rejected,
	.value-field.rejected {
		border-color: var(--danger);
	}

	.problem {
		margin: 0;
		font-size: 0.66rem;
		line-height: 1.4;
		color: var(--danger);
	}

	.value-field input {
		flex: 1;
		min-width: 0;
		border: none;
		background: transparent;
		padding: 0.35rem 0.5rem;
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.82rem;
	}

	.value-field input:focus {
		outline: none;
	}

	.unit {
		padding: 0 0.5rem;
		color: var(--label-dim);
		font-size: 0.75rem;
		border-left: 1px solid var(--border);
		align-self: stretch;
		display: flex;
		align-items: center;
	}

	select {
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text);
		padding: 0.35rem 0.4rem;
		font-size: 0.82rem;
	}

	.actions {
		display: flex;
		gap: 0.35rem;
	}

	.actions button {
		flex: 1;
		padding: 0.35rem;
		font-size: 0.75rem;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--text);
		cursor: pointer;
	}

	.actions button:hover {
		background: var(--hover);
	}

	.actions .danger:hover {
		border-color: var(--danger);
		color: var(--danger);
	}

	.issues h3 {
		margin: 0 0 0.3rem;
		font-size: 0.66rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--label-dim);
		font-weight: 600;
	}

	.issues ul {
		margin: 0;
		padding-left: 1rem;
		font-size: 0.72rem;
		color: var(--label-dim);
		line-height: 1.5;
	}

	.more {
		list-style: none;
		margin-left: -1rem;
		opacity: 0.7;
	}

	kbd {
		font-family: var(--font-mono);
		font-size: 0.85em;
		opacity: 0.6;
	}
</style>
