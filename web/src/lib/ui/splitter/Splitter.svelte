<script lang="ts">
	/**
	 * The edge of a panel, dragged to resize it.
	 *
	 * It sits inside the panel against the edge it moves, so the panel's own
	 * overflow cannot clip it. `grow` says which way a drag makes the panel
	 * bigger: a left sidebar grows to the right, a right one to the left, and a
	 * panel along the bottom grows upwards. Arrow keys move it too, and a double
	 * click puts it back where it started.
	 */
	type Props = {
		/** The panel's size in pixels. */
		size: number;
		grow: 'right' | 'left' | 'up';
		min: number;
		max: number;
		/** Where a double click puts it back to. */
		initial: number;
		label: string;
		onResize: (size: number) => void;
		/** When a drag or a key press has finished. */
		onCommit?: () => void;
		class?: string;
	};

	let { size, grow, min, max, initial, label, onResize, onCommit, class: className = '' }: Props =
		$props();

	const vertical = $derived(grow !== 'up');
	let start: { at: number; size: number } | null = $state(null);

	function coordinate(event: PointerEvent): number {
		return vertical ? event.clientX : event.clientY;
	}

	function onpointerdown(event: PointerEvent) {
		if (event.button !== 0) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		start = { at: coordinate(event), size };
	}

	function onpointermove(event: PointerEvent) {
		if (!start) return;
		const delta = coordinate(event) - start.at;
		onResize(start.size + (grow === 'right' ? delta : -delta));
	}

	function onpointerup(event: PointerEvent) {
		if (!start) return;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
		start = null;
		onCommit?.();
	}

	function onkeydown(event: KeyboardEvent) {
		const step = event.shiftKey ? 48 : 16;
		const bigger = { right: 'ArrowRight', left: 'ArrowLeft', up: 'ArrowUp' }[grow];
		const smaller = { right: 'ArrowLeft', left: 'ArrowRight', up: 'ArrowDown' }[grow];
		if (event.key === bigger) onResize(size + step);
		else if (event.key === smaller) onResize(size - step);
		else if (event.key === 'Home') onResize(min);
		else if (event.key === 'End') onResize(max);
		else return;
		event.preventDefault();
		onCommit?.();
	}
</script>

<!-- A focusable separator is a widget in ARIA terms, which the checker does not know. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	role="separator"
	tabindex="0"
	aria-label={label}
	aria-orientation={vertical ? 'vertical' : 'horizontal'}
	aria-valuenow={size}
	aria-valuemin={min}
	aria-valuemax={max}
	title="Drag to resize; double-click to reset"
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	onpointercancel={onpointerup}
	ondblclick={() => {
		onResize(initial);
		onCommit?.();
	}}
	{onkeydown}
	class="group absolute z-20 touch-none outline-none select-none {vertical
		? 'inset-y-0 w-1.5 cursor-col-resize'
		: 'inset-x-0 h-1.5 cursor-row-resize'} {grow === 'right'
		? 'right-0'
		: grow === 'left'
			? 'left-0'
			: 'top-0'} {className}"
>
	<!-- A hairline that lights up on hover, focus or drag, so the handle is findable but quiet. -->
	<span
		class="pointer-events-none absolute bg-accent opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-100 {start
			? 'opacity-100'
			: ''} {vertical
			? `inset-y-0 w-0.5 ${grow === 'right' ? 'right-0' : 'left-0'}`
			: 'inset-x-0 top-0 h-0.5'}"
	></span>
</div>
