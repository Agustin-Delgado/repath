<script lang="ts">
	import { app } from '$lib/state.svelte';
	import { ledRating } from '$lib/schematic/led';
	import { pinKey } from '$lib/schematic/nets';
	import { definitionOf, isParamVisible } from '$lib/schematic/model';
	import { bjtFromCard, cardFor, diodeFromCard, mosfetFromCard, parseModelCards } from '$lib/spice';
	import {
		formatWithUnit,
		joinValue,
		parseValue,
		PREFIX_OPTIONS,
		splitValue,
		stepValue,
		type SplitValue
	} from '$lib/units';

	const instance = $derived(app.selectedInstances.length === 1 ? app.selectedInstances[0] : null);
	const def = $derived(instance ? definitionOf(instance.kind) : null);

	/** Whether every pin of the selected part lands on the same net. */
	const shorted = $derived.by(() => {
		if (!instance || !def || def.pins.length < 2) return false;
		const nets = new Set(
			def.pins.map((pin) => app.compiled.connectivity.netOfPin.get(pinKey(instance.id, pin.name)))
		);
		return nets.size === 1 && !nets.has(undefined);
	});

	/** What the selected LED is carrying right now, or null if that is not a question. */
	const lit = $derived.by(() => {
		if (instance?.kind !== 'led') return null;
		const current = app.currentThrough(instance.name);
		if (current === null) return null;
		const rated = ledRating(instance);
		return {
			current: Math.max(current, 0),
			rated,
			percent: Math.round((Math.max(current, 0) / rated) * 1000) / 10
		};
	});

	/**
	 * What the pasted card came to, or `undefined` for a part that does not take
	 * one. `null` means there is a box to paste into and nothing in it yet.
	 */
	const card = $derived.by(() => {
		if (!instance || !def?.params.some((p) => p.key === 'spice')) return undefined;
		const text = String(instance.params.spice ?? '');
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
	 * Why a paste did nothing.
	 *
	 * Silence here reads as "it worked": the fields above do not change when a
	 * card is applied — they are what it overrides — so with nothing said, text
	 * sitting in the box and a part still behaving like the generic one look
	 * exactly the same.
	 */
	const cardProblem = $derived.by(() => {
		if (!instance || card !== null) return null;
		const text = String(instance.params.spice ?? '');
		if (!text.trim()) return null;
		const cards = parseModelCards(text);
		if (cards.length === 0) return 'No .model card found in that text.';
		const types = [...new Set(cards.map((c) => c.type))].join(', ');
		return `That card is a ${types}, which does not fit a ${def?.label ?? 'part'}.`;
	});

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

	/** Parameters shown as a plain number keep their own, no prefix beside them. */
	function isPlain(key: string): boolean {
		return def?.params.find((p) => p.key === key)?.plain === true;
	}

	/** The number and the decade shown for a parameter right now. */
	function split(key: string, value: number | string): SplitValue {
		if (typeof value !== 'number') return { mantissa: 0, prefix: '' };
		if (isPlain(key)) return { mantissa: value, prefix: '' };
		return splitValue(value, 4);
	}

	/**
	 * Apply a value, reporting anything the model turns away.
	 *
	 * Returns whether it went in, so callers can decide whether to put the field
	 * back to what is actually in effect.
	 */
	function apply(key: string, value: number): boolean {
		if (!instance) return false;
		const refusal = app.setParam(instance.id, key, value);
		if (refusal) {
			problems[key] = refusal;
			return false;
		}
		delete problems[key];
		return true;
	}

	/**
	 * How long the field waits after the last keystroke before applying.
	 *
	 * Long enough that `4700` goes in as one value rather than as four, short
	 * enough that typing a number and looking up at the circuit shows it already
	 * done. Leaving nothing to apply until Enter meant a value could sit on the
	 * screen looking set while the circuit was still running the old one.
	 */
	const SETTLE_MS = 350;
	const settling: Record<string, ReturnType<typeof setTimeout>> = {};

	/**
	 * A keystroke.
	 *
	 * The typed text is kept as-is — the field is not reformatted underneath
	 * someone mid-number — and the value goes in once the typing stops. Anything
	 * that does not parse yet is simply not applied: `-` and `4.` are on the way
	 * to a number, not mistakes, and complaining about them while they are still
	 * being typed would be nagging. Pressing Enter or leaving the field still
	 * takes the full path, refusals and reformatting included.
	 */
	function typing(key: string, raw: string) {
		editing[key] = raw;
		clearTimeout(settling[key]);

		// Captured now: a timer that fires after the selection has moved on must
		// still apply to the part the value was typed for.
		const id = instance?.id;
		const prefix = instance ? split(key, instance.params[key]).prefix : '';
		if (!id) return;

		settling[key] = setTimeout(() => {
			const typed = parseValue(raw);
			if (typed === null) return;
			const hasOwnPrefix = /[fpnuµμmkKMGT]|meg/i.test(raw.trim());
			const refusal = app.setParam(id, key, hasOwnPrefix ? typed : joinValue(typed, prefix));
			if (refusal) problems[key] = refusal;
			else delete problems[key];
		}, SETTLE_MS);
	}

	/**
	 * The card box, on the same timer as every other field.
	 *
	 * A paste arrives as one event and would be fine either way, but a card that
	 * is typed or corrected by hand would otherwise be one undo step and one trace
	 * line per keystroke — which buries whatever came before it.
	 */
	function typingCard(raw: string) {
		clearTimeout(settling.spice);
		const id = instance?.id;
		if (!id) return;
		settling.spice = setTimeout(() => app.setParam(id, 'spice', raw), SETTLE_MS);
	}

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
			field.value = String(split(key, instance.params[key]).mantissa);
		};

		// The field takes a plain number now, but someone with the habit will still
		// type `4k7`, and there is no reason to punish them for it — it parses, and
		// the prefix beside the field moves to match.
		const typed = parseValue(raw);
		if (typed === null) {
			problems[key] = `“${raw.trim()}” is not a number.`;
			restore();
			return;
		}
		const hasOwnPrefix = /[fpnuµμmkKMGT]|meg/i.test(raw.trim());
		const value = hasOwnPrefix ? typed : joinValue(typed, split(key, instance.params[key]).prefix);

		if (!apply(key, value)) restore();
		else delete editing[key];
	}

	/**
	 * Nudge a value with the arrow keys, applied as it moves.
	 *
	 * Stepping the number being read rather than the underlying value keeps a
	 * nudge meaning the same thing at every scale, and re-splitting afterwards is
	 * what lets 999 Ω step up to 1 kΩ instead of growing a fourth digit.
	 *
	 * Shift takes ten at a time and Alt a tenth, so a coarse sweep and a fine
	 * adjustment are the same key.
	 */
	function nudge(event: KeyboardEvent, key: string, field: HTMLInputElement) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		if (!instance || typeof instance.params[key] !== 'number') return;

		event.preventDefault();
		const param = def?.params.find((p) => p.key === key);
		const unit = param?.plain ? (param.step ?? 1) : 1;
		const size = unit * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1);
		const by = event.key === 'ArrowUp' ? size : -size;
		const current = instance.params[key] as number;
		const next = param?.plain
			? Number((current + by).toPrecision(12))
			: stepValue(current, by, 4);

		if (apply(key, next)) {
			delete editing[key];
			// The binding will not rewrite a field whose rendered value it thinks is
			// unchanged, and after a re-split it often is — 1000 and 1 both read as a
			// mantissa the expression already produced.
			field.value = String(split(key, instance.params[key]).mantissa);
		}
	}

	function setPrefix(key: string, prefix: string) {
		if (!instance || typeof instance.params[key] !== 'number') return;
		// Picking a prefix changes the value, which is the whole point of picking
		// one; keeping the value and restating it would just be a different way of
		// writing the same number.
		apply(key, joinValue(split(key, instance.params[key]).mantissa, prefix));
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
		return typeof value === 'number' ? String(split(key, value).mantissa) : String(value);
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
				{#if !param.hidden && isParamVisible(param, instance.params)}
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
						{:else if typeof param.default === 'string'}
							<!--
								Free text, not a quantity. Everything below is built for a number
								and a unit — arrow keys that step it, an engineering prefix, a
								parse that refuses what is not one — and running a name through
								that machinery is how a probe called "drive" came back as "P1".
							-->
							<input
								class="text"
								value={String(instance.params[param.key] ?? '')}
								oninput={(e) => app.setParam(instance.id, param.key, e.currentTarget.value)}
								onkeydown={(e) => {
									if (e.key === 'Enter') e.currentTarget.blur();
								}}
							/>
						{:else}
							<span class="value-field" class:rejected={problems[param.key]}>
								<input
									class="number"
									inputmode="decimal"
									title="Arrow keys step the value — Shift for ten at a time, Alt for a tenth"
									value={displayed(param.key, instance.params[param.key])}
									oninput={(e) => typing(param.key, e.currentTarget.value)}
									onblur={(e) => {
										clearTimeout(settling[param.key]);
										commit(param.key, e.currentTarget.value, e.currentTarget);
									}}
									onkeydown={(e) => {
										if (e.key === 'Enter') e.currentTarget.blur();
										else nudge(e, param.key, e.currentTarget);
									}}
								/>
								{#if typeof instance.params[param.key] === 'number' && !param.plain}
									<select
										class="prefix"
										aria-label="{param.label} scale"
										value={splitValue(instance.params[param.key] as number, 4).prefix}
										onchange={(e) => setPrefix(param.key, e.currentTarget.value)}
									>
										{#each PREFIX_OPTIONS as option (option.prefix)}
											<option value={option.prefix}>{option.label}</option>
										{/each}
									</select>
								{/if}
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

		<!--
			Why an LED is not lighting is the question this readout exists to answer.
			Brightness is not linear in current, so a part carrying a fiftieth of its
			rating is very nearly dark, and there is no way to tell that from the
			drawing alone — the difference between "barely on" and "off" is a few
			pixels of glow. Saying the number, and what it is a fraction of, turns
			guessing into arithmetic.
		-->
		{#if lit}
			<p class="reading">
				Carrying <strong>{formatWithUnit(lit.current, 'A')}</strong>, {lit.percent}% of its
				{formatWithUnit(lit.rated, 'A')} rating.
				{#if shorted}
					Nothing can flow through it: a wire runs straight past it, joining both of its pins. Move
					the wire so it ends on each pin instead of crossing them.
				{:else if lit.percent < 5}
					Too little to light: check how much voltage is left over the series resistor once the LED
					has taken its forward drop.
				{/if}
			</p>
		{/if}

		<!--
			A part is a paste from the manufacturer rather than a row of numbers
			transcribed by hand. What the card could not be used for is named rather
			than dropped quietly: a 2N3904 without its high-level injection keeps its
			gain at currents where the real part has lost most of it, and the gap
			between a simplification and a lie is whether it is stated.
		-->
		{#if card !== undefined}
			<section class="spice">
				<h3>SPICE model</h3>
				{#if card}
					<p class="loaded">
						Using <strong>{card.name}</strong>. Its values override the fields above.
					</p>
					{#if card.ignored.length > 0}
						<p class="dropped">
							Not modelled here: {card.ignored.join(', ')}.
						</p>
					{/if}
				{/if}
				<textarea
					rows="3"
					spellcheck="false"
					placeholder=".model 2N3904 NPN(IS=6.734f BF=416.4 VAF=74.03 …)"
					value={String(instance.params.spice ?? '')}
					oninput={(e) => typingCard(e.currentTarget.value)}
					onblur={(e) => {
						// Read from the field, not from what the last keystroke left behind:
						// focusing this box and leaving it without typing has to be a
						// no-op, and taking the pending value would blank the card instead.
						clearTimeout(settling.spice);
						if (instance) app.setParam(instance.id, 'spice', e.currentTarget.value);
					}}
					aria-label="SPICE model card"
				></textarea>
				{#if cardProblem}
					<p class="problem" role="alert">{cardProblem}</p>
				{/if}
			</section>
		{/if}

		<div class="actions">
			<button onclick={() => app.rotateSelection()} title="Turn a quarter turn; wires follow"
				>Rotate <kbd>R</kbd></button
			>
			<button class="danger" onclick={() => app.deleteSelection()}>Delete <kbd>Del</kbd></button>
		</div>
	{/if}

	{#if app.burnouts.length > 0}
		<section class="issues burnt">
			<h3>Burnt out</h3>
			<ul>
				{#each app.burnouts as burnout (burnout.instanceId)}
					<li>
						<strong>{burnout.name}</strong> reached
						{formatWithUnit(burnout.peak, 'A')} against a
						{formatWithUnit(burnout.rated, 'A')} rating, and went at
						{formatWithUnit(burnout.time, 's')}.
					</li>
				{/each}
			</ul>
			<p class="caveat">
				{app.burnouts.length === 1 ? 'It is' : 'They are'} open from then on, and the rest of the
				run is the circuit without {app.burnouts.length === 1 ? 'it' : 'them'}. Add a series
				resistor to keep {app.burnouts.length === 1 ? 'it' : 'them'} alive.
			</p>
		</section>
	{/if}

	{#if app.compiled.warnings.length > 0}
		<section class="issues">
			<!-- Not "loose ends" any more: a part shorted by a wire drawn past it is
			     the opposite problem, and belongs in the same list. -->
			<h3>Check the wiring</h3>
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

	.fields input.text {
		width: 100%;
		box-sizing: border-box;
		font-size: 0.72rem;
		padding: 0.2rem 0.35rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--control-bg);
		color: var(--label-strong);
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

	.prefix {
		border: none;
		border-left: 1px solid var(--border);
		border-radius: 0;
		background: transparent;
		color: var(--text);
		font-family: var(--font-mono);
		font-size: 0.8rem;
		padding: 0 0.15rem 0 0.3rem;
		align-self: stretch;
		cursor: pointer;
	}

	.prefix:hover {
		background: var(--hover);
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

	.burnt h3 {
		color: var(--danger);
	}

	.burnt strong {
		color: var(--label-strong);
		font-weight: 600;
	}

	.reading {
		margin: 0;
		padding: 0.4rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		font-size: 0.7rem;
		line-height: 1.5;
		color: var(--label-dim);
	}

	.reading strong {
		font-family: var(--font-mono);
		color: var(--label-strong);
		font-weight: 600;
	}

	.spice {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.spice h3 {
		margin: 0;
		font-size: 0.66rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--label-dim);
		font-weight: 600;
	}

	.spice textarea {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		font-family: var(--font-mono);
		font-size: 0.66rem;
		line-height: 1.5;
		padding: 0.35rem 0.45rem;
		border: 1px solid var(--border);
		border-radius: 5px;
		background: var(--control-bg);
		color: var(--label-strong);
	}

	.spice .loaded,
	.spice .dropped {
		margin: 0;
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--label-dim);
	}

	.spice .loaded strong {
		font-family: var(--font-mono);
		color: var(--label-strong);
		font-weight: 600;
	}

	/* Said quietly. It is a limit worth knowing, not a fault to fix. */
	.spice .dropped {
		opacity: 0.8;
		word-break: break-word;
	}

	.caveat {
		margin: 0.35rem 0 0;
		font-size: 0.68rem;
		line-height: 1.45;
		color: var(--label-dim);
		opacity: 0.85;
	}

	kbd {
		font-family: var(--font-mono);
		font-size: 0.85em;
		opacity: 0.6;
	}
</style>
