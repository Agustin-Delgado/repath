<script lang="ts">
	/**
	 * SVG rendering of a component symbol, for the palette.
	 *
	 * The geometry itself lives in `schematic/symbols.ts` so the canvas editor
	 * draws exactly the same shapes. Keeping two copies in sync by hand is how
	 * symbols end up subtly different between the palette and the schematic.
	 */
	import { shapeToPathData, symbolGeometry } from '$lib/schematic/symbols';

	interface Props {
		kind: string;
		params?: Record<string, number | string>;
	}

	let { kind, params = {} }: Props = $props();

	const geometry = $derived(symbolGeometry(kind, params));

	/**
	 * An icon here is 46x34 pixels for a symbol drawn 80 units wide, so everything
	 * lands at about four tenths of its size. A chip's leg numbers and pin names
	 * come out three pixels tall at that scale: nothing to read, and a thousand
	 * text runs to rasterize on every scrolled frame once the palette holds a few
	 * dozen chips. They are drawn on the schematic, where they are legible.
	 */
	const labels = $derived(geometry.labels.filter((label) => !label.fine));
</script>

{#each geometry.shapes as shape, i (i)}
	<path d={shapeToPathData(shape)} class:filled={shape.fill} />
{/each}

{#each labels as label, i (i)}
	<text
		x={label.x}
		y={label.y}
		class="pin-label"
		text-anchor={label.anchor ?? 'middle'}
		font-size={label.size ?? 11}>{label.text}</text
	>
{/each}

<style>
	path {
		stroke: var(--symbol-stroke, #d8dee9);
		stroke-width: 1;
		stroke-linecap: round;
		stroke-linejoin: round;
		fill: none;
		vector-effect: non-scaling-stroke;
	}

	.filled {
		fill: var(--symbol-stroke, #d8dee9);
	}

	.pin-label {
		font-family: inherit;
		fill: var(--symbol-stroke, #d8dee9);
		stroke: none;
		opacity: 0.75;
		dominant-baseline: middle;
	}
</style>
