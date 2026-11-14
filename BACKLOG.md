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
| Switch | A click during a sweep lands at the newest instant, never in the past | The run only goes forwards; to see an operation at a particular moment, schedule it and sweep through that moment |
| Supply | Each symbol is its own ideal source to ground, not a named net | Three on one rail is three currents rather than one, and two wired together build one source and a warning |
| Logic bridge | A tri-state net switching too fast to resolve is averaged as though it were always driven: its high-impedance intervals count as mid-rail through the bridge's output resistance | An LED or RC fed by a fast tri-state bus sits nearer mid-supply than it should; resolved edge by edge (slower nets, or a narrower window) it is right |
| Op-amp | One pole, and no CMRR, PSRR or output current limit | Bandwidth, slew rate, offset, bias current and output resistance are modelled; a design that fails on common-mode rejection will not fail here |
| Temperature | One number for the whole circuit; no self-heating and no per-part rise | A resistor dissipating a watt is at the same temperature as the air around it |
| Probe | Voltage only; no current probe and no differential pair | Measuring a current means reading it off the component, not putting a probe in the branch |
| Monte Carlo | Uniform draws, no correlation between parts, no worst-case corner search | Two halves of a matched pair drift independently here, and a random sweep can miss a corner a deliberate search would find |
| Solver | Dense LU | Fine to a few hundred nodes, quadratic-ish past that |
| Solver | The step controller steers by stored charge, never by a device's conduction | A signal small beside a junction's 26 mV converges at the default step; one that is not is under-resolved and nothing says so. A 10 mV sine into a bipolar base reads 2.29 V at the collector against 1.79 V solved properly, and the drive that binds the step is the waveform's own fifty-points-per-cycle rather than anything the transistor asked for. Tightening that heuristic is not the answer — five hundred points a cycle still reads 2.12 V — so the fix is a step control that watches the nonlinear current. Deliberately not taken: it is a heuristic rather than a truncation error — nothing there is integrated — and it would cost five to twenty times the steps on every nonlinear circuit, which is paid by the live animation. Until it is measured properly across a spread of circuits, a large-signal answer wants its step set by hand |
| Drawing | The live layer shows one number per frame, and a frame covers tens of microseconds of simulated time | An event shorter than a frame is drawn as its average rather than resolved: through a contact bouncing for 266 us, the reading beside the switch stays in the milliamps at 1x playback and falls to 110 uA at 0.25x, where the engine has picoamps. That average is deliberate — sampling one instant per frame drew a CMOS inverter as a dead circuit on almost every frame — but it is never taken across a change of state any more: the mean runs from the last digital transition inside the span, and a frame the playhead crosses an operated part on reads the instant. Before that, flipping an input of the half adder left both lamps at half brightness for about a second. The symbol keeps its actuated position throughout, which is the one thing about it that is stable and true; making the blade follow the frame instead was considered and refused, because at frame rate it would show some transitions and not others, and a symbol flickering four frames reads as a rendering fault rather than as data. The chatter is drawn sharp on the scope, which is where a sub-frame event belongs |
| Digital | An analog load on a net that is also an input of a feedback loop stops the loop settling | The four-NAND D latch with an LED straight off Q and QN sits at unknown on both outputs forever; take the lamps off and the same drawing settles to Q high, QN low in three gate delays. The loop is fine on its own — the engine walks a cross-coupled pair to a fixed point in two delta cycles, verified in `digital.rs` tests for both NAND and NOR — so it is the bridge to the analog side that costs the net its state. Both latch examples drive their lamps through a buffer, which is what a real board would do anyway, and that is a workaround rather than a fix |
| Digital | No setup/hold checking, no X-propagation through timing | A metastable design simulates as if it were fine |
| Digital | A logic input with no pull to either rail is refused rather than guessed | The gate is handed unknown and the node reads "floating"; what it would do on a real board depends on what its input capacitance picked up, which is not a thing to simulate |
| Digital | One logic family for the whole drawing, and no fan-out limit | Two families on one board is a real design, and here every input is free to drive |
| Digital | Gate delay is one number, the same for a rising and a falling edge | A real part is slower one way than the other, and slower again as it warms |
| Microcontroller | The ATmega328P only, and only its CPU, GPIO, external and pin-change interrupts, the three timers, USART0, the EEPROM and the ADC. The analog comparator, SPI and the watchdog are registers and nothing more: an SPI transfer finishes at once and shifts in nothing | A sketch that relies on the watchdog to reset it runs on. Each was made to finish rather than hang where a sketch waits on a flag, so the symptom is a wrong value, not a frozen chip — and the first time a program enables SPI or the TWI, reads the comparator or arms the watchdog, the run says so in the inspector and the issues box. |
| Microcontroller | The ADC is the ideal converter, floor(Vin × 1024 / Vref) taken at the datasheet's sample-and-hold instant, with no offset, gain or linearity error, and its inputs draw no current: the sample-and-hold capacitor does not load the source, the internal 1.1 V is exactly 1.1 V and needs no time to settle, and it is not driven out onto AREF. Conversions start from ADSC or run free; auto-triggering from a timer, the comparator or INT0, and the start on entering ADC noise reduction sleep, are not simulated, and neither is the temperature sensor, which reads 0 V. ADC6 and ADC7 are bonded out only on the surface-mount packages, so the part has neither | A divider of any impedance reads its exact voltage, where on a real chip a source above about 10 kΩ reads low just after the channel changes; a 1.1 V reference reads as nominal, not as the 1.0 to 1.2 V a given chip has. A sketch that triggers conversions from a timer gets only the ones it starts by writing ADSC, and is told so, as is one that reads the temperature sensor |
| Microcontroller | USART0's receiver counts its sample clock from each start edge, where the silicon's runs free and catches the edge up to a sample period late; synchronous (USART in SPI) mode is not simulated | Every sample is taken up to a sample period — a sixteenth of a bit, an eighth with U2X0 — earlier than on a real chip, so a sender off by nearly the datasheet's tolerance is received a little differently at the edge of it; a matched rate, the Uno's case, is received as on the bench |
| Microcontroller | The serial monitor sends through a USB-serial converter on D0, which lets go of the line until the first byte is typed and idles high from then on, as an Uno's does; through the board's 1 kΩ only where D0's net reaches something analog | Typing to a chip whose D0 is also driven by another chip's TX on a net that is only logic makes the net unknown wherever the two disagree, and the chip reads unknown as low; on a real Uno the other TX wins over the 1 kΩ and the typed text is lost. Put a resistor or anything analog on D0 for the two to fight as they would on the bench |
| Microcontroller | The EEPROM is erased, every byte 0xFF, at the start of every run, and kept only through a reset within one: nothing written survives to the next run, and the `.eep` file the toolchain writes for `EEMEM` data is not loaded. Its programming times are the datasheet's typical 3.4 ms and 1.8 ms, with no spread for voltage or temperature | A sketch that counts its boots in EEPROM starts from 255 every run; a write takes as long as on a typical chip |
| Microcontroller | The TWI is a master on an I2C bus with nothing else on it, since there are no I2C parts to put there: every address and data byte is NACKed and a byte read is 0xFF, with each START, STOP and byte taking its SCL periods at the rate TWBR and TWPS set. No slave modes, no arbitration, and the transfer is not driven onto SDA and SCL, which stay as the port leaves them — after `Wire.begin()`, two pull-ups | `Wire.endTransmission()` returns 2 and `Wire.requestFrom()` 0, after about the time the transfer takes, as on an Uno with nothing plugged in; an I2C display or sensor cannot be simulated, and a scope on A4/A5 shows an idle bus |
| Microcontroller | Every sleep mode sleeps like idle: the timers keep running | A sketch in power-down wakes on Timer0's overflow every 1.024 ms (the `millis()` interrupt) where real silicon would stay asleep until an external interrupt |
| Microcontroller | No start-up time after power-on or reset, no fuses, no CLKPR clock division, no bootloader: the program starts from address 0 on the first cycle, and the clock is whatever the part says | Edges come about 65 ms earlier than on an Uno, whose fuses wait that long for the crystal after power-on — and after the reset button, its bootloader listens for an upload first; a sketch that divides its own clock runs at the undivided rate |
| Microcontroller | Timer details not modelled: clocking from the T0/T1 pins (counts as stopped), Timer1's input capture (ICR1 works only as TOP), Timer2's asynchronous mode, and the prescaler reset in GTCCR. In the phase-correct modes a flag the datasheet sets on reaching TOP is set on leaving it, one timer clock later | Frequency counting with Timer1 and a 32 kHz watch crystal on Timer2 do not work; PWM periods and duty cycles are exact |
| Microcontroller | A pin is a logic level, with no drive strength, no current limit and no input synchroniser. An input that changes is seen by the first instruction starting in or after the cycle it changed in; a floating input reads the chip's own pull-up or 0, and an unknown one reads 0 | Shorting an output to ground does nothing to it; input latency is a cycle or two shorter than on the silicon, whose synchroniser delays a pin by half a cycle to a cycle and a half |
| Microcontroller | A timer edge that falls inside an instruction which also writes a pin is published after that write, up to four cycles late | A PWM edge that coincides with a pin write is up to four cycles late, and can come out after an edge it preceded; edges that do not coincide are on their cycle |
| Microcontroller | An external or pin-change interrupt flag is raised only while that interrupt is enabled, and an unknown opcode (erased flash included) stops the CPU with a fault instead of doing what the silicon does | A sketch polling EIFR or PCIFR with the interrupt off sees nothing; one that runs off the end of its program stops and says where, instead of wandering |
| Microcontroller | An input that comes from the analog side by a crossing nobody scheduled — an RC charging past the threshold, a comparator's input drifting — can reach the chip up to one analog step late. The digital side is run ahead to where the next step could end before that step is solved (never past a corner, so a switch, a button or a pulse is heard on time), and the chip cannot take back cycles it has already run when the step turns up the change | A sketch timing how long an RC takes to charge measures it up to a step ceiling long; buttons, switches and logic driven from the digital side are on their cycle |
| Microcontroller | The pull-ups are fixed resistors: 35 kΩ on a port pin, 45 kΩ on RESET, the middle of the datasheet's ranges. AVCC, AREF and the second ground are measured by the converter and draw no current, and the clock is a value in the inspector rather than a crystal on PB6 and PB7 | A sketch leaning on the pull-up works as on any real chip; one that times how fast it recovers through a capacitor is off by however far that part's resistor is from 35 kΩ. Leaving AVCC unwired is warned about, and `analogRead()` then returns 1023 for anything above ground, where a real chip with no AVCC would not convert at all |
| Microcontroller | A port pin is never called a floating input, since whether it drives, pulls up or does neither is up to the program at run time | An input with its pull-up off and nothing else on the net reads 0 with no warning, where the silicon would read whatever the pin picked up |
| Arduino Uno | The board as it runs from USB: 5V and 3V3 are ideal sources behind 0.5 Ω, GND is the circuit's ground, and VIN, the barrel jack and the regulator behind them do nothing. The 500 mA polyfuse is not modelled | A short across 5V draws whatever the 0.5 Ω allows and nothing trips; a sketch that runs off a battery on VIN runs exactly as on USB |
| Arduino Uno | Of the parts on the board only the L LED (pin 13 through an LMV358 follower and 1 kΩ, typical datasheet figures), the ON LED and the 10 kΩ reset pull-up are there. The TX and RX LEDs, the 16U2 USB-to-serial chip on pins 0 and 1 and AREF's capacitor are not | Pins 0 and 1 are free for anything, where on the real board the 16U2 holds them through 1 kΩ; serial reaches the inspector but blinks nothing |
| Arduino Uno | Pin 13 carries a 10 MΩ to ground that the board does not have, standing in for the pin's leakage and protection diodes, which are not modelled: without it the buffer's bias current alone ran an unwired pin 13 to kilovolts | Half a microamp at 5 V; an unwired pin 13 left as an input reads low with L dark, where a real one floats |
| LED | Reverse breakdown not modelled | A real LED dies a few volts backwards; here it simply blocks |
| LED | Failure is thermal-free: one dose rule, no junction temperature | A part in still air and one on a heatsink fail at the same instant |
| Animation | BJT base current approximated as zero when distributing wire current | Base-net current dots are missing rather than wrong |
| Animation | Wires closing a loop show no current | Genuinely undefined for ideal wires in parallel; shown as nothing rather than guessed |
| Animation | Speed is scaled to the 90th percentile of what is on screen, not the peak | A spike ten times everything else is drawn at full speed rather than flattening the rest of the circuit to a standstill |
| Canvas | Layer-level invalidation, no dirty rectangles | A full-screen repaint per interaction on the affected layer |
| Canvas | Labels are placed per part, with no collision avoidance between them | Two parts a symbol's width apart can have a name and a reading land on each other |
| Editor | No touch or pen input | Unusable on a tablet |
| Editor | Deleting heals a gap only for a two-pin part wired on both sides | Anything with three pins leaves stubs, since no pairing is obviously right |
| Editor | History still stores whole-document snapshots | Bounded now (100 entries or 8 MB, whichever comes first) but not a delta log |
| Router | Widening the search box is a fixed ladder (12 then 40 cells) | An obstacle wider than 40 cells is still routed through rather than around |
| Blocks | A box that grows wider (a longer name, a longer port name) grows over whatever stands beside it | The wires follow the pins; a part under the box has to be moved out by hand. A longer name only grows the box downward, under the ports, for the same reason |
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
   and it is what the rows above are mostly complaining about. *(Done: Early
   effect, channel-length modulation, and charge storage in all three devices, so
   an amplifier has a top end and a switch takes time. The MOSFET's body diode came with it — the gate capacitances are what
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
   *(Both halves are in: a `.subckt` pasted from a vendor's file becomes a
   placeable part, and a piece of the drawing boxes up as a block whose
   terminals are the ports drawn inside it, edited on its own canvas. Either is
   unfolded into the netlist when the drawing compiles.)*
4. **Sparse solver.** Dense LU is fine to a few hundred nodes and quadratic-ish
   past that. It matters once steps 2 and 3 bring circuits big enough to feel it,
   which is why it is fourth and not first.
5. **Measurement.** Parameter sweep, noise, Fourier and THD. *(The scope is
   mostly there: gain and position per channel, split scales, two cursors with
   deltas, and a panel that reads off frequency, duty, RMS, rise time and
   overshoot. A trigger and a timebase are what it still lacks.)*

## Must

### Engine

- [x] **Subcircuits you draw** — turn a selection into a block, reuse it, nest it.
      `B` boxes the selection up, a port inside is a pin on the box, double-click
      edits the inside on its own canvas for every copy at once, `U` opens it
      back up into the drawing, and the definition lives in the palette and
      travels with the drawing. Since #50 the inspector moves a pin up or down
      its column and across to the other side. *What is left:* ports go on the
      left and right only, never the top or bottom; a symbol of one's own for a
      block.
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
- [ ] **Opening a box on a crowded page.** On the counter drawing
      (`tests/web/fixtures/counter-with-gates.link`) boxing the three CD4027s
      up works and opening the box is refused — every one of nine selections
      tried is, on `main` as well, with a different pair of pins named each
      time. Two causes, both verified headless. The wires round the box were
      routed through where the parts stood, and the inside wires come back
      *as drawn* (`keep` in `open`): a port wire that went round the parts on
      an empty page now runs over corners of those outside wires, and a
      corner on a wire is a junction. And a port's own spot can be on an
      outside wire that runs past — the guard catches that one, but the
      re-routes then happen in a two-cell gap and come out as diagonal
      `lastResort` legs (seven of them on one selection). Routing the inside
      wires again between their own ends, with the outside wires as
      obstacles, opened four of the nine and left the diagonals; the honest
      fix is to drop the port wires on the way out and put the outside wires
      back on the pins the port was wired to, which is where they came from.

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

- [x] Potentiometer and trimmer, and a variable capacitor (the setting is an
      inspector value, not yet dragged live).
- [x] Transformer and coupled inductors: two windings, a turns ratio and a
      coupling. The core never saturates.
- [x] Relay, and an SPDT switch. The relay reads its coil current and has no
      armature delay or contact bounce.
- [x] Crystal / resonator, as the Butterworth–Van Dyke model.
- [ ] Voltage-controlled oscillator, comparator with hysteresis.
- [x] Counters, shift registers, decoders, encoders, multiplexers, adders,
      comparators and three-state bus parts, as 74xx and 4000-series chips,
      and byte-wide memory: the 6116 and 62256 RAMs, and the 28C16 and 28C256
      EEPROMs programmed as hex in the inspector, which a circuit can also write
      at the part's own pace: page loads, write time, data polling on I/O7.
      *What is left:* the toggle bit and software data protection.
- [x] 7-segment display, a four-digit multiplexed one, and a bar graph, built
      on the LED that already lights.
- [x] A fuse that blows on its `I²t` and stays open. It and the LEDs heat as
      two thermal masses, so a short kills fast, a small overload slowly, and a
      pulse rating from a datasheet is survived.
- [x] Chips with analog insides: the 555, op-amp packages (LM358, LM324,
      TL072, TL074, LM741), comparators (LM393, LM339), the 4066 switch and the
      ULN2003 and L293D, plus a 78xx/79xx/LM317 regulator part with its current
      limit. Amplifier rails and Schmitt thresholds follow the supply legs
      during the run. *What is left:* the 4066's control thresholds are still
      read off the supply once; the regulator has no thermal shutdown.
- [x] Schmitt-trigger inputs (7414, 74132, 40106, 4093), as inputs read against
      two thresholds by the bridge rather than hysteresis in the gate.
- [ ] Ideal transmission line.

### Editor

- [ ] **Text labels, and net names that join** — free text anywhere on the
      drawing, and a name that makes two distant points one net so a wire does not
      have to cross the page. A probe already names a signal for the scope; what
      it cannot do is connect anything.
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
      the result is connected, lands on both endpoints and joins nothing on the
      way (`joinsSomething`). Orthogonal too, except for the one case where nothing
      orthogonal could be found and it came out as a straight diagonal leg.
- [ ] **A router that never gives up.** When the search, both elbows and the old
      shape all run into something, the wire is drawn as one straight diagonal leg
      from pin to pin — safe, since the drawing's rules only see contact along a
      row or column, but not a drawing anyone wants. A search that widens out to a
      free lane beyond the drawing's extent would nearly always find a real route.
- [ ] **Golden-file regression tests** for the analyses, so a numerical change is
      noticed rather than discovered.
- [ ] **Browser checks in CI.** Playwright is a dev dependency and has found three
      shipped bugs — a dead overlay, a double-click that could not fire, a compiler
      case that never landed — none of which the other tests could see, because
      none of them opens a browser. Nothing in CI runs it yet.
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
