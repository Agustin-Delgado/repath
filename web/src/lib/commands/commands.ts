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
	// While a run locks the drawing, the edits are left out of the list.
	const editing = () => !app.locked;
	const hasSelection = () => editing() && app.selection.length > 0;

	const commands: Command[] = [
		// --- Simulation -------------------------------------------------------
		{
			id: 'run',
			label: 'Run',
			group: 'Simulation',
			keywords: ['start', 'simulate', 'play', 'sweep'],
			available: () => !app.playing && !app.running,
			// Space starts a run only when there is no stopped one to pick up:
			// with one, it resumes, which is not what this command does.
			get shortcut() {
				return app.acquiring ? undefined : 'Space';
			},
			run: () => void app.run()
		},
		{
			id: 'stop',
			label: 'Stop',
			group: 'Simulation',
			keywords: ['pause', 'freeze', 'halt'],
			shortcut: 'Space',
			available: () => app.playing,
			run: () => app.stop()
		},
		{
			id: 'single',
			label: 'Single sweep',
			group: 'Simulation',
			keywords: ['once', 'one shot', 'trigger'],
			available: () => app.analysis === 'transient',
			run: () => app.single()
		},
		{
			id: 'reset',
			label: 'Reset run',
			group: 'Simulation',
			keywords: ['clear results', 'discard', 'rest'],
			run: () => app.reset()
		},
		{
			id: 'analysis-transient',
			label: 'Transient analysis',
			group: 'Simulation',
			keywords: ['time domain', 'scope', 'waveform'],
			available: () => app.analysis !== 'transient',
			run: () => app.setAnalysis('transient')
		},
		{
			id: 'analysis-frequency',
			label: 'Frequency analysis (Bode plot)',
			group: 'Simulation',
			keywords: ['ac', 'bode', 'frequency response', 'filter', 'gain', 'phase'],
			available: () => app.analysis !== 'frequency',
			run: () => app.setAnalysis('frequency')
		},
		{
			id: 'analysis-dc',
			label: 'DC sweep (I-V curve)',
			group: 'Simulation',
			keywords: ['dc', 'operating point', 'iv', 'i-v', 'curve', 'transfer', 'characteristic'],
			available: () => app.analysis !== 'dc',
			run: () => app.setAnalysis('dc')
		},
		{
			id: 'sample',
			label: 'Sample part values from tolerance',
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
			label: 'Monte Carlo: run many samples',
			group: 'Simulation',
			keywords: ['monte carlo', 'tolerance', 'envelope', 'worst case'],
			available: () => app.sweepCount === 0,
			run: () => app.setSweep(25)
		},
		{
			id: 'sweep-off',
			label: 'Stop Monte Carlo',
			group: 'Simulation',
			keywords: ['monte carlo', 'envelope'],
			available: () => app.sweepCount > 0,
			run: () => app.setSweep(0)
		},

		// --- Edit -------------------------------------------------------------
		{ id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', available: editing, run: () => app.undo() },
		{
			id: 'redo',
			label: 'Redo',
			group: 'Edit',
			shortcut: 'Ctrl+Shift+Z',
			available: editing,
			run: () => app.redo()
		},
		{
			id: 'rotate',
			label: 'Rotate selection',
			group: 'Edit',
			shortcut: 'R',
			keywords: ['turn', 'orientation'],
			available: hasSelection,
			run: () => app.rotateSelection()
		},
		{
			id: 'duplicate',
			label: 'Duplicate selection',
			group: 'Edit',
			shortcut: 'Ctrl+D',
			keywords: ['copy', 'clone'],
			available: hasSelection,
			run: () => app.duplicateSelection()
		},
		{
			id: 'delete',
			label: 'Delete selection',
			group: 'Edit',
			shortcut: 'Del',
			keywords: ['remove', 'erase'],
			available: hasSelection,
			run: () => app.deleteSelection()
		},
		{
			id: 'group',
			label: 'Group selection',
			group: 'Edit',
			shortcut: 'Ctrl+G',
			available: () => editing() && app.selection.length > 1,
			run: () => void app.groupSelection()
		},
		{
			id: 'box',
			label: 'Box selection as a block',
			group: 'Edit',
			shortcut: 'B',
			keywords: ['subcircuit', 'hierarchy', 'module', 'block'],
			available: hasSelection,
			run: () => void app.boxSelection()
		},
		{
			id: 'leave-block',
			label: 'Leave block',
			group: 'Edit',
			keywords: ['up', 'parent', 'exit'],
			available: () => !!app.inside,
			run: () => app.leaveBlock()
		},
		{
			id: 'clear',
			label: 'Clear circuit',
			group: 'Edit',
			keywords: ['new', 'empty', 'blank', 'start over'],
			available: () => app.schematic.instances.length > 0 || app.schematic.wires.length > 0,
			run: () => clearAndReport(app)
		},
		{
			id: 'probe-all',
			label: 'Auto-probe nets',
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
			available: editing,
			run: () => (app.tool = { mode: 'wire' })
		},

		// --- View -------------------------------------------------------------
		{
			id: 'fit',
			label: 'Fit circuit to screen',
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
			label: 'Show current flow',
			group: 'View',
			keywords: ['animation', 'dots', 'flow'],
			available: () => !app.showCurrent,
			run: () => (app.showCurrent = true)
		},
		{
			id: 'current-off',
			label: 'Hide current flow',
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
				label: `Symbols: ${standard.label}`,
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
			label: 'Save to file',
			group: 'File',
			shortcut: 'Ctrl+S',
			keywords: ['download', 'export', 'json'],
			run: () => saveToFile(app)
		},
		{
			id: 'open',
			label: 'Open file…',
			group: 'File',
			shortcut: 'Ctrl+O',
			keywords: ['load', 'import', 'json'],
			run: () => openFromFile(app)
		},
		{
			id: 'share',
			label: 'Copy link',
			group: 'File',
			keywords: ['share', 'url', 'send'],
			run: () => void shareAndReport(app, context.share)
		},
		{
			id: 'steps',
			label: 'Copy edit steps',
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

/**
 * Where the highlight is in `keys`: on the row it was put on, wherever that
 * row has moved to, or on the first row when it has gone or was never set.
 */
export function keepHighlight(keys: readonly string[], key: string | null): number {
	if (key === null) return 0;
	const index = keys.indexOf(key);
	return index < 0 ? 0 : index;
}
