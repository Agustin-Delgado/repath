<script lang="ts">
	import { Select } from '$lib/ui';
	import type { ParamDef } from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import {
		joinValue,
		parseValue,
		PREFIX_OPTIONS,
		splitValue,
		stepValue,
		type SplitValue
	} from '$lib/units';
	import { fieldBox, fieldInput, fieldLabel, hint, problem as problemClass } from './styles';

	/**
	 * One parameter of one part, edited in place.
	 *
	 * Mounted per part and per parameter — the panel keys it on both — so
	 * everything here (the half-typed text, the last refusal) belongs to this
	 * field of this part and goes away with it.
	 */
	type Props = {
		/** The part it edits, fixed for the life of the field. */
		id: string;
		param: ParamDef;
		value: number | string;
	};

	let { id, param, value }: Props = $props();

	/** Text currently in the field, so a half-typed value is not clobbered. */
	let editing = $state<string | null>(null);
	/**
	 * Why the last edit was refused.
	 *
	 * A refusal with no explanation is indistinguishable from a bug: the field
	 * kept whatever was typed while the model had rejected it, so the drawing and
	 * the screen disagreed and nothing said so.
	 */
	let refusal = $state<string | null>(null);

	/**
	 * How long the field waits after the last keystroke before applying.
	 *
	 * Long enough that `4700` goes in as one value rather than as four, short
	 * enough that typing a number and looking up at the circuit shows it already
	 * done. Leaving nothing to apply until Enter meant a value could sit on the
	 * screen looking set while the circuit was still running the old one.
	 */
	const SETTLE_MS = 350;
	let settling: ReturnType<typeof setTimeout> | undefined;
	/** A name typed but not yet applied, so leaving the field can apply it at once. */
	let pendingText: string | null = null;

	/** A quantity, as opposed to free text; decided by the definition, not the stored value. */
	const numeric = $derived(typeof param.default !== 'string');

	/** The number and the decade shown right now. */
	function split(current: number | string): SplitValue {
		if (typeof current !== 'number') return { mantissa: 0, prefix: '' };
		if (param.plain) return { mantissa: current, prefix: '' };
		return splitValue(current, 4);
	}

	/** Apply a value; whether it went in. */
	function apply(next: number | string): boolean {
		refusal = app.setParam(id, param.key, next);
		return refusal === null;
	}

	/** Typed with its own prefix — `4k7`, `10meg` — rather than beside the scale picker. */
	const hasOwnPrefix = (raw: string) => /[fpnuµμmkKMGT]|meg/i.test(raw.trim());

	/**
	 * A keystroke.
	 *
	 * The typed text is kept as-is — the field is not reformatted underneath
	 * someone mid-number — and the value goes in once the typing stops. Anything
	 * that does not parse yet is simply not applied: `-` and `4.` are on the way
	 * to a number, not mistakes, and complaining about them while they are still
	 * being typed would be nagging. Leaving the field or Enter still takes the
	 * full path, refusals and reformatting included.
	 */
	function typing(raw: string) {
		editing = raw;
		clearTimeout(settling);
		// Captured now: a timer that fires after the selection has moved on must
		// still apply to the part the value was typed for.
		const target = id;
		const prefix = split(value).prefix;
		settling = setTimeout(() => {
			const typed = parseValue(raw);
			if (typed === null) return;
			refusal = app.setParam(target, param.key, hasOwnPrefix(raw) ? typed : joinValue(typed, prefix));
		}, SETTLE_MS);
	}

	function commit(raw: string, field: HTMLInputElement) {
		clearTimeout(settling);
		/**
		 * Put the value that is actually in effect back in the box, written to the
		 * element: the model refused, so the rendered expression has not changed
		 * and Svelte will not touch the node to set it to what it already believes
		 * is there.
		 */
		const restore = () => {
			editing = null;
			field.value = String(split(value).mantissa);
		};
		// Someone with the habit will still type `4k7`, and there is no reason to
		// punish them for it — it parses, and the scale beside the field follows.
		const typed = parseValue(raw);
		if (typed === null) {
			refusal = `“${raw.trim()}” is not a number.`;
			restore();
			return;
		}
		const next = hasOwnPrefix(raw) ? typed : joinValue(typed, split(value).prefix);
		if (apply(next)) editing = null;
		else restore();
	}

	/**
	 * Nudge with the arrow keys, applied as it moves.
	 *
	 * Stepping the number being read rather than the underlying value keeps a
	 * nudge meaning the same thing at every scale, and re-splitting afterwards is
	 * what lets 999 Ω step up to 1 kΩ instead of growing a fourth digit. Shift
	 * takes ten at a time and Alt a tenth.
	 */
	function nudge(event: KeyboardEvent, field: HTMLInputElement) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
		if (typeof value !== 'number') return;
		event.preventDefault();
		const unit = param.plain ? (param.step ?? 1) : 1;
		const size = unit * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1);
		const by = event.key === 'ArrowUp' ? size : -size;
		const next = param.plain ? Number((value + by).toPrecision(12)) : stepValue(value, by, 4);
		if (apply(next)) {
			editing = null;
			// After a re-split the rendered mantissa is often one the expression
			// already produced — 1000 and 1 both read as 1 — so it is written here.
			// The prop reads through to the part, so it already holds the new value.
			field.value = String(split(value).mantissa);
		}
	}

	/**
	 * A name, on the same timer. Typing "output" into a probe used to be six
	 * undo steps, six trace lines and six recompiles of the whole circuit.
	 */
	function typingText(raw: string) {
		clearTimeout(settling);
		pendingText = raw;
		const target = id;
		settling = setTimeout(() => {
			pendingText = null;
			app.setParam(target, param.key, raw);
		}, SETTLE_MS);
	}

	/** Leaving the field, or Enter: whatever is still waiting goes in now. */
	function commitText() {
		clearTimeout(settling);
		if (pendingText === null) return;
		app.setParam(id, param.key, pendingText);
		pendingText = null;
	}

	/** The scale picker's keys; the empty prefix needs a key a select can hold. */
	const UNIT_KEY = '1';
	const scales = PREFIX_OPTIONS.map((option) => ({
		value: option.prefix || UNIT_KEY,
		label: option.label
	}));
</script>

<div class="flex flex-col gap-1">
	<span class={fieldLabel}>{param.label}</span>

	{#if param.choices}
		<Select
			items={param.choices}
			value={String(value)}
			onChange={(next) => app.setParam(id, param.key, next)}
			aria-label={param.label}
			class="w-full justify-between"
		/>
	{:else if !numeric}
		<!--
			Free text, not a quantity. The numeric machinery below — arrow keys that
			step it, an engineering prefix, a parse that refuses what is not one — is
			how a probe called "drive" once came back as "P1".
		-->
		<span class={fieldBox}>
			<input
				value={String(value ?? '')}
				aria-label={param.label}
				spellcheck="false"
				class={fieldInput}
				oninput={(e) => typingText(e.currentTarget.value)}
				onchange={commitText}
				onblur={commitText}
				onkeydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
				}}
			/>
		</span>
	{:else}
		<span class={fieldBox} data-rejected={refusal ? '' : undefined}>
			<input
				inputmode="decimal"
				aria-label={param.label}
				title="Arrow keys step the value — Shift for ten at a time, Alt for a tenth"
				value={editing ?? String(split(value).mantissa)}
				class={fieldInput}
				oninput={(e) => typing(e.currentTarget.value)}
				onblur={(e) => commit(e.currentTarget.value, e.currentTarget)}
				onkeydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
					else nudge(e, e.currentTarget);
				}}
			/>
			{#if typeof value === 'number' && !param.plain}
				<!-- Picking a scale changes the value, which is the point of picking one. -->
				<Select
					items={scales}
					value={split(value).prefix || UNIT_KEY}
					onChange={(next) =>
						apply(joinValue(split(value).mantissa, next === UNIT_KEY ? '' : next))}
					aria-label="{param.label} scale"
					size="sm"
					class="h-full rounded-none border-0 border-l border-border bg-transparent px-1.5 font-mono"
				/>
			{/if}
			{#if param.unit}
				<span class="shrink-0 border-l border-border px-2 font-mono text-[0.7rem] text-muted">
					{param.unit}
				</span>
			{/if}
		</span>
	{/if}

	{#if refusal}
		<span class={problemClass} role="alert">{refusal}</span>
	{:else if param.description}
		<span class={hint}>{param.description}</span>
	{/if}
</div>
