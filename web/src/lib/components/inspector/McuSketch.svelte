<script lang="ts" module>
	const endpoint = '/api/arduino/compile';
	// Asked once per page load: the answer cannot change while the server runs.
	let availability: Promise<{ available: boolean; reason?: string }> | undefined;
	// By chip, so the "changed since the last compile" note survives selecting another part and back.
	const compiledSketches = new Map<string, string>();

	const blink = `// Blink: turns the LED on pin 13 on and off every second.

void setup() {
  pinMode(13, OUTPUT);     // runs once at start
}

void loop() {
  digitalWrite(13, HIGH);  // LED on
  delay(1000);
  digitalWrite(13, LOW);   // LED off
  delay(1000);
}`;
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { Button, TextArea } from '$lib/ui';
	import { FLASH_BYTES } from '$lib/schematic/chips-mcu';
	import { readFirmware } from '$lib/schematic/firmware';
	import type { Instance } from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import { hint, problem, sectionTitle } from './styles';

	let { instance }: { instance: Instance } = $props();
	const saved = $derived(String(instance.params.sketch ?? ''));
	let draft = $state<string | null>(null);
	// An empty sketch starts as the Blink example: real text to edit, not a hint.
	const sketch = $derived(draft ?? (saved || blink));

	let available = $state<boolean | null>(null);
	let notAvailable = $state<string | undefined>();
	let compiling = $state(false);
	let result = $state<{ error: boolean; text: string; diagnostics?: string } | null>(null);
	let lastCompiled = $state<string | undefined>();
	let active: AbortController | undefined;

	onMount(() => {
		// A server that answers but has no toolchain says why; one that does not answer at all
		// (the hosted site) has no reason to give.
		availability ??= fetch(endpoint)
			.then(async (response) => {
				const body = response.ok ? await response.json() : null;
				return {
					available: body?.available === true,
					reason: typeof body?.reason === 'string' ? body.reason : undefined
				};
			})
			.catch(() => ({ available: false }));
		void availability.then((value) => {
			available = value.available;
			notAvailable = value.reason;
		});
	});

	$effect.pre(() => {
		const id = instance.id;
		draft = null;
		result = null;
		lastCompiled = compiledSketches.get(id);
		compiling = false;
		active = undefined;
		return () => active?.abort();
	});

	/** Leaving the box saves what was typed; Compile also saves the starting example. */
	function saveSketch(typed = true) {
		if (typed && draft === null) return true;
		if (sketch !== saved) {
			const refusal = app.setParam(instance.id, 'sketch', sketch);
			if (refusal) {
				result = { error: true, text: refusal };
				return false;
			}
		}
		draft = null;
		return true;
	}

	// The box's height while it is dragged taller or shorter. Kept here only: it is
	// a way of looking at the sketch, not part of the drawing, so it is neither saved
	// nor an Undo step.
	let box: HTMLTextAreaElement | null = $state(null);
	let height = $state<number | null>(null);
	let drag: { at: number; height: number } | null = $state(null);

	function limits() {
		const style = getComputedStyle(box!);
		return { min: parseFloat(style.minHeight), max: parseFloat(style.maxHeight) };
	}
	function resize(to: number) {
		if (!box) return;
		const { min, max } = limits();
		height = Math.round(Math.min(max, Math.max(min, to)));
	}
	function grab(event: PointerEvent) {
		if (event.button !== 0 || !box) return;
		event.preventDefault();
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		drag = { at: event.clientY, height: box.offsetHeight };
	}
	function pull(event: PointerEvent) {
		if (drag) resize(drag.height + event.clientY - drag.at);
	}
	function release(event: PointerEvent) {
		if (!drag) return;
		(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
		drag = null;
	}
	function nudge(event: KeyboardEvent) {
		if (!box) return;
		const step = event.shiftKey ? 48 : 16;
		const { min, max } = limits();
		if (event.key === 'ArrowDown') resize(box.offsetHeight + step);
		else if (event.key === 'ArrowUp') resize(box.offsetHeight - step);
		else if (event.key === 'Home') resize(min);
		else if (event.key === 'End') resize(max);
		else return;
		event.preventDefault();
	}

	async function compile() {
		if (!available || compiling || app.locked || !sketch.trim()) return;
		const source = sketch;
		if (!saveSketch(false)) return;

		const target = instance;
		const id = target.id;
		const firmware = target.params.firmware;
		const controller = new AbortController();
		active = controller;
		compiling = true;
		result = null;
		const start = performance.now();
		const stillSelected = () =>
			!controller.signal.aborted && instance === target &&
			app.selectedInstances.length === 1 && app.selectedInstances[0] === target;

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Repath-Compile': '1' },
				body: JSON.stringify({ sketch: source }),
				signal: controller.signal
			});
			const body = await response.json();
			if (!stillSelected()) return;
			if (!response.ok || body?.ok !== true || typeof body.hex !== 'string') {
				throw new Error(body?.diagnostics || 'Compilation failed.');
			}
			const { bytes, problem: invalid } = readFirmware(body.hex, FLASH_BYTES);
			if (invalid || !bytes) throw new Error(invalid || 'The compiled program is empty.');
			if (target.params.firmware !== firmware) throw new Error('The program changed while compiling. Compile again.');

			const refusal = app.setParam(id, 'firmware', body.hex);
			if (refusal) throw new Error(refusal);
			compiledSketches.set(id, source);
			lastCompiled = source;
			const seconds = ((performance.now() - start) / 1000).toFixed(2);
			result = {
				error: false,
				text: `Compiled ${bytes.toLocaleString('en')} bytes in ${seconds} s.`,
				diagnostics: typeof body.diagnostics === 'string' ? body.diagnostics.trim() : undefined
			};
		} catch (cause) {
			if (stillSelected()) {
				result = { error: true, text: cause instanceof Error ? cause.message : String(cause) };
			}
		} finally {
			if (active === controller) {
				active = undefined;
				compiling = false;
			}
		}
	}
</script>

<section class="flex flex-col gap-1.5">
	<h3 class={sectionTitle}>Sketch</h3>
	<div class="flex flex-col">
		<!-- 10 lines is the least that shows Blink without scrolling; 40 keeps a long sketch from
			pushing the Program section off the screen. -->
		<TextArea
			bind:element={box}
			rows={15}
			spellcheck="false"
			aria-label="Arduino sketch"
			value={sketch}
			oninput={(event) => (draft = event.currentTarget.value)}
			onblur={() => saveSketch()}
			style={height === null ? undefined : `height: ${height}px`}
			class="min-h-[10lh] max-h-[40lh] w-full resize-none rounded-t-control border border-b-0 border-border bg-canvas px-2 py-1.5 font-mono text-3xs leading-normal text-fg outline-none field"
		/>
		<!-- A focusable separator is a widget in ARIA terms, which the checker does not know. -->
		<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
		<div
			role="separator"
			tabindex="0"
			aria-label="Resize the sketch box"
			aria-orientation="horizontal"
			aria-valuenow={height ?? box?.offsetHeight ?? 0}
			aria-valuemin={box ? limits().min : undefined}
			aria-valuemax={box ? limits().max : undefined}
			title="Drag to resize; double-click to reset"
			onpointerdown={grab}
			onpointermove={pull}
			onpointerup={release}
			onpointercancel={release}
			ondblclick={() => (height = null)}
			onkeydown={nudge}
			class="group flex h-2 w-full cursor-ns-resize touch-none items-center justify-center rounded-b-control border border-t-0 border-border bg-panel outline-none select-none hover:bg-hover focus-visible:bg-hover {drag
				? 'bg-hover'
				: ''}"
		>
			<span
				class="pointer-events-none h-0.5 w-8 rounded-full bg-muted opacity-60 group-hover:opacity-100 group-focus-visible:opacity-100 {drag
					? 'opacity-100'
					: ''}"
			></span>
		</div>
	</div>
	<div class="flex gap-1.5">
		<Button size="sm" onclick={compile} disabled={!available || compiling || app.locked || !sketch.trim()}>
			{compiling ? 'Compiling…' : 'Compile'}
		</Button>
	</div>
	{#if app.locked}
		<p class={hint}>Stop the run to compile.</p>
	{/if}
	{#if available === false && notAvailable}
		<p class={problem} role="alert">{notAvailable}</p>
	{:else if available === false}
		<p class={hint}>
			Compile needs the dev server and the Arduino AVR toolchain. Compile on your computer and
			load the .hex below.
		</p>
	{/if}
	{#if lastCompiled !== undefined && sketch !== lastCompiled}
		<p class={hint}>The sketch changed since the last compile.</p>
	{/if}
	{#if result?.error}
		<pre class="{problem} max-h-[10lh] overflow-auto font-mono whitespace-pre-wrap break-words" role="alert">{result.text}</pre>
	{:else if result}
		<p class={hint} role="status">{result.text}</p>
		{#if result.diagnostics}
			<pre class="{hint} max-h-[10lh] overflow-auto font-mono whitespace-pre-wrap break-words">{result.diagnostics}</pre>
		{/if}
	{/if}
</section>
