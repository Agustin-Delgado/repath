<script lang="ts">
	import { FileUp, X } from '@lucide/svelte';
	import { Button } from '$lib/ui';
	import { FLASH_BYTES, unsimulatedMessage } from '$lib/schematic/chips-mcu';
	import { readFirmware } from '$lib/schematic/firmware';
	import type { Instance } from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';
	import { hint, problem, sectionTitle } from './styles';

	/**
	 * A microcontroller's program, and what it has said while running.
	 *
	 * The program is the .hex file a toolchain writes, kept as text on the part
	 * the way an EEPROM keeps its contents, so it is saved and shared with the
	 * drawing. Nothing here compiles: the inspector says where a .hex comes from
	 * instead.
	 */
	let { instance }: { instance: Instance } = $props();

	const text = $derived(String(instance.params.firmware ?? ''));
	const loaded = $derived(text.trim() !== '');
	const summary = $derived(loaded ? readFirmware(text, FLASH_BYTES) : null);
	const log = $derived(app.mcuLogs[instance.name]);
	/** A run is going or has been, so there is a log to show, empty or not. */
	const ran = $derived(app.capture !== null);

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
</script>

<section class="flex flex-col gap-1.5">
	<h3 class={sectionTitle}>Program</h3>
	{#if !loaded}
		<p class={hint}>None loaded: until one is, the chip runs nothing and leaves its pins alone.</p>
	{:else if summary?.problem}
		<p class={problem} role="alert">That is not a program it can run: {summary.problem}.</p>
	{:else if summary}
		<p class={hint}>
			<strong class="text-fg">{summary.bytes.toLocaleString('en')} bytes</strong> of
			{FLASH_BYTES.toLocaleString('en')}.
		</p>
	{/if}
	{#if unreadable}<p class={problem} role="alert">{unreadable}</p>{/if}
	<div class="flex gap-1.5">
		<Button size="sm" onclick={() => picker?.click()} title="Load a .hex file">
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
				title="Remove the program"
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
		<textarea
			rows="4"
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
			class="w-full resize-y rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-[0.64rem] leading-normal text-fg outline-none focus:border-accent/70"
		></textarea>
	{/if}
	<p class={hint}>
		From the Arduino IDE: Sketch → Export Compiled Binary, then the <code>.hex</code> without
		“with_bootloader”. From a terminal:
		<code>arduino-cli compile -b arduino:avr:uno --output-dir out</code>. Arduino D0–D7 are PD0–PD7,
		D8–D13 are PB0–PB5 and A0–A5 are PC0–PC5.
	</p>
</section>

{#if ran && loaded && log && log.notices.length > 0}
	<section class="flex flex-col gap-1.5">
		<h3 class={sectionTitle}>Not simulated</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0">
			{#each log.notices as notice (notice.peripheral)}
				<li class={hint}>
					<span class="text-fg">{unsimulatedMessage(notice.peripheral)}</span>
					First used at {formatWithUnit(notice.time, 's', 4)}.
				</li>
			{/each}
		</ul>
		<p class={hint}>
			The program runs on: these parts of the chip just do not do what the real ones would.
		</p>
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
			class="m-0 max-h-40 min-h-12 overflow-auto rounded-control border border-border bg-canvas px-2 py-1.5 font-mono text-[0.64rem] leading-normal whitespace-pre-wrap break-all text-fg">{#if log?.text}{log.text}{:else}<span
					class="text-muted">Nothing sent yet.</span
				>{/if}</pre>
		<p class={hint}>What it sends on TX (D1), at whatever baud rate the program set.</p>
	</section>
{/if}
