<script lang="ts">
	import { measure } from '$lib/measure';
	import { netLabel } from '$lib/schematic/nets';
	import { logicFamily } from '$lib/schematic/logic';
	import { app } from '$lib/state.svelte';
	import { formatValue } from '$lib/units';
	import type { DigitalTransition, LogicState } from '$lib/engine';
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
		/** Where this channel's knobs are set. */
		gain: number;
		offset: number;
		key: string;
	}

	const traces = $derived.by((): Trace[] => {
		const run = app.result;
		if (!run) return [];
		const out: Trace[] = [];
		for (const probe of analogProbes) {
			const key = `v(${probe.analog})`;
			const samples = run.signals.get(key);
			if (!samples) continue;
			// Only while it lines up. The tolerance band is a batch answer over one
			// window, and a sweep that has rolled past that window shares no time
			// axis with it — drawing it anyway would put the spread of one stretch of
			// time underneath a trace from another.
			const band = app.envelope?.time.length === run.time.length ? app.envelope : null;
			const knobs = app.channels[probe.key] ?? { gain: 1, offset: 0 };
			out.push({
				label: probe.label,
				colour: probe.colour,
				samples,
				low: band?.low.get(key),
				high: band?.high.get(key),
				gain: knobs.gain,
				offset: knobs.offset,
				key: probe.key
			});
		}
		return out;
	});

	const digitalTraces = $derived.by(() => {
		const run = app.result;
		if (!run) return [];
		const out: Array<{
			label: string;
			colour: string;
			events: DigitalTransition[];
			/** The level the net was already at when the memory opens. */
			opening: LogicState;
		}> = [];
		for (const probe of digitalProbes) {
			const index = run.netNames.indexOf(probe.digital!);
			if (index < 0) continue;
			out.push({
				label: probe.label,
				colour: probe.colour,
				events: run.digital[index],
				opening: app.capture?.openingState(index) ?? 'unknown'
			});
		}
		return out;
	});

	/**
	 * What the screen covers, in simulated seconds.
	 *
	 * Running, it follows the sweep: a window of the chosen width with the newest
	 * instant at its right edge, so the trace rolls leftwards the way a roll-mode
	 * scope's does. Stopped, it stays wherever it was left and can be dragged and
	 * zoomed — inside what memory still holds, which is the honest limit. Nothing
	 * outside that was kept, and a scope that let you scroll to it would be
	 * drawing a blank and calling it a measurement.
	 */
	let view = $state<{ from: number; to: number } | null>(null);

	/**
	 * The ends of what is still in memory.
	 *
	 * Read off `app.result` rather than off the capture itself, and that is not
	 * incidental: the capture is a plain object that mutates in place, so nothing
	 * watching it would ever be told it had grown. The run *object* is replaced on
	 * every chunk, which is what makes this recompute — and what makes the window
	 * follow the sweep instead of freezing where it was first drawn.
	 */
	const held = $derived.by(() => {
		const time = app.result?.time;
		if (!time || time.length === 0) return { earliest: 0, now: 0 };
		return { earliest: time[0], now: time[time.length - 1] };
	});

	const span = $derived.by(() => {
		const width = Math.max(app.stopTime, 1e-12);
		if (!app.result) return { from: 0, to: width };
		// A running sweep follows itself. Whatever the window was dragged to while
		// it was stopped is kept for when it stops again, but it cannot hold the
		// screen still over a run that has moved on.
		if (view && !app.playing) return view;
		// Before the first full window has gone by, the axis holds still and the
		// trace grows into it; after that the window slides along with the sweep.
		const to = Math.max(held.now, width);
		return { from: to - width, to };
	});

	// A new acquisition is a new picture: whatever the last one was zoomed into
	// belonged to a run that no longer exists.
	$effect(() => {
		void app.acquiring;
		view = null;
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

	/**
	 * Turn the extremes of a signal into a window worth drawing it in.
	 *
	 * Filling the plot with whatever the signal did is right for a signal that did
	 * something and badly wrong for one that did not. Two traces sitting on a 5 V
	 * rail differ by half a millivolt, and scaled to themselves that half
	 * millivolt filled the screen: five gridlines, all of them labelled `5V`,
	 * with the traces apparently miles apart. Nothing about that reading was
	 * false and none of it was useful.
	 *
	 * So a swing that is negligible beside the level it sits on is treated as no
	 * swing, and the window opens out to include ground — which is the thing a
	 * flat trace is actually telling you about. A signal that genuinely moves
	 * keeps the close-up, and the gain knob is there for anyone who wants the
	 * ripple on a rail.
	 */
	function windowFor(lo: number, hi: number) {
		if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: -1, hi: 1 };
		const level = Math.max(Math.abs(lo), Math.abs(hi));
		if (hi - lo < Math.max(level * 0.01, 1e-12)) {
			if (level < 1e-12) return { lo: -0.5, hi: 0.5 };
			lo = Math.min(lo, 0);
			hi = Math.max(hi, 0);
		}
		const pad = (hi - lo) * 0.1;
		return { lo: lo - pad, hi: hi + pad };
	}

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
		return windowFor(lo, hi);
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
		return windowFor(lo, hi);
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
		const { from, to } = span;
		const width = Math.max(to - from, 1e-15);
		const toX = (t: number) => plot.x + ((t - from) / width) * plot.w;

		// Where each trace lives and what it is scaled against. Shared, they all
		// have the whole plot and one range; separated, a band each and their own.
		const bandHeight = traces.length ? plot.h / traces.length : plot.h;
		const bandOf = (index: number) =>
			separate
				? { top: plot.y + index * bandHeight, h: bandHeight * 0.86, span: lanes[index] }
				: { top: plot.y, h: plot.h, span: range };
		const mapY = (index: number, v: number) => {
			const b = bandOf(index);
			const t = traces[index];
			// Gain about the middle of the band, so turning it up expands the trace
			// where it is rather than launching it off the top; offset in divisions,
			// which is what the marks on the screen are.
			const centre = (b.span.lo + b.span.hi) / 2;
			const scaled = centre + (v - centre) * (t?.gain ?? 1);
			const y = b.top + b.h - ((scaled - b.span.lo) / (b.span.hi - b.span.lo)) * b.h;
			return y - (t?.offset ?? 0) * (b.h / 5);
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

		const tStep = niceStep(width, 6);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for (let t = Math.ceil(from / tStep) * tStep; t <= to + tStep / 2; t += tStep) {
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

		// Clipped, which a whole-run plot never had to be: the memory holds more
		// than the window shows, and without this the traces would be painted over
		// the axis labels and out into the panel.
		ctx.save();
		ctx.beginPath();
		ctx.rect(plot.x, plot.y - 6, plot.w, plot.h + laneHeight + 12);
		ctx.clip();

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
		const labels: Array<{ text: string; y: number }> = [];
		ctx.lineWidth = 1.8;
		digitalTraces.forEach((trace, index) => {
			const top = plot.y + plot.h + index * lane + lane * 0.22;
			const bottom = top + lane * 0.56;
			ctx.strokeStyle = trace.colour;
			ctx.beginPath();

			const levelY = (state: string) =>
				state === 'high' ? top : state === 'low' ? bottom : (top + bottom) / 2;

			// Starting from what the net was already at when the memory opens: a net
			// that has not changed in a while has no transition inside the window, and
			// left to the events alone its lane would simply be empty.
			let previousY = levelY(trace.opening);
			let started = true;
			ctx.moveTo(toX(from), previousY);

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
			if (started) ctx.lineTo(toX(to), previousY);
			ctx.stroke();

			labels.push({ text: trace.label, y: (top + bottom) / 2 });
		});
		ctx.restore();

		// Lane names, outside the clip so they sit in the margin like the volts do.
		ctx.fillStyle = colour('--label-dim');
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		for (const label of labels) ctx.fillText(label.text, plot.x - 8, label.y);

		// Playhead: the instant the drawing is showing.
		if (app.result) {
			const x = toX(Math.min(Math.max(app.playbackTime, from), to));
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

	/** Simulated time under a pointer. */
	function timeAt(clientX: number): number | null {
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const plotW = Math.max(rect.width - PADDING.left - PADDING.right, 10);
		const fraction = (clientX - rect.left - PADDING.left) / plotW;
		return span.from + fraction * (span.to - span.from);
	}

	function seekTo(event: PointerEvent) {
		const t = timeAt(event.clientX);
		if (t !== null) app.seek(t);
	}

	/**
	 * Put the window somewhere, bounded by what is still in memory.
	 *
	 * Both ways: a scope will not scroll back past what it kept, and it will not
	 * scroll forward past the last thing it caught. There is nothing there.
	 */
	function place(from: number, width: number) {
		if (!app.result) return;
		let start = Math.max(from, held.earliest);
		start = Math.min(start, Math.max(held.now - width, held.earliest));
		view = { from: start, to: start + width };
	}

	/** Zoom about the pointer, so whatever is under it stays under it. */
	function zoom(factor: number, about: number) {
		if (!app.result) return;
		const memory = Math.max(held.now - held.earliest, 1e-12);
		const width = Math.min(Math.max((span.to - span.from) * factor, 1e-9), memory);
		const share = (about - span.from) / Math.max(span.to - span.from, 1e-15);
		place(about - share * width, width);
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
		const at = cursor.time;
		const here = indexAt(run.time, at);
		const there = marker === null ? null : indexAt(run.time, marker);
		const family = logicFamily(app.logicFamily);
		return {
			time: run.time[here],
			delta: there === null ? null : run.time[here] - run.time[there],
			values: traces.map((t) => ({
				label: t.label,
				colour: t.colour,
				text: `${formatValue(t.samples[here], 4)}V`,
				// The change between the two, which is the number nobody wants to do
				// by subtracting two readings they wrote down.
				delta:
					there === null ? null : `${formatValue(t.samples[here] - t.samples[there], 4)}V`
			})),
			// And the logic lanes, which read nothing at all until now: a lane is two
			// levels and a label, so "is that a one, and what is a one here" was a
			// question the panel underneath the trace could not answer.
			logic: digitalTraces.map((t) => {
				const state = t.events.filter((e) => e.time <= at).at(-1)?.state ?? 'unknown';
				const volts =
					state === 'high' ? family.v_high : state === 'low' ? family.v_low : null;
				return {
					label: t.label,
					colour: t.colour,
					text:
						state === 'high' || state === 'low'
							? `${state === 'high' ? 1 : 0} (${formatValue(volts ?? 0, 3)}V)`
							: state
				};
			})
		};
	});

	/** Where a drag started, in screen pixels and in seconds. */
	let dragging: { x: number; from: number } | null = null;

	function onMove(event: PointerEvent) {
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const t = timeAt(event.clientX);
		cursor = t !== null && t >= span.from && t <= span.to ? { x, time: t } : null;

		// Dragging pans the window — and only when the sweep has stopped, because a
		// running acquisition has nowhere to be dragged to: the newest instant is
		// the only one there is. Shift is measuring and must not move anything.
		if (dragging && event.buttons & 1 && !event.shiftKey) {
			const plotW = Math.max(rect.width - PADDING.left - PADDING.right, 10);
			const width = span.to - span.from;
			place(dragging.from + ((dragging.x - x) / plotW) * width, width);
		}
	}

	function onWheel(event: WheelEvent) {
		if (app.playing || !app.result) return;
		const about = timeAt(event.clientX);
		if (about === null) return;
		event.preventDefault();
		zoom(event.deltaY > 0 ? 1.25 : 0.8, about);
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
		void [
			app.result,
			traces,
			digitalTraces,
			range,
			lanes,
			separate,
			marker,
			size,
			cursor,
			playheadPx,
			span,
			app.channels
		];
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

		{#if readout && readout.values.length + readout.logic.length > 0}
			<div class="readout">
				<span class="time">
					t = {formatValue(readout.time, 4)}s
					{#if readout.delta !== null}
						<span class="delta">Δt = {formatValue(readout.delta, 4)}s</span>
					{/if}
				</span>
				{#each readout.values as entry (entry.label)}
					<span class="value" style:color={entry.colour}>
						{entry.label} = {entry.text}
						{#if entry.delta !== null}
							<span class="delta">Δ {entry.delta}</span>
						{/if}
					</span>
				{/each}
				{#each readout.logic as entry (entry.label)}
					<span class="value" style:color={entry.colour}>{entry.label} = {entry.text}</span>
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

						<!--
							The knobs. Automatic is the right default — nobody wants to set up
							a scope before seeing anything — but a scope you cannot turn is a
							picture of a scope. Gain expands about the middle of the band, so
							turning it up shows more of what a trace is doing rather than
							launching it off the top.
						-->
						{#if probe}
							{@const knob = app.channels[probe.key] ?? { gain: 1, offset: 0 }}
							<div class="knobs">
								<span class="knob">
									<button onclick={() => app.adjustGain(probe.key, -1)} title="Less gain">−</button>
									<span class="reading">×{knob.gain}</span>
									<button onclick={() => app.adjustGain(probe.key, 1)} title="More gain">+</button>
								</span>
								<span class="knob">
									<button onclick={() => app.adjustOffset(probe.key, 1)} title="Move up">↑</button>
									<button onclick={() => app.adjustOffset(probe.key, -1)} title="Move down">↓</button>
								</span>
								{#if knob.gain !== 1 || knob.offset !== 0}
									<button
										class="reset"
										onclick={() => app.resetChannel(probe.key)}
										title="Back to automatic">auto</button
									>
								{/if}
							</div>
						{/if}
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
	.knobs {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.1rem 0 0.15rem 1.35rem;
	}

	.knob {
		display: inline-flex;
		align-items: center;
		border: 1px solid var(--border);
		border-radius: 4px;
		overflow: hidden;
	}

	.knobs button {
		border: 0;
		background: var(--control-bg);
		color: var(--label-dim);
		font-size: 0.62rem;
		line-height: 1;
		padding: 0.12rem 0.28rem;
		cursor: pointer;
	}

	.knobs button:hover {
		color: var(--text);
	}

	.knobs .reading {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--label-dim);
		padding: 0 0.25rem;
		min-width: 2.1rem;
		text-align: center;
	}

	.knobs .reset {
		border: 1px solid var(--border);
		border-radius: 4px;
		font-size: 0.58rem;
	}

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
