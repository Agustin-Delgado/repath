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

import { contactControl, operationTimes, restingContact } from './contacts';
import { ledDiodeModel, ledRating } from './led';
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

export function compileSchematic(
	schematic: Schematic,
	temperature = 300.15,
	seed = 0,
	family = DEFAULT_FAMILY
): CompileResult {
	const connectivity = buildConnectivity(schematic);
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
		names.set(net.index, entry);
	}

	if (schematic.instances.length === 0) {
		errors.push('The schematic is empty. Drag a component in from the palette to start.');
	} else if (!grounded && connectivity.nets.some((n) => n.hasAnalog)) {
		errors.push('No ground. Every analog circuit needs one ground symbol as a voltage reference.');
	}

	for (const instance of schematic.instances) {
		const def = definitionFor(instance);
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
	/** Nets already held at a voltage by a supply symbol, by net index. */
	const railed = new Map<number, { name: string; volts: number }>();

	for (const instance of schematic.instances) {
		const name = instance.name;
		switch (instance.kind) {
			case 'ground':
			// A probe is a name attached to a point. It carries no current and
			// changes nothing, so the engine never hears about it — but its pin
			// still joins a net, which is how it knows what it is measuring.
			case 'probe':
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
					resistance: drawn(instance, 'resistance', num(instance, 'resistance', 1000), seed)
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
					state: str(instance, 'state', 'low') === 'high' ? 'high' : 'low',
					// Every instant it was clicked at, so the run reproduces the steps
					// rather than replaying the whole thing at the level it ended on.
					flips: operationTimes(instance)
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
				net: entry.digital,
				delay: 0
			});
		}
	}

	// An empty sheet has already been told it is empty, and saying it twice on the
	// first thing anybody sees is not twice as helpful. This is for the drawing
	// that has parts on it and still builds nothing — a lone ground symbol, or a
	// probe waiting for a circuit.
	if (components.length === 0 && devices.length === 0 && schematic.instances.length > 0) {
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
		connectivity
	};
}

/** Signal label the engine will use for a net's voltage, e.g. `v(n3)`. */
export function analogSignalName(names: NetNames | undefined): string | null {
	return names?.analog && names.analog !== 'gnd' ? `v(${names.analog})` : null;
}
