<script lang="ts">
	import TextInput from '../field/TextInput.svelte';
	import {
		angleOf,
		arcPath,
		dragTo,
		keyTo,
		percent,
		readPercent,
		SWEEP,
		UNIT_RANGE,
		wheelTo,
		type KnobRange
	} from './knob';

	/**
	 * A rotary knob for a fraction: drag up or down, roll the wheel, use the
	 * keys, or double-click to type a percentage.
	 *
	 * Hand-built rather than on the kit's Slider: that one is a track, and a
	 * press on it jumps the thumb to the pointer. A knob turns from where it
	 * is by how far the hand moves, which a track has no way to say.
	 */
	type Props = {
		value: number;
		/** Names the slider. */
		label: string;
		/** What a screen reader hears and the readout shows under the percentage. */
		detail?: string;
		range?: KnobRange;
		disabled?: boolean;
		/** Turn it. `first` starts a turn: a press, a key, a new roll of the wheel. */
		onturn: (value: number, first: boolean) => void;
	};

	let { value, label, detail = '', range = UNIT_RANGE, disabled = false, onturn }: Props = $props();

	let dial = $state<HTMLDivElement | null>(null);
	let typing = $state(false);
	let dragging = $state(false);
	let drag: { id: number; y: number; from: number; first: boolean } | null = null;
	/** When the wheel last moved, so a pause starts a new turn. */
	let rolledAt = -Infinity;

	const angle = $derived(angleOf(value, range));
	const shown = $derived(percent(value, range));
	const track = arcPath(20, 20, 15, -SWEEP / 2, SWEEP / 2);
	const fill = $derived(arcPath(20, 20, 15, -SWEEP / 2, Math.max(angle, -SWEEP / 2 + 0.01)));

	function turn(next: number, first: boolean) {
		if (disabled || next === value) return;
		onturn(next, first);
	}

	function down(event: PointerEvent) {
		if (disabled || event.button !== 0) return;
		event.preventDefault();
		dial?.focus();
		dial?.setPointerCapture(event.pointerId);
		drag = { id: event.pointerId, y: event.clientY, from: value, first: true };
		dragging = true;
	}

	function move(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.id) return;
		const next = dragTo(drag.from, event.clientY - drag.y, range, event.shiftKey);
		if (next === value) return;
		turn(next, drag.first);
		drag.first = false;
	}

	function up(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.id) return;
		drag = null;
		dragging = false;
	}

	function key(event: KeyboardEvent) {
		const next = keyTo(value, event.key, range, event.shiftKey);
		if (next === null) {
			if (event.key === 'Enter') typing = true;
			return;
		}
		event.preventDefault();
		turn(next, true);
	}

	// Not passive: the wheel turns the knob rather than scrolling the panel.
	$effect(() => {
		const element = dial;
		if (!element) return;
		const roll = (event: WheelEvent) => {
			if (disabled) return;
			event.preventDefault();
			const now = performance.now();
			turn(wheelTo(value, event.deltaY, range, event.shiftKey), now - rolledAt > 400);
			rolledAt = now;
		};
		element.addEventListener('wheel', roll, { passive: false });
		return () => element.removeEventListener('wheel', roll);
	});

	function finish(text: string | null) {
		typing = false;
		if (text !== null) {
			const next = readPercent(text, range);
			if (next !== null) turn(next, true);
		}
		queueMicrotask(() => dial?.focus());
	}
</script>

<div class="flex items-center gap-2.5" data-disabled={disabled ? '' : undefined}>
	<div
		bind:this={dial}
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label={label}
		aria-valuemin={range.min}
		aria-valuemax={range.max}
		aria-valuenow={value}
		aria-valuetext={detail ? `${shown}, ${detail}` : shown}
		aria-disabled={disabled || undefined}
		title={disabled ? undefined : 'Drag up or down, scroll or use the arrow keys. Double-click to type.'}
		class="knob size-10 shrink-0 touch-none rounded-full outline-none select-none focus-visible:focus-ring
			{disabled ? 'cursor-not-allowed opacity-50' : 'cursor-ns-resize'}"
		data-dragging={dragging ? '' : undefined}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={up}
		onpointercancel={up}
		onkeydown={key}
		ondblclick={() => {
			if (!disabled) typing = true;
		}}
	>
		<svg viewBox="0 0 40 40" class="size-full" aria-hidden="true">
			<circle cx="20" cy="20" r="11" class="fill-control stroke-border-strong" />
			<path d={track} class="fill-none stroke-border" stroke-width="3" stroke-linecap="round" />
			<path d={fill} class="fill-none stroke-accent" stroke-width="3" stroke-linecap="round" />
			<g class="pointer" style:transform="rotate({angle}deg)">
				<line x1="20" y1="20" x2="20" y2="11" class="stroke-fg" stroke-width="2" stroke-linecap="round" />
			</g>
		</svg>
	</div>

	<div class="flex min-w-0 flex-col">
		{#if typing}
			<TextInput
				class="h-6 w-20 rounded-control border border-accent bg-control px-1.5 font-mono text-ui text-fg outline-none"
				value={shown.replace(' %', '')}
				aria-label="{label} in percent"
				inputmode="decimal"
				autofocus
				onfocus={(e) => e.currentTarget.select()}
				onblur={(e) => finish(e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
					else if (e.key === 'Escape') {
						e.preventDefault();
						finish(null);
					}
					e.stopPropagation();
				}}
			/>
		{:else}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span
				class="font-mono text-ui text-fg {disabled ? '' : 'cursor-text'}"
				ondblclick={() => {
					if (!disabled) typing = true;
				}}
			>
				{shown}
			</span>
		{/if}
		{#if detail}
			<span class="truncate font-mono text-3xs text-muted">{detail}</span>
		{/if}
	</div>
</div>

<style>
	.pointer {
		transform-origin: 20px 20px;
		transform-box: view-box;
	}

	/* A key press steps the pointer round; a drag follows the hand exactly. */
	@media (prefers-reduced-motion: no-preference) {
		.knob:not([data-dragging]) .pointer {
			transition: transform var(--duration-fast) var(--ease-out-strong);
		}
	}
</style>
