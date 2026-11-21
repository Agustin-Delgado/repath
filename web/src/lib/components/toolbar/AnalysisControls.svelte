<script lang="ts">
	import { Button, Select, UnitField } from '$lib/ui';
	import { definitionFor } from '$lib/schematic/model';
	import { LOGIC_FAMILIES } from '$lib/schematic/logic';
	import { app } from '$lib/state.svelte';
	import { formatValue, parseValue } from '$lib/units';
	import type { Analysis } from '$lib/format';

	const ANALYSES = [
		{ value: 'transient', label: 'Transient' },
		{ value: 'frequency', label: 'Frequency' },
		{ value: 'dc', label: 'DC sweep' }
	];

	/** The sources the sweep can turn, for the picker. */
	const sourceItems = $derived(app.dcSources.map((s) => ({ value: s.name, label: s.name })));
	const sweptUnit = $derived(app.dcSwept?.unit ?? 'V');

	/** Whether anything on the drawing has a digital pin to speak of. */
	const hasDigital = $derived(
		app.schematic.instances.some((instance) =>
			definitionFor(instance).pins.some((pin) => pin.domain === 'digital')
		)
	);

	/** A positive value in engineering notation, or null for anything else. */
	function positive(text: string): number | null {
		const parsed = parseValue(text);
		return parsed !== null && parsed > 0 ? parsed : null;
	}
</script>

<Select
	items={ANALYSES}
	value={app.analysis}
	onChange={(value) => app.setAnalysis(value as Analysis)}
	aria-label="Analysis"
	title="Which analysis Run performs"
/>

{#if app.analysis === 'frequency'}
	<UnitField
		prefix="from"
		unit="Hz"
		value={formatValue(app.acStart, 3)}
		commit={(text) => {
			const parsed = positive(text);
			if (parsed !== null) app.acStart = parsed;
		}}
		aria-label="Sweep start frequency"
	/>
	<UnitField
		prefix="to"
		unit="Hz"
		value={formatValue(app.acStop, 3)}
		commit={(text) => {
			const parsed = positive(text);
			if (parsed !== null) app.acStop = parsed;
		}}
		aria-label="Sweep stop frequency"
	/>
{:else if app.analysis === 'dc'}
	<!--
		Only a choice when there is one: a drawing with a single source sweeps
		that, and a picker with one entry in it is a label pretending otherwise.
	-->
	{#if sourceItems.length > 1}
		<Select
			items={sourceItems}
			value={app.dcSwept?.name ?? ''}
			onChange={(value) => (app.dcSource = value)}
			aria-label="Source to sweep"
			title="Which source the sweep turns"
		/>
	{:else}
		<span class="shrink-0 font-mono text-2xs text-muted" title="The source the sweep turns">
			{app.dcSwept?.name ?? 'no source'}
		</span>
	{/if}
	<UnitField
		prefix="from"
		unit={sweptUnit}
		width="3.5rem"
		value={formatValue(app.dcStart, 4)}
		commit={(text) => {
			const parsed = parseValue(text);
			if (parsed !== null) app.dcStart = parsed;
		}}
		aria-label="Sweep start value"
	/>
	<UnitField
		prefix="to"
		unit={sweptUnit}
		width="3.5rem"
		value={formatValue(app.dcStop, 4)}
		commit={(text) => {
			const parsed = parseValue(text);
			if (parsed !== null) app.dcStop = parsed;
		}}
		aria-label="Sweep stop value"
	/>
	<UnitField
		prefix="step"
		unit={sweptUnit}
		width="3.5rem"
		value={formatValue(app.dcStep, 4)}
		commit={(text) => {
			const parsed = parseValue(text);
			if (parsed !== null) app.dcStep = parsed;
		}}
		aria-label="Sweep step"
	/>
	<!-- How many points that is, or what is wrong with it, before Run is pressed. -->
	{#if 'error' in app.dcPlan}
		<span class="shrink-0 text-2xs text-danger" title={app.dcPlan.error} role="status">
			invalid
		</span>
	{:else}
		<span class="shrink-0 font-mono text-2xs text-muted" title="Operating points the sweep solves">
			{app.dcPlan.values.length} pts
		</span>
	{/if}
{:else}
	<!--
		The timebase: how much simulated time the screen covers. Not a length
		any more — the run does not have one — but the width of the window it
		is watched through, and what Single captures one of.
	-->
	<UnitField
		prefix="window"
		unit="s"
		title="How much simulated time the screen covers"
		value={formatValue(app.stopTime, 3)}
		commit={(text) => {
			const parsed = positive(text);
			if (parsed !== null) app.setStopTime(parsed);
		}}
		aria-label="Timebase: seconds across the screen"
	/>
{/if}

<!--
	One temperature for the drawing, because that is the question people
	ask of a circuit: does it still work in a cold car, or inside a hot
	enclosure. Every junction drop, every gain and every resistor moves
	with it.
-->
<UnitField
	prefix="at"
	unit="°C"
	width="2.5rem"
	value={String(app.temperature)}
	commit={(text) => {
		const parsed = Number(text);
		if (text.trim() !== '' && Number.isFinite(parsed)) app.setTemperature(parsed);
	}}
	aria-label="Circuit temperature"
/>

<!--
	Only where it means something. On a purely analog drawing the family
	decides nothing, and a control that changes nothing is worse than no
	control: it invites the reader to believe it matters here.
-->
{#if hasDigital}
	<Select
		items={LOGIC_FAMILIES}
		value={app.logicFamily}
		onChange={(value) => app.setLogicFamily(value)}
		aria-label="Logic family"
		title="What a digital one and a digital zero are, in volts"
	/>
{/if}

<!--
	One sample says nothing; half a dozen say whether the corner of a
	filter is a property of the design or of the parts that happened to be
	in the drawer. So the button rerolls rather than toggling.
-->
<Button
	active={app.sample > 0}
	class="tabular-nums"
	onclick={() => app.setSample(app.sample > 0 ? app.sample + 1 : 1)}
	oncontextmenu={(e) => {
		e.preventDefault();
		app.setSample(0);
	}}
	title={app.sample > 0
		? `Sample #${app.sample} — click for another, right-click for nominal`
		: 'Draw every part from inside its tolerance instead of using its marking'}
>
	{app.sample > 0 ? `sample #${app.sample}` : 'nominal'}
</Button>

<!--
	One sample answers "does it work with these parts". This answers the
	question anyone actually has: does it work with the parts I am going
	to be sent.
-->
<Button
	active={app.sweepCount > 0}
	class="tabular-nums"
	onclick={() => app.setSweep(app.sweepCount > 0 ? 0 : 25)}
	title={app.sweepCount > 0
		? `Running ${app.sweepCount} samples and shading where they all went`
		: 'Run many samples and shade the band they cover'}
>
	{app.sweepCount > 0 ? `×${app.sweepCount}` : 'sweep'}
</Button>
