<script lang="ts">
	import { untrack } from 'svelte';
	import { measureBurst, measureLogic } from '$lib/measure';
	import { firstAfter, levelAt } from '$lib/transitions';
	import { DEPTH } from '$lib/capture';
	import { logicFamily } from '$lib/schematic/logic';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';
	import { decimate, extent, ticks, timeLabel, visibleRange, wheelFactor } from '$lib/plot';
	import { advance, freshScan, pickFrame, resolveLevels, type TriggerScan } from '$lib/trigger';
	import { spectrumSpan } from '$lib/spectrum';
	import {
		axisY,
		fitLabel,
		marginFor,
		measureVisible,
		playheadPixel,
		scopeLayout,
		settleReading
	} from '$lib/plot-layout';
	import { watchPixelRatio } from '$lib/canvas/pixel-ratio';
	import type { Burst, DigitalTransition, LogicState } from '$lib/engine';
	import BodePlot from './BodePlot.svelte';
	import SweepPlot from './SweepPlot.svelte';
	import SignalsPanel from './scope/SignalsPanel.svelte';
	import SpectrumPlot from './scope/SpectrumPlot.svelte';
	import TriggerPanel from './scope/TriggerPanel.svelte';
	import { Button } from '$lib/ui';

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

	/** The least left margin: room for the volts. Widened for long lane names. */
	const LEFT_LEAST = 62;
	const PADDING = { right: 14, top: 14, bottom: 26 };
	/** The size the canvas writes its labels at. */
	const FONT_PX = 11;

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
		/**
		 * Whether the node is being driven with a time average at the moment: it
		 * hangs off a logic net switching faster than this timebase shows, and the
		 * engine holds the bridge at the net's average rather than solving every
		 * edge. The trace is then a level where the circuit has a square wave.
		 */
		averaged: boolean;
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
			const net = probe.digital ? run.netNames.indexOf(probe.digital) : -1;
			const burst = net < 0 ? undefined : run.bursts?.[net]?.at(-1);
			const newest = run.time[run.time.length - 1] ?? 0;
			out.push({
				label: probe.label,
				colour: probe.colour,
				samples,
				low: band?.low.get(key),
				high: band?.high.get(key),
				gain: knobs.gain,
				offset: knobs.offset,
				key: probe.key,
				averaged: burst !== undefined && burst.to >= newest - app.stopTime / 200
			});
		}
		return out;
	});

	const digitalTraces = $derived.by(() => {
		const run = app.result;
		if (!run) return [];
		const out: Array<{
			key: string;
			label: string;
			colour: string;
			/** Which net, in the run's numbering. */
			index: number;
			events: DigitalTransition[];
			/** Spans the net switched through too fast for the events to record. */
			bursts: Burst[];
			/** The level the net was already at when the memory opens. */
			opening: LogicState;
			/** Where the lane sits, in lane heights. The one knob a lane has. */
			offset: number;
		}> = [];
		for (const probe of digitalProbes) {
			const index = run.netNames.indexOf(probe.digital!);
			if (index < 0) continue;
			// Bridged nets are drawn as an analog trace as well, and that trace is
			// what the gain knob is for; the lane only ever has a position.
			out.push({
				key: probe.key,
				label: probe.label,
				colour: probe.colour,
				index,
				events: run.digital[index],
				bursts: run.bursts?.[index] ?? [],
				opening: app.capture?.openingState(index) ?? 'unknown',
				offset: app.channels[probe.key]?.offset ?? 0
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

	/**
	 * How much of the chosen window the memory can actually fill.
	 *
	 * The memory is a fixed number of samples, and a fast circuit spends them
	 * quickly: a clock at a hundred megahertz fills it in a couple of hundred
	 * microseconds. Drawn across a five-millisecond window that came out as a
	 * flat line with a smear at the right-hand end, which reads as the simulator
	 * having broken. Once samples have been let go, the window is only as wide as
	 * what is still held.
	 */
	const coverage = $derived.by(() => {
		const width = Math.max(app.stopTime, 1e-12);
		const time = app.result?.time;
		if (!time || held.earliest <= 0) return width;
		// The memory is a ring that holds between one and two depths of samples
		// and lets a depth go at a time, so "everything held" lurches back and
		// forth by half at every compaction — and a window sized to it lurched
		// with it. What is guaranteed is the newest depth; the width is that.
		const guaranteed = time[Math.max(0, time.length - DEPTH)];
		return Math.min(width, Math.max(held.now - guaranteed, 1e-12));
	});
	const narrowed = $derived(app.result !== null && coverage < Math.max(app.stopTime, 1e-12) * 0.999);

	/**
	 * The trace the trigger watches: the one chosen, or the first while the
	 * chosen one is not plotted.
	 */
	const triggerIndex = $derived(
		traces.length === 0 ? -1 : Math.min(app.trigger.source, traces.length - 1)
	);

	/** What an automatic level and hysteresis come to, from all the source has done in memory. */
	const triggerLevels = $derived.by(() => {
		const source = traces[triggerIndex];
		if (!source || app.trigger.mode === 'off') return null;
		const { lo, hi } = extent(source.samples, 0, source.samples.length);
		return resolveLevels(app.trigger, lo, hi);
	});

	/**
	 * Where the trigger search has got to. Not reactive: it is the memo of the
	 * search, carried from chunk to chunk, and started again from nothing when
	 * the run, the source or a setting that decides where it fires changes —
	 * an automatic level included, once it has moved by a hysteresis.
	 */
	let scan: TriggerScan = freshScan();
	let scanFor: { acquiring: unknown; key: string } = { acquiring: null, key: '' };

	/** When single was last armed: a trigger before it is not the one it waits for. */
	let armedAt = $state(-Infinity);

	const triggerFrame = $derived.by(() => {
		const run = app.result;
		const source = traces[triggerIndex];
		const t = app.trigger;
		if (!run || !source || !triggerLevels || t.mode === 'off') return null;
		// The level as it resolved, in steps of the hysteresis: an automatic level
		// that moves by more than that — the swing still growing at the start of
		// a run — searches again, so a trigger found at a level that has since
		// moved does not stand. One that settles stops moving, and stops this.
		const step = Math.max(triggerLevels.hysteresis, 1e-12);
		const key = [source.key, t.edge, t.holdoff, Math.round(triggerLevels.level / step), step].join('|');
		const newest = run.time[run.time.length - 1] ?? 0;
		if (scanFor.acquiring !== app.acquiring || scanFor.key !== key || newest < scan.scanned) {
			scan = freshScan();
			scanFor = { acquiring: app.acquiring, key };
		}
		scan = advance(scan, run.time, source.samples, { ...triggerLevels, edge: t.edge, holdoff: t.holdoff });
		return pickFrame(scan.events, {
			mode: t.mode,
			width: coverage,
			position: t.position,
			now: held.now,
			running: app.playing,
			armedAt
		});
	});

	// Single arms from the start of a new run, when a stopped run is picked up
	// again, and when single is chosen.
	let armedFor: unknown = null;
	let wasPlaying = false;
	let lastMode = untrack(() => app.trigger.mode);
	$effect(() => {
		const acquiring = app.acquiring;
		const playing = app.playing;
		const mode = app.trigger.mode;
		untrack(() => {
			if (acquiring !== armedFor) armedAt = -Infinity;
			else if ((playing && !wasPlaying) || (mode === 'single' && lastMode !== 'single')) armedAt = held.now;
			armedFor = acquiring;
			wasPlaying = playing;
			lastMode = mode;
		});
	});

	// Caught: a single stops the run, as Single on a bench scope does, so the
	// screen it caught stays in memory to be looked at.
	$effect(() => {
		if (triggerFrame?.status === 'captured' && untrack(() => app.playing)) app.stop();
	});

	/** Wait for the next trigger, running on if the run had stopped. */
	function arm() {
		armedAt = held.now;
		view = null;
		if (!app.playing && app.acquiring) app.togglePlay();
	}

	const span = $derived.by(() => {
		const width = coverage;
		if (!app.result) return { from: 0, to: width };
		// A running sweep follows itself. Whatever the window was dragged to while
		// it was stopped is kept for when it stops again, but it cannot hold the
		// screen still over a run that has moved on.
		if (view && !app.playing) return view;
		// Triggered, the screen is placed around the trigger instead.
		if (triggerFrame?.window) return triggerFrame.window;
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

	/**
	 * Which samples the window covers.
	 *
	 * Found by bisection, and everything drawn or scaled works from it: the
	 * memory holds up to two depths of samples per signal, and walking all of
	 * them on every chunk to draw a sliver of them was most of what a frame
	 * cost.
	 */
	const visible = $derived.by(() => {
		const time = app.result?.time;
		return time ? visibleRange(time, span.from, span.to) : { start: 0, end: 0 };
	});

	/**
	 * Range of one trace on its own, padded so nothing touches its band edge.
	 *
	 * Of what is on screen, not of everything in memory: a scope's autoset
	 * scales what it is showing, and a spike that has scrolled off the left
	 * should not keep the trace squashed.
	 */
	function spanOf(series: Array<Float64Array | undefined>) {
		const into = { lo: Infinity, hi: -Infinity };
		for (const s of series) extent(s, visible.start, visible.end, into);
		return windowFor(into.lo, into.hi);
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
			.map((t) => ({
				key: t.key,
				label: t.label,
				colour: t.colour,
				averaged: t.averaged,
				m: measureVisible(run.time, t.samples, span.from, span.to)
			}))
			.filter((row) => row.m !== null);
	});

	/**
	 * The same for the logic lanes, which had no way to be asked how fast they
	 * were going — the one question anybody has about a counter's outputs.
	 */
	const logicMeasurements = $derived.by(() => {
		void app.result;
		const capture = app.capture;
		if (!capture || !measuring) return [];
		// Measured from the edges the capture keeps beyond its samples: the top of
		// a counter changes once in seconds, and the memory holds milliseconds. A
		// lane that has not gone round even once still gets a row, saying so —
		// silence read as the button not working.
		return digitalTraces.map((t) => {
			const { events, opening } = capture.edges(t.index);
			// A net that is busy — switching faster than the screen can show — is
			// read off the burst the engine folded it into, which is newer than any
			// edge the history holds.
			const burst = t.bursts[t.bursts.length - 1];
			const newest = events[events.length - 1];
			const m =
				burst && (!newest || burst.to >= newest.time)
					? measureBurst(burst)
					: measureLogic(events, opening);
			return { key: t.key, label: t.label, colour: t.colour, m };
		});
	});

	/** The trace the spectrum is of: the one chosen, or the first while that one is not plotted. */
	const spectrumOf = $derived(
		traces.length === 0 ? null : traces[Math.min(app.spectrum.source, traces.length - 1)]
	);

	/** The stretch of time the spectrum is taken over. */
	const fftSpan = $derived.by(() => {
		const run = app.result;
		if (!run || !spectrumOf || !app.spectrum.on) return { from: span.from, to: span.to, whole: false };
		const period =
			app.spectrum.span === 'periods'
				? (measureVisible(run.time, spectrumOf.samples, span.from, span.to)?.period ?? null)
				: null;
		return spectrumSpan(app.spectrum, span, held, period);
	});

	/** The analog traces by their place in the list, for the pickers that choose one. */
	const sourceItems = $derived(traces.map((t, i) => ({ value: String(i), label: t.label })));

	/** One range per trace, for when they are drawn separated. */
	const lanes = $derived(traces.map((t) => spanOf([t.samples, t.low, t.high])));

	/** Vertical range of the analog traces, padded so nothing touches the frame. */
	const range = $derived.by(() => {
		const into = { lo: Infinity, hi: -Infinity };
		for (const trace of traces) {
			// The band too, or a sweep whose corners leave the nominal window would
			// be drawn flat against the frame — which reads as "it stays inside"
			// when what happened is that the plot ran out of room.
			for (const series of [trace.samples, trace.low, trace.high]) {
				extent(series, visible.start, visible.end, into);
			}
		}
		return windowFor(into.lo, into.hi);
	});

	function niceStep(span: number, target: number): number {
		const raw = span / Math.max(target, 1);
		const power = Math.pow(10, Math.floor(Math.log10(raw)));
		for (const m of [1, 2, 5, 10]) {
			if (power * m >= raw) return power * m;
		}
		return power * 10;
	}

	/**
	 * The theme's colours, read once rather than on every frame.
	 *
	 * `getComputedStyle` forces style to be worked out, and the scope used to
	 * ask for it on every chunk of a running sweep. Read again after the canvas
	 * is resized and when the system theme changes, which is when they can.
	 */
	let colours = new Map<string, string>();
	function colour(name: string): string {
		let value = colours.get(name);
		if (value === undefined && canvas) {
			value = getComputedStyle(canvas).getPropertyValue(name).trim();
			colours.set(name, value);
		}
		return value ?? '';
	}

	/**
	 * Device pixels per CSS pixel. Watched, not only read at a resize: moving the
	 * window to a screen with another scale changes it with the size unchanged,
	 * and the scope stayed blurry until something else resized it.
	 */
	let dpr = $state(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
	$effect(() => watchPixelRatio(window, (ratio) => (dpr = ratio)));

	/**
	 * Size the backing store, and only when the size changes.
	 *
	 * Assigning a canvas's width reallocates it even when the number is the same,
	 * and that used to happen on every repaint.
	 */
	$effect(() => {
		if (!canvas) return;
		canvas.width = Math.round(size.width * dpr);
		canvas.height = Math.round(size.height * dpr);
		colours = new Map();
	});

	/** Width of a label as the canvas will write it. */
	let measurer: CanvasRenderingContext2D | null = null;
	function textWidth(text: string): number {
		if (!measurer && canvas) {
			measurer = document.createElement('canvas').getContext('2d');
			if (measurer) measurer.font = `${FONT_PX}px ${colour('--font-mono') || 'monospace'}`;
		}
		// A monospace advance is about six tenths of the size, for the first frame
		// before the canvas exists.
		return measurer ? measurer.measureText(text).width : text.length * FONT_PX * 0.6;
	}

	/**
	 * The left margin: wide enough for the volts and for the longest lane name.
	 *
	 * Lane names are written right-aligned into this margin, and at a fixed 62 px
	 * a name like `BUTTON.p+1` lost its first letters off the canvas's edge.
	 */
	const left = $derived(
		marginFor(
			digitalTraces.map((t) => t.label),
			textWidth,
			{ least: LEFT_LEAST, width: size.width }
		)
	);
	const padding = $derived({ ...PADDING, left });

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

	function draw() {
		if (!canvas || size.width === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		const w = size.width;
		const h = size.height;
		ctx.clearRect(0, 0, w, h);

		// A purely digital circuit has no voltage axis to draw, so give the whole
		// panel over to the logic lanes instead of leaving an empty graph above.
		// With both, the lanes shrink first and the analog plot keeps a floor;
		// lanes there is no room for at all are counted rather than drawn over
		// the time axis.
		const hasAnalog = traces.length > 0;
		const layout = scopeLayout({
			width: w,
			height: h,
			padding,
			analog: hasAnalog,
			lanes: digitalTraces.length
		});
		const { plot, lane } = layout;
		const laneHeight = layout.shown * lane;
		hiddenLanes = layout.hidden;

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
		// Grid. On the axis itself, not through any channel's knobs: mapped through
		// the first trace's gain, the gridlines and their volts followed that one
		// knob out of the plot and over the lanes.
		ctx.strokeStyle = colour('--scope-grid') || '#2a2f3a';
		ctx.fillStyle = colour('--label-dim') || '#7c8496';
		ctx.lineWidth = 1;
		ctx.font = `${FONT_PX}px ${colour('--font-mono') || 'monospace'}`;

		const vStep = niceStep(range.hi - range.lo, 5);
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		for (const v of hasAnalog && !separate ? ticks(range.lo, range.hi, vStep) : []) {
			const y = axisY(range, plot, v);
			if (y < plot.y - 0.5 || y > plot.y + plot.h + 0.5) continue;
			ctx.beginPath();
			ctx.moveTo(plot.x, y);
			ctx.lineTo(plot.x + plot.w, y);
			ctx.strokeStyle = v === 0 ? colour('--scope-axis') : colour('--scope-grid');
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(formatWithUnit(v, 'V', 3), plot.x - 8, y);
		}

		const tStep = niceStep(width, 6);
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		for (const t of ticks(from, to, tStep, tStep / 2)) {
			const x = toX(t);
			ctx.beginPath();
			ctx.moveTo(x, plot.y);
			ctx.lineTo(x, plot.y + plot.h + laneHeight);
			ctx.strokeStyle = colour('--scope-grid');
			ctx.stroke();
			ctx.fillStyle = colour('--label-dim');
			ctx.fillText(timeLabel(t, tStep), x, h - PADDING.bottom + 6);
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
		const { start, end } = visible;
		traces.forEach((trace, index) => {
			if (!trace.low || !trace.high) return;
			ctx.beginPath();
			const top = decimate(run.time, trace.high, start, end, toX);
			for (let i = 0; i < top.length; i += 2) {
				const y = mapY(index, top[i + 1]);
				if (i === 0) ctx.moveTo(top[i], y);
				else ctx.lineTo(top[i], y);
			}
			const bottom = decimate(run.time, trace.low, start, end, toX);
			for (let i = bottom.length - 2; i >= 0; i -= 2) {
				ctx.lineTo(bottom[i], mapY(index, bottom[i + 1]));
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
			const line = decimate(run.time, trace.samples, start, end, toX);
			for (let i = 0; i < line.length; i += 2) {
				const y = mapY(index, line[i + 1]);
				if (i === 0) ctx.moveTo(line[i], y);
				else ctx.lineTo(line[i], y);
			}
			ctx.stroke();

			// Separated, each band carries its own two numbers in its own colour.
			// A shared axis on the left would be describing only one of them.
			if (separate) {
				const b = bandOf(index);
				ctx.fillStyle = trace.colour;
				ctx.textAlign = 'right';
				ctx.textBaseline = 'top';
				ctx.fillText(formatWithUnit(b.span.hi, 'V', 3), plot.x - 8, b.top);
				ctx.textBaseline = 'bottom';
				ctx.fillText(formatWithUnit(b.span.lo, 'V', 3), plot.x - 8, b.top + b.h);
				ctx.textAlign = 'left';
				ctx.textBaseline = 'top';
				ctx.fillText(trace.label, plot.x + 6, b.top + 2);
			}
		});

		// Digital lanes below the analog plot.
		const labels: Array<{ text: string; y: number }> = [];
		ctx.lineWidth = 1.8;
		digitalTraces.slice(0, layout.shown).forEach((trace, index) => {
			// Moved by its own knob, in half-lane steps, so two lanes can be laid
			// over each other to compare edges — which is what moving a channel on a
			// scope is for.
			const shift = trace.offset * lane * 0.5;
			const top = plot.y + plot.h + index * lane + lane * 0.22 - shift;
			const bottom = top + lane * 0.56;
			ctx.strokeStyle = trace.colour;
			ctx.beginPath();

			const levelY = (state: string) =>
				state === 'high' ? top : state === 'low' ? bottom : (top + bottom) / 2;

			// Starting from what the net was at when the window opens — the last
			// edge before it, or what it was already at when the memory opens: a
			// net that has not changed in a while has no transition inside the
			// window, and left to the events alone its lane would simply be empty.
			// Only the edges inside the window are drawn; the memory holds every
			// edge of a long sweep, and walking them all for each frame was a frame
			// that grew for as long as the run went on.
			let previousY = levelY(levelAt(trace.events, from, trace.opening));
			ctx.moveTo(toX(from), previousY);

			for (let i = firstAfter(trace.events, from); i < trace.events.length; i++) {
				const event = trace.events[i];
				if (event.time > to) break;
				const x = toX(event.time);
				const y = levelY(event.state);
				ctx.lineTo(x, previousY);
				ctx.lineTo(x, y);
				previousY = y;
			}
			ctx.lineTo(toX(to), previousY);
			ctx.stroke();

			// Where the net was switching faster than a pixel: a band between the
			// levels, which is what a scope shows of a signal it cannot resolve.
			for (const burst of trace.bursts) {
				const left = Math.max(toX(burst.from), plot.x);
				const right = Math.min(toX(burst.to), plot.x + plot.w);
				if (right <= left) continue;
				ctx.globalAlpha = 0.45;
				ctx.fillStyle = trace.colour;
				ctx.fillRect(left, top, right - left, bottom - top);
				ctx.globalAlpha = 1;
			}

			labels.push({ text: trace.label, y: (top + bottom) / 2 });
		});
		ctx.restore();

		// Lane names, outside the clip so they sit in the margin like the volts do.
		ctx.fillStyle = colour('--label-dim');
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		// Shortened from the middle if even the widened margin cannot take them.
		for (const label of labels) {
			ctx.fillText(fitLabel(label.text, plot.x - 12, textWidth), plot.x - 8, label.y);
		}

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

		// The trigger: a tab on the top edge where it fired, and one on the right
		// edge at its level, in the colour of the trace it watches.
		const source = traces[triggerIndex];
		if (source && triggerLevels) {
			ctx.fillStyle = source.colour;
			if (triggerFrame?.at != null) {
				const x = toX(triggerFrame.at);
				ctx.beginPath();
				ctx.moveTo(x - 5, plot.y - 10);
				ctx.lineTo(x + 5, plot.y - 10);
				ctx.lineTo(x, plot.y - 3);
				ctx.closePath();
				ctx.fill();
				ctx.save();
				ctx.globalAlpha = 0.5;
				ctx.setLineDash([2, 4]);
				ctx.strokeStyle = source.colour;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(x, plot.y);
				ctx.lineTo(x, plot.y + plot.h);
				ctx.stroke();
				ctx.restore();
			}
			const y = mapY(triggerIndex, triggerLevels.level);
			if (y >= plot.y - 1 && y <= plot.y + plot.h + 1) {
				const right = plot.x + plot.w;
				ctx.beginPath();
				ctx.moveTo(right + 1, y);
				ctx.lineTo(right + 9, y - 5);
				ctx.lineTo(right + 9, y + 5);
				ctx.closePath();
				ctx.fill();
			}
		}

		// What the spectrum under the scope is taken over, as a bar along the
		// bottom of the plot: it need not be the screen.
		if (app.spectrum.on && spectrumOf) {
			const a = Math.max(toX(fftSpan.from), plot.x);
			const b = Math.min(toX(fftSpan.to), plot.x + plot.w);
			if (b > a) {
				ctx.save();
				ctx.globalAlpha = 0.6;
				ctx.fillStyle = spectrumOf.colour;
				ctx.fillRect(a, plot.y + plot.h - 3, b - a, 3);
				ctx.restore();
			}
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
		const plotW = Math.max(size.width - left - PADDING.right, 10);
		return playheadPixel(app.playbackTime, span, plotW);
	});

	/** Logic lanes there was no room for in the last frame drawn. */
	let hiddenLanes = $state(0);

	/** Simulated time under a pointer. */
	function timeAt(clientX: number): number | null {
		if (!canvas) return null;
		const rect = canvas.getBoundingClientRect();
		const plotW = Math.max(rect.width - left - PADDING.right, 10);
		const fraction = (clientX - rect.left - left) / plotW;
		return span.from + fraction * (span.to - span.from);
	}

	/**
	 * Whether a pointer is on the playhead, close enough to pick it up.
	 *
	 * A finger is wider than a line, so it gets more room than a mouse.
	 */
	function onPlayhead(event: PointerEvent): boolean {
		if (!canvas || !app.result || app.playing) return false;
		const rect = canvas.getBoundingClientRect();
		const plotW = Math.max(rect.width - left - PADDING.right, 10);
		const at = Math.min(Math.max(app.playbackTime, span.from), span.to);
		const x = left + ((at - span.from) / Math.max(span.to - span.from, 1e-15)) * plotW;
		return Math.abs(event.clientX - rect.left - x) <= (event.pointerType === 'touch' ? 14 : 6);
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

	/** Narrowest and widest the timebase can be turned to. */
	const TIMEBASE = { least: 1e-9, most: 100 };

	/**
	 * Turn the timebase, as the knob on a bench scope does.
	 *
	 * Running, the window follows the sweep at whatever width it has, so the
	 * knob is the width itself — the same setting as the field in the header,
	 * and the run follows it without starting over. Stopped, the trace is a
	 * picture, and the knob zooms the picture about the pointer.
	 */
	function turn(factor: number, about: number | null) {
		if (!app.result) return;
		if (app.playing) {
			const width = Math.min(Math.max(app.stopTime * factor, TIMEBASE.least), TIMEBASE.most);
			app.setStopTime(width);
			return;
		}
		zoom(factor, about ?? (span.from + span.to) / 2);
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
		const delta = there === null ? null : run.time[here] - run.time[there];
		return {
			time: run.time[here],
			delta,
			// A cursor pair on two edges is one period, and the frequency is what
			// the person was after; dividing it out by hand is the step that gets
			// skipped.
			rate: delta !== null && Math.abs(delta) > 1e-15 ? 1 / Math.abs(delta) : null,
			values: traces.map((t) => ({
				key: t.key,
				label: t.label,
				colour: t.colour,
				text: formatWithUnit(settleReading(t.samples[here], range.hi - range.lo), 'V', 4),
				// The change between the two, which is the number nobody wants to do
				// by subtracting two readings they wrote down.
				delta:
					there === null
						? null
						: formatWithUnit(settleReading(t.samples[here] - t.samples[there], range.hi - range.lo), 'V', 4)
			})),
			// And the logic lanes, which read nothing at all until now: a lane is two
			// levels and a label, so "is that a one, and what is a one here" was a
			// question the panel underneath the trace could not answer.
			logic: digitalTraces.map((t) => {
				const state = levelAt(t.events, at, t.opening);
				const volts =
					state === 'high' ? family.v_high : state === 'low' ? family.v_low : null;
				return {
					key: t.key,
					label: t.label,
					colour: t.colour,
					text:
						state === 'high' || state === 'low'
							? `${state === 'high' ? 1 : 0} (${formatWithUnit(volts ?? 0, 'V', 3)})`
							: state
				};
			})
		};
	});

	/** Where a drag started, in screen pixels and in seconds. */
	let dragging: { x: number; from: number } | null = null;
	/** The playhead is held and follows the pointer, for a seek finer than a click. */
	let scrubbing = $state(false);
	/** The pointer is over the playhead, so the plot shows it can be picked up. */
	let overPlayhead = $state(false);

	/** Fingers on the plot, for a pinch. */
	const touches = new Map<number, number>();
	/** How far apart the two fingers were when the last turn was taken from them. */
	let pinchSpread: number | null = null;

	function onDown(event: PointerEvent) {
		// Every pointer, not only a finger: a mouse drag that left the canvas
		// stopped panning at its edge, and one let go outside it left the drag
		// behind.
		canvas?.setPointerCapture(event.pointerId);
		if (event.pointerType === 'touch') {
			touches.set(event.pointerId, event.clientX);
			if (touches.size === 2) {
				// Two fingers: the timebase, and neither of them is a seek or a drag.
				dragging = null;
				scrubbing = false;
				pinchSpread = spread();
				return;
			}
		}
		if (event.shiftKey) {
			// Second press in the same place picks it up again.
			marker =
				marker !== null && cursor && Math.abs(marker - cursor.time) < 1e-12
					? null
					: (cursor?.time ?? null);
			return;
		}
		if (onPlayhead(event)) {
			// Picked up by the line itself: the drag moves it rather than the view.
			scrubbing = true;
			return;
		}
		seekTo(event);
		// Stopped, the trace is a picture that can be dragged along. Running, the
		// newest instant is the only place there is, so there is nowhere to drag to.
		if (!app.playing && canvas) {
			const rect = canvas.getBoundingClientRect();
			dragging = { x: event.clientX - rect.left, from: span.from };
		}
	}

	function onUp(event: PointerEvent) {
		if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
		touches.delete(event.pointerId);
		if (touches.size < 2) pinchSpread = null;
		dragging = null;
		scrubbing = false;
	}

	function spread(): number {
		const [a, b] = [...touches.values()];
		return Math.abs(a - b);
	}

	function onMove(event: PointerEvent) {
		if (!canvas) return;
		if (touches.has(event.pointerId)) touches.set(event.pointerId, event.clientX);
		if (pinchSpread !== null && touches.size === 2) {
			// Wider apart is a narrower window: what was between the fingers grows to
			// fill the screen. Taken in whole notches so the ratio is exact over the
			// gesture rather than accumulating rounding from every move event.
			const now = spread();
			if (now > 0 && pinchSpread > 0) {
				const [a, b] = [...touches.values()];
				turn(pinchSpread / now, timeAt((a + b) / 2));
				pinchSpread = now;
			}
			return;
		}
		const rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const t = timeAt(event.clientX);
		cursor = t !== null && t >= span.from && t <= span.to ? { x, time: t } : null;

		if (scrubbing) {
			if (t !== null) app.seek(Math.min(Math.max(t, span.from), span.to));
			return;
		}
		overPlayhead = event.pointerType !== 'touch' && onPlayhead(event);

		// Dragging pans the window — and only when the sweep has stopped, because a
		// running acquisition has nowhere to be dragged to: the newest instant is
		// the only one there is. Shift is measuring and must not move anything.
		if (dragging && event.buttons & 1 && !event.shiftKey) {
			const plotW = Math.max(rect.width - left - PADDING.right, 10);
			const width = span.to - span.from;
			place(dragging.from + ((dragging.x - x) / plotW) * width, width);
		}
	}

	function onWheel(event: WheelEvent) {
		if (!app.result) return;
		const factor = wheelFactor(event);
		if (factor === null) return;
		event.preventDefault();
		turn(factor, timeAt(event.clientX));
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
			visible,
			separate,
			marker,
			size,
			cursor,
			playheadPx,
			span,
			padding,
			dpr,
			app.channels,
			triggerFrame,
			triggerLevels,
			fftSpan,
			app.spectrum.on
		];
		// Untracked, so the list above is the whole of what repaints it. `draw`
		// reads the raw playback time, and tracked it would repaint the canvas on
		// every frame of the animation however little the line moved — which is
		// what `playheadPx` exists to stop.
		untrack(draw);
	});
</script>

<div class="scope">
	{#if app.analysis === 'frequency'}
		<BodePlot />
	{:else if app.analysis === 'dc'}
		<SweepPlot />
	{:else}
	<div class="stack" class:split={app.spectrum.on}>
	<div class="plot" bind:this={host}>
		<canvas
			bind:this={canvas}
			style:width="{size.width}px"
			style:height="{size.height}px"
			onpointermove={onMove}
			onpointerdown={onDown}
			onpointerup={onUp}
			onpointercancel={onUp}
			onwheel={onWheel}
			onpointerleave={() => {
				cursor = null;
				overPlayhead = false;
			}}
			class:grab-playhead={overPlayhead || scrubbing}
		></canvas>

		{#if !app.result}
			<p class="empty">
				{app.running ? 'Simulating…' : 'Press Run to simulate.'}
			</p>
		{:else if app.activeProbes.length === 0}
			<p class="empty">Tick a net on the right to plot it.</p>
		{/if}

		{#if narrowed}
			<p class="memory" title="The memory is a fixed number of samples, and this circuit uses them quickly. A shorter stop time is a window it can fill.">
				memory holds {formatWithUnit(coverage, 's', 3)} of the {formatWithUnit(app.stopTime, 's', 3)} window
			</p>
		{/if}

		{#if hiddenLanes > 0}
			<p class="lanes-hidden" title="Each lane needs some height to tell its two levels apart. Drag the scope taller, or untick a net on the right.">
				+{hiddenLanes} {hiddenLanes === 1 ? 'lane' : 'lanes'} not shown — make the scope taller
			</p>
		{/if}

		{#if readout && readout.values.length + readout.logic.length > 0}
			<div class="readout">
				<span class="time">
					t = {formatWithUnit(readout.time, 's', 4)}
					{#if readout.delta !== null}
						<span class="delta">Δt = {formatWithUnit(readout.delta, 's', 4)}</span>
						{#if readout.rate !== null}
							<span class="delta">1/Δt = {formatWithUnit(readout.rate, 'Hz', 4)}</span>
						{/if}
					{/if}
				</span>
				{#each readout.values as entry (entry.key)}
					<span class="value" style:color={entry.colour}>
						{entry.label} = {entry.text}
						{#if entry.delta !== null}
							<span class="delta">Δ {entry.delta}</span>
						{/if}
					</span>
				{/each}
				{#each readout.logic as entry (entry.key)}
					<span class="value" style:color={entry.colour}>{entry.label} = {entry.text}</span>
				{/each}
				{#if marker === null}
					<span class="hint">shift-click to measure from a point</span>
				{/if}
			</div>
		{/if}
	</div>
	{#if app.spectrum.on}
		<SpectrumPlot
			time={app.result?.time ?? null}
			samples={spectrumOf?.samples ?? null}
			from={fftSpan.from}
			to={fftSpan.to}
			whole={fftSpan.whole}
			colour={spectrumOf?.colour ?? 'currentColor'}
			sources={sourceItems}
		/>
	{/if}
	</div>
	{/if}

	<SignalsPanel bind:measuring bind:separate traceCount={traces.length}>
		{#snippet actions()}
			{#if app.analysis === 'transient'}
				<Button
					size="sm"
					class="h-5 px-1.5 text-3xs"
					active={app.spectrum.on}
					aria-pressed={app.spectrum.on}
					onclick={() => app.setSpectrum({ on: !app.spectrum.on })}
					title="The spectrum of a trace, under the scope: tones, levels and THD"
				>
					fft
				</Button>
			{/if}
		{/snippet}
		{#snippet measures()}
		{#if app.analysis === 'transient'}
			<TriggerPanel
				sources={sourceItems}
				status={triggerFrame?.status ?? null}
				resolved={triggerLevels}
				{arm}
			/>
		{/if}
		{#if measurements.length > 0 || logicMeasurements.length > 0}
			<!--
				Each of these is something you could get from two cursors and some
				arithmetic. Doing it by hand is slow, and being slow is the reason
				nobody checks.
			-->
			<div class="measures">
				{#each measurements as row (row.key)}
					{@const m = row.m!}
					<div class="measure">
						<span class="who" style:color={row.colour}>{row.label}</span>
						<dl>
							<dt>pk-pk</dt>
							<dd>{formatWithUnit(m.peakToPeak, 'V', 3)}</dd>
							<dt>mean</dt>
							<dd>{formatWithUnit(m.mean, 'V', 3)}</dd>
							<dt>rms</dt>
							<dd>{formatWithUnit(m.rms, 'V', 3)}</dd>
							{#if m.frequency !== null && m.period !== null}
								<dt>freq</dt>
								<dd>{formatWithUnit(m.frequency, 'Hz', 3)}</dd>
								<dt>period</dt>
								<dd>{formatWithUnit(m.period, 's', 3)}</dd>
								<dt>duty</dt>
								<dd>{Math.round((m.duty ?? 0) * 100)}%</dd>
							{/if}
							{#if m.riseTime !== null}
								<dt>rise</dt>
								<dd>{formatWithUnit(m.riseTime, 's', 3)}</dd>
							{/if}
							{#if m.overshoot !== null && m.overshoot > 0.005}
								<dt>over</dt>
								<dd>{Math.round(m.overshoot * 100)}%</dd>
							{/if}
							{#if row.averaged}
								<dt></dt>
								<dd class="folded" title="This node hangs off a logic net switching faster than this timebase can show, so the engine drives it with the net's time average rather than every edge. The trace is that average; zoom the window in to see the edges.">
									averaged
								</dd>
							{/if}
						</dl>
					</div>
				{/each}
				{#each logicMeasurements as row (row.key)}
					<div class="measure">
						<span class="who" style:color={row.colour}>{row.label}</span>
						{#if row.m}
							{@const m = row.m}
							<dl>
								<dt>freq</dt>
								<dd>{formatWithUnit(m.frequency, 'Hz', 3)}</dd>
								<dt>period</dt>
								<dd>{formatWithUnit(m.period, 's', 3)}</dd>
								<dt>duty</dt>
								<dd>{Math.round(m.duty * 100)}%</dd>
								<dt>cycles</dt>
								<dd title="Whole cycles the numbers are averaged over">{m.cycles}</dd>
								{#if m.folded}
									<dt></dt>
									<dd class="folded" title="Faster than this timebase can show: the numbers are averaged over the busy span, which the lane draws as a band. Zoom the window in to see the edges.">
										busy
									</dd>
								{/if}
							</dl>
						{:else}
							<span class="waiting" title="A period is two rising edges, and this lane has not had them yet. Leave it running.">
								no full cycle yet
							</span>
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		{/snippet}
		{#snippet footer()}
		{#if app.analysis === 'frequency' && app.acResult}
			<!-- Each figure kept whole, so a narrow column breaks between them, never inside one. -->
			<footer>
				<span>{app.acResult.frequencies.length} points</span> ·
				<span>{app.acResult.elapsedMs.toFixed(0)} ms</span>
			</footer>
		{/if}

		{#if app.analysis === 'dc' && app.dcResult}
			<footer>
				<span>{app.dcResult.values.length} points</span> ·
				<span>{app.dcResult.elapsedMs.toFixed(0)} ms</span>
			</footer>
		{/if}

		{#if app.analysis === 'transient' && app.result}
			<footer>
				<span>{app.result.stats.accepted_steps} steps</span> ·
				<span>{app.result.stats.newton_iterations} iterations</span> ·
				<span title="Time spent solving, on this machine">{app.result.elapsedMs.toFixed(0)} ms</span>
			</footer>
		{/if}
		{/snippet}
	</SignalsPanel>
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
		font-size: var(--text-3xs);
		font-family: var(--font-mono);
	}

	.measure .waiting {
		display: block;
		font-size: var(--text-3xs);
		color: var(--label-dim);
		font-style: italic;
	}

	.measure .folded {
		color: var(--label-dim);
		font-style: italic;
	}

	.measure dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 0.05rem 0.4rem;
		margin: 0.15rem 0 0;
		font-size: var(--text-3xs);
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

	.scope {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 210px;
		/*
			Explicit, because the row would otherwise size itself to the canvas —
			which is sized to the row. Nothing in that loop can ever shrink, so a
			scope that lost height kept its old canvas and spilled off the page.
		*/
		grid-template-rows: minmax(0, 1fr);
		height: 100%;
		min-height: 0;
		background: var(--panel-bg);
	}

	@media (max-width: 900px) {
		.scope {
			grid-template-columns: minmax(0, 1fr) 160px;
		}
	}

	.stack {
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		min-width: 0;
		min-height: 0;
	}

	.stack.split {
		grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
	}

	.plot {
		position: relative;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		--scope-grid: var(--grid-line);
	}

	canvas {
		display: block;
		cursor: crosshair;
		/* The plot takes the fingers: a pinch is the timebase, a drag is a pan. */
		touch-action: none;
	}

	canvas.grab-playhead {
		cursor: ew-resize;
	}

	.empty {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		margin: 0;
		color: var(--label-dim);
		font-size: var(--text-ui);
		pointer-events: none;
	}

	/* Bottom left, out of the way of the readout and the traces' opening levels. */
	.memory {
		position: absolute;
		left: 12px;
		bottom: 6px;
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		color: var(--label-dim);
		pointer-events: auto;
		background: color-mix(in srgb, var(--panel-bg) 85%, transparent);
		padding: 0.15rem 0.4rem;
		border-radius: var(--radius-sm);
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
		font-size: var(--text-2xs);
		pointer-events: none;
		/* Nearly opaque, with a frame: it sits over the traces it describes. */
		background: color-mix(in srgb, var(--raised) 94%, transparent);
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
	}

	.readout .time {
		color: var(--label-dim);
	}

	footer span {
		white-space: nowrap;
	}

	.lanes-hidden {
		position: absolute;
		right: 12px;
		bottom: 30px;
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-2xs);
		color: var(--label-dim);
		background: color-mix(in srgb, var(--panel-bg) 85%, transparent);
		padding: 0.15rem 0.4rem;
		border-radius: var(--radius-sm);
	}

	footer {
		border-top: 1px solid var(--border);
		padding: 0.4rem 0.75rem;
		font-size: var(--text-2xs);
		color: var(--label-dim);
		font-family: var(--font-mono);
	}
</style>
