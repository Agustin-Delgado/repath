<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		--font-mono: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;

		--bg: #12151c;
		--panel-bg: #171b24;
		--canvas-bg: #0e1116;
		--border: #262c38;
		--hover: #1f2531;
		--control-bg: #1b202a;

		--text: #e3e8f0;
		--label-strong: #cdd5e2;
		--label-dim: #7c8496;

		--symbol: #cfd7e4;
		--wire: #8b96aa;
		--pin: #6d7a8f;
		--pin-digital: #d09b4a;
		--grid-dot: #232936;
		--grid-line: #1e2430;

		--accent: #4ea8ff;
		--accent-text: #08111c;
		--selection: #ffb454;
		--danger: #ff6b7a;

		--scope-axis: #39414f;
		--scope-cursor: #7c8496;

		--badge-mixed: #3a2d4d;
		--badge-mixed-text: #c58bff;
		--badge-logic: #3a3221;
		--badge-logic-text: #ffb454;
	}

	:global(html),
	:global(body) {
		margin: 0;
		height: 100%;
		background: var(--bg);
		color: var(--text);
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			sans-serif;
		font-size: 14px;
		overscroll-behavior: none;
	}

	:global(*) {
		box-sizing: border-box;
	}

	:global(button) {
		font: inherit;
	}
</style>
