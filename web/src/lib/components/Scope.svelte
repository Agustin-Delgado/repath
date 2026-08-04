<script lang="ts">
	import { measure } from '$lib/measure';
	import { netLabel } from '$lib/schematic/nets';
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';
	import type { DigitalTransition } from '$lib/engine';
	import BodePlot from './BodePlot.svelte';

	let canvas = $state<HTMLCanvasElement | null>(null);
	let host = $state<HTMLDivElement | null>(null);
	let size = $state({ width: 0, height: 0 });
	let cursor = $state<{ x: number; time: number } | null>(null);
	/**
	 * A second cursor, left where you put it.
	 *
	 * One cursor answers "what is it here". Two answer "how much did it change,
	 * and how long did that take", which is most of what anyone walks up to a
	 * scope to find out. Shift-click drops it; shift-click again picks it up.
	 */
	let marker = $state<number | null>(null);

	const DIGITAL_LANE = 26;
	const PADDING = { left: 62, right: 14, top: 14, bottom: 26 };

	const analogProbes = $derived(app.activeProbes.filter((p) => p.analog && p.analog !== 'gnd'));
	const digitalProbes = $derived(app.activeProbes.filter((p) => p.digital));

	interface Trace {
		label: string;
		colour: string;
		samples: Float64Array;
		/** How far this signal moved across a tolerance sweep, if one was run. */
		low?: Float64Array;
		high?: Float64Array;
	}

	const traces = $derived.by((): Trace[] => {
		const run = app.result;
		if (!run) return [];
		const out: Trace[] = [];
		for (const probe of analogProbes) {
			const key = `v(${probe.analog})`;
			const samples = run.signals.get(key);
			if (!samples) continue;
			const band = app.envelope;
			out.push({
				label: probe.label,
				colour: probe.colour,
				samples,
				low: band?.low.get(key),
				high: band?.high.get(key)
			});
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

	/**
	 * One vertical scale, or one per trace.
	 *
	 * Shared is what a scope does when the signals are comparable. They often are
	 * not: a 5 V square wave and the 400 mV of ripple it produces share an axis
	 * only in the sense that the ripple becomes a flat line. Separated, each trace
	 * gets a band of its own and is scaled to fill it — which is what the vertical
	 * knob on a bench scope is for.
	 */
	let separate = $state(false);

	/** Range of one trace on its own, padded so nothing touches its band edge. */
	function spanOf(series: Array<Float64Array | undefined>) {
		let lo = Infinity;
		let hi = -Infinity;
		for (const s of series) {
			if (!s) continue;
			for (const v of s) {
				if (v < lo) lo = v;
				if (v > hi) hi = v;
			}
		}
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: -1, hi: 1 };
		if (hi - lo < 1e-12) {
			const centre = (hi + lo) / 2 || 0;
			return { lo: centre - 0.5, hi: centre + 0.5 };
		}
		const pad = (hi - lo) * 0.1;
		return { lo: lo - pad, hi: hi + pad };
	}

	/**
	 * The numbers a bench scope has a button for.
	 *
	 * Off by default: they are what you want once you have stopped to check
	 * something, and a wall of figures over a moving trace is what you want at no
	 * other time.
	 */
	let measuring = $state(false);

	const measurements = $derived.by(() => {
		const run = app.result;
		if (!run || !measuring) return [];
		return traces
			.map((t) => ({ label: t.label, colour: t.colour, m: measure(run.time, t.samples) }))
			.filter((row) => row.m !== null);
	});

	/** One range per trace, for when they are drawn separated. */
	const lanes = $derived(traces.map((t) => spanOf([t.samples, t.low, t.high])));

	/** Vertical range of the analog traces, padded so nothing touches the frame. */
	const range = $derived.by(() => {
		let lo = Infinity;
		let hi = -Infinity;
		for (const trace of traces) {
			// The band too, or a sweep whose corners leave the nominal window would
			// be drawn flat against the frame — which reads as "it stays inside"
			// when what happened is that the plot ran out of room.
			for (const series of [trace.samples, trace.low, trace.high]) {
				if (!series) continue;
				for (const v of series) {
					if (v < lo) lo = v;
					if (v > hi) hi = v;
				}
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

		// Where each trace lives and what it is scaled against. Shared, they all
		// have the whole plot and one range; separated, a band each and their own.
		const bandHeight = traces.length ? plot.h / traces.length : plot.h;
		const bandOf = (index: number) =>
			separate
				? { top: plot.y + index * bandHeight, h: bandHeight * 0.86, span: lanes[index] }
				: { top: plot.y, h: plot.h, span: range };
		const mapY = (index: number, v: number) => {
			const b = bandOf(index);
			return b.top + b.h - ((v - b.span.lo) / (b.span.hi - b.span.lo)) * b.h;
		};
		const toY = (v: number) => mapY(0, v);

		// Grid.
		ctx.strokeStyle = colour('--scope-grid') || '#2a2f3a';
		ctx.fillStyle = colour('--label-dim') || '#7c8496';
		ctx.lineWidth = 1;
		ctx.font = '11px var(--font-mono, monospace)';

		const vStep = niceStep(range.hi - range.lo, 5);
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		const gridFrom = hasAnalog && !separate ? Math.ceil(range.lo / vStep) * vStep : Infinity;
		for (let v = gridFrom; v <= range.hi; v += vStep) {
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

		// The spread first, so the nominal trace sits on top of its own band. A
		// filled shape rather than two lines: the useful reading is how much room
		// the answer has, and an outline invites reading the edges as two more
		// traces that some particular circuit followed. No sample followed either
		// of them — each edge is the worst any sample managed at that instant.
		ctx.lineJoin = 'round';
		traces.forEach((trace, index) => {
			if (!trace.low || !trace.high) return;
			ctx.beginPath();
			for (let i = 0; i < run.time.length; i++) {
				const x = toX(run.time[i]);
				const y = mapY(index, trace.high[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			for (let i = run.time.length - 1; i >= 0; i--) {
				ctx.lineTo(toX(run.time[i]), mapY(index, trace.low[i]));
			}
			ctx.closePath();
			ctx.globalAlpha = 0.22;
			ctx.fillStyle = trace.colour;
			ctx.fill();
			ctx.globalAlpha = 1;
		});

		// Analog traces.
		ctx.lineWidth = 1.6;
		traces.forEach((trace, index) => {
			ctx.strokeStyle = trace.colour;
			ctx.beginPath();
			for (let i = 0; i < run.time.length; i++) {
				const x = toX(run.time[i]);
				const y = mapY(index, trace.samples[i]);
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.stroke();

			// Separated, each band carries its own two numbers in its own colour.
			// A shared axis on the left would be describing only one of them.
			if (separate) {
				const b = bandOf(index);
				ctx.fillStyle = trace.colour;
				ctx.textAlign = 'right';
				ctx.textBaseline = 'top';
				ctx.fillText(`${formatValue(b.span.hi, 3)}V`, plot.x - 8, b.top);
				ctx.textBaseline = 'bottom';
				ctx.fillText(`${formatValue(b.span.lo, 3)}V`, plot.x - 8, b.top + b.h);
				ctx.textAlign = 'left';
				ctx.textBaseline = 'top';
				ctx.fillText(trace.label, plot.x + 6, b.top + 2);
			}
		});

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
		if (marker !== null) {
			const x = toX(marker);
			ctx.save();
			ctx.setLineDash([3, 3]);
			ctx.strokeStyle = colour('--scope-cursor');
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(x, plot.y);
			ctx.lineTo(x, plot.y + plot.h + laneHeight);
			ctx.stroke();
			ctx.restore();
		}

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

	/** Index of the sample nearest a time. */
	function indexAt(time: Float64Array, at: number): number {
		let lo = 0;
		let hi = time.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (time[mid] < at) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	/** What the cursors read, and the difference between them if there are two. */
	const readout = $derived.by(() => {
		const run = app.result;
		if (!run || !cursor || run.time.length === 0) return null;
		const here = indexAt(run.time, cursor.time);
		const there = marker === null ? null : indexAt(run.time, marker);
		return {
			time: run.time[here],
			delta: there === null ? null : run.time[here] - run.time[there],
			values: traces.map((t) => ({
				label: t.label,
				colour: t.colour,
				value: t.samples[here],
				// The change between the two, which is the number nobody wants to do
				// by subtracting two readings they wrote down.
				delta: there === null ? null : t.samples[here] - t.samples[there]
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
		// Dragging scrubs; a plain hover only reads values off. Shift is measuring,
		// so it must not drag the playhead around while you do it.
		if (event.buttons & 1 && !event.shiftKey) seekTo(event);
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
		void [app.result, traces, digitalTraces, range, lanes, separate, marker, size, cursor, playheadPx];
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
			onpointerdown={(e) => {
				if (e.shiftKey) {
					// Second press in the same place picks it up again.
					marker = marker !== null && cursor && Math.abs(marker - cursor.time) < 1e-12
						? null
						: (cursor?.time ?? null);
					return;
				}
				seekTo(e);
			}}
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
				<span class="time">
					t = {formatValue(readout.time, 4)}s
					{#if readout.delta !== null}
						<span class="delta">Δt = {formatValue(readout.delta, 4)}s</span>
					{/if}
				</span>
				{#each readout.values as entry (entry.label)}
					<span class="value" style:color={entry.colour}>
						{entry.label} = {formatValue(entry.value, 4)}V
						{#if entry.delta !== null}
							<span class="delta">Δ {formatValue(entry.delta, 4)}V</span>
						{/if}
					</span>
				{/each}
				{#if marker === null}
					<span class="hint">shift-click to measure from a point</span>
				{/if}
			</div>
		{/if}
	</div>
	{/if}

	<aside class="signals">
		<h3>
			Signals
			<button
				class="scale"
				class:on={measuring}
				onclick={() => (measuring = !measuring)}
				title="Read off frequency, duty, RMS, rise time and overshoot"
			>
				measure
			</button>
			{#if traces.length > 1}
				<button
					class="scale"
					class:on={separate}
					onclick={() => (separate = !separate)}
					title={separate
						? 'One axis for everything'
						: 'Give each signal its own scale, so a small one is not flattened by a large one'}
				>
					{separate ? 'split' : 'shared'}
				</button>
			{/if}
		</h3>
		<ul>
			{#each app.compiled.connectivity.nets as net (net.index)}
				{@const names = app.compiled.names.get(net.index)}
				{@const signal = names?.analog ?? names?.digital}
				{@const probe = app.activeProbes.find((p) => p.netIndex === net.index)}
				{@const label = probe?.label ?? (signal ? netLabel(net, signal) : '')}
				{#if signal && !net.isGround}
					<!--
						Pointing at a name lights that net up on the schematic. A label can
						only say so much in the width of a sidebar; this says the rest by
						pointing at the drawing, which is where the answer actually is.
					-->
					<li
						onpointerenter={() => (app.hoverNet = net.index)}
						onpointerleave={() => (app.hoverNet = null)}
					>
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
		{/if}

		{#if measurements.length > 0}
			<!--
				Each of these is something you could get from two cursors and some
				arithmetic. Doing it by hand is slow, and being slow is the reason
				nobody checks.
			-->
			<div class="measures">
				{#each measurements as row (row.label)}
					{@const m = row.m!}
					<div class="measure">
						<span class="who" style:color={row.colour}>{row.label}</span>
						<dl>
							<dt>pk-pk</dt>
							<dd>{formatValue(m.peakToPeak, 3)}V</dd>
							<dt>mean</dt>
							<dd>{formatValue(m.mean, 3)}V</dd>
							<dt>rms</dt>
							<dd>{formatValue(m.rms, 3)}V</dd>
							{#if m.frequency !== null}
								<dt>freq</dt>
								<dd>{formatValue(m.frequency, 3)}Hz</dd>
								<dt>duty</dt>
								<dd>{Math.round((m.duty ?? 0) * 100)}%</dd>
							{/if}
							{#if m.riseTime !== null}
								<dt>rise</dt>
								<dd>{formatValue(m.riseTime, 3)}s</dd>
							{/if}
							{#if m.overshoot !== null && m.overshoot > 0.005}
								<dt>over</dt>
								<dd>{Math.round(m.overshoot * 100)}%</dd>
							{/if}
						</dl>
					</div>
				{/each}
			</div>
		{/if}

		{#if app.analysis === 'transient' && app.result}
			<footer>
				{app.result.stats.accepted_steps} steps ·
				{app.result.stats.newton_iterations} iterations ·
				{app.result.elapsedMs.toFixed(0)} ms
			</footer>
		{/if}
	</aside>
</div>

<style>
	.measures {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: 0.4rem 0.15rem 0;
		border-top: 1px solid var(--border);
		margin-top: 0.4rem;
	}

	.measure .who {
		font-size: 0.66rem;
		font-family: var(--font-mono);
	}

	.measure dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.05rem 0.4rem;
		margin: 0.15rem 0 0;
		font-size: 0.64rem;
	}

	.measure dt {
		color: var(--label-dim);
	}

	.measure dd {
		margin: 0;
		text-align: right;
		font-family: var(--font-mono);
		color: var(--label-strong);
	}

	.readout .delta {
		margin-left: 0.35rem;
		opacity: 0.8;
	}

	.readout .hint {
		opacity: 0.5;
		font-style: italic;
	}

	.signals h3 {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.4rem;
	}

	.signals .scale {
		font-size: 0.6rem;
		letter-spacing: 0;
		text-transform: none;
		padding: 0.1rem 0.35rem;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--control-bg);
		color: var(--label-dim);
		cursor: pointer;
	}

	.signals .scale.on {
		border-color: var(--accent);
		color: var(--text);
	}

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
