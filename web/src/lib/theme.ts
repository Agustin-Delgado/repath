/**
 * The colours that TypeScript needs to know by value.
 *
 * Everything else about the look — spacing, type, radii, elevation, motion —
 * lives in `app.css` as custom properties, and the canvases read those at run
 * time. What is here is what has to exist before there is a stylesheet to read
 * (the painter's fallback, used by tests and the first frame) or what is handed
 * out as data rather than drawn from CSS (a probe's colour travels with it into
 * the scope, the legend and a saved file). A test holds every value here to its
 * twin in `app.css`, so the two cannot drift.
 */

/**
 * The canvas palette, as `app.css` defines it. `readTheme` in
 * `schematic/draw.ts` reads the live values and falls back to these.
 */
export const CANVAS_PALETTE = {
	background: '#0e1116',
	gridDot: '#232936',
	wire: '#8b96aa',
	symbol: '#cfd7e4',
	pin: '#6d7a8f',
	pinDigital: '#d09b4a',
	accent: '#4ea8ff',
	/**
	 * Yellow, and nothing else on the canvas is.
	 *
	 * It was orange before, which was the second trace colour *exactly* — so a
	 * selected wire and a probed one were the same shade. Yellow is clear of the
	 * traces, of the diverging voltage scale, of danger, and of the LED inks.
	 */
	selection: '#ffd400',
	labelStrong: '#cdd5e2',
	labelDim: '#8a93a6',
	danger: '#ff6b7a'
} as const;

/** The custom property each canvas colour is read from. */
export const CANVAS_TOKENS: Record<keyof typeof CANVAS_PALETTE, string> = {
	background: '--canvas-bg',
	gridDot: '--grid-dot',
	wire: '--wire',
	symbol: '--symbol',
	pin: '--pin',
	pinDigital: '--pin-digital',
	accent: '--accent',
	selection: '--selection',
	labelStrong: '--label-strong',
	labelDim: '--label-dim',
	danger: '--danger'
};

/**
 * Probe colours, in the order probes are given them.
 *
 * Chosen by search rather than by eye: every pair stays apart in OKLab under
 * normal vision and under simulated protanopia, deuteranopia and tritanopia,
 * the first four — the probes most drawings have — by the widest margin; every
 * one clears 4.5:1 against the canvas and the panels; and none comes near the
 * selection yellow or the grey of a wire and a symbol. The set this replaced
 * had a yellow a shade off the selection's, two oranges a hair apart, and a
 * green and a cyan that tritanopia made one colour.
 *
 * A trace is never told apart by colour alone — each has its name beside it in
 * the legend — but colour is what the eye goes to first.
 */
export const TRACE_COLOURS = [
	'#4ea8ff',
	'#fe5828',
	'#81fda0',
	'#f69a9d',
	'#cc7580',
	'#c9c510',
	'#43d0f9',
	'#a380c8'
] as const;
