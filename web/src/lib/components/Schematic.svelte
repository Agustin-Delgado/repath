<script lang="ts">
	/**
	 * Host for the canvas editor.
	 *
	 * Everything this component does is wiring: create the editor, keep its
	 * scene in step with the model, and route keystrokes. All the drawing,
	 * picking, snapping and tool behaviour lives in `$lib/canvas` and
	 * `$lib/schematic`, where it can be tested without a browser.
	 */
	import { CanvasEditor, type Painter } from '$lib/canvas';
	import { createAnimationState } from '$lib/schematic/animate';
	import {
		drawGrid,
		drawSchematic,
		readTheme,
		setCurrentTheme,
		type SchematicView,
		type Theme
	} from '$lib/schematic/draw';
	import { drawDynamic, tick, type DynamicView } from '$lib/schematic/dynamic';
	import { prepareFlow, sampleFlow, sampleIndexAt } from '$lib/schematic/flow';
	import { burnoutsById } from '$lib/schematic/led';
	import { GRID } from '$lib/schematic/model';
	import { routeWire } from '$lib/schematic/route';
	import { parseTrace } from '$lib/trace';
	import { junctionDots } from '$lib/schematic/nets';
	import { buildSceneItems, buildSnapTargets } from '$lib/schematic/scene';
	import { createPlaceTool, createSelectTool, createWireTool } from '$lib/schematic/tools';
	import { app } from '$lib/state.svelte';

	let host = $state<HTMLDivElement | null>(null);
	/**
	 * `$state.raw` rather than `$state`: reassignment is reactive, so the sync
	 * effects below re-run once the editor exists, but the instance itself is not
	 * wrapped in a proxy — which would break its private fields and Maps.
	 */
	let editor = $state.raw<CanvasEditor | null>(null);
	let theme: Theme | null = null;
	const selectTool = createSelectTool();
	const wireTool = createWireTool();
	// Built once per kind and kept. A tool holds in-flight gesture state, so
	// rebuilding one mid-interaction quietly discards it.
	const placeTools = new Map<string, ReturnType<typeof createPlaceTool>>();

	function placeTool(kind: string) {
		let tool = placeTools.get(kind);
		if (!tool) placeTools.set(kind, (tool = createPlaceTool(kind)));
		return tool;
	}

	// Derived once per model change rather than once per frame: finding junctions
	// compares every wire against every other, which is not something to do at 60 Hz.
	const junctions = $derived(junctionDots(app.schematic));
	const selectionSet = $derived(new Set(app.selection));
	/**
	 * Which nets carry a trace colour, and only while something is running.
	 *
	 * The tint is what ties a wire on the page to its trace on the scope, so it is
	 * as much a part of showing a simulation as the voltage colours are — and it
	 * lives on the static layer, which is why stopping used to leave it behind
	 * looking like the run was still going.
	 */
	const probeColours = $derived(
		app.live ? new Map(app.activeProbes.map((p) => [p.netIndex, p.colour] as const)) : new Map()
	);

	// The live overlay. Planned once per run, evaluated once per frame.
	const animation = createAnimationState();
	let dynamicView: DynamicView | null = null;

	// Keyed on the list rather than rebuilt per frame: the map is only interesting
	// on the frames where an LED is actually failing, which is very few of them.
	const burnoutMap = $derived(burnoutsById(app.burnouts));

	const flowContext = $derived.by(() => {
		const run = app.result;
		if (!run) return null;
		const compiled = app.compiled;
		return prepareFlow(app.schematic, compiled.connectivity, compiled.names, run);
	});

	function view(): SchematicView {
		return {
			schematic: app.schematic,
			theme: theme!,
			selection: selectionSet,
			hoverNet: app.hoverNet,
			netOfPoint: app.compiled.connectivity.netOfPoint,
			probeColours,
			junctions
		};
	}

	$effect(() => {
		if (!host) return;

		theme = readTheme(host);
		setCurrentTheme(theme);

		const created = new CanvasEditor(host, {
			layers: ['grid', 'schematic', 'dynamic', 'overlay'],
			overlayLayer: 'overlay',
			gridSize: GRID,
			hitTolerance: 7,
			render: {
				grid: (painter: Painter, e: CanvasEditor) =>
					drawGrid(painter, theme!, GRID, e.visibleBounds),
				schematic: (painter: Painter, e: CanvasEditor) =>
					drawSchematic(painter, view(), e.visibleBounds),
				dynamic: (painter: Painter, e: CanvasEditor) => {
					if (dynamicView) drawDynamic(painter, dynamicView, e.visibleBounds);
				},
				overlay: () => {
					// Tool feedback is drawn by the editor after this runs.
				}
			}
		});
		created.viewport.limits = { minScale: 0.15, maxScale: 6 };
		editor = created;

		if (import.meta.env.DEV) {
			// A handle for driving the canvas from the console or a browser test.
			// There is no DOM to query on a canvas, so without this the editor is
			// a black box to anything outside it.
			(window as unknown as Record<string, unknown>).__repath = {
				editor: created,
				app,
				/**
				 * Re-perform a trace someone handed over.
				 *
				 * Routed through the select tool's own router, so a replay reproduces
				 * this editor rather than a slightly different one.
				 */
				replay: (text: string) =>
					app.replay(parseTrace(text), (from, to, settling, prefer) =>
						routeWire(app.schematic, from, to, {
							grid: GRID,
							ignoreWires: settling,
							prefer,
							effort: 4000
						})
					)
			};
		}

		return () => {
			created.destroy();
			editor = null;
			if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__repath;
		};
	});

	// Rebuild the spatial index and snap targets whenever the drawing changes.
	$effect(() => {
		const active = editor;
		const schematic = app.schematic;
		if (!active) return;

		active.scene.replaceAll(buildSceneItems(schematic));
		const targets = buildSnapTargets(schematic);
		active.snap.rebuild(targets.points, targets.segments);
		active.invalidate();
	});

	$effect(() => {
		const active = editor;
		const tool = app.tool;
		if (!active) return;
		active.setTool(
			tool.mode === 'place' ? placeTool(tool.kind) : tool.mode === 'wire' ? wireTool : selectTool
		);
	});

	// Appearance-only changes: repaint the schematic, leave the index alone.
	$effect(() => {
		void [selectionSet, probeColours, app.hoverNet];
		editor?.invalidate('schematic');
	});

	// Recentre when a different example is loaded.
	$effect(() => {
		const active = editor;
		void app.exampleId;
		queueMicrotask(() => active?.fit());
	});

	/**
	 * The animation loop.
	 *
	 * Separate from the editor's invalidate-driven rendering: this is the one
	 * thing that genuinely wants a frame every frame. It touches only the
	 * `dynamic` layer, so the schematic underneath is never repainted for it.
	 */
	$effect(() => {
		const active = editor;
		const context = flowContext;
		if (!active || !context) {
			dynamicView = null;
			return;
		}

		let frame = 0;
		let last = performance.now();
		// Where playback was on the previous frame, so a drag of the scrubber shows
		// up here as a distance rather than as a jump nobody can see.
		let lastPlayback = app.playbackTime;

		const step = (now: number) => {
			// Clamped so a backgrounded tab does not resume with one enormous jump.
			const dt = Math.min((now - last) / 1000, 0.1);
			last = now;

			// How far playback moved this frame, which is what the current dots run
			// on. Zero while paused and untouched, negative when the scrubber is
			// dragged backwards, large when it is dragged fast.
			let moved = 0;
			if (app.playing) {
				const next = app.playbackTime + dt * app.playbackRate;
				if (next >= app.stopTime) {
					// Looping back to the start is not a rewind anybody performed, so it
					// does not spin the dots backwards through the whole run.
					app.playbackTime = 0;
				} else {
					app.playbackTime = next;
					moved = dt * app.playbackRate;
				}
			} else {
				moved = app.playbackTime - lastPlayback;
			}
			lastPlayback = app.playbackTime;

			// The live overlay belongs to the transient result. Leaving it running
			// during a frequency sweep would show the state of a run the user is no
			// longer looking at, which is worse than showing nothing.
			// Built whenever there is a transient result to draw from, rather than
			// only when a layer is switched on. What each layer paints is the layer's
			// business; a burnt part is drawn regardless of all three, and gating the
			// whole view on them meant switching them off hid that too.
			if (app.analysis === 'transient' && app.live) {
				const index = sampleIndexAt(context.run.time, app.playbackTime);
				dynamicView = {
					schematic: app.schematic,
					frame: sampleFlow(context, index),
					context,
					animation,
					netOfPoint: app.compiled.connectivity.netOfPoint,
					showVoltage: app.showVoltage,
					showCurrent: app.showCurrent,
					showLight: app.showLight,
					showValues: app.showValues,
					running: app.playing,
					time: app.playbackTime,
					stopTime: app.stopTime,
					burnouts: burnoutMap,
					selection: selectionSet,
					selectionColour: theme!.selection
				};
				// In seconds of wall clock, so a given current draws the dots along at
				// the same speed however fast the run is being played.
				tick(dynamicView, moved / Math.max(app.playbackRate, 1e-9));
				active.invalidate('dynamic');
				if (import.meta.env.DEV) {
					const handle = (window as unknown as Record<string, Record<string, unknown>>).__repath;
					if (handle) {
						handle.flow = context;
						handle.frame = dynamicView.frame;
					}
				}
			} else if (dynamicView) {
				dynamicView = null;
				active.invalidate('dynamic');
			}

			frame = requestAnimationFrame(step);
		};

		frame = requestAnimationFrame(step);
		return () => {
			cancelAnimationFrame(frame);
			dynamicView = null;
		};
	});

	export function fitToContent() {
		editor?.fit();
	}

	function onKeyDown(event: KeyboardEvent) {
		const target = event.target as HTMLElement | null;
		if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

		if (event.ctrlKey || event.metaKey) {
			switch (event.key.toLowerCase()) {
				case 'z':
					event.preventDefault();
					if (event.shiftKey) app.redo();
					else app.undo();
					return;
				case 'y':
					event.preventDefault();
					app.redo();
					return;
				case 'c':
					if (app.copySelection()) event.preventDefault();
					return;
				case 'x':
					if (app.copySelection()) {
						app.deleteSelection();
						event.preventDefault();
					}
					return;
				case 'v':
					event.preventDefault();
					// Paste where the cursor is, which is where the user is looking.
					app.paste(editor?.pointerWorld ?? undefined);
					return;
				case 'd':
					event.preventDefault();
					app.duplicateSelection();
					return;
			}
		}

		// The active tool gets first refusal — it may be mid-gesture.
		if (editor?.handleKeyDown(event)) {
			event.preventDefault();
			return;
		}

		switch (event.key) {
			case 'Delete':
			case 'Backspace':
				// Reached only when the active tool did not claim it — the place tool
				// does not, and "Delete does nothing" is never the right answer.
				event.preventDefault();
				app.deleteSelection();
				break;
			case ' ':
				// Only reaches here when no tool claimed it — the wire tool uses
				// Space to flip its bend while a run is in progress.
				event.preventDefault();
				app.togglePlay();
				break;
			case 'v':
			case 'V':
			case 'Escape':
				app.tool = { mode: 'select' };
				break;
			case 'f':
			case 'F':
				editor?.fit();
				break;
		}
	}

	/** Where the rename field goes, in canvas pixels, and what it starts with. */
	const renameAt = $derived.by(() => {
		const id = app.renaming;
		const view = editor?.viewport;
		if (!id || !view) return null;
		const instance = app.schematic.instances.find((i) => i.id === id);
		if (!instance) return null;
		const at = view.toScreen({ x: instance.x, y: instance.y });
		return { x: at.x, y: at.y, name: instance.name };
	});

	let renameField = $state.raw<HTMLInputElement | null>(null);

	$effect(() => {
		// Focused and selected the moment it appears, so the second click lands you
		// typing rather than clicking again to put the caret somewhere.
		if (renameAt && renameField) renameField.select();
	});

	function commitRename(value: string) {
		const id = app.renaming;
		app.renaming = null;
		if (id) app.rename(id, value);
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="stage">
	<div class="host" bind:this={host} role="application" aria-label="Schematic editor"></div>

	<!--
		Renaming happens where the name is. An input floated over the canvas rather
		than drawn into it, so it is a real text field — selection, caret, undo, an
		IME — none of which is worth reimplementing on a 2D context.
	-->
	{#if renameAt}
		<input
			class="rename"
			style:left="{renameAt.x}px"
			style:top="{renameAt.y}px"
			bind:this={renameField}
			value={renameAt.name}
			onblur={(e) => commitRename(e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur();
				else if (e.key === 'Escape') {
					// Put the old name back before blurring, so Escape cancels rather
					// than committing whatever was half-typed.
					e.currentTarget.value = renameAt?.name ?? '';
					e.currentTarget.blur();
				}
				e.stopPropagation();
			}}
			aria-label="Component name"
		/>
	{/if}
</div>

<style>
	.stage {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
	}

	.rename {
		position: absolute;
		transform: translate(-50%, -50%);
		width: 6.5rem;
		text-align: center;
		font-size: 0.78rem;
		font-family: var(--font-mono);
		padding: 0.15rem 0.3rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: var(--control-bg);
		color: var(--label-strong);
		z-index: 3;
	}

	.host {
		position: relative;
		width: 100%;
		height: 100%;
		background: var(--canvas-bg);
		overflow: hidden;
		touch-action: none;
		user-select: none;
	}
</style>
