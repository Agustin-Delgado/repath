<script lang="ts">
	/**
	 * A DC sweep: what each probed net sits at, and what each chosen part
	 * carries, against the value of the source being swept.
	 *
	 * Volts and amperes in panels of their own over one shared axis, the way
	 * the Bode plot keeps magnitude and phase apart: an I-V curve and a transfer
	 * curve share nothing but the drive they were measured at.
	 */
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';
	import { niceStep, paddedRange, sweepPanels, type Rect } from '$lib/plot-layout';
	import { ticks } from '$lib/plot';
	import { watchPixelRatio } from '$lib/canvas/pixel-ratio';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let host = $state<HTMLDivElement | null>(null);
	let size = $state({ width: 0, height: 0 });
	let cursor = $state<number | null>(null);

	const PADDING = { left: 64, right: 26, top: 12, bottom: 30 };

	interface Trace {
		key: string;
		label: string;
		colour: string;
		samples: Float64Array;
	}

	/** The swept source's unit: what it was set in at each point. */
	const unit = $derived(
		app.dcSources.find((s) => s.name === app.dcResult?.source)?.unit ?? app.dcSwept?.unit ?? 'V'
	);

	const voltages = $derived.by((): Trace[] => {
		const run = app.dcResult;
		if (!run) return [];
		const out: Trace[] = [];
		for (const probe of app.activeProbes) {
			if (!probe.analog || probe.analog === 'gnd') continue;
			const index = run.unknownNames.indexOf(`v(${probe.analog})`);
			if (index < 0) continue;
			out.push({ key: probe.key, label: probe.label, colour: probe.colour, samples: run.signals[index] });
		}
		return out;
	});

	const currents = $derived.by((): Trace[] => {
		const run = app.dcResult;
		if (!run) return [];
		const out: Trace[] = [];
		for (const current of app.plottedCurrents) {
			const index = run.elementNames.indexOf(current.name);
			if (index < 0) continue;
			out.push({
				key: `i:${current.name}`,
				label: current.label,
				colour: current.colour,
				samples: run.currents[index]
			});
		}
		return out;
	});

	const xRange = $derived.by(() => {
		const values = app.dcResult?.values;
		if (!values || values.length === 0) return { lo: 0, hi: 1 };
		let lo = Math.min(values[0], values[values.length - 1]);
		let hi = Math.max(values[0], values[values.length - 1]);
		if (hi - lo <= 0) {
			const half = Math.abs(lo) * 0.1 || 1;
			lo -= half;
			hi += half;
		}
		return { lo, hi };
	});
	const vRange = $derived(paddedRange(voltages.map((t) => t.samples)));
	const iRange = $derived(paddedRange(currents.map((t) => t.samples)));

	const panels = $derived(
		sweepPanels(size, PADDING, { voltage: voltages.length > 0, current: currents.length > 0 })
	);

	/** The theme's colours, read once a draw rather than on every pointer move. */
	let colours = new Map<string, string>();
	function colour(name: string): string {
		let value = colours.get(name);
		if (value === undefined && canvas) {
			value = getComputedStyle(canvas).getPropertyValue(name).trim();
			colours.set(name, value);
		}
		return value ?? '';
	}

	let dpr = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
	$effect(() => watchPixelRatio(window, (ratio) => (dpr = ratio)));

	$effect(() => {
		if (!canvas) return;
		canvas.width = Math.round(size.width * dpr);
		canvas.height = Math.round(size.height * dpr);
		colours = new Map();
	});

	$effect(() => {
		const scheme = window.matchMedia?.('(prefers-color-scheme: dark)');
		if (!scheme) return;
		const forget = () => {
			colours = new Map();
			draw();
		};
		scheme.addEventListener('change', forget);
		return () => scheme.removeEventListener('change', forget);
	});

	const toX = (v: number) =>
		PADDING.left + ((v - xRange.lo) / (xRange.hi - xRange.lo)) * Math.max(size.width - PADDING.left - PADDING.right, 10);

	function drawPanel(
		ctx: CanvasRenderingContext2D,
		panel: Rect,
		range: { lo: number; hi: number },
		quantity: 'V' | 'A',
		traces: Trace[],
		values: Float64Array
	) {
		const toY = (v: number) => panel.y + panel.h - ((v - range.lo) / (range.hi - range.lo)) * panel.h;

		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		const step = niceStep(range.hi - range.lo, Math.max(5, Math.floor(panel.h / 24)));
		for (const v of ticks(range.lo, range.hi, step)) {
			const y = toY(v);
			ctx.strokeStyle = v === 0 ? colour('--scope-axis') : colour('--grid-line');
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(panel.x, y);
			ctx.lineTo(panel.x + panel.w, y);
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(formatWithUnit(v, quantity, 3), panel.x - 8, y);
		}

		ctx.save();
		ctx.beginPath();
		ctx.rect(panel.x - 1, panel.y - 1, panel.w + 2, panel.h + 2);
		ctx.clip();
		ctx.lineWidth = 1.6;
		ctx.lineJoin = 'round';
		for (const trace of traces) {
			ctx.strokeStyle = trace.colour;
			ctx.beginPath();
			for (let i = 0; i < values.length; i++) {
				const x = toX(values[i]);
				const y = toY(trace.samples[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();
		}
		ctx.restore();

		ctx.fillStyle = colour('--label-dim');
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText(quantity === 'V' ? 'voltage' : 'current', panel.x + 6, panel.y + 2);
	}

	function draw() {
		if (!canvas || size.width === 0) return;
		const run = app.dcResult;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size.width, size.height);
		ctx.font = `11px ${colour('--font-mono') || 'monospace'}`;
		if (!run || run.values.length === 0) return;
		const { voltage, current } = panels;
		const shown = [voltage, current].filter((p): p is Rect => p !== null);
		if (shown.length === 0) return;

		// The swept axis: gridlines down every panel, labelled once at the foot.
		const top = shown[0].y;
		const bottom = shown[shown.length - 1].y + shown[shown.length - 1].h;
		const plotW = shown[0].w;
		const xStep = niceStep(xRange.hi - xRange.lo, Math.max(2, Math.floor(plotW / 90)));
		// Which quantity the axis is, since its ticks only say the unit: in the
		// corner under the value labels, with any tick label it would cover left out.
		const axisName = `${run.source} (${unit})`;
		const nameEnd = 4 + ctx.measureText(axisName).width + 6;
		ctx.fillStyle = colour('--label-strong') || colour('--label-dim');
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText(axisName, 4, bottom + 6);
		ctx.textAlign = 'center';
		for (const v of ticks(xRange.lo, xRange.hi, xStep)) {
			const x = toX(v);
			ctx.strokeStyle = v === 0 ? colour('--scope-axis') : colour('--grid-line');
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (const panel of shown) {
				ctx.moveTo(x, panel.y);
				ctx.lineTo(x, panel.y + panel.h);
			}
			ctx.stroke();
			const label = formatWithUnit(v, unit, 3);
			if (x - ctx.measureText(label).width / 2 < nameEnd) continue;
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(label, x, bottom + 6);
		}

		if (voltage) drawPanel(ctx, voltage, vRange, 'V', voltages, run.values);
		if (current) drawPanel(ctx, current, iRange, 'A', currents, run.values);


		if (cursor !== null && cursor >= PADDING.left && cursor <= PADDING.left + plotW) {
			ctx.strokeStyle = colour('--scope-cursor');
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(cursor, top);
			ctx.lineTo(cursor, bottom);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	/** The sweep point nearest the cursor, and every trace's value there. */
	const readout = $derived.by(() => {
		const run = app.dcResult;
		if (!run || cursor === null || run.values.length === 0) return null;
		const plotW = Math.max(size.width - PADDING.left - PADDING.right, 10);
		const at = xRange.lo + ((cursor - PADDING.left) / plotW) * (xRange.hi - xRange.lo);
		let nearest = 0;
		for (let i = 1; i < run.values.length; i++) {
			if (Math.abs(run.values[i] - at) < Math.abs(run.values[nearest] - at)) nearest = i;
		}
		return {
			value: run.values[nearest],
			entries: [
				...voltages.map((t) => ({ ...t, text: formatWithUnit(t.samples[nearest], 'V', 4) })),
				...currents.map((t) => ({ ...t, text: formatWithUnit(t.samples[nearest], 'A', 4) }))
			]
		};
	});

	$effect(() => {
		if (!host) return;
		const observer = new ResizeObserver(([entry]) => {
			size = { width: entry.contentRect.width, height: entry.contentRect.height };
		});
		observer.observe(host);
		return () => observer.disconnect();
	});

	$effect(() => {
		void [app.dcResult, voltages, currents, xRange, vRange, iRange, panels, unit, size, cursor, dpr];
		draw();
	});
</script>

<div class="sweep" bind:this={host}>
	<canvas
		bind:this={canvas}
		style:width="{size.width}px"
		style:height="{size.height}px"
		onpointermove={(e) => (cursor = e.clientX - e.currentTarget.getBoundingClientRect().left)}
		onpointerleave={() => (cursor = null)}
	></canvas>

	{#if !app.dcResult}
		<p class="empty">
			{app.running
				? 'Sweeping…'
				: app.dcSwept
					? `Press Run to sweep ${app.dcSwept.name} and solve the circuit at each value.`
					: 'Place a source to sweep: a voltage source, a current source, a battery or a supply.'}
		</p>
	{:else if voltages.length + currents.length === 0}
		<p class="empty">Tick a net, or a part’s current, on the right to plot it against {app.dcResult.source}.</p>
	{/if}

	{#if readout && readout.entries.length > 0}
		<div class="readout">
			<span class="at">{app.dcResult?.source} = {formatWithUnit(readout.value, unit, 4)}</span>
			{#each readout.entries as entry (entry.key)}
				<span style:color={entry.colour}>{entry.label} = {entry.text}</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.sweep {
		position: relative;
		min-width: 0;
		height: 100%;
	}

	canvas {
		display: block;
		cursor: crosshair;
	}

	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		margin: 0;
		color: var(--label-dim);
		font-size: 0.85rem;
		pointer-events: none;
		text-align: center;
		padding: 0 2rem;
	}

	.readout {
		position: absolute;
		top: 8px;
		right: 12px;
		display: flex;
		gap: 0.75rem;
		flex-wrap: wrap;
		justify-content: flex-end;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		pointer-events: none;
		/* Nearly opaque, with a frame: it sits over the curves it describes. */
		background: color-mix(in srgb, var(--panel-bg) 94%, transparent);
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
	}

	.at {
		color: var(--label-dim);
	}
</style>
