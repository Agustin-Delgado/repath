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

import { ledDiodeModel, ledRating } from './led';
import { definitionOf, subcircuitOf, type Instance, type Schematic } from './model';
import { buildConnectivity, pinKey, type Connectivity, type Net } from './nets';
import {
	bjtFromCard,
	cardFor,
	diodeFromCard,
	expandSubcircuit,
	mosfetFromCard,
	parseSubcircuits,
	type ModelCard
} from '../spice';

export interface NetNames {
	analog?: string;
	digital?: string;
}

export interface CompileResult {
	/** JSON accepted by the engine. `null` when `errors` is non-empty. */
	netlist: unknown | null;
	/** Net index -> the names it was given. */
	names: Map<number, NetNames>;
	errors: string[];
	warnings: string[];
	connectivity: Connectivity;
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
		return { type: 'sine', offset, amplitude, frequency, delay: 0, damping: 0, phase: 0 };
	}
	if (kind === 'pulse') {
		const period = 1 / frequency;
		const duty = Math.min(Math.max(num(instance, 'duty', 0.5), 0.01), 0.99);
		const width = period * duty;
		// Fast but finite edges. Instantaneous ones are not physical and give the
		// transient loop nothing to land on.
		const edge = Math.min(period / 1000, width / 10);
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

function diodeModel(instance: Instance): Record<string, unknown> {
	const kind = str(instance, 'model', 'silicon');
	// The bulk resistance travels with every one of them. It does nothing at a
	// milliamp and it is most of the forward drop at an amp, and a part without
	// one has an exponential that never stops climbing.
	const base = { rs: num(instance, 'rs', 0.568), temp: 300.15 };
	if (kind === 'led') return { is: 9.3e-20, n: 3.73, bv: null, ...base };
	if (kind === 'zener') {
		return { is: 2.52e-9, n: 1.752, bv: Math.abs(num(instance, 'breakdown', 5.1)), ...base };
	}
	return { is: 2.52e-9, n: 1.752, bv: null, ...base };
}

export function compileSchematic(schematic: Schematic): CompileResult {
	const connectivity = buildConnectivity(schematic);
	const errors: string[] = [];
	const warnings: string[] = [];
	const names = new Map<number, NetNames>();

	// ---- name every net -------------------------------------------------
	let analogCounter = 0;
	let digitalCounter = 0;
	const grounded = connectivity.nets.some((n) => n.isGround);

	for (const net of connectivity.nets) {
		const entry: NetNames = {};
		if (net.isGround) entry.analog = 'gnd';
		else if (net.hasAnalog) entry.analog = `n${++analogCounter}`;
		if (net.hasDigitalInput || net.hasDigitalOutput) entry.digital = `d${++digitalCounter}`;
		names.set(net.index, entry);
	}

	if (schematic.instances.length === 0) {
		errors.push('The schematic is empty. Drag a component in from the palette to start.');
	} else if (!grounded && connectivity.nets.some((n) => n.hasAnalog)) {
		errors.push('No ground. Every analog circuit needs one ground symbol as a voltage reference.');
	}

	for (const instance of schematic.instances) {
		const def = definitionOf(instance.kind);
		for (const pin of def.pins) {
			const index = connectivity.netOfPin.get(pinKey(instance.id, pin.name));
			const net = index === undefined ? undefined : connectivity.nets[index];
			// A pin with a wire hanging off it is fine — that is how you leave a
			// test point. Only a pin touching literally nothing is worth a warning.
			if (!net || (net.pins.length < 2 && net.points.length < 2)) {
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
		return (index !== undefined && names.get(index)?.digital) || `unused_${instance.id}_${pin}`;
	};

	// ---- components ------------------------------------------------------
	const components: unknown[] = [];
	const devices: unknown[] = [];

	for (const instance of schematic.instances) {
		const name = instance.name;
		switch (instance.kind) {
			case 'ground':
				break;
			case 'resistor':
				components.push({
					type: 'resistor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					resistance: num(instance, 'resistance', 1000)
				});
				break;
			case 'capacitor':
				components.push({
					type: 'capacitor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					capacitance: num(instance, 'capacitance', 1e-6)
				});
				break;
			case 'inductor':
				components.push({
					type: 'inductor',
					name,
					a: analogOf(instance, 'a'),
					b: analogOf(instance, 'b'),
					inductance: num(instance, 'inductance', 1e-3)
				});
				break;
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
				devices.push({
					type: 'gate',
					name,
					kind: instance.kind,
					inputs: [digitalOf(instance, 'a'), digitalOf(instance, 'b')],
					output: digitalOf(instance, 'y'),
					delay: num(instance, 'delay', 1e-9)
				});
				break;
			case 'not':
				devices.push({
					type: 'gate',
					name,
					kind: 'not',
					inputs: [digitalOf(instance, 'a')],
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
				if (skipped.length > 0) {
					warnings.push(
						`${name}: ${sub.name} uses ${skipped.join(', ')}, which this simulator cannot build.`
					);
				}
				break;
			}
		}
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
		if (net.hasDigitalInput) {
			bridges.push({
				direction: 'to_digital',
				name: `BAD${net.index}`,
				node: entry.analog,
				net: entry.digital,
				delay: 0
			});
		}
	}

	if (components.length === 0 && devices.length === 0) {
		errors.push('Nothing to simulate: place at least one component.');
	}

	return {
		netlist: errors.length ? null : { components, devices, bridges },
		names,
		errors,
		warnings,
		connectivity
	};
}

/** Signal label the engine will use for a net's voltage, e.g. `v(n3)`. */
export function analogSignalName(names: NetNames | undefined): string | null {
	return names?.analog && names.analog !== 'gnd' ? `v(${names.analog})` : null;
}
