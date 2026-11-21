<script lang="ts">
	import { CircleX, Cpu, Flame, Info, TriangleAlert } from '@lucide/svelte';
	import { isUnsimulated, unsimulatedMessage } from '$lib/schematic/chips-mcu';
	import { burnoutKey } from '$lib/schematic/led';
	import { app } from '$lib/state.svelte';
	import { formatWithUnit } from '$lib/units';

	/**
	 * What is wrong with the circuit as a whole, whatever is selected: parts
	 * that burnt out during the run, and wiring that cannot be what was meant.
	 *
	 * Not "loose ends" any more: a part shorted by a wire drawn past it is the
	 * opposite problem, and belongs in the same list.
	 */
	const SHOWN = 6;
	const warnings = $derived(app.compiled.warnings);
	const burnouts = $derived(app.burnouts);
	const leds = $derived(burnouts.filter((b) => b.kind === 'led').length);
	const fuses = $derived(burnouts.length - leds);
	/** Microcontrollers whose CPU stopped during the run: shown whatever is selected. */
	const stopped = $derived(
		Object.entries(app.mcuLogs).flatMap(([name, log]) => (log.fault ? [{ name, ...log.fault }] : []))
	);
	/**
	 * Parts of a chip its program used that are not simulated. Not a fault —
	 * the program runs on — but what it reads from them is not what a real chip
	 * would read, and that is easy to take for a result.
	 */
	const notices = $derived(
		Object.entries(app.mcuLogs).flatMap(([name, log]) =>
			log.notices.map((notice) => ({ name, peripheral: notice.peripheral }))
		)
	);
	const unsimulated = $derived(notices.filter((notice) => isUnsimulated(notice.peripheral)));
	/**
	 * What a program met on its bus that a real board would let pass in
	 * silence: an I²C address nobody answered, the usual reason a display
	 * stays blank.
	 */
	const unanswered = $derived(notices.filter((notice) => !isUnsimulated(notice.peripheral)));
	/**
	 * Where the last solve failed, in the drawing's own names. The same parts
	 * and nets are marked on the canvas; hovering a net here lights it the way
	 * hovering it there does, and a part's name selects it.
	 */
	const failure = $derived(app.failure);
</script>

{#if failure}
	<section
		class="flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2"
		aria-label="Solve failure"
	>
		<h3 class="m-0 flex items-center gap-1.5 text-2xs font-semibold text-danger">
			<CircleX class="size-3.5" />
			{failure.kind === 'singular' ? 'Singular matrix' : 'No convergence'}
			{#if failure.time !== null && failure.time > 0}
				<span class="ml-auto font-mono text-3xs font-normal opacity-70"
					>at {formatWithUnit(failure.time, 's')}</span
				>
			{/if}
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-2xs leading-snug text-strong">
			{#each failure.parts as id, i (id)}
				<li>
					<button
						class="cursor-pointer border-0 bg-transparent p-0 text-left font-semibold text-fg hover:underline"
						onclick={() => (app.selection = [id])}>{failure.partNames[i]}</button
					>
				</li>
			{/each}
			{#each failure.nets as net, i (net)}
				<li
					class="rounded-sm {app.hoverNet === net ? 'bg-hover' : ''}"
					onpointerenter={() => (app.hoverNet = net)}
					onpointerleave={() => (app.hoverNet = null)}
				>
					net <span class="font-mono text-fg">{failure.netLabels[i]}</span>
				</li>
			{/each}
		</ul>
		<p class="m-0 text-2xs text-muted">{failure.message}</p>
	</section>
{/if}

{#if stopped.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-2xs font-semibold text-danger">
			<Cpu class="size-3.5" /> Program stopped
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-2xs leading-snug text-strong">
			{#each stopped as fault (fault.name)}
				<li>
					<strong class="text-fg">{fault.name}</strong> stopped at {formatWithUnit(fault.time, 's')}:
					{fault.message}.
				</li>
			{/each}
		</ul>
		<p class="m-0 text-2xs text-muted">
			Usual causes: a program built for another chip, or a program that ran into erased flash.
		</p>
	</section>
{/if}

{#if burnouts.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-2xs font-semibold text-danger">
			<Flame class="size-3.5" />
			{leds === 0 ? 'Blown' : fuses === 0 ? 'Burnt out' : 'Burnt out and blown'}
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-2xs leading-snug text-strong">
			{#each burnouts as burnout (burnoutKey(burnout))}
				<li>
					<strong class="text-fg">{burnout.name}</strong>: {formatWithUnit(burnout.peak, 'A')} peak,
					{formatWithUnit(burnout.rated, 'A')} rated. {burnout.kind === 'fuse' ? 'Blew' : 'Burnt out'} at
					{formatWithUnit(burnout.time, 's')}.
				</li>
			{/each}
		</ul>
		<p class="m-0 text-2xs text-muted">
			Open circuit for the rest of the run.
			{#if leds > 0}Add a series resistor.{/if}
			{#if fuses > 0}Find the overcurrent before you fit a larger fuse.{/if}
		</p>
	</section>
{/if}

{#if warnings.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-warn/30 bg-warn/5 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-2xs font-semibold text-warn">
			<TriangleAlert class="size-3.5" /> Check the wiring
			<span class="ml-auto font-mono text-3xs font-normal opacity-70">{warnings.length}</span>
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-2xs leading-snug text-strong">
			{#each warnings.slice(0, SHOWN) as warning, i (i)}
				<li>{warning}</li>
			{/each}
			{#if warnings.length > SHOWN}
				<li class="text-muted">+{warnings.length - SHOWN} more</li>
			{/if}
		</ul>
	</section>
{/if}

{#if unanswered.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-warn/30 bg-warn/5 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-2xs font-semibold text-warn">
			<TriangleAlert class="size-3.5" /> No I²C response
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-2xs leading-snug text-strong">
			{#each unanswered as notice (`${notice.name}:${notice.peripheral}`)}
				<li>
					<strong class="text-fg">{notice.name}</strong>: {unsimulatedMessage(notice.peripheral)}
				</li>
			{/each}
		</ul>
	</section>
{/if}

{#if unsimulated.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-accent/30 bg-accent/5 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-2xs font-semibold text-accent">
			<Info class="size-3.5" /> Not simulated
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-2xs leading-snug text-strong">
			{#each unsimulated as notice (`${notice.name}:${notice.peripheral}`)}
				<li>
					<strong class="text-fg">{notice.name}</strong>: {unsimulatedMessage(notice.peripheral)}
				</li>
			{/each}
		</ul>
		<p class="m-0 text-2xs text-muted">The program continues. These peripherals do not operate as on a real chip.</p>
	</section>
{/if}
