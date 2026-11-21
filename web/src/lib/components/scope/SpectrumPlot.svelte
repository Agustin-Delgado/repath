<script lang="ts">
	/**
	 * The spectrum of one probed trace, under the scope: what a bench scope's
	 * FFT key shows, so a question about distortion or ripple can be answered
	 * without exporting anything.
	 *
	 * Levels are peak volts or decibels referred to 1 V peak, so a 1 V sine is
	 * 1 V and 0 dB. The strongest tones are marked and listed with their
	 * frequency and level, and the THD of the strongest is given, counting the
	 * 2nd to the 10th harmonic.
	 */
	import { untrack } from 'svelte';
	import { Select, UnitField } from '$lib/ui';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';
	import { niceStep, stepsWithin } from '$lib/plot-layout';
	import { watchPixelRatio } from '$lib/canvas/pixel-ratio';
	import {
		THD_HARMONICS,
		dbv,
		distortion,
		peaks,
		periodsForDistortion,
		spectrum,
		type Spectrum,
		type SpectrumSpan,
		type WindowKind
	} from '$lib/spectrum';

	type Props = {
		time: Float64Array | null;
		samples: Float64Array | null;
		/** The stretch of time transformed. */
		from: number;
		to: number;
		/** Whether that stretch is a whole number of periods. */
		whole: boolean;
		colour: string;
		/** The analog traces the spectrum can be of, by their place in the scope's list. */
		sources: Array<{ value: string; label: string }>;
	};

	let { time, samples, from, to, whole, colour, sources }: Props = $props();

	let canvas = $state<HTMLCanvasElement | null>(null);
	let host = $state<HTMLDivElement | null>(null);
	let size = $state({ width: 0, height: 0 });
	let cursor = $state<number | null>(null);

	const PADDING = { left: 58, right: 14, top: 10, bottom: 24 };
	const FONT_PX = 11;

	const WINDOW_ITEMS: Array<{ value: WindowKind; label: string; description: string }> = [
		{ value: 'rectangular', label: 'Rectangular', description: 'No window: exact for a tone that fits the span a whole number of times, and leaky for any other' },
		{ value: 'hann', label: 'Hann', description: 'The general-purpose window' },
		{ value: 'blackman-harris', label: 'Blackman-Harris', description: 'Sidelobes down 92 dB, for a small harmonic beside a large tone' },
		{ value: 'flat-top', label: 'Flat top', description: 'A lobe flat to a hundredth of a decibel, for reading levels' }
	];
	const SPAN_ITEMS: Array<{ value: SpectrumSpan; label: string; description: string }> = [
		{ value: 'window', label: 'Screen', description: 'What the scope is showing' },
		{ value: 'periods', label: 'Periods', description: 'Whole periods ending at the right of the screen, measured over the screen' },
		{ value: 'memory', label: 'Memory', description: 'Everything the scope still holds: the finest frequency step' }
	];
	const SCALE_ITEMS = [
		{ value: 'db', label: 'dBV', description: 'Decibels referred to 1 V peak' },
		{ value: 'linear', label: 'V', description: 'Peak volts' }
	];
	const AXIS_ITEMS = [
		{ value: 'log', label: 'log f', description: 'Logarithmic frequency axis' },
		{ value: 'linear', label: 'lin f', description: 'Linear frequency axis' }
	];

	/**
	 * The spectrum, recomputed at most a few times a second while the run goes.
	 *
	 * A transform of 65536 points takes some milliseconds, and the run hands
	 * over a new chunk every frame; a spectrum the eye cannot read that fast
	 * has no business taking that much of each frame.
	 */
	let result = $state<Spectrum | null>(null);
	let computedAt = 0;
	let pending: ReturnType<typeof setTimeout> | null = null;
	const THROTTLE_MS = 150;

	function compute() {
		pending = null;
		computedAt = performance.now();
		result = time && samples ? spectrum(time, samples, from, to, { window: app.spectrum.window }) : null;
	}

	$effect(() => {
		void [time, samples, from, to, app.spectrum.window];
		untrack(() => {
			const since = performance.now() - computedAt;
			if (!app.playing || since >= THROTTLE_MS) {
				if (pending) clearTimeout(pending);
				compute();
			} else if (!pending) {
				pending = setTimeout(compute, THROTTLE_MS - since);
			}
		});
	});
	$effect(() => () => {
		if (pending) clearTimeout(pending);
	});

	const tones = $derived(result ? peaks(result, 5) : []);
	const thd = $derived(result ? distortion(result) : null);

	/**
	 * How far up the axis goes: past the last bin within 100 dB of the
	 * strongest, so the grid's own Nyquist — often megahertz — does not push a
	 * kilohertz signal into the left-hand pixel.
	 */
	const top = $derived.by(() => {
		if (!result) return 1;
		const { amplitude, df } = result;
		let strongest = 0;
		for (let k = 1; k < amplitude.length; k++) strongest = Math.max(strongest, amplitude[k]);
		const floor = strongest * 1e-5;
		let last = 1;
		for (let k = amplitude.length - 1; k >= 1; k--) {
			if (amplitude[k] > floor) {
				last = k;
				break;
			}
		}
		const nyquist = (amplitude.length - 1) * df;
		return Math.min(nyquist, Math.max(last * 2, 20) * df);
	});

	/** The lowest frequency drawn: the first bin, since DC has no place on a log axis. */
	const bottom = $derived(result ? (app.spectrum.axis === 'log' ? result.df : 0) : 0);

	const levelRange = $derived.by(() => {
		if (!result) return { lo: -120, hi: 0 };
		let strongest = 0;
		const { amplitude, df } = result;
		for (let k = 0; k < amplitude.length && k * df <= top; k++) strongest = Math.max(strongest, amplitude[k]);
		if (app.spectrum.scale === 'linear') return { lo: 0, hi: Math.max(strongest * 1.1, 1e-9) };
		const hi = Math.ceil((dbv(strongest) + 5) / 10) * 10;
		return { lo: hi - 130, hi };
	});

	const level = (volts: number) => (app.spectrum.scale === 'db' ? dbv(volts) : volts);
	const levelText = (volts: number) =>
		app.spectrum.scale === 'db' ? `${dbv(volts).toFixed(1)} dBV` : formatWithUnit(volts, 'V', 3);

	let colours = new Map<string, string>();
	function themeColour(name: string): string {
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

	/** Where a frequency falls across the plot, as a fraction. */
	function along(hz: number): number {
		if (app.spectrum.axis === 'log') {
			const lo = Math.log10(Math.max(bottom, 1e-30));
			const hi = Math.log10(Math.max(top, bottom * 10));
			return (Math.log10(Math.max(hz, 1e-30)) - lo) / Math.max(hi - lo, 1e-9);
		}
		return (hz - bottom) / Math.max(top - bottom, 1e-30);
	}

	function frequencyAt(fraction: number): number {
		if (app.spectrum.axis === 'log') {
			const lo = Math.log10(Math.max(bottom, 1e-30));
			const hi = Math.log10(Math.max(top, bottom * 10));
			return Math.pow(10, lo + fraction * (hi - lo));
		}
		return bottom + fraction * (top - bottom);
	}

	function draw() {
		if (!canvas || size.width === 0) return;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size.width, size.height);
		ctx.font = `${FONT_PX}px ${themeColour('--font-mono') || 'monospace'}`;
		const plot = {
			x: PADDING.left,
			y: PADDING.top,
			w: Math.max(size.width - PADDING.left - PADDING.right, 10),
			h: Math.max(size.height - PADDING.top - PADDING.bottom, 10)
		};
		const toX = (hz: number) => plot.x + along(hz) * plot.w;
		const toY = (v: number) =>
			plot.y + plot.h - ((v - levelRange.lo) / (levelRange.hi - levelRange.lo)) * plot.h;

		ctx.lineWidth = 1;
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		// About one gridline per 28 px, so a short panel is not a column of labels.
		const lines = Math.max(2, Math.floor(plot.h / 28));
		const step =
			app.spectrum.scale === 'db'
				? ([10, 20, 40, 60].find((s) => (levelRange.hi - levelRange.lo) / s <= lines) ?? 60)
				: niceStep(levelRange.hi - levelRange.lo, Math.min(lines, 4));
		for (const v of stepsWithin(levelRange.lo, levelRange.hi, step)) {
			const y = toY(v);
			ctx.strokeStyle = themeColour('--grid-line');
			ctx.beginPath();
			ctx.moveTo(plot.x, y);
			ctx.lineTo(plot.x + plot.w, y);
			ctx.stroke();
			ctx.fillStyle = themeColour('--label-dim');
			ctx.fillText(app.spectrum.scale === 'db' ? `${v.toFixed(0)} dB` : formatWithUnit(v, 'V', 2), plot.x - 8, y);
		}

		// No spectrum, no frequency axis: there is no bin spacing to put it at.
		if (!result) return;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		if (app.spectrum.axis === 'log') {
			const lo = Math.floor(Math.log10(Math.max(bottom, 1e-30)));
			const hi = Math.ceil(Math.log10(Math.max(top, 1e-30)));
			for (let decade = lo; decade <= hi; decade++) {
				for (let m = 1; m < 10; m++) {
					const hz = m * Math.pow(10, decade);
					const x = toX(hz);
					if (x < plot.x - 0.5 || x > plot.x + plot.w + 0.5) continue;
					ctx.strokeStyle = m === 1 ? themeColour('--grid-line') : themeColour('--canvas-bg');
					ctx.beginPath();
					ctx.moveTo(x, plot.y);
					ctx.lineTo(x, plot.y + plot.h);
					ctx.stroke();
					if (m === 1) {
						ctx.fillStyle = themeColour('--label-dim');
						ctx.fillText(formatWithUnit(hz, 'Hz', 3), x, plot.y + plot.h + 6);
					}
				}
			}
		} else {
			const fStep = niceStep(top - bottom, 6);
			for (const hz of stepsWithin(bottom, top, fStep)) {
				const x = toX(hz);
				ctx.strokeStyle = themeColour('--grid-line');
				ctx.beginPath();
				ctx.moveTo(x, plot.y);
				ctx.lineTo(x, plot.y + plot.h);
				ctx.stroke();
				ctx.fillStyle = themeColour('--label-dim');
				ctx.fillText(formatWithUnit(hz, 'Hz', 3), x, plot.y + plot.h + 6);
			}
		}

		const { amplitude, df } = result;
		ctx.save();
		ctx.beginPath();
		ctx.rect(plot.x, plot.y, plot.w, plot.h);
		ctx.clip();

		// The highest bin in each pixel column, so a tone narrower than a pixel
		// is drawn at its full height rather than averaged away.
		ctx.strokeStyle = colour;
		ctx.lineWidth = 1.4;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		let started = false;
		let column = -Infinity;
		let best = -Infinity;
		let bestX = 0;
		const flush = () => {
			if (best === -Infinity) return;
			const y = toY(best);
			if (!started) {
				ctx.moveTo(bestX, y);
				started = true;
			} else ctx.lineTo(bestX, y);
		};
		const first = app.spectrum.axis === 'log' ? 1 : 0;
		for (let k = first; k < amplitude.length; k++) {
			const hz = k * df;
			if (hz > top * 1.0001) break;
			const x = toX(hz);
			const c = Math.floor(x);
			const v = level(amplitude[k]);
			if (c !== column) {
				flush();
				column = c;
				best = v;
				bestX = x;
			} else if (v > best) {
				best = v;
				bestX = x;
			}
		}
		flush();
		ctx.stroke();

		// The tones found, numbered as the list beside them is.
		ctx.fillStyle = colour;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'bottom';
		tones.forEach((tone, i) => {
			const x = toX(tone.frequency);
			const y = Math.max(toY(level(amplitude[tone.bin])), plot.y + 22);
			ctx.beginPath();
			ctx.moveTo(x - 4, y - 9);
			ctx.lineTo(x + 4, y - 9);
			ctx.lineTo(x, y - 3);
			ctx.closePath();
			ctx.fill();
			ctx.fillText(String(i + 1), x, y - 10);
		});
		ctx.restore();

		if (cursor !== null && cursor >= plot.x && cursor <= plot.x + plot.w) {
			ctx.strokeStyle = themeColour('--scope-cursor');
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(cursor, plot.y);
			ctx.lineTo(cursor, plot.y + plot.h);
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	/** The bin under the pointer, and what it reads. */
	const readout = $derived.by(() => {
		if (!result || cursor === null) return null;
		const w = Math.max(size.width - PADDING.left - PADDING.right, 10);
		const fraction = (cursor - PADDING.left) / w;
		if (fraction < 0 || fraction > 1) return null;
		const bin = Math.min(Math.max(Math.round(frequencyAt(fraction) / result.df), 0), result.amplitude.length - 1);
		return { hz: bin * result.df, volts: result.amplitude[bin] };
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
		void [result, tones, top, bottom, levelRange, size, cursor, dpr, colour, app.spectrum.scale, app.spectrum.axis];
		untrack(draw);
	});
</script>

<section class="spectrum" aria-label="Spectrum">
	<div class="controls">
		<span class="title">Spectrum</span>
		{#if sources.length > 1}
			<Select
				size="sm"
				items={sources}
				value={String(Math.min(app.spectrum.source, sources.length - 1))}
				onChange={(value) => app.setSpectrum({ source: Number(value) })}
				aria-label="Trace to transform"
				title="Which trace the spectrum is of"
			/>
		{/if}
		<Select
			size="sm"
			items={WINDOW_ITEMS}
			value={app.spectrum.window}
			onChange={(value) => app.setSpectrum({ window: value as WindowKind })}
			aria-label="Window"
			title="The window the trace is weighted by before it is transformed"
		/>
		<Select
			size="sm"
			items={SPAN_ITEMS}
			value={app.spectrum.span}
			onChange={(value) => app.setSpectrum({ span: value as SpectrumSpan })}
			aria-label="Span"
			title="Which stretch of time is transformed"
		/>
		{#if app.spectrum.span === 'periods'}
			<UnitField
				width="2rem"
				unit={whole ? '×T' : '×T?'}
				value={String(app.spectrum.periods)}
				commit={(text) => {
					const parsed = Number(text);
					if (Number.isFinite(parsed) && parsed >= 1) app.setSpectrum({ periods: parsed });
				}}
				title={whole
					? 'How many periods: a tone that fits whole lands on a bin'
					: 'No period could be measured on the screen, so the screen is taken instead'}
				aria-label="Periods to transform"
			/>
		{/if}
		<Select
			size="sm"
			items={SCALE_ITEMS}
			value={app.spectrum.scale}
			onChange={(value) => app.setSpectrum({ scale: value as 'db' | 'linear' })}
			aria-label="Level scale"
			title="Levels in decibels referred to 1 V peak, or in peak volts"
		/>
		<Select
			size="sm"
			items={AXIS_ITEMS}
			value={app.spectrum.axis}
			onChange={(value) => app.setSpectrum({ axis: value as 'log' | 'linear' })}
			aria-label="Frequency axis"
			title="Logarithmic or linear frequency axis"
		/>
		{#if result}
			<span class="facts" title="Frequency step, the points transformed, and the time span they cover">
				Δf {formatWithUnit(result.df, 'Hz', 3)} · {result.n} pts · {formatWithUnit(to - from, 's', 3)}
			</span>
		{/if}
	</div>
	<div class="plot" bind:this={host}>
		<canvas
			bind:this={canvas}
			style:width="{size.width}px"
			style:height="{size.height}px"
			onpointermove={(e) => (cursor = e.clientX - e.currentTarget.getBoundingClientRect().left)}
			onpointerleave={() => (cursor = null)}
		></canvas>
		{#if !result}
			<p class="empty">
				{!time ? 'Press Run to see a spectrum.' : samples ? 'Nothing in the span to transform yet.' : 'Plot a trace to see its spectrum.'}
			</p>
		{:else}
			<div class="tones">
				{#if readout}
					<span class="dim">{formatWithUnit(readout.hz, 'Hz', 4)} · {levelText(readout.volts)}</span>
				{/if}
				<span title="The time average, which the spectrum's first bin stands for">
					<span class="dim">DC</span> {formatWithUnit(result.dc, 'V', 3)}
				</span>
				{#each tones as tone, i (tone.bin)}
					<span style:color={colour}>
						{i + 1}
						<span class="value">{formatWithUnit(tone.frequency, 'Hz', 4)} {levelText(tone.amplitude)}</span>
					</span>
				{/each}
				{#if thd}
					<span
						title="Total harmonic distortion of tone 1, counting the 2nd to the {THD_HARMONICS}th harmonic ({thd.harmonics.length} below the Nyquist frequency)"
					>
						<span class="dim">THD</span>
						{(thd.thd * 100).toPrecision(3)}% ({dbv(thd.thd).toFixed(1)} dB)
					</span>
				{:else if tones.length > 0}
					<span
						class="dim"
						title="The span holds too few periods of tone 1 for its harmonics to be told apart through this window: {periodsForDistortion(app.spectrum.window)} at least. Widen the screen or take more periods."
					>
						THD needs ≥{periodsForDistortion(app.spectrum.window)} periods
					</span>
				{/if}
			</div>
		{/if}
	</div>
</section>

<style>
	.spectrum {
		display: flex;
		flex-direction: column;
		min-height: 0;
		min-width: 0;
		border-top: 1px solid var(--border);
	}

	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.3rem;
		padding: 0.3rem 0.5rem;
	}

	.title {
		font-size: var(--text-3xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--label-dim);
		margin-right: 0.2rem;
	}

	.facts {
		margin-left: auto;
		font-family: var(--font-mono);
		font-size: var(--text-3xs);
		color: var(--label-dim);
		white-space: nowrap;
	}

	.plot {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
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
	}

	.tones {
		position: absolute;
		top: 6px;
		right: 12px;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.05rem;
		/* A short panel keeps the first lines, not a box hanging off its foot. */
		max-height: calc(100% - 12px);
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: var(--text-3xs);
		pointer-events: none;
		background: color-mix(in srgb, var(--panel-bg) 94%, transparent);
		border: 1px solid var(--border);
		padding: 0.2rem 0.45rem;
		border-radius: 4px;
		color: var(--label-strong);
	}

	.tones .dim {
		color: var(--label-dim);
	}

	.tones .value {
		color: var(--label-strong);
	}
</style>
