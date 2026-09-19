<script lang="ts">
	/**
	 * Host for the canvas editor.
	 *
	 * Everything this component does is wiring: create the editor, keep its
	 * scene in step with the model, and route keystrokes. All the drawing,
	 * picking, snapping and tool behaviour lives in `$lib/canvas` and
	 * `$lib/schematic`, where it can be tested without a browser.
	 */
	import { untrack } from 'svelte';
	import { CanvasEditor, type Painter, type ViewportState } from '$lib/canvas';
	import { createAnimationState, forget } from '$lib/schematic/animate';
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
	import { prepareFlow, rescale, sampleFlow, sampleIndexAt } from '$lib/schematic/flow';
	import { logicFamily } from '$lib/schematic/logic';
	import { burnoutsById } from '$lib/schematic/led';
	import { GRID } from '$lib/schematic/model';
	import { groupLabelBox, groupLabelSize, placeGroups } from '$lib/schematic/groups';
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

	/**
	 * The flow plan: which wire carries what, worked out once per run.
	 *
	 * Deliberately *not* rebuilt when samples arrive. The plan is a property of
	 * the drawing — a spanning tree per net and a map from parts to the engine's
	 * arrays — and rebuilding it on every acquired chunk meant building spanning
	 * trees sixty times a second for an answer that had not changed. The samples
	 * are read untracked here for exactly that reason, and handed to `sampleFlow`
	 * fresh on every frame instead.
	 */
	const flowContext = $derived.by(() => {
		void app.acquiring;
		const compiled = app.compiled;
		const family = logicFamily(app.logicFamily);
		return untrack(() => {
			const run = app.result;
			if (!run) return null;
			return prepareFlow(
				app.schematic,
				compiled.connectivity,
				compiled.names,
				run,
				family,
				compiled.portFlow
			);
		});
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

	/**
	 * What every operable part was doing at an instant, as one comparable value.
	 *
	 * Switches and logic toggles both, because both of them change the circuit:
	 * only the first one breaks a path, but flipping an input rewrites every level
	 * downstream of it, and the readings are just as wrong about the result. Only
	 * contacts were counted here at first, and a toggled input went unnoticed —
	 * which is how a half adder came to sit with both of its lamps half lit.
	 *
	 * The electrical truth, not the drawn one: `isClosedAt` includes the bounce
	 * that `isActuatedAt` deliberately leaves out, and the bounce is exactly when
	 * this matters.
	 */
	function operatedAt(time: number): string {
		const parts: string[] = [];
		for (const instance of app.schematic.instances) {
			const flips = app.operationsOf(instance.id);
			if (instance.kind === 'switch') {
				parts.push(`${instance.id}:${isClosedAt(instance, time, flips) ? 1 : 0}`);
			} else if (instance.kind === 'toggle') {
				parts.push(`${instance.id}:${isHighAt(instance, time, flips) ? 1 : 0}`);
			}
		}
		return parts.join(',');
	}

	/** What `operatedAt` said on the previous frame, so a change can be noticed. */
	let operated: string | null = null;

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
			junctions,
			renamingGroup: app.renamingGroup
		};
	}

	/**
	 * The box a group's name is typed into, over the name itself.
	 *
	 * Placed once, when the rename starts, from where the label is on screen
	 * at that moment. The canvas can still be panned underneath it; the box
	 * does not follow, and finishing the name (Enter, or clicking away) is what
	 * closes it.
	 */
	let renameBox = $state<{ id: string; name: string; x: number; y: number; size: number } | null>(
		null
	);
	$effect(() => {
		const id = app.renamingGroup;
		const active = editor;
		if (!id || !active) {
			renameBox = null;
			return;
		}
		const placed = placeGroups(app.schematic).find((g) => g.group.id === id);
		if (!placed) {
			app.renamingGroup = null;
			return;
		}
		const scale = active.viewport.scale;
		const box = groupLabelBox(
			active.viewport.toScreen({ x: placed.frame.x, y: placed.frame.y }),
			placed.group.name,
			scale
		);
		renameBox = { id, name: placed.group.name, x: box.x, y: box.y, size: groupLabelSize(scale) };
		active.invalidate('schematic');
	});

	function finishRename(value: string | null) {
		const box = renameBox;
		app.renamingGroup = null;
		if (box && value !== null) app.renameGroup(box.id, value);
		editor?.invalidate('schematic');
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
				/** The live overlay's own numbers — what each wire is being drawn as. */
				get view() {
					return dynamicView;
				},
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

		// A block's box is drawn from its definition, which the parts on the
		// drawing only point at: renaming it or one of its ports changes the
		// shape of every copy without touching a single instance.
		void schematic.blocks?.map(
			(b) =>
				`${b.name}:${b.instances
					.filter((i) => i.kind === 'port')
					.map((i) => `${i.name}${i.params.flow}${i.y}`)
					.join()}`
		);
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
	// The symbol standard is one of these: pins and boxes stay put, only the
	// drawing between them changes, and the paths are rebuilt on their own
	// because the standard is part of their cache key.
	$effect(() => {
		void [selectionSet, probeColours, app.hoverNet, app.symbolStandard];
		// Groups are drawn from the parts, so only their names and membership
		// are theirs to watch; the index does not know they exist.
		void app.schematic.groups?.map((g) => `${g.name}:${g.members.length}`);
		editor?.invalidate('schematic');
	});

	// Recentre on every drawing that arrives whole: an example, a link, a file.
	$effect(() => {
		const active = editor;
		void app.arrivals;
		queueMicrotask(() => active?.fit());
	});

	// Going into a block, the view goes to the block: its inside sits around its
	// own origin, nowhere near where the drawing was being looked at, and a
	// double click that lands on an empty screen reads as nothing happening.
	// Coming back out, the drawing is looked at from where it was left.
	let views: ViewportState[] = [];
	$effect(() => {
		const active = editor;
		const depth = app.depth;
		if (!active) return;
		if (depth > views.length) {
			views.push(active.viewport.snapshot());
			// After the index has been rebuilt for the new document, or the fit
			// would be to the old one.
			queueMicrotask(() => active.fit());
		} else {
			while (views.length > depth) {
				const back = views.pop();
				if (views.length === depth && back) {
					active.viewport.restore(back);
					active.invalidate();
				}
			}
		}
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

			// The live overlay belongs to the transient result. Leaving it running
			// during a frequency sweep would show the state of a run the user is no
			// longer looking at, which is worse than showing nothing.
			// Built whenever there is a transient result to draw from, rather than
			// only when a layer is switched on. What each layer paints is the layer's
			// business; a burnt part is drawn regardless of all three, and gating the
			// whole view on them meant switching them off hid that too.
			const run = app.result;
			if (context && run && app.analysis === 'transient' && app.live) {
				const index = sampleIndexAt(run.time, app.playbackTime);
				// Two ways for a reading to be about a circuit that is not the one on
				// screen. Something operable moving is one: past that instant it is not
				// the same circuit any more. The playhead jumping backwards is the other
				// — Run restarting a sweep from zero, or the timeline dragged — and a
				// reading belongs to the instant it was taken at, so it does not travel
				// with the playhead.
				const nowOperated = operatedAt(app.playbackTime);
				const jumped = lastPlayback === null || app.playbackTime < lastPlayback;
				const changed = jumped || (operated !== null && nowOperated !== operated);
				operated = nowOperated;
				// Where the last frame left off, so this one can be told what went
				// past in between rather than what happens to be true at its end —
				// except across a change, where the mean would belong to neither of the
				// two circuits it spans.
				const since =
					changed || lastPlayback === null || lastPlayback > app.playbackTime
						? index
						: sampleIndexAt(run.time, lastPlayback);
				// Scaled to what is on screen, not to the whole of memory: the window
				// is what somebody is looking at, and a spike that scrolled off it an
				// hour ago should not still be deciding how fast the dots move.
				const first = sampleIndexAt(run.time, app.playbackTime - app.stopTime);
				rescale(context, run, first, index);
				const frame = sampleFlow(context, run, index, since);
				const closed = closedSwitchesAt(app.playbackTime);
				dynamicView = {
					schematic: app.schematic,
					frame,
					context,
					animation,
					netOfPoint: app.compiled.connectivity.netOfPoint,
					junctions,
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
					floating: new Set([...app.compiled.floatingAt(closed), ...frame.netUndriven]),
					selection: selectionSet,
					selectionColour: theme!.selection
				};
				// The readings carry a fall time so that a burst too short to see is
				// still visible, and coasting that across a change drew milliamps
				// through a contact the engine had at five picoamps, all the way
				// through a quarter of a millisecond of bounce. Dropped here, before
				// the dots are advanced, so the frame reads the circuit that exists
				// now: the branch that stopped goes quiet at once, and whatever else is
				// still carrying — a capacitor discharging into its load, say — keeps
				// its dots, because those are measured afresh every frame.
				if (changed) forget(animation);
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
						handle.animation = animation;
					}
				}
			} else if (dynamicView) {
				dynamicView = null;
				active.invalidate('dynamic');
			}

			// Nothing live to read a contact position off: back to resting.
			if (!app.live) {
				if (trackSwitches(null)) active.invalidate('schematic');
				// And nothing operated to remember either, so the next run does not open
				// by comparing itself against the end of the last one — nor, after a
				// different circuit is loaded, against a drawing that is gone.
				operated = null;
				forget(animation);
			}

			lastPlayback = app.playbackTime;
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
				case 'g':
					event.preventDefault();
					if (event.shiftKey) app.ungroupSelection();
					else app.groupSelection();
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
	<!--
		Inside a block, the canvas is the block and not the drawing, and that has
		to be said out loud: an edit here reaches every copy. The way back is here
		too, since nothing on the canvas is the drawing to click on.
	-->
	{#if app.inside}
		<div class="inside">
			<span>
				Inside <strong>{app.inside.name}</strong> — every copy of the block changes with it. Wire a
				pin to a <em>Port</em> to give the box a pin.
			</span>
			<button onclick={() => app.leaveBlock()}>Back to the drawing</button>
		</div>
	{/if}
	{#if renameBox}
		<!-- svelte-ignore a11y_autofocus -->
		<input
			class="rename"
			style:left="{renameBox.x}px"
			style:top="{renameBox.y}px"
			style:font-size="{renameBox.size}px"
			value={renameBox.name}
			size={Math.max(4, renameBox.name.length + 1)}
			aria-label="Group name"
			autofocus
			onfocus={(e) => e.currentTarget.select()}
			onblur={(e) => finishRename(e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === 'Enter') e.currentTarget.blur();
				else if (e.key === 'Escape') {
					e.preventDefault();
					finishRename(null);
				}
				e.stopPropagation();
			}}
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

	.host {
		position: relative;
		width: 100%;
		height: 100%;
		background: var(--canvas-bg);
		overflow: hidden;
		touch-action: none;
		user-select: none;
	}

	.inside {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.4rem 0.75rem;
		background: var(--panel-bg);
		border-bottom: 1px solid var(--accent, #4ea8ff);
		color: var(--text, inherit);
		font-size: 0.8rem;
		pointer-events: none;
	}

	.inside button {
		pointer-events: auto;
		padding: 0.3rem 0.6rem;
		font-size: 0.75rem;
		border: 1px solid var(--accent, #4ea8ff);
		border-radius: 5px;
		background: var(--control-bg);
		color: inherit;
		cursor: pointer;
		white-space: nowrap;
	}

	.inside button:hover {
		background: var(--hover);
	}

	.rename {
		position: absolute;
		padding: 2px 3px;
		border: 1px solid var(--accent, #4ea8ff);
		border-radius: 3px;
		background: var(--panel-bg);
		color: var(--text, inherit);
		font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
		line-height: 1;
		width: auto;
		outline: none;
	}
</style>
