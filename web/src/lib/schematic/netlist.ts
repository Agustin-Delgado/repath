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

import { definitionOf, type Instance, type Schematic } from './model';
import { buildConnectivity, pinKey, type Connectivity, type Net } from './nets';

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

function diodeModel(instance: Instance): unknown {
	const kind = str(instance, 'model', 'silicon');
	if (kind === 'led') return { is: 9.3e-20, n: 3.73, bv: null, temp: 300.15 };
	if (kind === 'zener') {
		return { is: 2.52e-9, n: 1.752, bv: Math.abs(num(instance, 'breakdown', 5.1)), temp: 300.15 };
	}
	return { is: 2.52e-9, n: 1.752, bv: null, temp: 300.15 };
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
					plus: analogOf(instance, 'plus'),
					minus: analogOf(instance, 'minus'),
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
					model: diodeModel(instance)
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
					model: {
						channel: instance.kind === 'nmos' ? 'n' : 'p',
						vto: num(instance, 'vto', 2),
						kp: num(instance, 'kp', 2e-5),
						lambda: 0,
						// Only the ratio matters at this model level.
						w: num(instance, 'ratio', 10),
						l: 1
					}
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
					model: {
						polarity: instance.kind === 'npn' ? 'npn' : 'pnp',
						is: num(instance, 'is', 6.73e-15),
						bf: num(instance, 'bf', 200),
						br: 4,
						temp: 300.15
					}
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
					v_min: num(instance, 'v_min', -15)
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
			default:
				errors.push(`${name}: '${instance.kind}' is not something the engine knows how to build.`);
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
