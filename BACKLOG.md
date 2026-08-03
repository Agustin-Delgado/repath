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
| BJT | No junction capacitances (`CJE`, `CJC`) | AC response has no transistor rolloff; bandwidth looks infinite |
| MOSFET | Shichman-Hodges (level 1) only, bulk tied to source, no gate capacitances | No body effect, no subthreshold conduction, no short-channel behaviour |
| Diode | No series resistance or junction capacitance | Forward drop at high current is optimistic; switching is instantaneous |
| Switch | AC stamp ignores the control-voltage dependence | Correct for a switch used as a switch, wrong for one used as a modulator |
| Op-amp | Single-pole-free: infinite bandwidth, no slew limit, no input offset | An op-amp circuit will look better than the real one |
| Solver | Dense LU | Fine to a few hundred nodes, quadratic-ish past that |
| Digital | No setup/hold checking, no X-propagation through timing | A metastable design simulates as if it were fine |
| Editor | A wire is consumed when a drag lands its two pins on the same point | Separating them again leaves both bare; the wire is not restored |
| LED | Reverse breakdown not modelled | A real LED dies a few volts backwards; here it simply blocks |
| LED | Failure is thermal-free: one dose rule, no junction temperature | A part in still air and one on a heatsink fail at the same instant |
| Animation | BJT base current approximated as zero when distributing wire current | Base-net current dots are missing rather than wrong |
| Animation | Wires closing a loop show no current | Genuinely undefined for ideal wires in parallel; shown as nothing rather than guessed |
| Canvas | Layer-level invalidation, no dirty rectangles | A full-screen repaint per interaction on the affected layer |
| Editor | No touch or pen input | Unusable on a tablet |
| Editor | Deleting heals a gap only for a two-pin part wired on both sides | Anything with three pins leaves stubs, since no pairing is obviously right |
| Editor | History still stores whole-document snapshots | Bounded now (100 entries or 8 MB, whichever comes first) but not a delta log |
| Router | Widening the search box is a fixed ladder (12 then 40 cells) | An obstacle wider than 40 cells is still routed through rather than around |

---

## The direction

Towards a simulator someone would check a design against, not one they would
play with. The bottleneck for that is not the editor — it is how much of a real
device the models know about, and how many real devices there are. In order,
because each step is what makes the next one worth having:

1. **Parasitics in the devices already here.** Early voltage, junction and gate
   capacitances, diode series resistance. Cheapest credibility per line of code,
   and it is what the rows above are mostly complaining about. *(Early effect and
   channel-length modulation done; the capacitances are next, and they are what
   gives an AC sweep its rolloff.)*
2. **`.model` import.** A SPICE model card is one line of the parameters step 1
   adds, so a real 1N4148 or 2N3904 becomes a paste from the manufacturer rather
   than a part someone has to hand-write here.
3. **Subcircuits**, then `.subckt` import. This is what turns "has an op-amp"
   into "has the op-amp you are going to buy", with its bandwidth and its slew
   rate, and it is the only way a library grows past what fits in one file.
4. **Sparse solver.** Dense LU is fine to a few hundred nodes and quadratic-ish
   past that. It matters once steps 2 and 3 bring circuits big enough to feel it,
   which is why it is fourth and not first.
5. **Measurement.** Parameter sweep, noise, Fourier and THD, and a scope with
   triggering and cursors that reports rise time and RMS rather than leaving them
   to be eyeballed.

## Must

### Engine

- [ ] **SPICE model import** — parse `.model` and `.subckt` from a manufacturer's
      datasheet. This is the single biggest gap between a toy and a tool: without
      it, every part is a generic approximation.
- [ ] **Subcircuits** — draw a block once, reuse it, nest it. Needed before any
      circuit larger than a page is bearable.
- [ ] **Sparse matrix solver** (KLU-style, or at least a sparse LU with Markowitz
      pivoting). The `LinearSystem` interface was kept narrow for this.
- [ ] **Junction and gate capacitances** on every nonlinear device — `CJE`/`CJC`
      on the BJT, `CGS`/`CGD` on the MOSFET, `CJ0` on the diode. Without them every
      AC answer above a few hundred kHz is wrong and switching is instantaneous.
      Needs charge-based integration on a device that is already nonlinear, which
      is the part that makes it a job rather than a parameter.
- [ ] **Diode series resistance** (`RS`). Solved against the junction rather than
      given an internal node, so the element count stays put.
- [ ] **Op-amp with a finite gain-bandwidth product.** The current ideal model
      makes unstable circuits look stable, which is actively misleading.
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
- [ ] **Monte Carlo** over component tolerances.
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
- [ ] **Measurement cursors** on the scope with delta readouts, and a "measure"
      panel: rise time, overshoot, RMS, frequency, duty.
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
- [ ] **Component tolerance and temperature coefficients** shown on the schematic.
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
- LEDs in five colours that light from the current through them and blow up when
  driven past their rating — modelled inside the transient loop, so a part that
  fails is open for the rest of the run and the waveforms after it are the circuit
  without it. The current animation stops when playback does.
