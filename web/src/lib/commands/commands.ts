import { clearAndReport, copyStepsAndReport, openFromFile, saveToFile, shareAndReport } from '$lib/document';
import { EXAMPLES, exampleDomain } from '$lib/examples';
import { SYMBOL_STANDARDS } from '$lib/schematic/symbols';
import type { App } from '$lib/state.svelte';

/**
 * Everything the app can be told to do, by name.
 *
 * The command palette lists these, and the shortcut written on one is the
 * same one the keyboard answers to — so the palette is also where somebody
 * learns the keys. The buttons around the screen are the common subset; this
 * is the whole of it, which is what keeps growing.
 */
export interface Command {
	id: string;
	label: string;
	group: string;
	/** As written on the key caps, for display: "Ctrl+Z". */
	shortcut?: string;
	keywords?: readonly string[];
	/** One line under the label. */
	description?: string;
	/** Whether it makes sense right now; the palette leaves out the ones that do not. */
	available?: () => boolean;
	run: () => void;
}

/** What only the page can do, handed in by it. */
export interface CommandContext {
	share: () => Promise<string>;
	fitToContent: () => void;
}

export function buildCommands(app: App, context: CommandContext): Command[] {
	const hasSelection = () => app.selection.length > 0;

	const commands: Command[] = [
		// --- Simulation -------------------------------------------------------
		{
			id: 'run',
			label: 'Run',
			group: 'Simulation',
			keywords: ['start', 'simulate', 'play', 'sweep'],
			available: () => !app.playing && !app.running,
			run: () => void app.run()
		},
		{
			id: 'stop',
			label: 'Stop',
			group: 'Simulation',
			keywords: ['pause', 'freeze', 'halt'],
			available: () => app.playing,
			run: () => app.stop()
		},
		{
			id: 'single',
			label: 'Capture a single sweep',
			group: 'Simulation',
			keywords: ['once', 'one shot', 'trigger'],
			available: () => app.analysis === 'transient',
			run: () => app.single()
		},
		{
			id: 'reset',
			label: 'Reset the run',
			group: 'Simulation',
			keywords: ['clear results', 'discard', 'rest'],
			run: () => app.reset()
		},
		{
			id: 'analysis-transient',
			label: 'Analyse over time (transient)',
			group: 'Simulation',
			keywords: ['time domain', 'scope', 'waveform'],
			available: () => app.analysis !== 'transient',
			run: () => app.setAnalysis('transient')
		},
		{
			id: 'analysis-frequency',
			label: 'Analyse over frequency (Bode plot)',
			group: 'Simulation',
			keywords: ['ac', 'bode', 'frequency response', 'filter', 'gain', 'phase'],
			available: () => app.analysis !== 'frequency',
			run: () => app.setAnalysis('frequency')
		},
		{
			id: 'sample',
			label: 'Draw parts from their tolerance',
			group: 'Simulation',
			keywords: ['monte carlo', 'tolerance', 'random', 'sample'],
			run: () => app.setSample(app.sample > 0 ? app.sample + 1 : 1)
		},
		{
			id: 'nominal',
			label: 'Use nominal part values',
			group: 'Simulation',
			keywords: ['tolerance', 'exact'],
			available: () => app.sample > 0,
			run: () => app.setSample(0)
		},
		{
			id: 'sweep',
			label: 'Run many samples and shade the band',
			group: 'Simulation',
			keywords: ['monte carlo', 'tolerance', 'envelope', 'worst case'],
			available: () => app.sweepCount === 0,
			run: () => app.setSweep(25)
		},
		{
			id: 'sweep-off',
			label: 'Stop sampling many parts',
			group: 'Simulation',
			keywords: ['monte carlo', 'envelope'],
			available: () => app.sweepCount > 0,
			run: () => app.setSweep(0)
		},

		// --- Edit -------------------------------------------------------------
		{ id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', run: () => app.undo() },
		{ id: 'redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Shift+Z', run: () => app.redo() },
		{
			id: 'rotate',
			label: 'Rotate the selection',
			group: 'Edit',
			shortcut: 'R',
			keywords: ['turn', 'orientation'],
			available: hasSelection,
			run: () => app.rotateSelection()
		},
		{
			id: 'duplicate',
			label: 'Duplicate the selection',
			group: 'Edit',
			shortcut: 'Ctrl+D',
			keywords: ['copy', 'clone'],
			available: hasSelection,
			run: () => app.duplicateSelection()
		},
		{
			id: 'delete',
			label: 'Delete the selection',
			group: 'Edit',
			shortcut: 'Del',
			keywords: ['remove', 'erase'],
			available: hasSelection,
			run: () => app.deleteSelection()
		},
		{
			id: 'group',
			label: 'Group the selection',
			group: 'Edit',
			shortcut: 'Ctrl+G',
			available: () => app.selection.length > 1,
			run: () => void app.groupSelection()
		},
		{
			id: 'box',
			label: 'Box the selection up as a block',
			group: 'Edit',
			shortcut: 'B',
			keywords: ['subcircuit', 'hierarchy', 'module', 'block'],
			available: hasSelection,
			run: () => void app.boxSelection()
		},
		{
			id: 'leave-block',
			label: 'Leave the block',
			group: 'Edit',
			keywords: ['up', 'parent', 'exit'],
			available: () => !!app.inside,
			run: () => app.leaveBlock()
		},
		{
			id: 'clear',
			label: 'Clear the drawing',
			group: 'Edit',
			keywords: ['new', 'empty', 'blank', 'start over'],
			available: () => app.schematic.instances.length > 0 || app.schematic.wires.length > 0,
			run: () => clearAndReport(app)
		},
		{
			id: 'probe-all',
			label: 'Probe the interesting nets',
			group: 'Edit',
			keywords: ['scope', 'measure', 'signals', 'auto'],
			run: () => app.autoProbe()
		},

		{
			id: 'wire',
			label: 'Draw a wire',
			group: 'Edit',
			shortcut: 'W',
			keywords: ['connect', 'net', 'branch'],
			run: () => (app.tool = { mode: 'wire' })
		},

		// --- View -------------------------------------------------------------
		{
			id: 'fit',
			label: 'Fit the drawing on screen',
			group: 'View',
			shortcut: 'F',
			keywords: ['zoom', 'center', 'frame'],
			run: context.fitToContent
		},
		{
			id: 'voltage',
			label: 'Show voltage on wires',
			group: 'View',
			keywords: ['colour', 'color', 'overlay'],
			available: () => !app.showVoltage,
			run: () => (app.showVoltage = true)
		},
		{
			id: 'voltage-off',
			label: 'Hide voltage on wires',
			group: 'View',
			keywords: ['colour', 'color', 'overlay'],
			available: () => app.showVoltage,
			run: () => (app.showVoltage = false)
		},
		{
			id: 'current',
			label: 'Show current flowing',
			group: 'View',
			keywords: ['animation', 'dots', 'flow'],
			available: () => !app.showCurrent,
			run: () => (app.showCurrent = true)
		},
		{
			id: 'current-off',
			label: 'Hide current flowing',
			group: 'View',
			keywords: ['animation', 'dots', 'flow'],
			available: () => app.showCurrent,
			run: () => (app.showCurrent = false)
		},
		{
			id: 'values',
			label: app.showValues ? 'Hide live values' : 'Show live values',
			group: 'View',
			keywords: ['readings', 'numbers', 'labels'],
			run: () => (app.showValues = !app.showValues)
		},
		...SYMBOL_STANDARDS.map(
			(standard): Command => ({
				id: `standard-${standard.value}`,
				label: `Draw symbols as ${standard.label}`,
				group: 'View',
				keywords: ['symbol', 'standard'],
				description: standard.description,
				available: () => app.symbolStandard !== standard.value,
				run: () => app.setSymbolStandard(standard.value)
			})
		),

		// --- File -------------------------------------------------------------
		{
			id: 'save',
			label: 'Save to a file',
			group: 'File',
			shortcut: 'Ctrl+S',
			keywords: ['download', 'export', 'json'],
			run: () => saveToFile(app)
		},
		{
			id: 'open',
			label: 'Open a file…',
			group: 'File',
			shortcut: 'Ctrl+O',
			keywords: ['load', 'import', 'json'],
			run: () => openFromFile(app)
		},
		{
			id: 'share',
			label: 'Copy a link to this circuit',
			group: 'File',
			keywords: ['share', 'url', 'send'],
			run: () => void shareAndReport(app, context.share)
		},
		{
			id: 'steps',
			label: 'Copy the steps taken',
			group: 'File',
			keywords: ['trace', 'bug report', 'replay'],
			run: () => void copyStepsAndReport(app)
		},

		// --- Examples ---------------------------------------------------------
		...EXAMPLES.map(
			(example): Command => ({
				id: `example-${example.id}`,
				label: example.name,
				group: 'Examples',
				keywords: ['example', 'demo', exampleDomain(example)],
				description: example.description,
				run: () => {
					app.loadExample(example.id);
					void app.run();
				}
			})
		)
	];

	return commands;
}
