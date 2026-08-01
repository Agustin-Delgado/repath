# repath

A free, open source, mixed-signal circuit simulator that runs entirely in your browser.

Analog and digital in the same schematic. Draw a comparator into a NAND gate and it
works — repath figures out where the two domains meet and inserts the converters
itself.

- **MIT licensed.** Every feature, no accounts, no paywall.
- **No server.** The engine is WebAssembly; your circuits never leave your machine.
- **Real SPICE-class analysis.** Modified nodal analysis, Newton-Raphson, companion
  models, adaptive timestepping, and the convergence aids that make nonlinear
  circuits actually solve.

## Status

Early. The engine is solid and tested against circuits with known closed-form
answers; the editor covers the basics. See [Roadmap](#roadmap) for what is missing.

## Running it

You need [Rust](https://rustup.rs), [Node](https://nodejs.org) 20+, and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack`).

```sh
git clone https://github.com/repath/repath
cd repath

# Build the engine into the web app
wasm-pack build crates/repath-wasm --release --target web \
  --out-dir ../../web/src/lib/wasm --out-name repath

cd web
npm install
npm run dev
```

The production build is fully static — `npm run build` produces a directory you can
drop on any host.

## How it works

```
crates/repath-core    the simulation engine (pure Rust, no web dependencies)
crates/repath-wasm    WebAssembly bindings
web                   SvelteKit editor, scope, and component library
```

### The analog side

Every element stamps its contribution into a matrix — this is modified nodal
analysis. Node voltages are the unknowns, plus one extra unknown per element that
defines a voltage rather than a current (sources, inductors, op-amps).

Nonlinear devices are linearized around the current guess and the system is solved
again, repeatedly, until the answer stops moving. Diodes, BJTs and MOSFETs all
compute their terminal currents and the derivatives of those currents, which is
what Newton-Raphson needs.

Capacitors and inductors become **companion models**: at each timestep a capacitor
is replaced by a conductance in parallel with a current source carrying its history.
That is what turns a differential equation into the linear system the solver already
knows how to handle. The default rule is trapezoidal, which is second order and adds
no numerical damping, with backward Euler for the first steps and after any
discontinuity — otherwise the trapezoidal rule rings.

### Convergence

This is where simulators are actually judged. Three fallbacks run in order:

1. **Plain Newton** from the last known solution.
2. **gmin stepping** — a large conductance is added from every node to ground,
   making the circuit trivially solvable, then walked down decade by decade with
   each solution seeding the next.
3. **Source stepping** — every independent source is scaled to zero, where the
   answer is all zeros, and ramped back up.

Every exponential junction runs through SPICE's `pnjlim` voltage limiting first.
Without it a single overshooting iterate produces `exp(500)` and the solve dies.

### Timestep control

Reactive elements record their charge or flux at each accepted timepoint. The third
divided difference of that history estimates the local truncation error, and the
solver takes the tightest step any element asks for. Below a noise floor derived
from floating-point precision the estimate is ignored — a straight line's third
divided difference is rounding error amplified by `1/h³`, and steering by it would
collapse the timestep for no reason.

The loop never steps *over* a discontinuity. Before each step it takes the minimum
of the error budget, the shortest feature of any source waveform, the next waveform
corner, the next digital event, and the end of any digital-to-analog ramp in flight.

### The digital side

Nothing steps through time. Devices run only when an input changes, and schedule
their outputs into the future by their propagation delay. A 100 MHz clock feeding an
idle counter costs a handful of evaluations per cycle, not one per analog timestep.

Nets are four-state (`0`, `1`, `X`, `Z`) and multiply driven on purpose, so tri-state
buses resolve properly and contention shows up as `X` instead of silently picking a
winner.

### Bridging the two

Neither side ever sees a discontinuity:

- A **digital-to-analog** bridge never jumps. When its net changes it ramps over a
  real rise or fall time, so the analog solver sees a continuous waveform and never
  has to re-solve a timepoint it already accepted.
- An **analog-to-digital** bridge watches a node between accepted timepoints and,
  when the voltage crosses a threshold, interpolates the crossing instant and
  schedules the digital event *there* rather than at the end of the step. Thresholds
  have hysteresis, so a slow edge produces one event rather than a burst.

The editor works out where a bridge is needed from the pins on each net. Analog pins
and digital pins on the same wire means a bridge — in whichever direction the
digital pins point.

## What is in the box

| | |
|---|---|
| **Passive** | resistor, capacitor, inductor, ground |
| **Sources** | voltage and current, with DC / sine / pulse waveforms |
| **Semiconductors** | diode (silicon, LED, zener), NMOS, PMOS, NPN, PNP |
| **Analog** | op-amp with finite gain and rail saturation, voltage-controlled switch, VCVS, VCCS |
| **Logic** | AND, NAND, OR, NOR, XOR, NOT, D flip-flop, tri-state buffer, clock |
| **Analyses** | DC operating point, DC sweep, mixed-signal transient |

## Using the editor

| | |
|---|---|
| Place a part | pick it in the palette, then click the canvas |
| Draw a wire | `W`, then drag |
| Rotate | `R` |
| Delete | `Del` |
| Pan | middle-drag, or `Alt`-drag |
| Zoom | scroll |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Plot a net | tick it in the Signals list |

Values accept engineering notation: `4k7`, `4.7k`, `10u`, `1meg`, `100n`.

## Roadmap

Roughly in order of how much they would change what repath is good for:

- **AC / frequency-domain analysis.** Bode plots are table stakes for filter work.
- **SPICE model import.** Reading `.model` and `.subckt` from a manufacturer's
  datasheet is the difference between a toy and a tool.
- **Subcircuits.** Draw a block once, use it everywhere, nest it.
- **Sparse matrix solver.** The dense LU is fine to a few hundred nodes and then it
  is not.
- **Netlist import/export** in SPICE format.
- **Sharing by URL**, so a circuit can be pasted into a forum answer.
- **Richer device models** — Early effect on the BJT, MOSFET levels beyond
  Shichman-Hodges, temperature sweeps.
- **More logic**: counters, registers, decoders, memory.

## Testing

```sh
cargo test --workspace     # engine
cd web && npm run check    # types
```

The engine's integration tests check circuits against answers derived independently:
RC and RL step responses against the closed-form exponential, an LC tank against
conservation of energy, a MOSFET's saturation current against the Shichman-Hodges
equation, a BJT's operating point against hand analysis, and a NAND gate's output
against its truth table at every sampled instant.

## Contributing

Issues and pull requests welcome. The engine is deliberately independent of the web
app — `repath-core` is a normal Rust crate with no web dependencies, so it can be
used on its own or wrapped in a different front end.

## Licence

MIT. See [LICENSE](LICENSE).
