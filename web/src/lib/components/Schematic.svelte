<script lang="ts">
	import { app } from '$lib/state.svelte';
	import {
		GRID,
		definitionOf,
		pinPosition,
		pointKey,
		snap,
		type Instance,
		type Wire
	} from '$lib/schematic/model';
	import { junctionDots } from '$lib/schematic/nets';
	import { formatWithUnit } from '$lib/units';
	import Symbol from './Symbol.svelte';

	let svg = $state<SVGSVGElement | null>(null);
	let view = $state({ x: 0, y: 0, scale: 1 });
	let hoverNet = $state<number | null>(null);

	type Drag =
		| { kind: 'none' }
		| { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }
		| { kind: 'move'; lastX: number; lastY: number; moved: boolean }
		| { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }
		| { kind: 'wire'; x0: number; y0: number; x1: number; y1: number };

	let drag = $state<Drag>({ kind: 'none' });

	const dots = $derived(junctionDots(app.schematic));
	const connectivity = $derived(app.compiled.connectivity);

	/** Net index -> the colour its trace is drawn in, for probed nets. */
	const probeColours = $derived(
		new Map(app.activeProbes.map((p) => [p.netIndex, p.colour] as const))
	);

	/**
	 * Pointer capture keeps a drag alive when the cursor leaves the SVG. It can
	 * throw if the pointer is already gone, and an exception here would abandon
	 * the rest of the handler — leaving the gesture half-started.
	 */
	function capture(pointerId: number, on: boolean) {
		try {
			if (on) svg?.setPointerCapture(pointerId);
			else svg?.releasePointerCapture(pointerId);
		} catch {
			// Nothing to recover: the drag still works, it just stops at the edge.
		}
	}

	function toWorld(event: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = svg?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return {
			x: (event.clientX - rect.left - view.x) / view.scale,
			y: (event.clientY - rect.top - view.y) / view.scale
		};
	}

	function netAtPoint(x: number, y: number): number | undefined {
		return connectivity.netOfPoint.get(pointKey(x, y));
	}

	function wireNet(wire: Wire): number | undefined {
		return netAtPoint(wire.x1, wire.y1);
	}

	function labelFor(instance: Instance): string | null {
		const p = instance.params;
		switch (instance.kind) {
			case 'resistor':
				return formatWithUnit(Number(p.resistance), 'Ω');
			case 'capacitor':
				return formatWithUnit(Number(p.capacitance), 'F');
			case 'inductor':
				return formatWithUnit(Number(p.inductance), 'H');
			case 'vsource':
				return p.waveform === 'dc'
					? formatWithUnit(Number(p.value), 'V')
					: `${formatWithUnit(Number(p.value), 'V')} @ ${formatWithUnit(Number(p.frequency), 'Hz')}`;
			case 'isource':
				return formatWithUnit(Number(p.value), 'A');
			case 'clock':
				return formatWithUnit(Number(p.frequency), 'Hz');
			default:
				return null;
		}
	}

	// -- pointer handling ---------------------------------------------------

	function onBackgroundPointerDown(event: PointerEvent) {
		if (event.button === 1 || event.altKey) {
			drag = {
				kind: 'pan',
				startX: event.clientX,
				startY: event.clientY,
				originX: view.x,
				originY: view.y
			};
			capture(event.pointerId, true);
			event.preventDefault();
			return;
		}
		if (event.button !== 0) return;

		const world = toWorld(event);
		const x = snap(world.x);
		const y = snap(world.y);

		if (app.tool.mode === 'place') {
			app.place(app.tool.kind, x, y);
			// Stay in place mode so a row of resistors is one click each.
			return;
		}
		if (app.tool.mode === 'wire') {
			drag = { kind: 'wire', x0: x, y0: y, x1: x, y1: y };
			capture(event.pointerId, true);
			return;
		}

		if (!event.shiftKey) app.selection = [];
		drag = { kind: 'marquee', x0: world.x, y0: world.y, x1: world.x, y1: world.y };
		capture(event.pointerId, true);
	}

	function onItemPointerDown(event: PointerEvent, id: string) {
		if (app.tool.mode !== 'select' || event.button !== 0 || event.altKey) return;
		event.stopPropagation();

		if (event.shiftKey) {
			app.selection = app.selection.includes(id)
				? app.selection.filter((s) => s !== id)
				: [...app.selection, id];
		} else if (!app.selection.includes(id)) {
			app.selection = [id];
		}

		const world = toWorld(event);
		drag = { kind: 'move', lastX: snap(world.x), lastY: snap(world.y), moved: false };
		capture(event.pointerId, true);
	}

	function onPointerMove(event: PointerEvent) {
		if (drag.kind === 'none') return;
		const world = toWorld(event);

		switch (drag.kind) {
			case 'pan':
				view.x = drag.originX + (event.clientX - drag.startX);
				view.y = drag.originY + (event.clientY - drag.startY);
				break;
			case 'move': {
				const x = snap(world.x);
				const y = snap(world.y);
				const dx = x - drag.lastX;
				const dy = y - drag.lastY;
				if (dx || dy) {
					// Only checkpoint once, on the first movement of the gesture, so
					// undo steps back over the whole drag rather than one grid unit.
					app.moveSelection(dx, dy, !drag.moved);
					drag = { kind: 'move', lastX: x, lastY: y, moved: true };
				}
				break;
			}
			case 'marquee':
				drag = { ...drag, x1: world.x, y1: world.y };
				break;
			case 'wire':
				drag = { ...drag, x1: snap(world.x), y1: snap(world.y) };
				break;
		}
	}

	function onPointerUp(event: PointerEvent) {
		if (drag.kind === 'marquee') {
			const lo = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1) };
			const hi = { x: Math.max(drag.x0, drag.x1), y: Math.max(drag.y0, drag.y1) };
			if (hi.x - lo.x > 3 || hi.y - lo.y > 3) {
				const inside = (x: number, y: number) => x >= lo.x && x <= hi.x && y >= lo.y && y <= hi.y;
				const hits = [
					...app.schematic.instances.filter((i) => inside(i.x, i.y)).map((i) => i.id),
					...app.schematic.wires
						.filter((w) => inside(w.x1, w.y1) && inside(w.x2, w.y2))
						.map((w) => w.id)
				];
				app.selection = event.shiftKey ? [...new Set([...app.selection, ...hits])] : hits;
			}
		} else if (drag.kind === 'wire') {
			app.addWire(drag.x0, drag.y0, drag.x1, drag.y1);
		}
		drag = { kind: 'none' };
		capture(event.pointerId, false);
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		const rect = svg?.getBoundingClientRect();
		if (!rect) return;
		const px = event.clientX - rect.left;
		const py = event.clientY - rect.top;
		const factor = Math.exp(-event.deltaY * 0.0015);
		const next = Math.min(Math.max(view.scale * factor, 0.25), 4);
		// Keep the point under the cursor fixed while zooming.
		view.x = px - ((px - view.x) * next) / view.scale;
		view.y = py - ((py - view.y) * next) / view.scale;
		view.scale = next;
	}

	function onKeyDown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
			event.preventDefault();
			if (event.shiftKey) app.redo();
			else app.undo();
			return;
		}
		switch (event.key) {
			case 'Delete':
			case 'Backspace':
				event.preventDefault();
				app.deleteSelection();
				break;
			case 'r':
			case 'R':
				app.rotateSelection();
				break;
			case 'w':
			case 'W':
				app.tool = { mode: 'wire' };
				break;
			case 'Escape':
				app.tool = { mode: 'select' };
				app.selection = [];
				drag = { kind: 'none' };
				break;
		}
	}

	export function fitToContent() {
		const items = app.schematic.instances;
		if (items.length === 0 || !svg) return;
		const xs = items.map((i) => i.x);
		const ys = items.map((i) => i.y);
		const rect = svg.getBoundingClientRect();
		const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
		const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
		view.scale = 1;
		view.x = rect.width / 2 - cx;
		view.y = rect.height / 2 - cy;
	}

	$effect(() => {
		// Re-centre whenever a different example is loaded.
		app.exampleId;
		queueMicrotask(fitToContent);
	});
</script>

<svelte:window onkeydown={onKeyDown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<svg
	bind:this={svg}
	class="canvas"
	class:placing={app.tool.mode === 'place'}
	class:wiring={app.tool.mode === 'wire'}
	role="application"
	aria-label="Schematic editor"
	onpointerdown={onBackgroundPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onwheel={onWheel}
	oncontextmenu={(e) => e.preventDefault()}
>
	<defs>
		<pattern
			id="grid"
			width={GRID * view.scale}
			height={GRID * view.scale}
			patternUnits="userSpaceOnUse"
			x={view.x}
			y={view.y}
		>
			<circle cx="0.5" cy="0.5" r="0.9" class="grid-dot" />
		</pattern>
	</defs>
	<rect width="100%" height="100%" fill="url(#grid)" />

	<g transform="translate({view.x} {view.y}) scale({view.scale})">
		<!-- wires -->
		{#each app.schematic.wires as wire (wire.id)}
			{@const net = wireNet(wire)}
			{@const colour = net === undefined ? undefined : probeColours.get(net)}
			<g
				class="wire"
				class:selected={app.selection.includes(wire.id)}
				class:hovered={net !== undefined && net === hoverNet}
				onpointerdown={(e) => onItemPointerDown(e, wire.id)}
				onpointerenter={() => (hoverNet = net ?? null)}
				onpointerleave={() => (hoverNet = null)}
				role="presentation"
			>
				<line
					x1={wire.x1}
					y1={wire.y1}
					x2={wire.x2}
					y2={wire.y2}
					class="hit"
					stroke="transparent"
					stroke-width="10"
				/>
				<line
					x1={wire.x1}
					y1={wire.y1}
					x2={wire.x2}
					y2={wire.y2}
					style:stroke={colour}
					style:stroke-width={colour ? 2.5 : undefined}
				/>
			</g>
		{/each}

		{#each dots as dot, i (i)}
			<circle cx={dot.x} cy={dot.y} r="3.5" class="junction" />
		{/each}

		<!-- components -->
		{#each app.schematic.instances as instance (instance.id)}
			{@const def = definitionOf(instance.kind)}
			{@const selected = app.selection.includes(instance.id)}
			<g
				class="instance"
				class:selected
				onpointerdown={(e) => onItemPointerDown(e, instance.id)}
				role="presentation"
			>
				<g transform="translate({instance.x} {instance.y}) rotate({instance.rotation})">
					<Symbol kind={instance.kind} params={instance.params} />
				</g>

				{#each def.pins as pin (pin.name)}
					{@const pos = pinPosition(instance, pin)}
					{@const net = netAtPoint(pos.x, pos.y)}
					<circle
						cx={pos.x}
						cy={pos.y}
						r="3"
						class="pin"
						class:digital={pin.domain === 'digital'}
						class:hovered={net !== undefined && net === hoverNet}
						onpointerenter={() => (hoverNet = net ?? null)}
						onpointerleave={() => (hoverNet = null)}
						role="presentation"
					/>
				{/each}

				{#if instance.kind !== 'ground'}
					<!-- Vertical parts get their text stacked to the right instead of
					     above and below, where the pins already are. -->
					{@const upright = instance.rotation === 0 || instance.rotation === 180}
					{@const extent = def.bodyExtent ?? 30}
					{@const tx = upright ? instance.x : instance.x + extent - 8}
					<text
						x={tx}
						y={upright ? instance.y - extent : instance.y - 4}
						class="ref"
						class:side={!upright}>{instance.name}</text
					>
					{#if labelFor(instance)}
						<text
							x={tx}
							y={upright ? instance.y + extent + 12 : instance.y + 10}
							class="value"
							class:side={!upright}>{labelFor(instance)}</text
						>
					{/if}
				{/if}
			</g>
		{/each}

		<!-- in-flight wire -->
		{#if drag.kind === 'wire'}
			<polyline
				points="{drag.x0},{drag.y0} {drag.x1},{drag.y0} {drag.x1},{drag.y1}"
				class="wire-preview"
			/>
		{/if}

		{#if drag.kind === 'marquee'}
			<rect
				x={Math.min(drag.x0, drag.x1)}
				y={Math.min(drag.y0, drag.y1)}
				width={Math.abs(drag.x1 - drag.x0)}
				height={Math.abs(drag.y1 - drag.y0)}
				class="marquee"
			/>
		{/if}
	</g>
</svg>

<style>
	.canvas {
		width: 100%;
		height: 100%;
		display: block;
		background: var(--canvas-bg);
		touch-action: none;
		cursor: default;
		user-select: none;
	}

	.canvas.placing,
	.canvas.wiring {
		cursor: crosshair;
	}

	.grid-dot {
		fill: var(--grid-dot);
	}

	.wire line:not(.hit) {
		stroke: var(--wire);
		stroke-width: 2;
		stroke-linecap: round;
		pointer-events: none;
	}

	.wire.hovered line:not(.hit) {
		stroke: var(--accent);
		stroke-width: 3;
	}

	.wire.selected line:not(.hit) {
		stroke: var(--selection);
		stroke-width: 3;
	}

	.wire .hit {
		cursor: pointer;
	}

	.junction {
		fill: var(--wire);
		pointer-events: none;
	}

	.instance {
		--symbol-stroke: var(--symbol);
		cursor: grab;
	}

	.instance.selected {
		--symbol-stroke: var(--selection);
	}

	.pin {
		fill: var(--canvas-bg);
		stroke: var(--pin);
		stroke-width: 1.5;
	}

	.pin.digital {
		stroke: var(--pin-digital);
	}

	.pin.hovered {
		fill: var(--accent);
		stroke: var(--accent);
	}

	.ref,
	.value {
		text-anchor: middle;
		font-size: 11px;
		pointer-events: none;
		font-family: var(--font-mono);
	}

	.ref.side,
	.value.side {
		text-anchor: start;
	}

	.ref {
		fill: var(--label-strong);
	}

	.value {
		fill: var(--label-dim);
	}

	.wire-preview {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-dasharray: 5 4;
	}

	.marquee {
		fill: color-mix(in srgb, var(--accent) 12%, transparent);
		stroke: var(--accent);
		stroke-width: 1;
		stroke-dasharray: 4 3;
	}
</style>
