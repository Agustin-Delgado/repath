/**
 * Compiles a drawn schematic into the engine's netlist format.
 *
 * The interesting part is bridging. A net that carries both analog pins and
 * digital pins gets *both* an analog node and a digital net, plus the converters
 * between them — a digital-to-analog driver if anything digital drives the net,
 * an analog-to-digital receiver if anything digital listens to it. So wiring a
 * comparator output straight into a NAND gate does the right thing, with no
 * converter symbol to remember to place.
 */

import { contactControl, restingContact } from './contacts';
import { BARS, ledDiodeModel, ledRating, SEGMENTS } from './led';
import { blockOf, chipOf, pointKey } from './model';
import { unfoldBlocks } from './blocks';
import { DEFAULT_FAMILY, logicFamily } from './logic';
import { definitionFor, subcircuitOf, type Instance, type Schematic } from './model';
import {
	buildConnectivity,
	floatingLogicInputs,
	pinKey,
	type Connectivity,
	type Net
} from './nets';
import {
	bjtFromCard,
	cardFor,
	diodeFromCard,
	expandSubcircuit,
	mosfetFromCard,
	parseSubcircuits,
	portInjections,
	type ModelCard,
	type PortInjection
} from '../spice';

export interface NetNames {
	analog?: string;
	digital?: string;
	/**
	 * The digital net the inputs on this net read, where it is not `digital`.
	 *
	 * A net that is driven by a logic output, read by a logic input, and also
	 * wired to something analog is two things: what the output drives — which
	 * goes into the analog node through a bridge — and what the node has become
	 * after the analog side has had its say, which is what the input reads
	 * through a bridge the other way. With one digital net for both, the bridge
	 * reading the node back drove the same net the output was driving, and an
	 * LED that pulled the node down to its forward voltage had the net resolve
	 * to "unknown" — the output and its own echo disagreeing — rather than to
	 * what it was: high on the driving side, and not high enough to read on the
	 * other.
	 */
	readBack?: string;
}

export interface CompileResult {
	/** JSON accepted by the engine. `null` when `errors` is non-empty. */
	netlist: unknown | null;
	/** Net index -> the names it was given. */
	names: Map<number, NetNames>;
	/**
	 * Nets carrying a logic input that nothing holds at either rail, given which
	 * switches are closed at the instant being drawn.
	 *
	 * Their voltage is whatever leakage decided, which is not a measurement of
	 * anything — so the drawing shows them as undetermined rather than printing a
	 * number that looks exactly like a real one.
	 *
	 * A question about an instant rather than about the drawing, and that is the
	 * whole point of it: a node fed through a closed switch is being held, and
	 * labelling it "floating" while five volts sits on it is the same lie as
	 * printing a number for one that really is adrift. Pass an empty set for the
	 * worst case, which is what a drawing with no run behind it is showing.
	 */
	floatingAt: (closedSwitches: ReadonlySet<string>) => Set<number>;
	errors: string[];
	warnings: string[];
	connectivity: Connectivity;
	/**
	 * Where the current at each terminal of a placed subcircuit comes from.
	 *
	 * A subcircuit is flattened before the engine sees it, so there is no element
	 * by that name to ask: its current lives spread across `X1.R1`, `X1.Q1:b` and
	 * the rest. The drawing needs that spelled out or it has nothing to accumulate
	 * at those pins, and a net whose only part is an imported one animates as
	 * carrying nothing.
	 */
	portFlow: Map<string, PortInjection[]>;
}

function num(instance: Instance, key: string, fallback = 0): number {
	const raw = instance.params[key];
	const value = typeof raw === 'number' ? raw : Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function str(instance: Instance, key: string, fallback = ''): string {
	const raw = instance.params[key];
	return raw === undefined ? fallback : String(raw);
}

/** Translate the UI's simplified waveform controls into the engine's format. */
function waveform(instance: Instance): unknown {
	const kind = str(instance, 'waveform', 'dc');
	const amplitude = num(instance, 'value', 0);
	const offset = num(instance, 'offset', 0);
	const frequency = Math.max(num(instance, 'frequency', 1000), 1e-9);

	if (kind === 'sine') {
		// `delay` and `damping` the engine has and nothing here sets: a delayed or
		// decaying sine is a different waveform rather than a knob on this one.
		return {
			type: 'sine',
			offset,
			amplitude,
			frequency,
			delay: 0,
			damping: 0,
			phase: num(instance, 'phase', 0)
		};
	}
	if (kind === 'pulse') {
		const period = 1 / frequency;
		const duty = Math.min(Math.max(num(instance, 'duty', 0.5), 0.01), 0.99);
		const high = period * duty;
		// Fast but finite edges. Instantaneous ones are not physical and give the
		// transient loop nothing to land on.
		const edge = Math.min(period / 1000, high / 10);
		// The engine measures `width` from the top of the rising edge, so a duty
		// cycle handed over as-is came out long by one edge — a pulse asked to be
		// high half the time was high a little more than half.
		const width = Math.max(high - edge, edge);
		return {
			type: 'pulse',
			v1: offset,
			v2: offset + amplitude,
			delay: 0,
			rise: edge,
			fall: edge,
			width,
			period
		};
	}
	return { type: 'dc', value: amplitude };
}

/**
 * Fold a pasted `.model` card over what the part's own fields say.
 *
 * The card wins where the two overlap. Pasting one is an explicit statement that
 * *this* is the part, and a field that quietly outranked it would leave someone
 * looking at a 2N3904 that behaves like the generic transistor it replaced.
 *
 * What the card could not be used for goes back to the caller by name. A card
 * carries twenty-odd parameters and this engine models eight of them, and the
 * difference is not a rounding error — a 2N3904 without its `IKF` keeps its gain
 * at currents where the real one has lost most of it. Reporting it is the
 * difference between a simplification and a lie.
 */
function withCard(
	instance: Instance,
	base: Record<string, unknown>,
	fold: (card: ModelCard) => { model: Record<string, number>; ignored: string[] },
	report: (message: string) => void
): unknown {
	const card = cardFor(str(instance, 'spice', ''), instance.kind);
	if (!card) return base;

	const { model, ignored } = fold(card);
	if (ignored.length > 0) {
		report(
			`${instance.name}: ${card.name} sets ${ignored.join(', ')}, which this simulator does not model.`
		);
	}
	return { ...base, ...model };
}

/**
 * A diode built from its own fields rather than from which of two names it went
 * by.
 *
 * There is one diode equation, and a 1N4148, a Schottky and a germanium part are
 * the same device with different numbers in it. The preset on the part fills
 * those numbers in; from there they are the part, so anything on the market can
 * be described without waiting for it to be added to a list.
 */
function diodeModel(instance: Instance): Record<string, unknown> {
	const kind = str(instance, 'model', 'silicon');
	return {
		is: num(instance, 'is', 2.52e-9),
		n: num(instance, 'n', 1.752),
		rs: num(instance, 'rs', 0.568),
		cj0: num(instance, 'cj0', 4e-12),
		tt: num(instance, 'tt', 5e-9),
		bv: kind === 'zener' ? Math.abs(num(instance, 'breakdown', 5.1)) : null,
		temp: 300.15
	};
}


/**
 * A part's value, drawn from inside its tolerance band.
 *
 * A 1% resistor is a 1% resistor: the number printed on it is the middle of a
 * band, and a circuit that only works at the middle does not work. One run at
 * nominal can never say so, so this picks a value for each part and holds it
 * there for the whole run — a circuit built once out of real parts, not a
 * circuit whose values jitter as it goes.
 *
 * Deterministic in the seed and the part's *name*, so the same sample can be
 * re-run, shared in a link and quoted in a bug report. Not its id: those are
 * regenerated every time a document is opened or a link followed, which would
 * have made the one property this feature exists for — that a sample is a thing
 * you can hand to somebody — quietly false. Uniform across the band rather than
 * bell-shaped: a tolerance is a bound the manufacturer guarantees, and parts are
 * binned besides, so a normal distribution would be a more confident claim than
 * anyone has grounds for.
 */
function drawn(instance: Instance, key: string, nominal: number, seed: number): number {
	const percent = num(instance, 'tolerance', 0);
	if (!seed || percent <= 0) return nominal;

	// A small integer hash of the seed and this part's identity. Nothing
	// cryptographic is needed; it only has to be well-spread and repeatable.
	let h = (seed * 2654435761) >>> 0;
	for (const text of [instance.name, key]) {
		for (let i = 0; i < text.length; i++) {
			h = (Math.imul(h ^ text.charCodeAt(i), 16777619) + 1) >>> 0;
		}
	}
	const unit = (h >>> 8) / 0x1000000;
	return nominal * (1 + (percent / 100) * (unit * 2 - 1));
}

/**
 * Why a chip has no supply, or null when it has one.
 *
 * Its positive leg has to reach a source — a supply terminal or a voltage
 * source — and its negative leg the reference, each directly or through parts
 * that conduct at DC: a regulator's zener and resistor are a supply as far as
 * the chip can tell. Another chip is not a way through, or two unpowered chips
 * would vouch for each other. Deliberately forgiving past that: this is for
 * the leg left off, tied to the wrong rail or to its partner, not for judging
 * how good a supply is.
 */
function chipUnpowered(chip: Instance, schematic: Schematic, connectivity: Connectivity): string | null {
	const legs = definitionFor(chip).pins.map((pin) => pin.name);
	const positive = legs.find((pin) => pin === 'VCC' || pin === 'VDD');
	const negative = legs.find((pin) => pin === 'GND' || pin === 'VSS');
	if (!positive || !negative) return null;
	const netOf = (instance: Instance, pin: string) =>
		connectivity.netOfPin.get(pinKey(instance.id, pin));
	const high = netOf(chip, positive);
	const low = netOf(chip, negative);
	if (high === undefined) return `its ${positive} leg is not connected to anything.`;
	if (low === undefined) return `its ${negative} leg is not connected to anything.`;
	if (high === low) return `its ${positive} and ${negative} legs are on the same net.`;
	if (connectivity.nets[high].isGround) return `its ${positive} leg is on the ground net.`;

	const { through, sourced } = dcGraph(schematic, connectivity);
	const reaches = (from: number, found: (index: number) => boolean) => {
		const seen = new Set([from]);
		const queue = [from];
		while (queue.length > 0) {
			const at = queue.pop()!;
			if (found(at)) return true;
			for (const next of through.get(at) ?? []) {
				if (!seen.has(next)) {
					seen.add(next);
					queue.push(next);
				}
			}
		}
		return false;
	};
	if (!reaches(high, (index) => sourced.has(index) && !connectivity.nets[index].isGround)) {
		return `its ${positive} leg reaches no supply.`;
	}
	if (!reaches(low, (index) => connectivity.nets[index].isGround)) {
		return `its ${negative} leg does not reach ground.`;
	}
	return null;
}

/**
 * Nets joined through parts that conduct at DC, and the nets a source sits on.
 *
 * Once per compile, however many chips ask: a page of a few hundred of them
 * rebuilding it each was a few hundred walks over every part.
 */
const dcGraphs = new WeakMap<Connectivity, { through: Map<number, number[]>; sourced: Set<number> }>();

function dcGraph(schematic: Schematic, connectivity: Connectivity) {
	const known = dcGraphs.get(connectivity);
	if (known) return known;
	const through = new Map<number, number[]>();
	const sourced = new Set<number>();
	const link = (a: number, b: number) => {
		const list = through.get(a);
		if (list) list.push(b);
		else through.set(a, [b]);
	};
	for (const instance of schematic.instances) {
		if (chipOf(instance.kind) || NO_DC_PATH.has(instance.kind)) continue;
		const on = definitionFor(instance)
			.pins.filter((pin) => pin.domain === 'analog')
			.map((pin) => connectivity.netOfPin.get(pinKey(instance.id, pin.name)))
			.filter((index): index is number => index !== undefined);
		if (instance.kind === 'supply' || instance.kind === 'vsource' || instance.kind === 'battery') {
			for (const index of on) sourced.add(index);
		}
		for (let i = 1; i < on.length; i++) {
			link(on[0], on[i]);
			link(on[i], on[0]);
		}
	}
	const graph = { through, sourced };
	dcGraphs.set(connectivity, graph);
	return graph;
}

/** Parts that carry no current at DC, the same list the floating-input check uses. */
const NO_DC_PATH = new Set(['capacitor', 'crystal', 'isource', 'probe', 'port']);

/** The last compile, and what it was a compile of. */
let lastCompile: { signature: string; result: CompileResult } | null = null;

/**
 * Everything a compile reads, apart from where things are drawn.
 *
 * Dragging a part changes the drawing on every frame and the circuit on
 * almost none of them: the same parts, the same values, the same pins on the
 * same nets. Everything the compile decides — names, netlist, warnings —
 * follows from these, so when they have not changed its answer has not either.
 * Only the connectivity, which says where each net runs on the page, is new.
 *
 * Each net contributes the flags the compile reads off it, its pins in order,
 * and the two geometric facts it asks: whether it runs through more than one
 * point, and whether any wire of the drawing itself reaches it.
 */
function compileSignature(
	sheet: Schematic,
	schematic: Schematic,
	connectivity: Connectivity,
	temperature: number,
	seed: number,
	family: string
): string {
	const drawn = new Set(sheet.wires.flatMap((w) => w.points.map((p) => pointKey(p.x, p.y))));
	const parts: string[] = [`${temperature}|${seed}|${family}`];
	for (const s of sheet.subcircuits ?? []) parts.push(`x${s.id}|${s.name}|${s.ports.join()}|${s.source}`);
	for (const i of schematic.instances) {
		parts.push(`i${i.id}|${i.kind}|${i.name}|${i.rotation}|${JSON.stringify(i.params)}`);
	}
	for (const net of connectivity.nets) {
		parts.push(
			`n${+net.isGround}${+net.hasAnalog}${+net.hasDigitalInput}${+net.hasDigitalOutput}` +
				`${+(net.points.length >= 2)}${+net.points.some((key) => drawn.has(key))}|` +
				net.pins.map((ref) => `${ref.instance.id}:${ref.pin.name}`).join(',')
		);
	}
	return parts.join('\n');
}

export function compileSchematic(
	sheet: Schematic,
	temperature = 300.15,
	seed = 0,
	family = DEFAULT_FAMILY
): CompileResult {
	// Blocks are unfolded before anything else looks: from here on the drawing
	// is flat, with the insides of every block in it under `B1.` names and the
	// boxes themselves still standing where their pins are.
	const unfolded = unfoldBlocks(sheet);
	const connectivity = buildConnectivity(unfolded.schematic, unfolded.ties);
	const signature = compileSignature(sheet, unfolded.schematic, connectivity, temperature, seed, family);
	if (lastCompile?.signature === signature) return { ...lastCompile.result, connectivity };
	const result = compileFresh(sheet, temperature, seed, family, unfolded, connectivity);
	lastCompile = { signature, result };
	return result;
}

function compileFresh(
	sheet: Schematic,
	temperature: number,
	seed: number,
	family: string,
	unfolded: ReturnType<typeof unfoldBlocks>,
	connectivity: Connectivity
): CompileResult {
	const schematic = unfolded.schematic;
	const errors: string[] = [];
	const warnings: string[] = [];
	const names = new Map<number, NetNames>();

	// ---- name every net -------------------------------------------------
	let analogCounter = 0;
	let digitalCounter = 0;
	/**
	 * Whether anything in the drawing refers to the reference node at all.
	 *
	 * A ground symbol is the obvious way, and it is not the only one. A supply
	 * terminal is a source with its negative end already on ground — that is what
	 * the symbol means — so a drawing with one in it is referenced whether or not
	 * anybody drew the return path. Demanding a ground symbol beside it was a
	 * check that outlived the circuit it was written for: it read "no ground
	 * symbol" and reported "no reference", which stopped being the same thing the
	 * moment the supply terminal existed.
	 *
	 * A voltage source is not the same case. Both of its ends are pins on the
	 * drawing, and if neither reaches ground the whole loop floats away from the
	 * reference — which is a singular matrix rather than a circuit.
	 */
	const grounded =
		connectivity.nets.some((n) => n.isGround) ||
		schematic.instances.some((i) => i.kind === 'supply');

	for (const net of connectivity.nets) {
		const entry: NetNames = {};
		if (net.isGround) entry.analog = 'gnd';
		else if (net.hasAnalog) entry.analog = `n${++analogCounter}`;
		if (net.hasDigitalInput || net.hasDigitalOutput) entry.digital = `d${++digitalCounter}`;
		if (entry.analog && net.hasDigitalInput && net.hasDigitalOutput) {
			entry.readBack = `${entry.digital}_in`;
		}
		names.set(net.index, entry);
	}

	if (schematic.instances.length === 0) {
		errors.push('The schematic is empty. Drag a component in from the palette to start.');
	} else if (!grounded && connectivity.nets.some((n) => n.hasAnalog)) {
		errors.push('No ground. Every analog circuit needs one ground symbol as a voltage reference.');
	}

	// The points the drawing's own wires pass through, for telling a box's pin
	// with a wire on it from one with nothing but its own insides behind it.
	const drawnPoints = new Set(sheet.wires.flatMap((w) => w.points.map((p) => pointKey(p.x, p.y))));
	for (const instance of schematic.instances) {
		const def = definitionFor(instance);
		const box = blockOf(schematic, instance.kind) !== null;
		for (const pin of def.pins) {
			const index = connectivity.netOfPin.get(pinKey(instance.id, pin.name));
			const net = index === undefined ? undefined : connectivity.nets[index];
			// A pin with a wire hanging off it is fine — that is how you leave a
			// test point. Only a pin touching literally nothing is worth a warning.
			//
			// A box's pin is always on a net with the pins inside it, so for a box
			// the question is whether anything *else* is there: another part's
			// pin, or a wire somebody drew.
			const alone = box
				? !net ||
					(net.pins.every((ref) => ref.instance.id === instance.id || ref.instance.id.startsWith(`${instance.id}/`)) &&
						!net.points.some((key) => drawnPoints.has(key)))
				: !net || (net.pins.length < 2 && net.points.length < 2);
			if (alone) {
				warnings.push(`${instance.name}.${pin.name} is not connected to anything.`);
			}
		}

		// A part with every pin on one net is wired out of its own circuit: the
		// current goes round it instead of through it, so it does nothing at all.
		//
		// Worth saying out loud, because it is close to invisible on the canvas. It
		// is what a wire drawn straight past a component looks like — the symbol
		// sits on the line with a pin touching it at each end, exactly like a part
		// that is properly in series. The simulation is then correct and the
		// drawing is a lie, which is the worst combination to leave someone with.
		if (def.pins.length >= 2) {
			const nets = new Set(
				def.pins.map((pin) => connectivity.netOfPin.get(pinKey(instance.id, pin.name)))
			);
			if (nets.size === 1 && !nets.has(undefined)) {
				warnings.push(
					`${instance.name} is shorted out: every pin is on the same net, so nothing flows through it. A wire probably runs straight past it.`
				);
			}
		}
	}

	const analogOf = (instance: Instance, pin: string): string => {
		const index = connectivity.netOfPin.get(pinKey(instance.id, pin));
		return (index !== undefined && names.get(index)?.analog) || 'gnd';
	};
	const digitalOf = (instance: Instance, pin: string): string => {
		const index = connectivity.netOfPin.get(pinKey(instance.id, pin));
		const entry = index === undefined ? undefined : names.get(index);
		if (!entry?.digital) return `unused_${instance.id}_${pin}`;
		// An input on a net the analog side has a say in reads the node, not the
		// output that drives it.
		const reads = definitionFor(instance).pins.find((p) => p.name === pin)?.direction === 'in';
		return (reads && entry.readBack) || entry.digital;
	};

	// ---- components ------------------------------------------------------
	const components: unknown[] = [];
	const devices: unknown[] = [];
	const portFlow = new Map<string, PortInjection[]>(unfolded.portFlow);
	let unpoweredChips = 0;
	/** Nets already held at a voltage by a supply symbol, by net index. */
	const railed = new Map<number, { name: string; volts: number }>();

	for (const instance of schematic.instances) {
		const name = instance.name;

		// A chip is the gates inside it, wired to its legs. Nothing new reaches the
		// engine: a 7400 is four `gate` devices that happen to share a package, and
		// the package is what the drawing gets to show. Ahead of the switch because
		// the kind is a chip id rather than one of a fixed set.
		//
		// A pin name a block uses that the package does not have is internal, and
		// gets a net of its own per instance — two 7476s on one drawing must not
		// share the inside of their flip-flops.
		// A block is already in the list as the parts inside it. The box builds
		// nothing of its own; its pins are on the nets they tie to and that is all.
		if (blockOf(schematic, instance.kind)) continue;

		const chip = chipOf(instance.kind);
		if (chip) {
			// A chip does nothing without its supply, and simulating the gates
			// inside one whose VCC goes nowhere — or to ground, or to its own GND —
			// is a confident answer about a part that is dead on the bench. Its
			// gates are left out instead, so what it drives reads as undetermined,
			// which is what an unpowered output is.
			const unpowered = chipUnpowered(instance, schematic, connectivity);
			if (unpowered) {
				unpoweredChips++;
				warnings.push(
					`${name} is not powered: ${unpowered} Its outputs are left undetermined rather than given levels a chip with no supply could not produce.`
				);
				continue;
			}
			const legs = new Set(chip.layout);
			const net = (pin: string) =>
				legs.has(pin) ? digitalOf(instance, pin) : `${instance.id}_in_${pin}`;
			for (const [index, block] of chip.blocks.entries()) {
				const blockName = index === 0 ? name : `${name}:${index + 1}`;
				if (block.kind === 'dff') {
					devices.push({
						type: 'd_flip_flop',
						name: blockName,
						clock: net(block.clock!),
						data: net(block.data!),
						reset: block.reset ? net(block.reset) : null,
						preset: block.preset ? net(block.preset) : null,
						q: net(block.q!),
						q_not: net(block.qn!),
						delay: 1e-9
					});
				} else if (block.kind === 'tristate') {
					devices.push({
						type: 'tri_state',
						name: blockName,
						input: net(block.inputs![0]),
						enable: net(block.enable!),
						output: net(block.output!),
						delay: 1e-9
					});
				} else {
					devices.push({
						type: 'gate',
						name: blockName,
						kind: block.kind,
						inputs: (block.inputs ?? []).map(net),
						output: net(block.output!),
						delay: 1e-9
					});
				}
			}
			continue;
		}

		switch (instance.kind) {
			case 'ground':
			// A probe is a name attached to a point. It carries no current and
			// changes nothing, so the engine never hears about it — but its pin
			// still joins a net, which is how it knows what it is measuring.
			case 'probe':
			// A port is the same from in here: the box's pin is tied to it, and
			// the tie is the whole of what it does.
			case 'port':
				break;
			case 'supply': {
				const index = connectivity.netOfPin.get(pinKey(instance.id, 'v'));
				const net = index === undefined ? undefined : connectivity.nets[index];
				const volts = num(instance, 'voltage', 5);
				if (net?.isGround) {
					errors.push(
						`${name} sits on the ground net, which asks for ${volts} V and 0 V at the same point.`
					);
					break;
				}
				// Two symbols wired to each other are one rail drawn twice. A second
				// ideal source across the first is a short between two voltages, so
				// only the first is built — and if they disagree, that is worth
				// saying, because one of the two numbers on the drawing is a lie.
				const already = index === undefined ? undefined : railed.get(index);
				if (already) {
					if (already.volts !== volts) {
						warnings.push(
							`${name} and ${already.name} are on the same net but set to ${volts} V and ${already.volts} V. Using ${already.volts} V.`
						);
					}
					break;
				}
				if (index !== undefined) railed.set(index, { name, volts });
				components.push({
					type: 'voltage_source',
					name,
					plus: analogOf(instance, 'v'),
					minus: 'gnd',
					waveform: { type: 'dc', value: volts },
					ac_magnitude: 0,
					ac_phase: 0
				});
				break;
			}
			case 'resistor':
				components.push({
					type: 'resistor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					resistance: drawn(instance, 'resistance', num(instance, 'resistance', 1000), seed),
					// Quoted in parts per million per degree, the way a part is marked;
					// the engine works in fractions per kelvin. Nothing could reach this
					// before, so the temperature control did nothing to any resistor.
					tc1: num(instance, 'tc1', 0) * 1e-6
				});
				break;
			case 'capacitor':
				components.push({
					type: 'capacitor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					capacitance: drawn(instance, 'capacitance', num(instance, 'capacitance', 1e-6), seed)
				});
				break;
			case 'inductor':
				components.push({
					type: 'inductor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					inductance: drawn(instance, 'inductance', num(instance, 'inductance', 1e-3), seed)
				});
				break;
			// Two resistors meeting at the wiper. Neither half is allowed all the
			// way to zero: a wiper at the end of its track still has its contact to
			// get through, and a zero resistance is a short the solver cannot stamp.
			case 'potentiometer': {
				const track = drawn(instance, 'resistance', num(instance, 'resistance', 10e3), seed);
				const position = Math.min(Math.max(num(instance, 'position', 0.5), 0), 1);
				const END = 1e-3;
				components.push({
					type: 'resistor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'wiper'),
					resistance: Math.max(track * position, END)
				});
				components.push({
					type: 'resistor',
					name: `${name}:b`,
					a: analogOf(instance, 'wiper'),
					b: analogOf(instance, 'b'),
					resistance: Math.max(track * (1 - position), END)
				});
				break;
			}
			// The motional arm from `a` to `b` through two nodes of its own, and the
			// holder's capacitance straight across. The loss is the element that
			// keeps the plain name, so the current the drawing animates is the one
			// through the quartz rather than round the holder.
			case 'crystal': {
				const a = analogOf(instance, 'a');
				const b = analogOf(instance, 'b');
				const frequency = Math.max(num(instance, 'frequency', 16e6), 1e-3);
				const c1 = Math.max(num(instance, 'c1', 20e-15), 1e-18);
				const l1 = 1 / ((2 * Math.PI * frequency) ** 2 * c1);
				const lossToCoil = `${name}__r`;
				const coilToCap = `${name}__l`;
				components.push({ type: 'resistor', name, a, b: lossToCoil, resistance: Math.max(num(instance, 'r1', 30), 1e-6) });
				components.push({ type: 'inductor', name: `${name}:l`, a: lossToCoil, b: coilToCap, inductance: l1 });
				components.push({ type: 'capacitor', name: `${name}:c1`, a: coilToCap, b, capacitance: c1 });
				const c0 = num(instance, 'c0', 5e-12);
				if (c0 > 0) components.push({ type: 'capacitor', name: `${name}:c0`, a, b, capacitance: c0 });
				break;
			}
			// A resistor at the temperature it glows at. See the catalog for what
			// that leaves out.
			case 'lamp': {
				const volts = Math.max(num(instance, 'voltage', 6), 1e-6);
				const watts = Math.max(num(instance, 'power', 1.2), 1e-9);
				components.push({
					type: 'resistor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					resistance: (volts * volts) / watts
				});
				break;
			}
			case 'switch': {
				// The engine's switch is voltage-controlled, which is the general
				// case and the one the digital output drivers are built on. A switch
				// somebody flips is that with its control written out in advance, on
				// a node of its own that nothing else can see.
				const control = `${name}__contact`;
				const controlPoints = contactControl(instance);
				components.push({
					type: 'voltage_source',
					name: `${name}__actuator`,
					plus: control,
					minus: 'gnd',
					// A switch nobody ever operates holds still, and a constant says that
					// without asking the solver to land a timepoint on anything. Read off
					// the control itself rather than off `action`, so a switch thrown by
					// hand during playback gets its edge too.
					waveform:
						controlPoints.length > 1
							? { type: 'pwl', points: controlPoints }
							: { type: 'dc', value: restingContact(instance) },
					ac_magnitude: 0,
					ac_phase: 0
				});
				components.push({
					type: 'switch',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					control_plus: control,
					control_minus: 'gnd',
					model: {
						v_on: 1,
						v_off: 0,
						r_on: num(instance, 'r_on', 0.05),
						r_off: num(instance, 'r_off', 1e9)
					}
				});
				break;
			}
			// The single pair twice over, worked by one actuator: the NO side
			// reads the control the way the plain switch does, and the NC side
			// reads it upside down — its control terminals swapped, so it is made
			// exactly when the other is broken.
			case 'spdt': {
				const control = `${name}__contact`;
				const controlPoints = contactControl(instance);
				components.push({
					type: 'voltage_source',
					name: `${name}__actuator`,
					plus: control,
					minus: 'gnd',
					waveform:
						controlPoints.length > 1
							? { type: 'pwl', points: controlPoints }
							: { type: 'dc', value: restingContact(instance) },
					ac_magnitude: 0,
					ac_phase: 0
				});
				const r_on = num(instance, 'r_on', 0.05);
				const r_off = num(instance, 'r_off', 1e12);
				const com = analogOf(instance, 'com');
				components.push({
					type: 'switch',
					name,
					a: com,
					b: analogOf(instance, 'no'),
					control_plus: control,
					control_minus: 'gnd',
					model: { v_on: 1, v_off: 0, r_on, r_off }
				});
				components.push({
					type: 'switch',
					name: `${name}:nc`,
					a: com,
					b: analogOf(instance, 'nc'),
					control_plus: 'gnd',
					control_minus: control,
					model: { v_on: 0, v_off: -1, r_on, r_off }
				});
				break;
			}
			// The coil, and two contacts that read the voltage across its winding
			// resistance — the coil current, scaled by a number the datasheet already
			// gives in volts. The NC side reads it negated, as the changeover does.
			// A coil driven backwards reads as a coil not driven at all, which a DC
			// relay with a flyback diode never sees and a bare one does.
			case 'relay': {
				const a = analogOf(instance, 'a');
				const mid = `${name}__coil`;
				const pullIn = Math.max(num(instance, 'pull_in', 3.75), 1e-3);
				const dropOut = Math.min(Math.max(num(instance, 'drop_out', 0.5), 0), pullIn);
				const r_on = num(instance, 'r_on', 0.05);
				const r_off = num(instance, 'r_off', 1e12);
				const com = analogOf(instance, 'com');
				components.push({ type: 'resistor', name, a, b: mid, resistance: num(instance, 'coil_r', 70) });
				components.push({
					type: 'inductor',
					name: `${name}:l`,
					a: mid,
					b: analogOf(instance, 'b'),
					inductance: num(instance, 'coil_l', 0.2)
				});
				components.push({
					type: 'switch',
					name: `${name}:no`,
					a: com,
					b: analogOf(instance, 'no'),
					control_plus: a,
					control_minus: mid,
					model: { v_on: pullIn, v_off: dropOut, r_on, r_off }
				});
				components.push({
					type: 'switch',
					name: `${name}:nc`,
					a: com,
					b: analogOf(instance, 'nc'),
					control_plus: mid,
					control_minus: a,
					model: { v_on: -dropOut, v_off: -pullIn, r_on, r_off }
				});
				break;
			}
			case 'vsource':
				components.push({
					type: 'voltage_source',
					name,
					plus: analogOf(instance, 'plus'),
					minus: analogOf(instance, 'minus'),
					waveform: waveform(instance),
					ac_magnitude: num(instance, 'ac', 0),
					ac_phase: 0
				});
				break;
			// The source reports the current, as a supply's does; the resistance
			// is inside it, between the EMF and the terminal anyone can touch.
			case 'battery': {
				const emf = `${name}__emf`;
				components.push({
					type: 'voltage_source',
					name,
					plus: emf,
					minus: analogOf(instance, 'minus'),
					waveform: { type: 'dc', value: num(instance, 'voltage', 9) },
					ac_magnitude: 0,
					ac_phase: 0
				});
				components.push({
					type: 'resistor',
					name: `${name}:r`,
					a: emf,
					b: analogOf(instance, 'plus'),
					resistance: Math.max(num(instance, 'r_int', 1.5), 1e-6)
				});
				break;
			}
			case 'isource':
				components.push({
					type: 'current_source',
					name,
					// Crossed on purpose. The engine follows SPICE, where current runs
					// from `plus` to `minus` *through* the source — so it drains the
					// terminal it is named after. The symbol draws an arrow pointing at
					// our `plus` pin, and an arrow on a current source means the way the
					// current is delivered. Reading them together, a 3 A source with its
					// arrow pointing up would have pushed the node above it negative.
					plus: analogOf(instance, 'minus'),
					minus: analogOf(instance, 'plus'),
					waveform: waveform(instance),
					ac_magnitude: num(instance, 'ac', 0),
					ac_phase: 0
				});
				break;
			case 'diode':
				components.push({
					type: 'diode',
					name,
					anode: analogOf(instance, 'anode'),
					cathode: analogOf(instance, 'cathode'),
					model: withCard(instance, diodeModel(instance), diodeFromCard, (m) =>
						warnings.push(m)
					)
				});
				break;
			// Electrically an LED is a diode with a high forward voltage and a current
			// it will not survive being held above. The engine takes both, so the
			// failure happens inside the run rather than being noticed after it.
			case 'led':
				components.push({
					type: 'diode',
					name,
					anode: analogOf(instance, 'anode'),
					cathode: analogOf(instance, 'cathode'),
					model: withCard(
						instance,
						ledDiodeModel(instance.params.colour, ledRating(instance)) as Record<string, unknown>,
						diodeFromCard,
						(m) => warnings.push(m)
					)
				});
				break;
			// Eight diodes sharing one terminal, which is what the package is. Each
			// one is named for its segment so the drawing can ask how brightly to
			// light that bar; the first keeps the plain instance name, the way a
			// MOSFET's drain does.
			// Ten LEDs with nothing shared, named for their bar the way a digit's
			// are named for their segment.
			case 'bargraph': {
				const model = ledDiodeModel(
					instance.params.colour,
					ledRating(instance)
				) as Record<string, unknown>;
				for (const [index, bar] of BARS.entries()) {
					components.push({
						type: 'diode',
						name: index === 0 ? name : `${name}:${bar}`,
						anode: analogOf(instance, `a${bar}`),
						cathode: analogOf(instance, `k${bar}`),
						model
					});
				}
				break;
			}
			case 'display7': {
				const model = ledDiodeModel(
					instance.params.colour,
					ledRating(instance)
				) as Record<string, unknown>;
				const common = analogOf(instance, 'common');
				const anodeCommon = instance.params.polarity === 'anode';
				for (const [index, segment] of SEGMENTS.entries()) {
					const pin = analogOf(instance, segment);
					components.push({
						type: 'diode',
						name: index === 0 ? name : `${name}:${segment}`,
						anode: anodeCommon ? common : pin,
						cathode: anodeCommon ? pin : common,
						model
					});
				}
				break;
			}
			case 'nmos':
			case 'pmos':
				components.push({
					type: 'mosfet',
					name,
					drain: analogOf(instance, 'drain'),
					gate: analogOf(instance, 'gate'),
					source: analogOf(instance, 'source'),
					model: withCard(
						instance,
						{
							channel: instance.kind === 'nmos' ? 'n' : 'p',
							vto: num(instance, 'vto', 2),
							kp: num(instance, 'kp', 2e-5),
							lambda: num(instance, 'lambda', 0.02),
							// Only the ratio matters at this model level.
							w: num(instance, 'ratio', 10),
							l: 1,
							cgs: num(instance, 'cgs', 20e-12),
							cgd: num(instance, 'cgd', 5e-12),
							cds: 20e-12
						},
						mosfetFromCard,
						(m) => warnings.push(m)
					)
				});
				break;
			case 'npn':
			case 'pnp':
				components.push({
					type: 'bjt',
					name,
					collector: analogOf(instance, 'collector'),
					base: analogOf(instance, 'base'),
					emitter: analogOf(instance, 'emitter'),
					model: withCard(
						instance,
						{
							polarity: instance.kind === 'npn' ? 'npn' : 'pnp',
							is: num(instance, 'is', 6.73e-15),
							bf: num(instance, 'bf', 200),
							br: 4,
							vaf: num(instance, 'vaf', 100),
							cjc: num(instance, 'cjc', 3.6e-12),
							tf: num(instance, 'tf', 301e-12),
							temp: 300.15
						},
						bjtFromCard,
						(m) => warnings.push(m)
					)
				});
				break;
			case 'opamp':
				components.push({
					type: 'op_amp',
					name,
					output: analogOf(instance, 'out'),
					input_plus: analogOf(instance, 'plus'),
					input_minus: analogOf(instance, 'minus'),
					gain: num(instance, 'gain', 1e5),
					v_max: num(instance, 'v_max', 15),
					v_min: num(instance, 'v_min', -15),
					gbw: num(instance, 'gbw', 1e6),
					slew: num(instance, 'slew', 0.5e6),
					r_out: num(instance, 'r_out', 75),
					v_os: num(instance, 'v_os', 1e-3),
					i_bias: num(instance, 'i_bias', 80e-9)
				});
				break;
			case 'and':
			case 'nand':
			case 'or':
			case 'nor':
			case 'xor':
			case 'xnor':
				devices.push({
					type: 'gate',
					name,
					kind: instance.kind,
					// Read off the pins the part actually grew rather than assumed to
					// be two, so a three-input gate is one gate with a three-way
					// decision in it and not a chain that costs an extra delay.
					inputs: definitionFor(instance)
						.pins.filter((pin) => pin.direction === 'in')
						.map((pin) => digitalOf(instance, pin.name)),
					output: digitalOf(instance, 'y'),
					delay: num(instance, 'delay', 1e-9)
				});
				break;
			case 'not':
			case 'buffer':
				devices.push({
					type: 'gate',
					name,
					kind: instance.kind,
					inputs: [digitalOf(instance, 'a')],
					output: digitalOf(instance, 'y'),
					delay: num(instance, 'delay', 1e-9)
				});
				break;
			case 'tristate':
				devices.push({
					type: 'tri_state',
					name,
					input: digitalOf(instance, 'a'),
					enable: digitalOf(instance, 'en'),
					output: digitalOf(instance, 'y'),
					delay: num(instance, 'delay', 1e-9)
				});
				break;
			case 'dff':
				devices.push({
					type: 'd_flip_flop',
					name,
					clock: digitalOf(instance, 'clk'),
					data: digitalOf(instance, 'd'),
					reset: null,
					q: digitalOf(instance, 'q'),
					q_not: digitalOf(instance, 'qn'),
					delay: num(instance, 'delay', 1e-9)
				});
				break;
			case 'toggle':
				devices.push({
					type: 'logic_source',
					name,
					output: digitalOf(instance, 'y'),
					// Where it starts. Clicking it during a run does not come through
					// here at all: the engine is told to move it at that instant, and
					// the drawing keeps saying what the circuit was built as.
					state: str(instance, 'state', 'low') === 'high' ? 'high' : 'low'
				});
				break;
			case 'clock':
				devices.push({
					type: 'clock',
					name,
					output: digitalOf(instance, 'out'),
					frequency: Math.max(num(instance, 'frequency', 1e6), 1e-9),
					duty: num(instance, 'duty', 0.5)
				});
				break;
			default: {
				// An imported subcircuit is flattened here rather than handed to the
				// engine as a hierarchy, because the engine solves one matrix: a
				// subcircuit is a way of writing a circuit down, not a thing a solver
				// knows about.
				const sub = subcircuitOf(schematic, instance.kind);
				if (!sub) {
					errors.push(
						`${name}: '${instance.kind}' is not something the engine knows how to build.`
					);
					break;
				}
				const parsed = parseSubcircuits(sub.source).find((s) => s.name === sub.name);
				if (!parsed) {
					errors.push(`${name}: the definition of ${sub.name} is no longer readable.`);
					break;
				}
				const { components: inner, skipped } = expandSubcircuit(
					parsed,
					name,
					sub.ports.map((port) => analogOf(instance, port))
				);
				components.push(...inner);
				portFlow.set(instance.id, portInjections(parsed, name));
				if (skipped.length > 0) {
					warnings.push(
						`${name}: ${sub.name} uses ${skipped.join(', ')}, which this simulator cannot build.`
					);
				}
				break;
			}
		}
	}

	// An LED straight across a logic output and the return, with nothing in
	// series. The most common mistake there is with a lamp, and one the drawing
	// does not show as one: it lights, which looks like success. The output is
	// clamped at the LED's forward voltage — a couple of volts, which is neither
	// a High nor a Low to anything else reading that net — and the current is
	// whatever the output can give, which is the LED's problem or the output's.
	// A counter with a lamp on every stage and no resistors stops counting at
	// the first lamp, because the stage after it never sees a High.
	for (const instance of schematic.instances) {
		if (instance.kind !== 'led') continue;
		const anode = connectivity.netOfPin.get(pinKey(instance.id, 'anode'));
		const cathode = connectivity.netOfPin.get(pinKey(instance.id, 'cathode'));
		if (anode === undefined || cathode === undefined) continue;
		const [a, k] = [connectivity.nets[anode], connectivity.nets[cathode]];
		const railed = (net: Net) =>
			net.isGround || net.pins.some((pin) => pin.instance.kind === 'supply');
		const driven = a.hasDigitalOutput && railed(k) ? a : k.hasDigitalOutput && railed(a) ? k : null;
		if (!driven) continue;
		const output = driven.pins.find((pin) => pin.pin.direction === 'out');
		const who = output ? `${output.instance.name}.${output.pin.name}` : 'a logic output';
		const readers = driven.pins
			.filter((pin) => pin.pin.domain === 'digital' && pin.pin.direction === 'in')
			.map((pin) => `${pin.instance.name}.${pin.pin.name}`);
		warnings.push(
			`${instance.name} sits straight across ${who} and the rail with nothing to limit the current. The output is held at the LED's forward voltage, about 2 V — which is not a High to anything else on that net${readers.length ? ` (${readers.join(', ')} read${readers.length === 1 ? 's' : ''} it)` : ''} — and the current is whatever the output can give. A resistor in series, 330 Ω for about 10 mA from 5 V, is what makes it a lamp.`
		);
	}

	// A logic input with nothing holding it at either rail is the most common
	// mistake there is with a switch, and the one that looks least like a
	// mistake: the level it reads is decided by leakage, so the gate answers with
	// total confidence and the switch appears to do nothing.
	//
	// Two cases, and they are not the same mistake. An input no switch can ever
	// reach is undefined for the whole run, and giving the gate "unknown" is the
	// only honest thing to do with it. An input a switch feeds is defined while
	// that switch is closed — so it stays bridged, and the drawing reports it as
	// floating only at the instants when it actually is. Treating both as the
	// first is what left a button wired to a gate doing nothing at all: the
	// verdict was reached at compile time and closing the contact came too late
	// to change it.
	const { inputs, floatingWith } = floatingLogicInputs(schematic, connectivity);
	const undefinedNets = new Set<number>();
	for (const { net, instance, pin, conditional } of inputs) {
		if (conditional) {
			warnings.push(
				`${instance.name}.${pin} is held only while a switch is closed. With that switch open nothing decides what it reads, so it is left to leakage rather than to the circuit. A pull-down resistor to ground, or a pull-up to the supply, is what gives it a level either way.`
			);
			continue;
		}
		undefinedNets.add(net);
		warnings.push(
			`${instance.name}.${pin} has no path to either rail, so nothing decides what it reads — it is left to leakage, which is not a logic level. The gate is given "unknown" rather than a level invented for it. A pull-down resistor to ground, or a pull-up to the supply, is what fixes it.`
		);
	}

	// ---- automatic bridges ----------------------------------------------
	const bridges: unknown[] = [];
	for (const net of connectivity.nets) {
		const entry = names.get(net.index)!;
		if (!entry.analog || !entry.digital) continue;

		if (net.hasDigitalOutput) {
			bridges.push({
				direction: 'to_analog',
				name: `BDA${net.index}`,
				net: entry.digital,
				node: entry.analog
			});
		}
		// Nothing is read off a floating node. The bridge would compare a voltage
		// that leakage put there against a threshold and come back with a level, in
		// which case the answer looks the same as a real one — and an undefined
		// input reported as a confident High is how somebody ships a board that
		// works on the bench and not in the field. Left unbridged, the digital net
		// has no driver and stays unknown, which is what it is.
		if (net.hasDigitalInput && !undefinedNets.has(net.index)) {
			bridges.push({
				direction: 'to_digital',
				name: `BAD${net.index}`,
				node: entry.analog,
				net: entry.readBack ?? entry.digital,
				delay: 0
			});
		}
	}

	// An empty sheet has already been told it is empty, and saying it twice on the
	// first thing anybody sees is not twice as helpful. This is for the drawing
	// that has parts on it and still builds nothing — a lone ground symbol, or a
	// probe waiting for a circuit.
	// A chip set aside for want of a supply has been told why already, and is not
	// a drawing with nothing on it.
	if (components.length === 0 && devices.length === 0 && schematic.instances.length > 0 && !unpoweredChips) {
		errors.push('Nothing to simulate: place at least one component.');
	}

	return {
		netlist: errors.length
			? null
			: { components, devices, bridges, temperature, logic_family: logicFamily(family) },
		names,
		floatingAt: floatingWith,
		errors,
		warnings,
		connectivity,
		portFlow
	};
}

/** Signal label the engine will use for a net's voltage, e.g. `v(n3)`. */
export function analogSignalName(names: NetNames | undefined): string | null {
	return names?.analog && names.analog !== 'gnd' ? `v(${names.analog})` : null;
}
