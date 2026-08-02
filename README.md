# repath

A free, open source, mixed-signal circuit simulator that runs entirely in your browser.

[![CI](https://github.com/Agustin-Delgado/repath/actions/workflows/ci.yml/badge.svg)](https://github.com/Agustin-Delgado/repath/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Engine: Rust + WebAssembly](https://img.shields.io/badge/engine-Rust%20%2B%20WebAssembly-orange.svg)](crates/repath-core)

Analog and digital in the same schematic. Draw a comparator into a NAND gate and it
works — repath figures out where the two domains meet and inserts the converters
itself.

![A sine wave driving an inverter, whose output drives an RC network. Wires are
coloured by voltage; the scope below shows both analog traces and the digital
rails they resolve to, with a playhead partway through the
run.](docs/screenshot.png)

<sub>A 10 kHz sine into a logic inverter, its output filtered by an RC. One
schematic, both domains, no converters placed by hand.</sub>

- **MIT licensed.** Every feature, no accounts, no paywall.
- **No server.** The engine is WebAssembly; your circuits never leave your machine.
- **Real SPICE-class analysis.** Modified nodal analysis, Newton-Raphson, companion
  models, adaptive timestepping, and the convergence aids that make nonlinear
  circuits actually solve.
- **You can watch it work.** Wires coloured by voltage and current animated along
  them, derived from the simulation rather than decorated on top of it.
- **Shareable.** The whole circuit fits in a URL, so a link is a working circuit.

## Contents

- [Status](#status) · [Running it](#running-it) · [How it works](#how-it-works)
- [What is in the box](#what-is-in-the-box) · [Using the editor](#using-the-editor)
- [Roadmap](#roadmap) · [Testing](#testing) · [Contributing](#contributing)

## Status

Usable, and honest about what it does. The engine handles DC, transient, AC and
mixed-signal, and every claim in this file is covered by a test that checks the
answer against something derived independently. What is not here yet — subcircuits,
SPICE model import, a sparse solver — is in the [Roadmap](#roadmap) rather than
half-implemented.

## Running it

You need [Rust](https://rustup.rs), [Node](https://nodejs.org) 20+, and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack`).

```sh
git clone https://github.com/Agustin-Delgado/repath.git
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
web/src/lib/canvas    2D editor engine — viewport, layers, spatial index, tools
web/src/lib/schematic the circuit-specific half: symbols, netlist, drawing, tools
web                   SvelteKit shell, scope, component palette
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

### The frequency domain

AC analysis is a *small-signal* analysis. The operating point is solved first,
every nonlinear device linearizes around it, and the sweep then describes how a
small wiggle propagates — not what the circuit does when driven hard. An
amplifier biased into cutoff correctly reports no gain, which is the whole point
of doing it this way: the answer depends on the bias the circuit actually settled
at.

Each frequency builds a complex matrix — a capacitor stamps `jωC`, an inductor
`jωL`, a transistor the conductances it computed at the operating point — and
solves it. Phase is unwrapped afterwards, so a two-pole rolloff walks past −180°
instead of teleporting to +180° in the middle of the plot.

Set one source's **AC drive** to 1 to make it the input; everything else supplies
bias only.

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

### The editor

The canvas is its own small engine (`web/src/lib/canvas`), deliberately ignorant of
circuits so it can be tested without a browser and reused for anything else.

**Layered canvases.** Grid, schematic, live overlay and tool feedback each get
their own canvas. Dragging a selection rectangle repaints only the top one; a
playing animation repaints only the live one; the schematic underneath — which
may hold thousands of components — is never re-rasterized for either. Nothing
repaints at all until something calls `invalidate`.

**A spatial index.** Every question the editor asks is a spatial one: what is on
screen, what is under the cursor, what falls inside the marquee. A uniform grid
hash keeps those proportional to the answer rather than to the document. Items
carry a precise hit test alongside their bounding box, so a long diagonal wire is
pickable along the wire and not across the empty rectangle around it.

**Snapping**, which is most of what separates precise from fiddly. Three things
can be snapped to, in order of how much you probably meant them: pins, then
anywhere along an existing wire, then the grid. The radius is a screen-pixel
tolerance converted to world units, so the feel stays constant across zoom levels
instead of getting stickier as you zoom in.

**Wires are routed connections, not loose segments.** A wire is a polyline —
one thing you drew, one thing you select, move and delete. That is what lets two
things work that otherwise cannot: dragging a component brings its wires with it
and re-routes them, instead of leaving them behind holding nothing; and dragging
off a pin draws a connection without switching tools, which is the gesture people
reach for after dropping a part.

**The router** is A* over the grid, with costs rather than walls almost
everywhere. Only component bodies are real obstacles; crossing a wire, running
alongside one, and turning a corner are all expensive but possible, in that order
— running *along* an existing wire is worst, because two conductors on the same
line cannot be told apart. A router that refuses when the ideal path is blocked is
worse than one that produces a slightly ugly wire, so it always returns something.

**Tools as state machines.** Select, wire and place are separate objects with a
small protocol — pointer events in, overlay drawing out. None of them touches the
DOM, which is what keeps the pointer handling from collapsing back into one
function full of mode flags.

Text is drawn in screen space rather than scaled with the world: rasterizing a
glyph and then magnifying it is what makes canvas text look muddy.

### The live layer

A net has one voltage, so colouring wires by it is exact. Current is harder: the
engine knows what flows through each device, but a wire is only a connection, and
a net with several branches does not assign a current to each segment on its own.

It does once you look at the topology. Cut a wire in a tree-shaped net and the net
falls into two halves; that wire must carry whatever is injected on one side. So
each net gets a spanning tree, rooted at ground where there is one, and the device
currents accumulate from the leaves inward. That is exact for trees, which nets
nearly always are. Wires that close a loop are genuinely ambiguous — ideal wires in
parallel share current in no defined ratio — and are left alone rather than guessed
at.

Voltage uses a diverging scale: two hues with a neutral grey midpoint, no rainbow
and no hue in the middle. Zero volts is drawn in the ordinary wire grey, so colour
appears only where there is something to say. The poles were checked rather than
eyeballed — ΔE 22 under protanopia, 32 under tritanopia, 32 with normal vision,
all clearing 3:1 against the canvas — and colour is never the only channel, since
the same values are on the scope and in the readout.

## What is in the box

| | |
|---|---|
| **Passive** | resistor, capacitor, inductor, ground |
| **Sources** | voltage and current, with DC / sine / pulse waveforms |
| **Semiconductors** | diode (silicon, LED, zener), NMOS, PMOS, NPN, PNP |
| **Analog** | op-amp with finite gain and rail saturation, voltage-controlled switch, VCVS, VCCS |
| **Logic** | AND, NAND, OR, NOR, XOR, NOT, D flip-flop, tri-state buffer, clock |
| **Analyses** | DC operating point, DC sweep, mixed-signal transient, AC frequency sweep |

## Using the editor

| | |
|---|---|
| Place a part | pick it in the palette, then click the canvas — `R` turns the ghost before you drop it |
| Connect two things | drag from one pin to another — no tool switch needed |
| Draw a wire | `W`, then drag; or click once per corner and finish on a pin |
| Hand-route a wire | hold `Shift` while drawing to bypass the router |
| Select | click, `Shift`-click to add, or drag a box around things |
| Rotate / delete | `R` / `Del` |
| Pan | middle-drag, or `Alt`-drag |
| Zoom | scroll — `Shift`-scroll pans sideways |
| Fit to the drawing | `F` |
| Back to selecting | `V` or `Esc` |
| Copy / cut / paste | `Ctrl+C` / `Ctrl+X` / `Ctrl+V` — paste lands at the cursor |
| Duplicate | `Ctrl+D` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Play / pause the overlay | `Space` |
| Plot a net | tick it in the Signals list |

Wires and pins snap: aim near a pin and the endpoint lands on it exactly, with the
pin's name shown so you can see what you are about to connect to. Dragging a part
until one of its pins is near another's snaps them together, so two components can
be joined without a wire between them. Hovering highlights the whole net, not just
the segment under the cursor.

Moving keeps connections. A dragged component brings its wires along and they
re-route; a dragged *wire* stays plugged into whatever it was plugged into and
grows legs to reach. The shape you see mid-drag is the shape you get on release —
the same router runs in both cases, so nothing rearranges itself when you let go.

Values accept engineering notation: `4k7`, `4.7k`, `10u`, `1meg`, `100n`.

## Roadmap

The full list — including every known limitation and what is deliberately out of
scope — is in [BACKLOG.md](BACKLOG.md). The headlines, roughly in order of how
much they would change what repath is good for:

- **SPICE model import.** Reading `.model` and `.subckt` from a manufacturer's
  datasheet is the difference between a toy and a tool.
- **Subcircuits.** Draw a block once, use it everywhere, nest it.
- **Sparse matrix solver.** The dense LU is fine to a few hundred nodes and then it
  is not.
- **Dirty-rectangle repaint.** Layer-level invalidation plus viewport culling
  covers most of the benefit today; per-region repaint is the next step up.
- **Noise and distortion analysis**, once AC has proved itself.
- **Netlist import/export** in SPICE format.
- **Richer device models** — Early effect on the BJT, MOSFET levels beyond
  Shichman-Hodges, temperature sweeps.
- **More logic**: counters, registers, decoders, memory.

## Testing

```sh
cargo test --workspace     # engine
cd web && npm test         # canvas engine
cd web && npm run check    # types
```

The engine's integration tests check circuits against answers derived independently:
RC and RL step responses against the closed-form exponential, an LC tank against
conservation of energy, a MOSFET's saturation current against the Shichman-Hodges
equation, a BJT's operating point against hand analysis, and a NAND gate's output
against its truth table at every sampled instant.

The frequency-domain tests are the same idea: an RC low-pass has to be −3 dB and
exactly −45° at its corner, roll off 20 dB per decade, and settle at −90°; a
series RLC has to peak at its resonant frequency with the Q its component values
imply; and a common-emitter amplifier has to lose its gain when its base bias is
taken away — which only happens if the sweep really is linearizing around the
operating point.

## Contributing

Issues and pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how
the project is laid out, what the tests expect, and the one rule that matters most
here: a wrong answer delivered confidently is worse than no answer, so anything
touching the engine needs a test that checks it against something derived
independently.

The engine is deliberately independent of the web app — `repath-core` is a normal
Rust crate with no web dependencies, so it can be used on its own or wrapped in a
different front end.

If you are looking for somewhere to start, [BACKLOG.md](BACKLOG.md) is the whole
list, sorted, with the reasoning for each item and an honest table of what is
deliberately simplified.

## Licence

MIT. See [LICENSE](LICENSE).
