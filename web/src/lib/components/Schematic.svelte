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
	import { GRID } from '$lib/schematic/model';
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
	const probeColours = $derived(
		new Map(app.activeProbes.map((p) => [p.netIndex, p.colour] as const))
	);

	// The live overlay. Planned once per run, evaluated once per frame.
	const animation = createAnimationState();
	let dynamicView: DynamicView | null = null;

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
			(window as unknown as Record<string, unknown>).__repath = { editor: created, app };
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
			tool.mode === 'wire' ? wireTool : tool.mode === 'place' ? placeTool(tool.kind) : selectTool
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

		const step = (now: number) => {
			// Clamped so a backgrounded tab does not resume with one enormous jump.
			const dt = Math.min((now - last) / 1000, 0.1);
			last = now;

			if (app.playing) {
				const next = app.playbackTime + dt * app.playbackRate;
				if (next >= app.stopTime) app.playbackTime = 0;
				else app.playbackTime = next;
			}

			// The live overlay belongs to the transient result. Leaving it running
			// during a frequency sweep would show the state of a run the user is no
			// longer looking at, which is worse than showing nothing.
			if (app.analysis === 'transient' && (app.showVoltage || app.showCurrent)) {
				const index = sampleIndexAt(context.run.time, app.playbackTime);
				dynamicView = {
					schematic: app.schematic,
					frame: sampleFlow(context, index),
					context,
					animation,
					netOfPoint: app.compiled.connectivity.netOfPoint,
					showVoltage: app.showVoltage,
					showCurrent: app.showCurrent
				};
				tick(dynamicView, dt);
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
			case ' ':
				// Only reaches here when no tool claimed it — the wire tool uses
				// Space to flip its bend while a run is in progress.
				event.preventDefault();
				app.togglePlay();
				break;
			case 'w':
			case 'W':
				app.tool = { mode: 'wire' };
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
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="host" bind:this={host} role="application" aria-label="Schematic editor"></div>

<style>
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
