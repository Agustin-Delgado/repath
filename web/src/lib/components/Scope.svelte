<script lang="ts">
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';
	import type { DigitalTransition } from '$lib/engine';
	import BodePlot from './BodePlot.svelte';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let host = $state<HTMLDivElement | null>(null);
	let size = $state({ width: 0, height: 0 });
	let cursor = $state<{ x: number; time: number } | null>(null);

	const DIGITAL_LANE = 26;
	const PADDING = { left: 62, right: 14, top: 14, bottom: 26 };

	const analogProbes = $derived(app.activeProbes.filter((p) => p.analog && p.analog !== 'gnd'));
	const digitalProbes = $derived(app.activeProbes.filter((p) => p.digital));

	interface Trace {
		label: string;
		colour: string;
		samples: Float64Array;
	}

	const traces = $derived.by((): Trace[] => {
		const run = app.result;
		if (!run) return [];
		const out: Trace[] = [];
		for (const probe of analogProbes) {
			const samples = run.signals.get(`v(${probe.analog})`);
			if (samples) out.push({ label: probe.label, colour: probe.colour, samples });
		}
		return out;
	});

	const digitalTraces = $derived.by(() => {
		const run = app.result;
		if (!run) return [];
		const out: Array<{ label: string; colour: string; events: DigitalTransition[] }> = [];
		for (const probe of digitalProbes) {
			const index = run.netNames.indexOf(probe.digital!);
			if (index >= 0) out.push({ label: probe.label, colour: probe.colour, events: run.digital[index] });
		}
		return out;
	});

	/** Vertical range of the analog traces, padded so nothing touches the frame. */
	const range = $derived.by(() => {
		let lo = Infinity;
		let hi = -Infinity;
		for (const trace of traces) {
			for (const v of trace.samples) {
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: -1, hi: 1 };
		if (hi - lo < 1e-12) {
			// A perfectly flat trace still needs a window to be drawn inside.
			const centre = (hi + lo) / 2 || 0;
			return { lo: centre - 0.5, hi: centre + 0.5 };
		}
		const pad = (hi - lo) * 0.1;
		return { lo: lo - pad, hi: hi + pad };
	});

	function niceStep(span: number, target: number): number {
		const raw = span / Math.max(target, 1);
		const power = Math.pow(10, Math.floor(Math.log10(raw)));
		for (const m of [1, 2, 5, 10]) {
			if (power * m >= raw) return power * m;
		}
		return power * 10;
	}

	function draw() {
		if (!canvas || size.width === 0) return;
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.round(size.width * dpr);
		canvas.height = Math.round(size.height * dpr);
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const style = getComputedStyle(canvas);
		const colour = (name: string) => style.getPropertyValue(name).trim();

		const w = size.width;
		const h = size.height;
		ctx.clearRect(0, 0, w, h);

		// A purely digital circuit has no voltage axis to draw, so give the whole
		// panel over to the logic lanes instead of leaving an empty graph above.
		const hasAnalog = traces.length > 0;
		const available = Math.max(h - PADDING.top - PADDING.bottom, 20);
		const lane = hasAnalog
			? DIGITAL_LANE
			: Math.min(64, available / Math.max(digitalTraces.length, 1));
		const laneHeight = digitalTraces.length * lane;
		const plot = {
			x: PADDING.left,
			y: PADDING.top,
			w: Math.max(w - PADDING.left - PADDING.right, 10),
			h: hasAnalog ? Math.max(available - laneHeight, 10) : 0
		};

		const run = app.result;
		const stop = run && run.time.length ? run.time[run.time.length - 1] : app.stopTime;
		const toX = (t: number) => plot.x + (t / (stop || 1)) * plot.w;
		const toY = (v: number) => plot.y + plot.h - ((v - range.lo) / (range.hi - range.lo)) * plot.h;

		// Grid.
		ctx.strokeStyle = colour('--scope-grid') || '#2a2f3a';
		ctx.fillStyle = colour('--label-dim') || '#7c8496';
		ctx.lineWidth = 1;
		ctx.font = '11px var(--font-mono, monospace)';

		const vStep = niceStep(range.hi - range.lo, 5);
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		for (let v = hasAnalog ? Math.ceil(range.lo / vStep) * vStep : Infinity; v <= range.hi; v += vStep) {
			const y = toY(v);
			ctx.beginPath();
			ctx.moveTo(plot.x, y);
			ctx.lineTo(plot.x + plot.w, y);
			ctx.strokeStyle = Math.abs(v) < vStep / 1000 ? colour('--scope-axis') : colour('--scope-grid');
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(`${formatValue(v, 3)}V`, plot.x - 8, y);
		}

		const tStep = niceStep(stop || 1, 6);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for (let t = 0; t <= (stop || 1) + tStep / 2; t += tStep) {
			const x = toX(t);
			ctx.beginPath();
			ctx.moveTo(x, plot.y);
			ctx.lineTo(x, plot.y + plot.h + laneHeight);
			ctx.strokeStyle = colour('--scope-grid');
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(`${formatValue(t, 3)}s`, x, h - PADDING.bottom + 6);
		}

		if (!run) return;

		// Analog traces.
		ctx.lineWidth = 1.6;
		ctx.lineJoin = 'round';
		for (const trace of traces) {
			ctx.strokeStyle = trace.colour;
			ctx.beginPath();
			for (let i = 0; i < run.time.length; i++) {
				const x = toX(run.time[i]);
				const y = toY(trace.samples[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();
		}

		// Digital lanes below the analog plot.
		ctx.lineWidth = 1.8;
		digitalTraces.forEach((trace, index) => {
			const top = plot.y + plot.h + index * lane + lane * 0.22;
			const bottom = top + lane * 0.56;
			ctx.strokeStyle = trace.colour;
			ctx.beginPath();

			let previousY = bottom;
			let started = false;
			const levelY = (state: string) =>
				state === 'high' ? top : state === 'low' ? bottom : (top + bottom) / 2;

			for (const event of trace.events) {
				const x = toX(event.time);
				const y = levelY(event.state);
				if (!started) {
					ctx.moveTo(x, y);
					started = true;
				} else {
					ctx.lineTo(x, previousY);
					ctx.lineTo(x, y);
				}
				previousY = y;
			}
			if (started) ctx.lineTo(toX(stop), previousY);
			ctx.stroke();

			ctx.fillStyle = colour('--label-dim');
			ctx.textAlign = 'right';
			ctx.textBaseline = 'middle';
			ctx.fillText(trace.label, plot.x - 8, (top + bottom) / 2);
		});

		// Playhead: where the live overlay on the schematic is showing.
		if (app.result) {
			const x = toX(Math.min(app.playbackTime, stop));
			ctx.strokeStyle = colour('--accent');
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(x, plot.y - 4);
			ctx.lineTo(x, plot.y + plot.h + laneHeight);
			ctx.stroke();
			// A small tab at the top, so it reads as a handle rather than a gridline.
			ctx.fillStyle = colour('--accent');
			ctx.beginPath();
			ctx.moveTo(x - 4, plot.y - 8);
			ctx.lineTo(x + 4, plot.y - 8);
			ctx.lineTo(x, plot.y - 2);
			ctx.closePath();
			ctx.fill();
		}

		// Cursor.
		if (cursor) {
			ctx.strokeStyle = colour('--scope-cursor');
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(cursor.x, plot.y);
			ctx.lineTo(cursor.x, plot.y + plot.h + laneHeight);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	/**
	 * The playhead quantized to whole pixels.
	 *
	 * The redraw effect depends on this rather than on the raw time, so a playing
	 * animation repaints the scope only when the line actually moves — sixty
	 * full-canvas repaints a second for a sub-pixel move is not a good trade.
	 */
	const playheadPx = $derived.by(() => {
		const run = app.result;
		if (!run || run.time.length === 0) return -1;
		const stop = run.time[run.time.length - 1] || 1;
		const plotW = Math.max(size.width - PADDING.left - PADDING.right, 10);
		return Math.round((app.playbackTime / stop) * plotW);
	});

	function seekTo(event: PointerEvent) {
		if (!canvas || !app.result) return;
		const rect = canvas.getBoundingClientRect();
		const stop = app.result.time[app.result.time.length - 1] || app.stopTime;
		const plotW = Math.max(rect.width - PADDING.left - PADDING.right, 10);
		app.seek(((event.clientX - rect.left - PADDING.left) / plotW) * stop);
	}

	/** Sample index nearest the cursor time, for the readout. */
	const readout = $derived.by(() => {
		const run = app.result;
		if (!run || !cursor || run.time.length === 0) return null;
		let lo = 0;
		let hi = run.time.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (run.time[mid] < cursor.time) lo = mid + 1;
			else hi = mid;
		}
		return {
			time: run.time[lo],
			values: traces.map((t) => ({
				label: t.label,
				colour: t.colour,
				value: t.samples[lo]
			}))
		};
	});

	function onMove(event: PointerEvent) {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const run = app.result;
		const stop = run && run.time.length ? run.time[run.time.length - 1] : app.stopTime;
		const plotW = Math.max(rect.width - PADDING.left - PADDING.right, 10);
		const t = ((x - PADDING.left) / plotW) * stop;
		cursor = t >= 0 && t <= stop ? { x, time: t } : null;
		// Dragging scrubs; a plain hover only reads values off.
		if (event.buttons & 1) seekTo(event);
	}

	$effect(() => {
		if (!host) return;
		const observer = new ResizeObserver(([entry]) => {
			size = { width: entry.contentRect.width, height: entry.contentRect.height };
		});
		observer.observe(host);
		return () => observer.disconnect();
	});

	$effect(() => {
		// Redraw whenever anything the plot depends on changes.
		void [app.result, traces, digitalTraces, range, size, cursor, playheadPx];
		draw();
	});
</script>

<div class="scope">
	{#if app.analysis === 'frequency'}
		<BodePlot />
	{:else}
	<div class="plot" bind:this={host}>
		<canvas
			bind:this={canvas}
			style:width="{size.width}px"
			style:height="{size.height}px"
			onpointermove={onMove}
			onpointerdown={seekTo}
			onpointerleave={() => (cursor = null)}
		></canvas>

		{#if !app.result}
			<p class="empty">
				{app.running ? 'Simulating…' : 'Press Run to simulate.'}
			</p>
		{:else if app.activeProbes.length === 0}
			<p class="empty">Tick a net on the right to plot it.</p>
		{/if}

		{#if readout && readout.values.length > 0}
			<div class="readout">
				<span class="time">t = {formatValue(readout.time, 4)}s</span>
				{#each readout.values as entry (entry.label)}
					<span class="value" style:color={entry.colour}>
						{entry.label} = {formatValue(entry.value, 4)}V
					</span>
				{/each}
			</div>
		{/if}
	</div>
	{/if}

	<aside class="signals">
		<h3>Signals</h3>
		<ul>
			{#each app.compiled.connectivity.nets as net (net.index)}
				{@const names = app.compiled.names.get(net.index)}
				{@const label = names?.analog ?? names?.digital}
				{#if label && !net.isGround}
					{@const probe = app.activeProbes.find((p) => p.netIndex === net.index)}
					<li>
						<label>
							<input
								type="checkbox"
								checked={!!probe}
								onchange={() => app.toggleProbe(net.points[0])}
							/>
							<span class="swatch" style:background={probe?.colour ?? 'transparent'}></span>
							<span class="name">{label}</span>
							{#if names?.analog && names?.digital}
								<span class="badge" title="This net is bridged between the analog and digital domains"
									>mixed</span
								>
							{:else if names?.digital}
								<span class="badge digital">logic</span>
							{/if}
						</label>
					</li>
				{/if}
			{/each}
		</ul>

		{#if app.analysis === 'frequency' && app.acResult}
			<footer>
				{app.acResult.frequencies.length} points ·
				{app.acResult.elapsedMs.toFixed(0)} ms
			</footer>
		{:else if app.analysis === 'transient' && app.result}
			<footer>
				{app.result.stats.accepted_steps} steps ·
				{app.result.stats.newton_iterations} iterations ·
				{app.result.elapsedMs.toFixed(0)} ms
			</footer>
		{/if}
	</aside>
</div>

<style>
	.scope {
		display: grid;
		grid-template-columns: 1fr 190px;
		height: 100%;
		min-height: 0;
		background: var(--panel-bg);
	}

	.plot {
		position: relative;
		min-width: 0;
		--scope-grid: var(--grid-line);
	}

	canvas {
		display: block;
		cursor: col-resize;
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

	.readout .time {
		color: var(--label-dim);
	}

	.signals {
		border-left: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	.signals h3 {
		margin: 0;
		padding: 0.6rem 0.75rem 0.4rem;
		font-size: 0.7rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--label-dim);
		font-weight: 600;
	}

	.signals ul {
		list-style: none;
		margin: 0;
		padding: 0 0.5rem 0.5rem;
		overflow-y: auto;
		flex: 1;
	}

	.signals label {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.2rem 0.25rem;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.signals label:hover {
		background: var(--hover);
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		border: 1px solid var(--border);
		flex: none;
	}

	.name {
		font-family: var(--font-mono);
	}

	.badge {
		margin-left: auto;
		font-size: 0.62rem;
		padding: 0.05rem 0.3rem;
		border-radius: 3px;
		background: var(--badge-mixed);
		color: var(--badge-mixed-text);
	}

	.badge.digital {
		background: var(--badge-logic);
		color: var(--badge-logic-text);
	}

	footer {
		border-top: 1px solid var(--border);
		padding: 0.4rem 0.75rem;
		font-size: 0.68rem;
		color: var(--label-dim);
		font-family: var(--font-mono);
	}
</style>
