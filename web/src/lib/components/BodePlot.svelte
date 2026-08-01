<script lang="ts">
	/**
	 * Frequency response: magnitude in decibels over phase in degrees, both
	 * against a logarithmic frequency axis.
	 *
	 * Two stacked panels sharing one x-axis rather than two y-scales on one plot.
	 * A dual-axis chart makes the reader guess which curve belongs to which scale,
	 * and here the two quantities have nothing to do with each other numerically —
	 * the only thing they share is the frequency they were measured at.
	 */
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let host = $state<HTMLDivElement | null>(null);
	let size = $state({ width: 0, height: 0 });
	let cursor = $state<number | null>(null);

	const PADDING = { left: 58, right: 52, top: 12, bottom: 26 };
	/** Fraction of the plot height given to magnitude; phase gets the rest. */
	const MAGNITUDE_SHARE = 0.62;

	interface Trace {
		label: string;
		colour: string;
		magnitudeDb: Float64Array;
		phase: Float64Array;
	}

	const traces = $derived.by((): Trace[] => {
		const run = app.acResult;
		if (!run) return [];
		const out: Trace[] = [];
		for (const probe of app.activeProbes) {
			if (!probe.analog || probe.analog === 'gnd') continue;
			const index = run.unknownNames.indexOf(`v(${probe.analog})`);
			if (index < 0) continue;
			const magnitude = run.magnitude[index];
			const db = new Float64Array(magnitude.length);
			for (let i = 0; i < magnitude.length; i++) {
				// A true zero is minus infinity decibels; floor it well below
				// anything a plot would show rather than letting it break the scale.
				db[i] = 20 * Math.log10(Math.max(magnitude[i], 1e-12));
			}
			out.push({ label: probe.label, colour: probe.colour, magnitudeDb: db, phase: run.phase[index] });
		}
		return out;
	});

	const dbRange = $derived.by(() => {
		let lo = Infinity;
		let hi = -Infinity;
		for (const trace of traces) {
			for (const v of trace.magnitudeDb) {
				if (!Number.isFinite(v)) continue;
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: -60, hi: 20 };
		// Never show more than 140 dB of range: below that the interesting part
		// of a response gets squashed into a few pixels by one deep null.
		lo = Math.max(lo, hi - 140);
		const pad = Math.max((hi - lo) * 0.08, 3);
		return { lo: lo - pad, hi: hi + pad };
	});

	const phaseRange = $derived.by(() => {
		let lo = Infinity;
		let hi = -Infinity;
		for (const trace of traces) {
			for (const v of trace.phase) {
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: -180, hi: 180 };
		if (hi - lo < 30) return { lo: lo - 20, hi: hi + 20 };
		const pad = (hi - lo) * 0.08;
		return { lo: lo - pad, hi: hi + pad };
	});

	function niceStep(span: number, target: number): number {
		const raw = span / Math.max(target, 1);
		const power = Math.pow(10, Math.floor(Math.log10(raw)));
		for (const m of [1, 2, 5, 10]) if (power * m >= raw) return power * m;
		return power * 10;
	}

	function draw() {
		if (!canvas || size.width === 0) return;
		const run = app.acResult;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(size.width * dpr);
		canvas.height = Math.round(size.height * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size.width, size.height);

		const style = getComputedStyle(canvas);
		const colour = (name: string) => style.getPropertyValue(name).trim();
		ctx.font = '11px var(--font-mono, monospace)';

		const plotW = Math.max(size.width - PADDING.left - PADDING.right, 10);
		const totalH = Math.max(size.height - PADDING.top - PADDING.bottom, 20);
		const magH = totalH * MAGNITUDE_SHARE;
		const phaseTop = PADDING.top + magH + 10;
		const phaseH = Math.max(totalH - magH - 10, 10);

		if (!run || run.frequencies.length === 0) return;

		const f0 = Math.log10(Math.max(run.frequencies[0], 1e-12));
		const f1 = Math.log10(Math.max(run.frequencies[run.frequencies.length - 1], 1e-11));
		const toX = (hz: number) =>
			PADDING.left + ((Math.log10(Math.max(hz, 1e-12)) - f0) / Math.max(f1 - f0, 1e-9)) * plotW;
		const toMagY = (db: number) =>
			PADDING.top + magH - ((db - dbRange.lo) / (dbRange.hi - dbRange.lo)) * magH;
		const toPhaseY = (deg: number) =>
			phaseTop + phaseH - ((deg - phaseRange.lo) / (phaseRange.hi - phaseRange.lo)) * phaseH;

		// Decade gridlines, with the 2..9 subdivisions drawn fainter — that ladder
		// is how you read a log axis at a glance.
		for (let decade = Math.floor(f0); decade <= Math.ceil(f1); decade++) {
			for (let m = 1; m < 10; m++) {
				const hz = m * Math.pow(10, decade);
				const x = toX(hz);
				if (x < PADDING.left - 1 || x > PADDING.left + plotW + 1) continue;
				ctx.strokeStyle = m === 1 ? colour('--grid-line') : colour('--canvas-bg');
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(x, PADDING.top);
				ctx.lineTo(x, PADDING.top + magH);
				ctx.moveTo(x, phaseTop);
				ctx.lineTo(x, phaseTop + phaseH);
				ctx.stroke();
				if (m === 1) {
					ctx.fillStyle = colour('--label-dim');
					ctx.textAlign = 'center';
					ctx.textBaseline = 'top';
					ctx.fillText(`${formatValue(hz, 3)}Hz`, x, size.height - PADDING.bottom + 6);
				}
			}
		}

		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		const dbStep = niceStep(dbRange.hi - dbRange.lo, 4);
		for (let db = Math.ceil(dbRange.lo / dbStep) * dbStep; db <= dbRange.hi; db += dbStep) {
			const y = toMagY(db);
			ctx.strokeStyle = Math.abs(db) < 1e-9 ? colour('--scope-axis') : colour('--grid-line');
			ctx.beginPath();
			ctx.moveTo(PADDING.left, y);
			ctx.lineTo(PADDING.left + plotW, y);
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(`${db.toFixed(0)} dB`, PADDING.left - 8, y);
		}

		const phaseStep = niceStep(phaseRange.hi - phaseRange.lo, 3);
		for (
			let deg = Math.ceil(phaseRange.lo / phaseStep) * phaseStep;
			deg <= phaseRange.hi;
			deg += phaseStep
		) {
			const y = toPhaseY(deg);
			ctx.strokeStyle = colour('--grid-line');
			ctx.beginPath();
			ctx.moveTo(PADDING.left, y);
			ctx.lineTo(PADDING.left + plotW, y);
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(`${deg.toFixed(0)}°`, PADDING.left - 8, y);
		}

		// Phase is drawn dashed so the two panels are never confused for one plot.
		ctx.lineWidth = 1.6;
		ctx.lineJoin = 'round';
		for (const trace of traces) {
			ctx.strokeStyle = trace.colour;
			ctx.setLineDash([]);
			ctx.beginPath();
			for (let i = 0; i < run.frequencies.length; i++) {
				const x = toX(run.frequencies[i]);
				const y = toMagY(trace.magnitudeDb[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();

			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			for (let i = 0; i < run.frequencies.length; i++) {
				const x = toX(run.frequencies[i]);
				const y = toPhaseY(trace.phase[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();
			ctx.setLineDash([]);
		}

		if (cursor !== null && cursor >= PADDING.left && cursor <= PADDING.left + plotW) {
			ctx.strokeStyle = colour('--scope-cursor');
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(cursor, PADDING.top);
			ctx.lineTo(cursor, phaseTop + phaseH);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		ctx.fillStyle = colour('--label-dim');
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText('magnitude', PADDING.left + 6, PADDING.top + 2);
		ctx.fillText('phase (dashed)', PADDING.left + 6, phaseTop + 2);
	}

	const readout = $derived.by(() => {
		const run = app.acResult;
		if (!run || cursor === null || run.frequencies.length === 0) return null;
		const plotW = Math.max(size.width - PADDING.left - PADDING.right, 10);
		const f0 = Math.log10(Math.max(run.frequencies[0], 1e-12));
		const f1 = Math.log10(Math.max(run.frequencies[run.frequencies.length - 1], 1e-11));
		const hz = Math.pow(10, f0 + ((cursor - PADDING.left) / plotW) * (f1 - f0));

		let nearest = 0;
		for (let i = 1; i < run.frequencies.length; i++) {
			if (Math.abs(Math.log10(run.frequencies[i]) - Math.log10(hz)) <
				Math.abs(Math.log10(run.frequencies[nearest]) - Math.log10(hz))) nearest = i;
		}
		return {
			hz: run.frequencies[nearest],
			values: traces.map((t) => ({
				label: t.label,
				colour: t.colour,
				db: t.magnitudeDb[nearest],
				phase: t.phase[nearest]
			}))
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
		void [app.acResult, traces, dbRange, phaseRange, size, cursor];
		draw();
	});
</script>

<div class="bode" bind:this={host}>
	<canvas
		bind:this={canvas}
		style:width="{size.width}px"
		style:height="{size.height}px"
		onpointermove={(e) => (cursor = e.clientX - e.currentTarget.getBoundingClientRect().left)}
		onpointerleave={() => (cursor = null)}
	></canvas>

	{#if !app.acResult}
		<p class="empty">
			{app.running ? 'Sweeping…' : 'Press Run to sweep the frequency response.'}
		</p>
	{:else if traces.length === 0}
		<p class="empty">Tick a net on the right to plot its response.</p>
	{/if}

	{#if readout && readout.values.length > 0}
		<div class="readout">
			<span class="freq">{formatValue(readout.hz, 4)}Hz</span>
			{#each readout.values as entry (entry.label)}
				<span style:color={entry.colour}>
					{entry.label} {entry.db.toFixed(1)} dB · {entry.phase.toFixed(0)}°
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.bode {
		position: relative;
		min-width: 0;
		height: 100%;
	}

	canvas {
		display: block;
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
		background: color-mix(in srgb, var(--panel-bg) 85%, transparent);
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
	}

	.freq {
		color: var(--label-dim);
	}
</style>
