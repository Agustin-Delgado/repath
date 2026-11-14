<script lang="ts">
	import { Cpu, Flame, Info, TriangleAlert } from '@lucide/svelte';
	import { isUnsimulated, unsimulatedMessage } from '$lib/schematic/chips-mcu';
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
</script>

{#if stopped.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-danger">
			<Cpu class="size-3.5" /> Program stopped
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
			{#each stopped as fault (fault.name)}
				<li>
					<strong class="text-fg">{fault.name}</strong> stopped at {formatWithUnit(fault.time, 's')}:
					{fault.message}.
				</li>
			{/each}
		</ul>
		<p class="m-0 text-[0.68rem] text-muted">
			Its program goes no further from there. One built for another chip, or one that ran off its end
			into empty flash, stops like this.
		</p>
	</section>
{/if}

{#if burnouts.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-danger/40 bg-danger/10 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-danger">
			<Flame class="size-3.5" />
			{leds === 0 ? 'Blown' : fuses === 0 ? 'Burnt out' : 'Burnt out and blown'}
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
			{#each burnouts as burnout (burnout.instanceId)}
				<li>
					<strong class="text-fg">{burnout.name}</strong> reached {formatWithUnit(burnout.peak, 'A')}
					against a {formatWithUnit(burnout.rated, 'A')} rating, and {burnout.kind === 'fuse'
						? 'blew'
						: 'went'} at
					{formatWithUnit(burnout.time, 's')}.
				</li>
			{/each}
		</ul>
		<p class="m-0 text-[0.68rem] text-muted">
			{burnouts.length === 1 ? 'It is' : 'They are'} open from then on, and the rest of the run is the
			circuit without {burnouts.length === 1 ? 'it' : 'them'}.
			{#if leds > 0}Add a series resistor to keep {leds === 1 ? 'an LED' : 'the LEDs'} alive.{/if}
			{#if fuses > 0}A fuse blowing is it doing its job: find what drew that much before fitting a
				bigger one.{/if}
		</p>
	</section>
{/if}

{#if warnings.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-selection/25 bg-selection/5 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-selection">
			<TriangleAlert class="size-3.5" /> Check the wiring
			<span class="ml-auto font-mono text-[0.62rem] font-normal opacity-70">{warnings.length}</span>
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
			{#each warnings.slice(0, SHOWN) as warning, i (i)}
				<li>{warning}</li>
			{/each}
			{#if warnings.length > SHOWN}
				<li class="text-muted">…and {warnings.length - SHOWN} more</li>
			{/if}
		</ul>
	</section>
{/if}

{#if unanswered.length > 0}
	<section class="flex flex-col gap-1.5 rounded-md border border-selection/25 bg-selection/5 p-2">
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-selection">
			<TriangleAlert class="size-3.5" /> Nobody answered
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
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
		<h3 class="m-0 flex items-center gap-1.5 text-[0.7rem] font-semibold text-accent">
			<Info class="size-3.5" /> Not simulated
		</h3>
		<ul class="m-0 flex list-none flex-col gap-1 p-0 text-[0.7rem] leading-snug text-strong">
			{#each unsimulated as notice (`${notice.name}:${notice.peripheral}`)}
				<li>
					<strong class="text-fg">{notice.name}</strong>: {unsimulatedMessage(notice.peripheral)}
				</li>
			{/each}
		</ul>
		<p class="m-0 text-[0.68rem] text-muted">
			The program keeps running; only what it gets from these parts of the chip is not what a real one
			would give.
		</p>
	</section>
{/if}
