# Backlog

Everything known to be missing, wrong, or worth doing, sorted by MoSCoW.

The point of this file is that nothing lives only in someone's head. If a
limitation is not written down here, a user will find it before we do.

**Must** — 1.0 is not credible without it.
**Should** — significant value, not blocking.
**Could** — good if it comes cheap or someone wants it.
**Won't (this time)** — deliberately out of scope, with the reason.

---

## Known limitations

Not bugs — deliberate simplifications that a user could reasonably trip over.
Each one should either move into Must/Should below, or be documented in the UI.

| Area | Limitation | Impact |
|---|---|---|
| MOSFET | Shichman-Hodges (level 1) only, bulk tied to source | No body effect, no subthreshold conduction, no short-channel behaviour |
| MOSFET | Gate capacitances are constant, not the bias-dependent Meyer model | Right for a datasheet's Ciss/Crss/Coss; a gate charge curve will not have its plateau in quite the right place |
| Switch | AC stamp ignores the control-voltage dependence | Correct for a switch used as a switch, wrong for one used as a modulator |
| Op-amp | One pole, and no CMRR, PSRR or output current limit | Bandwidth, slew rate, offset, bias current and output resistance are modelled; a design that fails on common-mode rejection will not fail here |
| Temperature | One number for the whole circuit; no self-heating and no per-part rise | A resistor dissipating a watt is at the same temperature as the air around it |
| Probe | Voltage only; no current probe and no differential pair | Measuring a current means reading it off the component, not putting a probe in the branch |
| Monte Carlo | Uniform draws, no correlation between parts, no worst-case corner search | Two halves of a matched pair drift independently here, and a random sweep can miss a corner a deliberate search would find |
| Solver | Dense LU | Fine to a few hundred nodes, quadratic-ish past that |
| Digital | No setup/hold checking, no X-propagation through timing | A metastable design simulates as if it were fine |
| LED | Reverse breakdown not modelled | A real LED dies a few volts backwards; here it simply blocks |
| LED | Failure is thermal-free: one dose rule, no junction temperature | A part in still air and one on a heatsink fail at the same instant |
| Animation | BJT base current approximated as zero when distributing wire current | Base-net current dots are missing rather than wrong |
| Animation | Wires closing a loop show no current | Genuinely undefined for ideal wires in parallel; shown as nothing rather than guessed |
| Canvas | Layer-level invalidation, no dirty rectangles | A full-screen repaint per interaction on the affected layer |
| Editor | No touch or pen input | Unusable on a tablet |
| Editor | Deleting heals a gap only for a two-pin part wired on both sides | Anything with three pins leaves stubs, since no pairing is obviously right |
| Editor | History still stores whole-document snapshots | Bounded now (100 entries or 8 MB, whichever comes first) but not a delta log |
| Router | Widening the search box is a fixed ladder (12 then 40 cells) | An obstacle wider than 40 cells is still routed through rather than around |
| Subcircuit | An `X` line inside a definition is reported, not expanded | A subcircuit built out of other subcircuits imports as its outer layer only |
| Subcircuit | No current-controlled sources (`F`, `H`) for a definition to use | Some vendor macromodels cannot be built; the lines are named rather than dropped in silence |

---

## The direction

Towards a simulator someone would check a design against, not one they would
play with. The bottleneck for that is not the editor — it is how much of a real
device the models know about, and how many real devices there are. In order,
because each step is what makes the next one worth having:

1. **Parasitics in the devices already here.** Early voltage, junction and gate
   capacitances, diode series resistance. Cheapest credibility per line of code,
   and it is what the rows above are mostly complaining about. *(Done: Early effect, channel-length modulation, and charge
   storage in all three devices, so an amplifier has a top end and a switch takes
   time. The MOSFET's body diode came with it — the gate capacitances are what
   first made it possible to drag a drain past its own rail. Series resistance
   included, which is also what stopped a diode across a volt reporting nine
   amps.)*
2. **`.model` import.** A SPICE model card is one line of the parameters step 1
   adds, so a real 1N4148 or 2N3904 becomes a paste from the manufacturer rather
   than a part someone has to hand-write here. *(Done for the diode, BJT and
   MOSFET. What a card carries and this engine does not is named on the part
   rather than dropped in silence.)*
3. **Subcircuits**, then `.subckt` import. This is what turns "has an op-amp"
   into "has the op-amp you are going to buy", with its bandwidth and its slew
   rate, and it is the only way a library grows past what fits in one file.
   *(The import half is in: a `.subckt` pasted from a vendor's file becomes a
   placeable part, flattened into the netlist when the drawing compiles. Drawing
   your own block and reusing it is what is left.)*
4. **Sparse solver.** Dense LU is fine to a few hundred nodes and quadratic-ish
   past that. It matters once steps 2 and 3 bring circuits big enough to feel it,
   which is why it is fourth and not first.
5. **Measurement.** Parameter sweep, noise, Fourier and THD, and a scope with
   triggering and cursors that reports rise time and RMS rather than leaving them
   to be eyeballed.

## Must

### Engine

- [ ] **Subcircuits you draw** — turn a selection into a block, reuse it, nest it.
      Imported ones are in and share the machinery: a definition with ports, a
      generated symbol, and flattening at compile time. What is left is a body that
      comes from a drawing rather than from pasted text, and somewhere to edit it.
      Needed before any circuit larger than a page is bearable.
- [ ] **Current-controlled sources** (`F`, `H`), which some vendor macromodels
      need before they will build.
- [ ] **Sparse matrix solver** (KLU-style, or at least a sparse LU with Markowitz
      pivoting). The `LinearSystem` interface was kept narrow for this.
- [ ] **Meyer gate capacitance** on the MOSFET — the channel charge split that
      makes `CGS` and `CGD` follow the operating region instead of sitting still.
      What a gate charge curve needs; the constant values are already enough for
      Miller and for a switching time.
- [ ] **Convergence diagnostics** — when a solve fails, say *which node* and *which
      device* stopped converging, not just that it did.

### Editor

- [ ] **Touch and pen input.** Pointer events are already used throughout, so this
      is mostly gesture design: pinch-zoom, two-finger pan, long-press menu.
- [ ] **Keyboard-only editing and screen reader support.** Currently the canvas is
      opaque to assistive technology. At minimum: tab through components, announce
      selection, edit values from the inspector without a mouse.
- [ ] **Errors that point at the circuit.** "Singular matrix near v(n3)" should
      highlight that net on the canvas, not just print a name the user never chose.
- [ ] **Wire editing, the rest of it** — splitting a run in two, and deleting a
      single corner. Dragging a leg to reshape a wire is done; these are not.

### Product

- [ ] **A real file format** with a version field and a migration path. `share.ts`
      has one; the save file does not.
- [ ] **Performance budget and benchmarks** — a 500-component circuit that pans at
      60 fps and simulates in under a second, measured in CI rather than assumed.

---

## Should

### Analyses

- [ ] **DC sweep in the UI.** The engine has `dc_sweep`; nothing exposes it. I-V
      curves are one of the most instructive things a simulator can draw.
- [ ] **Noise analysis** (thermal and shot), reported as spectral density and
      integrated over a band.
- [ ] **FFT of a transient trace**, so a distortion question can be answered
      without leaving the app.
- [ ] **Parameter sweeps** — run the same analysis across a range of a component
      value and overlay the results.
- [ ] **Operating point display on the schematic** — node voltages and branch
      currents annotated in place, which is how people actually debug bias.
- [ ] **Transfer function / input and output impedance** at a port.

### Components

- [ ] Potentiometer, trimmer, variable capacitor.
- [ ] Transformer and coupled inductors.
- [ ] Relay, pushbutton, SPDT switch.
- [ ] Crystal / resonator.
- [ ] Voltage-controlled oscillator, comparator with hysteresis.
- [ ] Counters, shift registers, decoders, multiplexers, RAM/ROM.
- [ ] 7-segment display and bar graph, built on the LED that already lights.
- [ ] Current-controlled sources (`F` and `H`) to complete the set.
- [ ] Ideal transmission line.

### Editor

- [ ] **Text labels and net names on the schematic** — naming a net beats reading
      `n7`, and named nets are how you avoid drawing a wire across the page.
- [ ] **Buses** for digital, with `d[7:0]` notation.
- [ ] **Align and distribute** on a multi-selection.
- [ ] **Component search** in the palette; it will not stay small.
- [ ] **A trigger and a timebase**, so a repeating waveform holds still instead
      of being read from wherever the run happened to start, and so a corner of it
      can be zoomed into. Vertical is done — gain, position, split scales, two
      cursors and a measure panel; horizontal is not.
- [ ] **Current and differential probes**, not just node voltages.
- [ ] **Export** — PNG/SVG of the schematic, CSV of the traces, SPICE netlist out.
- [ ] **Print / PDF** of a schematic that looks like a schematic.
- [ ] **Snapshot comparison** — overlay the previous run's traces to see what a
      change did.

### Quality

- [ ] **Dirty-rectangle repaint** in the canvas engine.
- [ ] **Property-based tests** for the router: any two points, any obstacle field,
      the result is orthogonal, connected, and lands on both endpoints.
- [ ] **Golden-file regression tests** for the analyses, so a numerical change is
      noticed rather than discovered.
- [ ] **Browser test suite in CI** (Playwright), covering the interactions that are
      currently only verified by hand.
- [ ] **Fuzz the netlist compiler** — no input should panic the engine.

---

## Could

- [ ] **Light theme**, and a high-contrast mode.
- [ ] **Spanish and other translations.** The audience for a free simulator is not
      only English-speaking.
- [ ] **Guided lessons** — a circuit plus a question, for people learning rather
      than designing.
- [ ] **Circuit gallery** with shareable links, seeded with classic circuits.
- [ ] **Assertions** — "v(out) must stay under 5 V", checked during the run, so a
      circuit can have a test bench.
- [ ] **Behavioural sources** with an arbitrary expression (SPICE `B` elements).
- [ ] **Verilog-A-lite** for user-defined devices.
- [ ] **Plugin API** for third-party component libraries.
- [ ] **Real-time collaboration** on a schematic.
- [ ] **Local persistence** — reopen where you left off, and keep a few recent
      circuits.
- [ ] **Tolerance and tempco shown on the schematic**, rather than only in the
      inspector.
- [ ] **Auto-arrange** a netlist into a readable schematic.
- [ ] **Dark-mode-aware PNG export** — light background for printing.
- [ ] **Engine as a published crate** on crates.io, and as an npm package, for
      people who want the solver without the editor.
- [ ] **Headless CLI** — `repath run circuit.json` for scripting and CI.

---

## Won't (this time)

| Item | Why not |
|---|---|
| PCB layout and routing | A different product. KiCad exists and is excellent; competing with it would sink both halves. |
| 3D visualisation | Looks impressive, teaches nothing about circuits. |
| Cloud accounts and server-side storage | The promise is that circuits never leave your machine. Links and files cover sharing. |
| Proprietary/encrypted model formats | Cannot be supported in an MIT project, and encourages exactly the lock-in this exists to avoid. |
| Electromagnetic / field simulation | Different mathematics, different audience, no overlap with the lumped-element engine. |
| Mixed-mode Verilog/VHDL co-simulation | Enormous, and the event-driven domain already covers what a hobbyist needs. |
| Monetisation of any kind | Stated goal: free, all features, no accounts. Worth writing down so it does not drift. |

---

## Recently done

Kept short — it is here to show the direction, not to be a changelog.

- Mixed-signal engine: DC, transient, AC, event-driven digital, automatic bridges.
- Canvas rewritten as an editor engine: layers, spatial index, snapping, tools.
- Live overlay: voltage as colour, current animated from the simulation.
- Orthogonal routing that avoids obstacles; wires as polylines; drag-from-pin to
  connect; moving a component or a wire keeps every connection, with the drag
  preview and the released result computed by the same code.
- Circuits shareable as a link; copy, cut, paste, duplicate.
- Edits that refuse say why; undo restores the selection; a group rotates about
  its own centre; deleting a two-pin part closes the gap; wires reshape by
  dragging a leg.
- Escape cancels whatever gesture is in flight; a link that cannot be read says
  so instead of quietly showing the default circuit.
- A wire that would end in mid-air is turned away, shown as such while it is
  being drawn rather than only after.
- Every operation recorded as replayable text, so a report can be reproduced
  rather than reconstructed from a screenshot and a description.
- Drag routing decided by one cost function with the old path as an input,
  replacing five interacting rules about when to keep a shape and when to redraw.
- Moving a part keeps its connections whether or not they were drawn: two pins
  resting on each other are joined by a wire as a drag pulls them apart, so the
  same picture behaves the same way regardless of how it was built.
- Per-channel gain and vertical position, in the 1-2-5 steps a bench scope uses,
  with automatic still the default — a scope that fits everything for you is
  convenient and is not a scope.
- A measure panel: peak-to-peak, mean, true RMS, frequency, duty, rise time and
  overshoot, read off the trace rather than off two cursors and some arithmetic.
- Each trace can have a scale of its own, so 400 mV of ripple is not flattened by
  the 5 V square wave beside it, and a second cursor gives Δt and ΔV rather than
  two readings to subtract by hand.
- A probe you place where you want to measure, with a name you choose and its
  own colour on the drawing — so telling two traces apart is a matter of looking
  at the schematic rather than holding a legend in your head.
- Signals on the scope are named after what they join — `V1.+ · R1.a` rather than
  `n1` — and pointing at one lights that net up on the drawing.
- A tolerance sweep: many samples at once, shaded on the scope as the band the
  answer moves in, so the question stops being "does it work with these parts"
  and starts being "does it work with the parts I will be sent".
- Parts have a tolerance, and a sample button that draws every one of them from
  inside its band and holds it there for the run. Repeatable from a seed, so a
  sample is a thing you can re-run, share and quote — one run at nominal is the
  circuit nobody has ever built.
- One temperature for the whole circuit, and every junction drop, bipolar gain
  and resistance moves with it. A diode loses two millivolts per degree, leakage
  doubles every ten, and the common-emitter example walks its bias across the
  room — which is the reason nobody biases one that way.
- Diodes have a bulk resistance, so the forward curve bends away from the
  exponential where a real one does instead of climbing forever, and breakdown is
  damped like conduction rather than running off the end of `exp`.
- The op-amp is a macromodel rather than an ideal: gain-bandwidth product, slew
  rate, output resistance, input offset and input bias current, all falling out
  of a transconductance into a compensated gain node. Every op-amp circuit here
  used to look better than the real one.
- A `.subckt` pasted from a vendor's file becomes a part you can place, flattened
  into the circuit it stands for when the drawing compiles — so an op-amp can be
  the one you are going to buy, with a bandwidth of its own, rather than an ideal.
- A part can be a `.model` card pasted from the manufacturer instead of a row of
  numbers transcribed by hand, kept as the text it arrived as so it survives a
  save and a share link. What the card carries and this engine does not model is
  named on the part.
- Devices that store charge: junction capacitances and transit times on the BJT,
  terminal capacitances and a body diode on the MOSFET. An amplifier now runs out
  of gain at the top, a transistor takes time to switch, and a drain cannot be
  dragged past its own rail.
- LEDs in five colours that light from the current through them and blow up when
  driven past their rating — modelled inside the transient loop, so a part that
  fails is open for the rest of the run and the waveforms after it are the circuit
  without it. The current animation stops when playback does.
