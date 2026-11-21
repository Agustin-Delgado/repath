<script lang="ts" module>
	import type { LineEnding } from '$lib/schematic/serial';

	/**
	 * What each chip's monitor was last set to, by name: the panel is rebuilt
	 * whenever the selection changes, and a monitor that forgot its baud rate
	 * every time would be set again on every look at it.
	 */
	const monitors = new Map<string, { baud: number; ending: LineEnding }>();
</script>

<script lang="ts">
	import { FileUp, SendHorizontal, X } from '@lucide/svelte';
	import { Button, Select, TextArea, TextInput } from '$lib/ui';
	import { FLASH_BYTES, isUnsimulated, unsimulatedMessage } from '$lib/schematic/chips-mcu';
	import { readFirmware } from '$lib/schematic/firmware';
	import type { Instance } from '$lib/schematic/model';
	import {
		BAUD_RATES,
		DEFAULT_BAUD,
		DEFAULT_LINE_ENDING,
		LINE_ENDINGS,
		baudMismatch
	} from '$lib/schematic/serial';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';
	import McuSketch from './McuSketch.svelte';
	import { fieldBox, fieldInput, hint, problem, sectionTitle } from './styles';

	/**
	 * A microcontroller's program, and what it has said while running.
	 *
	 * The program is the .hex file a toolchain writes, kept as text on the part
	 * the way an EEPROM keeps its contents, so it is saved and shared with the
	 * drawing.
	 */
	let { instance }: { instance: Instance } = $props();

	const text = $derived(String(instance.params.firmware ?? ''));
	const loaded = $derived(text.trim() !== '');
	const summary = $derived(loaded ? readFirmware(text, FLASH_BYTES) : null);
	const log = $derived(app.mcuLogs[instance.name]);
	/** A run is going or has been, so there is a log to show, empty or not. */
	const ran = $derived(app.capture !== null);
	const unsimulated = $derived((log?.notices ?? []).filter((n) => isUnsimulated(n.peripheral)));
	/** What the program did that a real board would let pass in silence. */
	const circuit = $derived((log?.notices ?? []).filter((n) => !isUnsimulated(n.peripheral)));

	let picker: HTMLInputElement | undefined = $state();
	let pasting = $state(false);
	let unreadable = $state<string | null>(null);

	async function load(file: File | undefined) {
		if (!file) return;
		unreadable = null;
		try {
			app.setParam(instance.id, 'firmware', await file.text());
		} catch (cause) {
			unreadable = `${file.name} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	/** The newest line in view as bytes come in, the way a serial monitor scrolls. */
	let monitor: HTMLPreElement | undefined = $state();
	$effect(() => {
		void log?.text;
		if (monitor) monitor.scrollTop = monitor.scrollHeight;
	});

	/** On the same timer as the memory contents, for the same reason. */
	let settling: ReturnType<typeof setTimeout> | undefined;

	// The monitor's input: what to send, and how, as the Arduino IDE has it.
	let typed = $state('');
	let baud = $state(DEFAULT_BAUD);
	let ending = $state<LineEnding>(DEFAULT_LINE_ENDING);
	/** Whose settings are showing: the panel can be handed another chip without being rebuilt. */
	let shown: string | null = null;
	$effect.pre(() => {
		if (instance.name === shown) return;
		shown = instance.name;
		const remembered = monitors.get(instance.name);
		baud = remembered?.baud ?? DEFAULT_BAUD;
		ending = remembered?.ending ?? DEFAULT_LINE_ENDING;
	});
	function choose(next: { baud?: number; ending?: LineEnding }) {
		baud = next.baud ?? baud;
		ending = next.ending ?? ending;
		monitors.set(instance.name, { baud, ending });
	}
	/** A run to send into: going or paused, as long as it is still there. */
	const live = $derived(app.acquiring !== null && app.analysis === 'transient');
	const listening = $derived(log?.listening ?? null);
	const garbled = $derived(listening !== null && baudMismatch(baud, listening));
	const baudItems = BAUD_RATES.map((rate) => ({
		value: String(rate),
		label: `${rate.toLocaleString('en')} baud`
	}));
	const endingItems = LINE_ENDINGS.map((e) => ({ value: e.id, label: e.label }));

	function send() {
		if (app.sendSerial(instance.name, typed, ending, baud)) typed = '';
	}
</script>

<McuSketch {instance} />

<section class="flex flex-col gap-1.5">
	<h3 class={sectionTitle}>Program</h3>
	{#if !loaded}
		<p class={hint}>No program. All pins are high-Z.</p>
	{:else if summary?.problem}
		<p class={problem} role="alert">Not a valid program: {summary.problem}.</p>
	{:else if summary}
		<p class={hint}>
			<strong class="text-fg">{summary.bytes.toLocaleString('en')} bytes</strong> of
			{FLASH_BYTES.toLocaleString('en')}.
		</p>
	{/if}
	{#if unreadable}<p class={problem} role="alert">{unreadable}</p>{/if}
	<div class="flex gap-1.5">
		<Button size="sm" onclick={() => picker?.click()}>
			<FileUp /> Load .hex
		</Button>
		<Button size="sm" variant="ghost" active={pasting} onclick={() => (pasting = !pasting)}>
			Paste
		</Button>
		{#if loaded}
			<Button
				size="sm"
				variant="ghost"
				class="ml-auto"
				onclick={() => app.setParam(instance.id, 'firmware', '')}
			>
				<X /> Clear
			</Button>
		{/if}
	</div>
	<input
		bind:this={picker}
		type="file"
		accept=".hex,.ihex,.ihx,text/plain"
		class="hidden"
		aria-label="Program file"
		onchange={(e) => {
			void load(e.currentTarget.files?.[0]);
			e.currentTarget.value = '';
		}}
	/>
	{#if pasting}
		<TextArea
			rows={4}
			spellcheck="false"
			placeholder={':100000000C9434000C943E000C943E000C943E0082\n…\n:00000001FF'}
			value={text}
			oninput={(e) => {
				const raw = e.currentTarget.value;
				const id = instance.id;
				clearTimeout(settling);
				settling = setTimeout(() => app.setParam(id, 'firmware', raw), 350);
			}}
			onblur={(e) => {
				clearTimeout(settling);
				app.setParam(instance.id, 'firmware', e.currentTarget.value);
			}}
			aria-label="Program as Intel HEX"
			class="w-full resize-y rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-3xs leading-normal text-fg outline-none field"
		/>
	{/if}
	<p class={hint}>
		Or compile the sketch above. Intel HEX, no bootloader. Arduino IDE: Sketch → Export Compiled Binary, the <code>.hex</code>
		without “with_bootloader”.
	</p>
	<p class={hint}>
		<span class="whitespace-nowrap">D0–7 = PD0–7</span> · <span class="whitespace-nowrap">D8–13 = PB0–5</span> ·
		<span class="whitespace-nowrap">A0–5 = PC0–5</span>
	</p>
</section>

{#if ran && loaded && circuit.length > 0}
	<section class="flex flex-col gap-1.5">
		<h3 class={sectionTitle}>On the bus</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0">
			{#each circuit as notice (notice.peripheral)}
				<li class={hint}>
					<span class="text-fg">{unsimulatedMessage(notice.peripheral)}</span>
					First at {formatWithUnit(notice.time, 's', 4)}.
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if ran && loaded && unsimulated.length > 0}
	<section class="flex flex-col gap-1.5">
		<h3 class={sectionTitle}>Not simulated</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0">
			{#each unsimulated as notice (notice.peripheral)}
				<li class={hint}>
					<span class="text-fg">{unsimulatedMessage(notice.peripheral)}</span>
					First at {formatWithUnit(notice.time, 's', 4)}.
				</li>
			{/each}
		</ul>
		<p class={hint}>The program continues. These peripherals do not operate as on a real chip.</p>
	</section>
{/if}

{#if ran && loaded && !summary?.problem}
	<section class="flex flex-col gap-1.5">
		<h3 class={sectionTitle}>Serial</h3>
		{#if log?.fault}
			<p class={problem} role="alert">
				Stopped at {formatWithUnit(log.fault.time, 's', 4)}: {log.fault.message}.
			</p>
		{/if}
		<pre
			bind:this={monitor}
			aria-label="Serial output"
			class="m-0 max-h-40 min-h-12 overflow-auto rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-3xs leading-normal whitespace-pre-wrap break-all text-fg">{log?.text ?? ''}</pre>
		<form
			class="flex gap-1.5"
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<label class={fieldBox}>
				<TextInput
					class={fieldInput}
					bind:value={typed}
					disabled={!live}
					placeholder={live ? 'Message' : 'Run the circuit to send'}
					aria-label="Serial input"
					spellcheck="false"
					autocomplete="off"
				/>
			</label>
			<Button size="sm" type="submit" disabled={!live || (typed === '' && ending === 'none')}>
				<SendHorizontal /> Send
			</Button>
		</form>
		<div class="flex flex-wrap gap-1.5">
			<Select
				size="sm"
				items={endingItems}
				value={ending}
				onChange={(value) => choose({ ending: value as LineEnding })}
				aria-label="Line ending"
			/>
			<Select
				size="sm"
				items={baudItems}
				value={String(baud)}
				onChange={(value) => choose({ baud: Number(value) })}
				aria-label="Baud rate"
			/>
		</div>
		{#if garbled && listening !== null}
			<p class={problem} role="alert">
				The program listens at {Math.round(listening).toLocaleString('en')} baud. Data sent at
				{baud.toLocaleString('en')} baud arrives garbled.
			</p>
		{:else if log && listening === null}
			<p class={hint}>Receiver off: input is ignored. Serial.begin() turns it on.</p>
		{/if}
		<p class={hint}>Output: TX (D1), at the program's baud. Input: RX (D0), at the baud set here.</p>
	</section>
{/if}
