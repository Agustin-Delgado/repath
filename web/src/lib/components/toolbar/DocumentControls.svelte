<script lang="ts">
	import { FileDown, FolderOpen, ListOrdered, Redo2, Share2, Undo2 } from '@lucide/svelte';
	import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, Select, ToolbarSeparator } from '$lib/ui';
	import { EXAMPLES } from '$lib/examples';
	import { SYMBOL_STANDARDS } from '$lib/schematic/symbols';
	import { app } from '$lib/state.svelte';

	type Props = {
		/**
		 * Put the circuit in a link and copy it. The page does this rather than
		 * the toolbar, because the draft that is being autosaved has to learn
		 * that it now continues the link. Rejects when the clipboard refuses.
		 */
		share: () => Promise<void>;
	};

	let { share }: Props = $props();

	/** A word of feedback shown for a moment on the button that caused it. */
	let shareFlash = $state('');
	let fileFlash = $state('');
	let fileInput = $state<HTMLInputElement | null>(null);

	function flash(set: (text: string) => void, text: string) {
		set(text);
		setTimeout(() => set(''), 2500);
	}

	async function onShare() {
		try {
			await share();
			flash((t) => (shareFlash = t), 'Copied');
		} catch {
			// Clipboard access can be refused; the URL bar still holds the link.
			flash((t) => (shareFlash = t), 'In the URL bar');
		}
	}

	/**
	 * Hand over what has been done here, as text.
	 *
	 * A share link carries the circuit; this carries the *route* to it, which for
	 * anything involving a drag is the part that is hard to describe and easy to
	 * get wrong when it is described. Paste it into a bug report and the exact
	 * sequence can be replayed rather than guessed at.
	 */
	async function copyTrace() {
		const text = app.trace.toText();
		if (!text) {
			app.notice = 'Nothing has been done yet, so there is nothing to hand over.';
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
			flash((t) => (fileFlash = t), `Copied ${app.trace.steps.length} steps`);
		} catch {
			app.notice = text;
		}
	}

	function save() {
		const blob = new Blob([app.toJSON()], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'circuit.repath.json';
		link.click();
		// After the click has been dispatched, not during it. Revoking inside the
		// same turn is a race the common browsers happen to win and Safari does
		// not, and losing it means the Save button doing nothing at all.
		setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	async function load(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			app.fromJSON(await file.text());
			app.run();
		} catch (cause) {
			app.notice = cause instanceof Error ? cause.message : String(cause);
		}
		input.value = '';
	}
</script>

<Button variant="ghost" size="icon" onclick={() => app.undo()} title="Undo (Ctrl+Z)" aria-label="Undo">
	<Undo2 />
</Button>
<Button
	variant="ghost"
	size="icon"
	onclick={() => app.redo()}
	title="Redo (Ctrl+Shift+Z)"
	aria-label="Redo"
>
	<Redo2 />
</Button>

<ToolbarSeparator />

<!--
	How the symbols are drawn, which is the reader's habit rather than a
	property of the circuit: not shared, not saved with the drawing.
-->
<Select
	items={SYMBOL_STANDARDS}
	value={app.symbolStandard}
	onChange={(value) => app.setSymbolStandard(value)}
	aria-label="Symbol standard"
	title="How the parts are drawn: zigzag or box resistors, shaped or boxed gates"
/>

<!--
	A menu of things to open, not a select: nothing in it is "the current
	example" once the drawing has been touched, and loading one replaces the
	drawing, which is an action rather than a setting.
-->
<Menu label="Examples" title="Open a circuit that shows something off">
	<MenuLabel>Examples</MenuLabel>
	{#each EXAMPLES as example (example.id)}
		<MenuItem
			textValue={example.name}
			title={example.description}
			onAction={() => {
				app.loadExample(example.id);
				app.run();
			}}
		>
			{example.name}
		</MenuItem>
	{/each}
</Menu>

<Menu label={fileFlash || 'File'} title="Save, open, or hand over this circuit">
	<MenuItem onAction={save}><FileDown /> Save to a file</MenuItem>
	<MenuItem onAction={() => fileInput?.click()}><FolderOpen /> Open a file…</MenuItem>
	<MenuSeparator />
	<MenuItem onAction={copyTrace} title="Copy every step taken here, as text, so it can be replayed">
		<ListOrdered /> Copy the steps taken
	</MenuItem>
</Menu>
<input bind:this={fileInput} type="file" accept="application/json,.json" onchange={load} hidden />

<Button onclick={onShare} title="Copy a link that contains this circuit">
	{#if shareFlash}{shareFlash}{:else}<Share2 /> Share{/if}
</Button>
