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
	import { isActuatedAt, isClosedAt, isHighAt } from '$lib/schematic/contacts';
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
	import { logicFamily } from '$lib/schematic/logic';
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

	/**
	 * What each placed probe will be called on the scope, and in what colour.
	 *
	 * Read by the drawing so a probe wears its own name: two traces are told apart
	 * by looking at the schematic rather than by matching a legend to it.
	 */
	const probeLabels = $derived(
		new Map(
			app.activeProbes
				.filter((p) => p.key.startsWith('pin:'))
				.map((p) => [p.key.split(':')[1], { label: p.label, colour: p.colour }] as const)
		)
	);

	const flowContext = $derived.by(() => {
		const run = app.result;
		if (!run) return null;
		const compiled = app.compiled;
		return prepareFlow(
			app.schematic,
			compiled.connectivity,
			compiled.names,
			run,
			logicFamily(app.logicFamily)
		);
	});

	/**
	 * Which switches are closed at the playhead.
	 *
	 * Deliberately not `$state`: the frame loop writes it and then invalidates the
	 * schematic layer by hand, on the few frames where a contact actually moved.
	 * Making it reactive would repaint the whole drawing sixty times a second to
	 * say the same thing.
	 */
	let switchStates = new Map<string, boolean>();

	/**
	 * Which contacts are conducting at an instant, by instance id.
	 *
	 * Not the same question as `switchStates`, which is where the blade is *drawn*
	 * and deliberately leaves the bounce out. This one is the electrical truth,
	 * and it decides whether a node fed through a switch counts as held or as
	 * floating — so it has to agree with what the engine was given, chatter and
	 * all, rather than with what the symbol looks like.
	 */
	function closedSwitchesAt(time: number): Set<string> {
		const closed = new Set<string>();
		for (const instance of app.schematic.instances) {
			if (instance.kind !== 'switch') continue;
			if (isClosedAt(instance, time, app.operationsOf(instance.id))) closed.add(instance.id);
		}
		return closed;
	}

	function view(): SchematicView {
		return {
			schematic: app.schematic,
			theme: theme!,
			selection: selectionSet,
			hoverNet: app.hoverNet,
			netOfPoint: app.compiled.connectivity.netOfPoint,
			probeColours,
			probes: probeLabels,
			switchStates,
			junctions
		};
	}

	/**
	 * Update the drawn contact positions, and say whether any of them moved.
	 *
	 * Cleared rather than left behind when there is nothing live: a switch with no
	 * run behind it is drawn resting where its parameters put it.
	 */
	function trackSwitches(time: number | null): boolean {
		let changed = false;
		const seen = new Set<string>();
		for (const instance of app.schematic.instances) {
			const operable = instance.kind === 'switch' || instance.kind === 'toggle';
			if (!operable) continue;
			seen.add(instance.id);
			if (time === null) continue;
			// Both parts are drawn where the run has them rather than where the
			// parameters rest, and for the same reason: one that was thrown at three
			// milliseconds is only in its new position from three milliseconds on.
			// Including what somebody has done to it during this run, which the
			// drawing knows about and the netlist deliberately does not.
			const flips = app.operationsOf(instance.id);
			const closed =
				instance.kind === 'switch'
					? isActuatedAt(instance, time, flips)
					: isHighAt(instance, time, flips);
			if (switchStates.get(instance.id) !== closed) {
				switchStates.set(instance.id, closed);
				changed = true;
			}
		}
		for (const id of switchStates.keys()) {
			if (time === null || !seen.has(id)) {
				switchStates.delete(id);
				changed = true;
			}
		}
		return changed;
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
		if (!active) {
			dynamicView = null;
			return;
		}

		let frame = 0;
		// Where simulated time was on the previous frame, so the dots are carried
		// along by however far the sweep got rather than by the wall clock.
		//
		// Left unset rather than seeded from `app.playbackTime`, and that is not a
		// style choice. A read here is a read in the effect *body*, which subscribes
		// this effect to a value that changes every single frame — so the effect
		// tore itself down and rebuilt sixty times a second, and its cleanup nulled
		// `dynamicView` between the frame setting it and the layer drawing it. The
		// whole live overlay went dark. Reads belong inside `step`, where they are
		// not tracked.
		//
		// `flowContext` was making the same mistake for a different reason, and it
		// is the one that got reported: it is rebuilt whenever a run finishes, so
		// every re-solve tore this loop down, blanked `dynamicView` and put it back
		// a frame later. Flipping a switch re-solves, which is why the whole overlay
		// — colours, dots, readings — blinked off and on again on every click.
		let lastPlayback: number | null = null;

		const step = () => {
			const context = flowContext;

			// How far simulated time moved this frame, which is what the current dots
			// run on. It is *read* here rather than advanced: the acquisition owns the
			// clock now, and this loop only draws what it has reached. Zero while the
			// sweep is stopped and untouched.
			const moved = lastPlayback === null ? 0 : app.playbackTime - lastPlayback;
			lastPlayback = app.playbackTime;

			// The live overlay belongs to the transient result. Leaving it running
			// during a frequency sweep would show the state of a run the user is no
			// longer looking at, which is worse than showing nothing.
			// Built whenever there is a transient result to draw from, rather than
			// only when a layer is switched on. What each layer paints is the layer's
			// business; a burnt part is drawn regardless of all three, and gating the
			// whole view on them meant switching them off hid that too.
			if (context && app.analysis === 'transient' && app.live) {
				const index = sampleIndexAt(context.run.time, app.playbackTime);
				const frame = sampleFlow(context, index);
				dynamicView = {
					schematic: app.schematic,
					frame,
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
					// Two ways of being at no particular potential, drawn the same way:
					// an analog node nothing holds, and a digital net nothing drives.
					floating: new Set([
						...app.compiled.floatingAt(closedSwitchesAt(app.playbackTime)),
						...frame.netUndriven
					]),
					selection: selectionSet,
					selectionColour: theme!.selection
				};
				// In seconds of wall clock, so a given current draws the dots along at
				// the same speed however fast the run is being played.
				tick(dynamicView, moved / Math.max(app.playbackRate, 1e-9));
				active.invalidate('dynamic');
				// The blades live on the layer underneath, which is repainted only on
				// the frames where one of them actually moves.
				if (trackSwitches(app.playbackTime)) active.invalidate('schematic');
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

			// Nothing live to read a contact position off: back to resting.
			if (!app.live && trackSwitches(null)) active.invalidate('schematic');

			frame = requestAnimationFrame(step);
		};

		frame = requestAnimationFrame(step);
		return () => {
			cancelAnimationFrame(frame);
			dynamicView = null;
			if (trackSwitches(null)) editor?.invalidate('schematic');
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

</script>

<svelte:window onkeydown={onKeyDown} />

<div class="stage">
	<div class="host" bind:this={host} role="application" aria-label="Schematic editor"></div>
</div>

<style>
	.stage {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
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
