<script lang="ts">
	/**
	 * Draws one component's symbol at the origin, unrotated. The caller applies
	 * the transform, so labels can stay upright while the body turns.
	 */
	interface Props {
		kind: string;
		params?: Record<string, number | string>;
	}

	let { kind, params = {} }: Props = $props();

	const diodeKind = $derived(String(params.model ?? 'silicon'));
	const sourceWave = $derived(String(params.waveform ?? 'dc'));
</script>

{#if kind === 'resistor'}
	<path d="M-30 0 H-18" />
	<rect x="-18" y="-7" width="36" height="14" fill="none" />
	<path d="M18 0 H30" />
{:else if kind === 'capacitor'}
	<path d="M-30 0 H-5 M-5 -12 V12 M5 -12 V12 M5 0 H30" />
{:else if kind === 'inductor'}
	<path d="M-30 0 H-18" />
	<path
		d="M-18 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 1 9 0"
		fill="none"
	/>
	<path d="M18 0 H30" />
{:else if kind === 'ground'}
	<path d="M0 -10 V0 M-11 0 H11 M-7 4 H7 M-3 8 H3" />
{:else if kind === 'vsource'}
	<path d="M0 -30 V-16 M0 16 V30" />
	<circle cx="0" cy="0" r="16" fill="none" />
	{#if sourceWave === 'sine'}
		<path d="M-9 0 a4.5 4.5 0 0 1 9 0 a4.5 4.5 0 0 0 9 0" fill="none" />
	{:else if sourceWave === 'pulse'}
		<path d="M-10 5 H-5 V-5 H2 V5 H8 V-5 H10" fill="none" />
	{:else}
		<path d="M-5 -6 H5 M0 -11 V-1 M-5 7 H5" />
	{/if}
{:else if kind === 'isource'}
	<path d="M0 -30 V-16 M0 16 V30" />
	<circle cx="0" cy="0" r="16" fill="none" />
	<path d="M0 9 V-9 M-5 -4 L0 -9 L5 -4" fill="none" />
{:else if kind === 'diode'}
	<path d="M-30 0 H-8" />
	<path d="M-8 -9 L-8 9 L8 0 Z" class="filled" />
	{#if diodeKind === 'zener'}
		<path d="M8 -9 H3 M8 -9 V9 M8 9 H13" fill="none" />
	{:else}
		<path d="M8 -9 V9" />
	{/if}
	<path d="M8 0 H30" />
	{#if diodeKind === 'led'}
		<path d="M2 -14 L10 -22 M6 -22 H10 V-18" fill="none" />
		<path d="M8 -11 L16 -19 M12 -19 H16 V-15" fill="none" />
	{/if}
{:else if kind === 'nmos' || kind === 'pmos'}
	{@const flip = kind === 'pmos' ? -1 : 1}
	<path d="M-30 0 H-16 M-16 -14 V14" />
	<path d="M-8 -14 V-5 M-8 -4 V4 M-8 5 V14" />
	<path d="M-8 -11 H10 M10 -11 V{-30 * 1} M-8 11 H10 M10 11 V30" />
	<path d="M-8 0 H10" />
	{#if flip === 1}
		<path d="M0 0 L-6 -4 L-6 4 Z" class="filled" />
	{:else}
		<path d="M-8 0 L-2 -4 L-2 4 Z" class="filled" />
	{/if}
{:else if kind === 'npn' || kind === 'pnp'}
	<path d="M-30 0 H-12 M-12 -15 V15" />
	<path d="M-12 -7 L10 -20 M10 -20 V-30" fill="none" />
	<path d="M-12 7 L10 20 M10 20 V30" fill="none" />
	{#if kind === 'npn'}
		<path d="M10 20 L1 18 L5 11 Z" class="filled" />
	{:else}
		<path d="M-12 7 L-3 9 L-7 16 Z" class="filled" />
	{/if}
{:else if kind === 'opamp'}
	<path d="M-30 -10 H-20 M-30 10 H-20 M24 0 H30" />
	<path d="M-20 -22 L-20 22 L24 0 Z" fill="none" />
	<path d="M-16 -13 H-9 M-12.5 -16.5 V-9.5" />
	<path d="M-16 10 H-9" />
{:else if kind === 'and' || kind === 'nand'}
	<path d="M-30 -10 H-18 M-30 10 H-18 M{kind === 'nand' ? 26 : 20} 0 H30" />
	<path d="M-18 -18 H0 A18 18 0 0 1 0 18 H-18 Z" fill="none" />
	{#if kind === 'nand'}<circle cx="23" cy="0" r="3.5" fill="none" />{/if}
{:else if kind === 'or' || kind === 'nor' || kind === 'xor'}
	<path d="M-30 -10 H-16 M-30 10 H-16 M{kind === 'nor' ? 26 : 20} 0 H30" />
	<path d="M-20 -18 Q-6 0 -20 18 Q6 18 20 0 Q6 -18 -20 -18 Z" fill="none" />
	{#if kind === 'xor'}<path d="M-26 -18 Q-12 0 -26 18" fill="none" />{/if}
	{#if kind === 'nor'}<circle cx="23" cy="0" r="3.5" fill="none" />{/if}
{:else if kind === 'not'}
	<path d="M-30 0 H-14 M22 0 H30" />
	<path d="M-14 -16 L14 0 L-14 16 Z" fill="none" />
	<circle cx="18" cy="0" r="3.5" fill="none" />
{:else if kind === 'dff'}
	<path d="M-30 -20 H-22 M-30 20 H-22 M22 -20 H30 M22 20 H30" />
	<rect x="-22" y="-32" width="44" height="64" fill="none" />
	<path d="M-22 14 L-14 20 L-22 26" fill="none" />
	<text x="-17" y="-16" class="pin-label">D</text>
	<text x="17" y="-16" class="pin-label end">Q</text>
	<text x="17" y="24" class="pin-label end">Q̅</text>
{:else if kind === 'clock'}
	<path d="M22 0 H30" />
	<rect x="-22" y="-16" width="44" height="32" fill="none" />
	<path d="M-14 6 H-8 V-6 H0 V6 H8 V-6 H14" fill="none" />
{:else}
	<rect x="-20" y="-20" width="40" height="40" fill="none" />
	<text x="0" y="4" class="pin-label mid">?</text>
{/if}

<style>
	path,
	rect,
	circle {
		stroke: var(--symbol-stroke, #d8dee9);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		fill: none;
		vector-effect: non-scaling-stroke;
	}

	.filled {
		fill: var(--symbol-stroke, #d8dee9);
	}

	.pin-label {
		font-size: 11px;
		font-family: inherit;
		fill: var(--symbol-stroke, #d8dee9);
		stroke: none;
		opacity: 0.75;
	}

	.pin-label.end {
		text-anchor: end;
	}

	.pin-label.mid {
		text-anchor: middle;
	}
</style>
