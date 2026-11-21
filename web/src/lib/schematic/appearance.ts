import type { Schematic } from './model';

/**
 * Everything printed beside the parts that an edit can change in place:
 * each part's name and the values its label is written from.
 *
 * The canvas repaints when the drawing is replaced, but an inspector edit
 * sets one value on the part that is already there, and nothing about the
 * part's shape or position moves. Read inside the repaint effect, this is
 * what makes such an edit a reason to repaint: without it a resistor set to
 * 2.2 kΩ in the inspector kept saying 1 kΩ on the drawing until something
 * else — a zoom, a click — happened to repaint it.
 *
 * Positions are left out on purpose. A drag changes them every frame, and
 * the index rebuild already repaints for that.
 */
export function drawnText(schematic: Schematic): string {
	let text = '';
	for (const instance of schematic.instances) {
		text += `${instance.id}\u0000${instance.name}`;
		for (const key in instance.params) text += `\u0000${key}=${instance.params[key]}`;
		text += '\u0001';
	}
	return text;
}
