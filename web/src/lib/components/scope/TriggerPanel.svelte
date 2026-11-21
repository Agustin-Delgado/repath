<script lang="ts">
	/**
	 * The trigger's knobs, in the signals column under the traces they act on.
	 *
	 * Off, only the mode is shown: the scope rolls as it always has, and a
	 * column of settings for a trigger nobody turned on is a column to read
	 * past. On, the rest — source, edge, level, holdoff, position, hysteresis —
	 * with level and hysteresis on automatic until a value is typed.
	 */
	import { ArrowDownRight, ArrowUpRight } from '@lucide/svelte';
	import { Button, Select, UnitField } from '$lib/ui';
	import { app } from '$lib/state.svelte';
	import { formatValue, parseValue } from '$lib/units';
	import type { TriggerMode, TriggerStatus } from '$lib/trigger';

	type Props = {
		/** The analog traces it can trigger on, by their place in the scope's list. */
		sources: Array<{ value: string; label: string }>;
		status: TriggerStatus | null;
		/** What an automatic level and hysteresis come to on the source, in volts. */
		resolved: { level: number; hysteresis: number } | null;
		/** Catch the next trigger, in single. */
		arm: () => void;
	};

	let { sources, status, resolved, arm }: Props = $props();

	const MODES: Array<{ value: TriggerMode; label: string; description: string }> = [
		{ value: 'off', label: 'Off', description: 'No trigger: the screen rolls with the run' },
		{ value: 'auto', label: 'Auto', description: 'Hold still on a trigger, and roll when there has not been one for a screen' },
		{ value: 'normal', label: 'Normal', description: 'Show only what a trigger caught, and hold the last one' },
		{ value: 'single', label: 'Single', description: 'Catch one trigger and stop the run' }
	];

	const STATUS: Record<TriggerStatus, string> = {
		triggered: "trig'd",
		auto: 'auto',
		waiting: 'waiting',
		armed: 'armed',
		captured: 'stopped'
	};

	const on = $derived(app.trigger.mode !== 'off');
</script>

<section class="mt-2 flex flex-col gap-1 border-t border-border px-1.5 pt-2" aria-label="Trigger">
	<div class="flex items-center gap-1 px-1">
		<h3 class="m-0 mr-auto text-3xs font-semibold tracking-[0.08em] text-muted uppercase">Trigger</h3>
		{#if on && status}
			<span
				class="font-mono text-3xs {status === 'triggered' || status === 'captured' ? 'text-accent' : 'text-muted'}"
				role="status">{STATUS[status]}</span
			>
		{/if}
	</div>
	<div class="flex flex-wrap items-center gap-1 px-1">
		<Select
			size="sm"
			items={MODES}
			value={app.trigger.mode}
			onChange={(value) => app.setTrigger({ mode: value as TriggerMode })}
			aria-label="Trigger mode"
			title="How the trigger holds the screen"
		/>
		{#if on}
			<Button
				size="sm"
				class="h-6 px-1.5"
				onclick={() => app.setTrigger({ edge: app.trigger.edge === 'rising' ? 'falling' : 'rising' })}
				title={app.trigger.edge === 'rising' ? 'Rising edge: click for falling' : 'Falling edge: click for rising'}
				aria-label={app.trigger.edge === 'rising' ? 'Rising edge' : 'Falling edge'}
			>
				{#if app.trigger.edge === 'rising'}<ArrowUpRight />{:else}<ArrowDownRight />{/if}
			</Button>
			{#if app.trigger.mode === 'single'}
				<Button size="sm" class="h-6 px-1.5" onclick={arm} title="Wait for the next trigger, running on if stopped">
					arm
				</Button>
			{/if}
		{/if}
	</div>
	{#if on}
		{#if sources.length > 1}
			<div class="px-1">
				<Select
					size="sm"
					class="max-w-full"
					items={sources}
					value={String(Math.min(app.trigger.source, sources.length - 1))}
					onChange={(value) => app.setTrigger({ source: Number(value) })}
					aria-label="Trigger source"
					title="Which trace the trigger watches"
				/>
			</div>
		{/if}
		<div class="grid grid-cols-1 gap-1 px-1 pb-1">
			<UnitField
				prefix="level"
				unit="V"
				width="100%"
				value={app.trigger.level === null
					? `auto ${resolved ? formatValue(resolved.level, 3) : ''}`.trim()
					: formatValue(app.trigger.level, 4)}
				commit={(text) => {
					if (/^\s*(auto)?\s*$/i.test(text)) return app.setTrigger({ level: null });
					const parsed = parseValue(text);
					if (parsed !== null) app.setTrigger({ level: parsed });
				}}
				title="Volts the source crosses to trigger. Empty or auto: halfway between its extremes"
				aria-label="Trigger level"
			/>
			<UnitField
				prefix="hyst"
				unit="V"
				width="100%"
				value={app.trigger.hysteresis === null
					? `auto ${resolved ? formatValue(resolved.hysteresis, 3) : ''}`.trim()
					: formatValue(app.trigger.hysteresis, 3)}
				commit={(text) => {
					if (/^\s*(auto)?\s*$/i.test(text)) return app.setTrigger({ hysteresis: null });
					const parsed = parseValue(text);
					if (parsed !== null && parsed >= 0) app.setTrigger({ hysteresis: parsed });
				}}
				title="How far past the level the other way the source must go before the next trigger: noise smaller than this does not fire it. Empty or auto: 2% of its swing"
				aria-label="Trigger hysteresis"
			/>
			<UnitField
				prefix="holdoff"
				unit="s"
				width="100%"
				value={formatValue(app.trigger.holdoff, 3)}
				commit={(text) => {
					const parsed = parseValue(text);
					if (parsed !== null && parsed >= 0) app.setTrigger({ holdoff: parsed });
				}}
				title="After a trigger, ignore the source for this long: set it past a burst to trigger on its first pulse"
				aria-label="Trigger holdoff"
			/>
			<UnitField
				prefix="pre"
				unit="%"
				width="100%"
				value={String(Math.round(app.trigger.position * 100))}
				commit={(text) => {
					const parsed = Number(text);
					if (text.trim() !== '' && Number.isFinite(parsed)) app.setTrigger({ position: parsed / 100 });
				}}
				title="How much of the screen comes before the trigger"
				aria-label="Trigger position, percent of the screen before the trigger"
			/>
		</div>
	{/if}
</section>
