<script lang="ts">
	import { ChevronRight, RotateCw, Trash2 } from '@lucide/svelte';
	import { Button } from '$lib/ui';
	import { mcuBlock } from '$lib/schematic/chips';
	import { ledRating } from '$lib/schematic/led';
	import { BUZZER_KIND } from '$lib/schematic/buzzer';
	import { pinKey } from '$lib/schematic/nets';
	import { MAX_PULSE_US, MIN_PULSE_US, SERVO_KIND } from '$lib/schematic/servo';
	import {
		chipOf,
		definitionFor,
		isAdvanced,
		isParamVisible,
		type Instance
	} from '$lib/schematic/model';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';
	import PartIcon from '../palette/PartIcon.svelte';
	import BlockPanel from './BlockPanel.svelte';
	import NameField from './NameField.svelte';
	import McuPanel from './McuPanel.svelte';
	import BuzzerPanel from './BuzzerPanel.svelte';
	import MemoryContents from './MemoryContents.svelte';
	import ParamField from './ParamField.svelte';
	import SpiceCard from './SpiceCard.svelte';
	import { hint } from './styles';

	let { instance }: { instance: Instance } = $props();

	const def = $derived(definitionFor(instance));

	const shown = $derived(
		def.params.filter((param) => !param.hidden && isParamVisible(param, instance.params))
	);
	const essential = $derived(shown.filter((param) => !isAdvanced(param)));
	const advanced = $derived(shown.filter(isAdvanced));
	/** Advanced values somebody changed: counted on the fold, so a folded change is not a hidden one. */
	const changed = $derived(
		advanced.filter((param) => instance.params[param.key] !== param.default).length
	);

	const MORE_KEY = 'repath.moreSettings';
	let more = $state(read());
	function read(): boolean {
		try {
			return localStorage.getItem(MORE_KEY) === 'open';
		} catch {
			return false;
		}
	}
	function toggleMore() {
		more = !more;
		try {
			localStorage.setItem(MORE_KEY, more ? 'open' : 'closed');
		} catch {
			// Stays as it is for this tab.
		}
	}

	/** When this part was operated by hand during the run that is going. */
	const operations = $derived(app.operationsOf(instance.id));

	/** Whether every pin lands on the same net. */
	const shorted = $derived.by(() => {
		if (def.pins.length < 2) return false;
		const nets = new Set(
			def.pins.map((pin) => app.compiled.connectivity.netOfPin.get(pinKey(instance.id, pin.name)))
		);
		return nets.size === 1 && !nets.has(undefined);
	});

	/** What an LED is carrying right now, or null if that is not a question. */
	const lit = $derived.by(() => {
		if (instance.kind !== 'led') return null;
		const current = app.currentThrough(instance.name);
		if (current === null) return null;
		const rated = ledRating(instance);
		const flowing = Math.max(current, 0);
		return { current: flowing, rated, percent: Math.round((flowing / rated) * 1000) / 10 };
	});

	/**
	 * Where a servo's horn is at the playback instant, and the pulse that put
	 * it there, or null with no run to say. Kept beside the drawing because a
	 * horn a few degrees off reads the same as one on target, and because a
	 * pulse the servo ignored leaves it looking as if nothing had been sent.
	 */
	const servo = $derived.by(() => {
		if (instance.kind !== SERVO_KIND) return null;
		const frame = app.servoAt(instance.name);
		if (!frame) return null;
		return { ...frame, current: app.currentThrough(instance.name) };
	});

	const takesCard = $derived(def.params.some((param) => param.key === 'spice'));
	/** A memory somebody programs, whose contents are edited as text. */
	const programmable = $derived.by(() => {
		const chip = chipOf(instance.kind);
		return chip?.contents ? chip : null;
	});
	/** A microcontroller, whose program is loaded rather than typed. */
	const runsProgram = $derived.by(() => {
		const chip = chipOf(instance.kind);
		return chip !== undefined && mcuBlock(chip) !== undefined;
	});
</script>

<div class="flex flex-col gap-3">
	<header class="flex items-center gap-2">
		<span class="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-canvas [--symbol-stroke:var(--symbol)]">
			<PartIcon kind={instance.kind} class="h-[24px] w-[32px]" />
		</span>
		<div class="flex min-w-0 flex-1 flex-col">
			<NameField
				prominent
				value={instance.name}
				commit={(raw) => app.rename(instance.id, raw)}
				aria-label="Reference designator"
			/>
			<span class="truncate px-1 text-2xs text-muted">{def.label}</span>
		</div>
	</header>

	<!--
		A block is a circuit in a box, and the box is what is edited here. What is
		inside is edited by opening the box up.
	-->
	{#if app.selectedBlock}
		<BlockPanel boxed={app.selectedBlock} />
	{/if}

	{#if essential.length > 0}
		<div class="flex flex-col gap-2.5">
			{#each essential as param (instance.id + ':' + param.key)}
				<ParamField id={instance.id} {param} value={instance.params[param.key]} />
			{/each}
		</div>
	{/if}

	{#if advanced.length > 0}
		<section class="flex flex-col gap-2.5">
			<button
				type="button"
				aria-expanded={more}
				onclick={toggleMore}
				class="flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left text-2xs text-muted hover:text-fg"
			>
				<ChevronRight class="size-3 transition-transform {more ? 'rotate-90' : ''}" />
				More settings
				<span class="font-mono opacity-70">({advanced.length})</span>
				{#if changed > 0 && !more}
					<span class="ml-auto rounded bg-accent/15 px-1.5 text-3xs text-accent">
						{changed} changed
					</span>
				{/if}
			</button>
			{#if more}
				{#each advanced as param (instance.id + ':' + param.key)}
					<ParamField id={instance.id} {param} value={instance.params[param.key]} />
				{/each}
			{/if}
		</section>
	{/if}

	<!--
		What has been done to this part during the run that is going. The field
		above says where it *starts*, which reads as a contradiction against a
		switch sitting closed on the drawing until the operations are named.
	-->
	{#if operations.length > 0}
		<p class={hint}>
			Operated {operations.length === 1 ? 'once' : `${operations.length} times`} in this run, at
			{operations.map((t: number) => formatWithUnit(t, 's', 3)).join(', ')}. The next run starts from
			the position above.
		</p>
	{/if}

	<!--
		Why an LED is not lighting is the question this readout exists to answer.
		Brightness is not linear in current, so a part carrying a fiftieth of its
		rating is very nearly dark; saying the number turns guessing into arithmetic.
	-->
	{#if lit}
		<p class="{hint} rounded-md border border-border bg-canvas px-2 py-1.5">
			<strong class="text-fg">{formatWithUnit(lit.current, 'A')}</strong>, {lit.percent}% of the
			{formatWithUnit(lit.rated, 'A')} rating.
			{#if shorted}
				No current: a wire crosses both pins. End the wire on each pin.
			{:else if lit.percent < 5}
				Too little current to light. Check the voltage across the series resistor.
			{/if}
		</p>
	{/if}

	{#if servo}
		<p class="{hint} rounded-md border border-border bg-canvas px-2 py-1.5">
			Horn at <strong class="text-fg">{servo.angle.toFixed(1)}°</strong>{#if Math.abs(servo.angle - servo.target) > 0.05},
				moving to {servo.target.toFixed(1)}°{/if}.
			{#if !servo.pulse}
				No pulse on SIG. The Servo library sends one every 20 ms after <code>attach()</code>.
			{:else if servo.pulse.taken}
				Last pulse {formatWithUnit(servo.pulse.width, 's', 4)} at {formatWithUnit(servo.pulse.at, 's', 4)}.
			{:else}
				Pulse {formatWithUnit(servo.pulse.width, 's', 4)} at {formatWithUnit(servo.pulse.at, 's', 4)}
				ignored. Valid: {MIN_PULSE_US}–{MAX_PULSE_US} µs, at least 3 ms after the previous pulse.
			{/if}
			{#if servo.current !== null}
				{formatWithUnit(Math.max(servo.current, 0), 'A')} from VCC.
			{/if}
		</p>
	{/if}

	{#if programmable}
		{#key instance.id}
			<MemoryContents {instance} chip={programmable} />
		{/key}
	{/if}

	{#if runsProgram}
		{#key instance.id}
			<McuPanel {instance} />
		{/key}
	{/if}

	{#if instance.kind === BUZZER_KIND}
		<BuzzerPanel {instance} />
	{/if}

	{#if takesCard}
		{#key instance.id}
			<SpiceCard {instance} label={def.label} />
		{/key}
	{/if}

	<div class="flex gap-1.5">
		<Button class="flex-1" onclick={() => app.rotateSelection()} title="Rotate 90°; wires follow">
			<RotateCw /> Rotate <kbd class="font-mono text-3xs text-muted">R</kbd>
		</Button>
		<Button class="flex-1 text-danger" onclick={() => app.deleteSelection()}>
			<Trash2 /> Delete <kbd class="font-mono text-3xs text-muted">Del</kbd>
		</Button>
	</div>
</div>
