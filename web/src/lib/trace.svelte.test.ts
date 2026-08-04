/**
 * Recording what was done, and doing it again.
 *
 * The point of a trace is that a reported problem can be reproduced instead of
 * guessed at, so the test that matters is the round trip: perform a session,
 * write it down, hand the text to a fresh editor, and end up with the same
 * drawing. Anything less — a log that reads plausibly but replays into something
 * else — would be worse than no log at all, because it would be trusted.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { app } from './state.svelte';
import { parseTrace, Trace, wireRef } from './trace';
import { routeWire } from './schematic/route';
import type { Point } from './schematic/model';

const route = (from: Point, to: Point, settling: ReadonlySet<string>, prefer?: readonly Point[]) =>
	routeWire(app.schematic, from, to, { grid: 10, ignoreWires: settling, prefer, effort: 4000 });

const drawing = () =>
	JSON.stringify({
		parts: app.schematic.instances
			.map((i) => `${i.name} ${i.kind} ${i.x},${i.y} ${i.rotation} ${JSON.stringify(i.params)}`)
			.sort(),
		wires: app.schematic.wires.map((w) => w.points.map((p) => `${p.x},${p.y}`).join(' ')).sort()
	});

const find = (name: string) => app.schematic.instances.find((i) => i.name === name)!;

function drag(name: string, dx: number, dy: number) {
	app.selection = [find(name).id];
	app.beginMove();
	app.applyMove(dx, dy, route);
	app.endMove();
}

beforeEach(() => {
	app.clear();
	app.selection = [];
});

describe('a recorded session', () => {
	it('replays into the same drawing', () => {
		app.loadExample('rc-lowpass');
		drag('C1', 60, 0);
		app.setParam(find('R1').id, 'resistance', 330);
		app.place('led', 500, 300, 90);
		drag('GND1', 0, 40);
		app.rename(find('R1').id, 'RLOAD');

		const text = app.trace.toText();
		const expected = drawing();

		// A different editor, told only what was done.
		app.clear();
		const outcome = app.replay(parseTrace(text), route);

		expect(outcome.failed).toBeUndefined();
		expect(drawing()).toBe(expected);
	});

	it('survives being written out and read back', () => {
		app.loadExample('rc-lowpass');
		drag('C1', 30, -20);
		app.rotateSelection(route);

		const once = app.trace.toText();
		const twice = (() => {
			app.clear();
			app.replay(parseTrace(once), route);
			return app.trace.toText();
		})();

		// Replaying a trace produces the same trace, which is what makes one safe to
		// pass along: whoever receives it is running the session that was recorded.
		expect(twice).toBe(once);
	});

	it('reads as something a person can follow', () => {
		app.loadExample('rc-lowpass');
		app.place('led', 300, 400, 90);
		drag('D1', 0, -20);
		app.setParam(find('D1').id, 'colour', 'blue');

		expect(app.trace.toText().split('\n')).toEqual([
			'example rc-lowpass',
			'place led 300 400 90',
			'move D1 - 0 -20',
			'param D1 colour blue'
		]);
	});

	it('starts again when the whole drawing is replaced', () => {
		app.place('resistor', 100, 100, 0);
		app.loadExample('rc-lowpass');
		// Steps against a circuit that has been thrown away would replay into
		// nothing, and reading them would only mislead.
		expect(app.trace.toText().split('\n')[0]).toBe('example rc-lowpass');
		expect(app.trace.steps).toHaveLength(1);
	});

	it('writes one line for a drag, not one per frame', () => {
		app.loadExample('rc-lowpass');
		app.selection = [find('C1').id];
		app.beginMove();
		for (let step = 10; step <= 60; step += 10) app.applyMove(step, 0, route);
		app.endMove();

		expect(app.trace.steps.filter((s) => s.op === 'move')).toEqual([
			{ op: 'move', parts: ['C1'], wires: [], dx: 60, dy: 0 }
		]);
	});

	it('writes nothing for a drag that was called off', () => {
		app.loadExample('rc-lowpass');
		const before = app.trace.steps.length;
		app.selection = [find('C1').id];
		app.beginMove();
		app.applyMove(40, 0, route);
		app.cancelMove();
		expect(app.trace.steps).toHaveLength(before);
	});

	it('says where it lost the thread rather than carrying on', () => {
		// A step naming something absent means the replay had already diverged, and
		// the steps after it would be acting on a different drawing.
		app.clear();
		const outcome = app.replay(parseTrace('move R9 - 10 0\nplace resistor 0 0 0'), route);

		expect(outcome.done).toBe(0);
		expect(outcome.failed).toMatch(/R9/);
		expect(app.schematic.instances).toHaveLength(0);
	});

	it('refuses a line it cannot read, and says which', () => {
		expect(() => parseTrace('example rc-lowpass\nwiggle the thing')).toThrow(/line 2/);
	});

	it('ignores blank lines and remarks', () => {
		const steps = parseTrace('# what I did\n\nexample rc-lowpass\n\n# then\nrun\n');
		expect(steps.map((s) => s.op)).toEqual(['example', 'run']);
	});
});

describe('naming wires', () => {
	it('refers to one by the ends it had, so a replay can find it again', () => {
		app.loadExample('rc-lowpass');
		const wire = app.schematic.wires[0];
		const ref = wireRef(wire.points);

		app.selection = [wire.id];
		app.beginMove();
		app.applyMove(0, 20, route);
		app.endMove();

		const move = app.trace.steps.find((s) => s.op === 'move');
		expect(move).toEqual({ op: 'move', parts: [], wires: [ref], dx: 0, dy: 20 });
	});
});

describe('a value with more than one line in it', () => {
	const CARD = '.MODEL 2N3904 NPN(IS=6.734f BF=416.4\n+ VAF=74.03 CJC=3.638p)';

	it('survives being written and read back', () => {
		// The format is one step per line, which held while every value was a
		// number. A pasted model card is not: written out as it stands, each of its
		// continuation lines becomes a step of its own, and replay stops at the
		// point where someone chose a part.
		const trace = new Trace();
		trace.record({ op: 'param', part: 'Q1', key: 'spice', value: CARD });
		const text = trace.toText();

		expect(text.split('\n').length).toBe(1);
		const [step] = parseTrace(text);
		expect(step).toEqual({ op: 'param', part: 'Q1', key: 'spice', value: CARD });
	});

	it('still reads a plain number as a number', () => {
		const trace = new Trace();
		trace.record({ op: 'param', part: 'R1', key: 'resistance', value: 330 });
		expect(parseTrace(trace.toText())[0]).toEqual({
			op: 'param',
			part: 'R1',
			key: 'resistance',
			value: 330
		});
	});
});

describe('replaying a session that imported a part', () => {
	it('creates the part before the step that places it', () => {
		// Found by replaying a trace in a process that had never imported the
		// definition — which is the only situation that matters, since it is what
		// happens when someone opens a stranger's trace. `import` was not a case in
		// the replay switch, so it was skipped in silence, and the `place` after it
		// threw `unknown component kind` out of `replay` altogether.
		const text = [
			'clear',
			String.raw`import .SUBCKT TRACEONLY a b\nR1 a b 4k7\n.ENDS`,
			'place x:traceonly 300 200 0'
		].join('\n');

		expect(app.replay(parseTrace(text), route)).toEqual({ done: 3 });
		expect(app.schematic.instances.map((i) => i.kind)).toEqual(['x:traceonly']);
		expect(app.schematic.subcircuits?.[0].name).toBe('TRACEONLY');
	});

	it('stops with a reason when it names a part this editor does not have', () => {
		// A refusal, not an exception. Replay is a debugging tool: it has to be able
		// to say where it got to.
		const outcome = app.replay(parseTrace('clear\nplace x:missing 0 0 0'), route);
		expect(outcome.failed).toBeTruthy();
		expect(outcome.failed).toContain('x:missing');
	});
});
