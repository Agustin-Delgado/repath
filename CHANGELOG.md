# What changed, and why you might care

The story of repath from the user's side, newest first. Each entry says what
you can do now that you could not before, or what stopped going wrong, and
points at the pull request that did it. The technical account — what was wrong
underneath, how it was measured, what the tests check — lives in those pull
requests; this file is the tour.

Before 30 August 2026 the project had no pull requests, only commits, so the
early entries point at those instead.

---

## 18 September 2026 — Dots that stood still

**The current dots on a lamp no longer freeze for the rest of the run.** On a
counter with six LEDs, the first lamp's dots stood still while the second's
raced and then settled. A second into the run one lamp was lit and eleven
supply terminals were carrying the picoamp of leakage the solver always has,
so "full speed" was set to a picoamp, and the lit lamp was owed a billion
dot-spacings of travel it then paid off at exactly one spacing a frame — which
looks like nothing moving. Parts that carry nothing no longer get a vote on the
speed, and a wire can never be owed more than a fraction of a second of motion.
[#44](https://github.com/Agustin-Delgado/repath/pull/44)

## 16 September 2026 — Your own chips

**Box up a piece of the drawing and use it as a part.** Select the stage you
have just got working, press `B`, and it becomes one box with a pin for every
signal that crossed its edge. Place as many copies as you like from the new
**Blocks** section of the palette. Rename it, rename its pins, nest blocks inside
blocks; it goes into share links, saved files and the clipboard with the rest of
the drawing. The engine still sees every resistor and gate inside, so nothing
about the answer changes — only how much of it you have to look at.
[#40](https://github.com/Agustin-Delgado/repath/pull/40)

**Open a block and edit it on its own canvas.** Double-click a box (or **Edit
inside** in the inspector) and the screen becomes the inside of that block, with
the main drawing waiting behind a banner. Add parts, add or remove terminals —
the terminals are now little flags called ports that you draw and wire like any
other part — and every copy of the block picks up the change when you come back.
An output nobody has wired up yet still counts as an output, which is what a
decoder with a spare line needed. [#41](https://github.com/Agustin-Delgado/repath/pull/41)

**Going into a block takes the view with it.** Double-clicking used to leave you
staring at an empty corner of the page until you zoomed out. Now the view fits
the inside, and comes back to exactly where you were on the way out. Boxing up a
block whose ports crowded onto the same rows could also quietly join two of them
into one net; each port now keeps to its own.
[#42](https://github.com/Agustin-Delgado/repath/pull/42)

## 16 September 2026 — Groups, and symbols in your standard

**Group parts under a name.** Select a handful of parts, press `G`, and they get
a dashed frame with a label. Drag the label to move them together, double-click
it to rename, drag a part clear of the frame to take it out of the group, `U` to
dissolve the group. Groups travel in links, files and the clipboard.
[#37](https://github.com/Agustin-Delgado/repath/pull/37) ·
[#38](https://github.com/Agustin-Delgado/repath/pull/38) ·
[#39](https://github.com/Agustin-Delgado/repath/pull/39)

**Symbols drawn the way you learnt them.** A selector in the toolbar switches
every symbol between **ANSI** (zigzag resistors, shaped gates), **IEC** (boxes
with `&`, `≥1`, `=1`) and **GOST**. It is your setting, not the drawing's:
a link you share opens in whatever the reader prefers, and no pin moves, so
nothing about the wiring changes. Asked for in issue #26 by someone who could
not read their own circuit in the symbols we had.
[#35](https://github.com/Agustin-Delgado/repath/pull/35)

**Nudging a selection no longer shorts it out.** Moving a row of gates one cell
to the left could run their input wires along the whole row, through every other
pin, and join eight nets into one. A wire that cannot be re-routed in time now
keeps the shape it had, stretched to the new position.
[#36](https://github.com/Agustin-Delgado/repath/pull/36)

**Housekeeping.** The test suite moved to a private repository, mounted as a
submodule; a clone of the public repository still builds and type-checks, and the
contributing guide says what CI checks with and without it.
[#34](https://github.com/Agustin-Delgado/repath/pull/34)

## 14–15 September 2026 — Fast counters in real time

**A sixteen-stage counter now blinks its one-hertz LED once a second.** It used
to take twenty. The digital side of the engine now runs ahead of the analog
solver, so a ripple counter's thousands of gate events per second stop costing
the analog side a step each. Same drawing, same 4 s window: the engine kept 4.8%
of real time before, 100% after.
[#28](https://github.com/Agustin-Delgado/repath/pull/28)

**An LED on a fast net no longer drags the run down.** A net toggling faster
than the screen can show is averaged — the lamp glows at the brightness your eye
would see — and its edges are folded into a band on the scope, marked `busy`.
The four-lamp ripple counter example went from 17% of real time to 94%.
[#29](https://github.com/Agustin-Delgado/repath/pull/29)

**A long run stays fast.** After a minute of simulated time the sweep used to
slow down as its lanes filled with edges. Now the scope keeps only what it can
draw and looks things up instead of walking them.
[#30](https://github.com/Agustin-Delgado/repath/pull/30)

**A `1:1` speed, and a label that says what each speed means.** The speed
buttons were multiples of "a window every four seconds", which meant a 100 s
window ran 25× fast and a 5 ms window ran 800× slow, and nothing said so. `1:1`
is one simulated second per real second whatever the window; the panel now reads
`real time`, `25× real time`, `1/800 real time`.
[#31](https://github.com/Agustin-Delgado/repath/pull/31)

**The LEDs that stopped a counter.** An LED straight across a flip-flop's output
with no resistor clamped the node at 2 V, which the next stage read as "not a
High", and the counter stalled with the lamps glowing faintly. A logic input now
reads the node as it actually is, not the output that is trying to drive it — so
the same drawing behaves as it would on a bench (the LED burns out at 0.8 ms and
the counter carries on), and the compiler names the LED and suggests the
resistor. [#32](https://github.com/Agustin-Delgado/repath/pull/32)

**Right-click rotates.** A part, or the whole selection, or the part you are
about to place. And zooming the scope in at `1:1` no longer slows the sweep:
a 5 ms window went from keeping 45% of the clock to 99.9%.
[#33](https://github.com/Agustin-Delgado/repath/pull/33)

**The scope window holds still, and slow stages get measured.** Zoomed out on a
long run the trace used to jump every few frames as memory compacted; now the
window is the newest samples, steady. And a stage whose period is longer than
the sample memory — the top of a sixteen-stage counter — keeps a history of its
edges, so `measure` reports its 3.3 s period instead of nothing.
[#27](https://github.com/Agustin-Delgado/repath/pull/27)

## 12 September 2026 — Phones, arrow keys, and a scope you can turn

**Usable on a phone.** The drawing takes the whole screen, the palette and the
inspector slide in as drawers, and a row of buttons stands in for the keys. Two
fingers pan and zoom; one finger on empty space pans; a finger on a part drags
it, a finger on a pin draws a wire.
[#21](https://github.com/Agustin-Delgado/repath/pull/21)

**Arrow keys nudge the selection** one grid point, five with Shift. And dragging
a whole drawing — eight chips, 160 wires — went from half a second per frame to
sixteen milliseconds. [#22](https://github.com/Agustin-Delgado/repath/pull/22)

**A fast clock no longer locks the page.** Turning a clock up to 100 MHz used to
freeze the tab, because each frame waited for the engine to finish. Each frame
now gets a time budget; the sweep slows instead of the screen, and the indicator
says how much of the timebase is being kept. When the scope's memory cannot hold
the whole window, it says so in the corner instead of drawing a smear.
[#23](https://github.com/Agustin-Delgado/repath/pull/23)

**Frequency, period and duty for every logic lane** in the `measure` panel, and
`1/Δt` next to the cursors. On the counter: 5 kHz, 2.5 kHz, 1.25 kHz down the
chain, each at 50%. [#24](https://github.com/Agustin-Delgado/repath/pull/24)

**Wheel on the scope turns the timebase.** While running it changes the window
width without restarting the run (it used to wipe the trace); stopped, it zooms
about the pointer and a drag pans. Pinch does the same on a phone.
[#25](https://github.com/Agustin-Delgado/repath/pull/25)

**A Reset button** puts a run away: clock to zero, wires uncoloured, scope
empty, switches back where they are drawn.
[#20](https://github.com/Agustin-Delgado/repath/pull/20)

## 11 September 2026 — Pinouts checked against the datasheets

**Five chips had legs in the wrong place.** The CD4027 had its two halves
swapped; the 4000-series two-input gates, the 4002/4012, the 4023/4025 and the
74266 were written from memory and disagreed with their sheets. All corrected
against the manufacturers' documents, with a test pinning every leg that was
wrong. None of them computed anything different — but which leg does what is the
whole reason a chip is on the drawing.
[#18](https://github.com/Agustin-Delgado/repath/pull/18)

**A wire running along a chip's legs can now be clicked.** Tie J to K on a
flip-flop and the wire runs straight down the row of pins; every click used to
select the chip instead. A click now tests the chip's body, not its legs.
[#18](https://github.com/Agustin-Delgado/repath/pull/18)

**Junction dots stay visible during a run.** They were being painted under the
coloured wires. [#19](https://github.com/Agustin-Delgado/repath/pull/19)

## 2–4 September 2026 — The 74xx and 4000 families

**Real chips, with real pinouts.** Nobody builds with a loose NAND; they build
with a 7400, four of them in fourteen legs with VCC on 14 and GND on 7. A new
**Chips** section in the palette, drawn as DIP packages with the leg numbers
outside and the pin names inside, and the supply pins are pins — a chip you
forgot to power collects a warning like any unconnected pin.

- Eleven 74xx gates: 7400, 7402 (with its famous outputs-first pinout), 7404,
  7408, 7410, 7420, 7421, 7427, 7432, 7486, 74266.
  [#11](https://github.com/Agustin-Delgado/repath/pull/11)
- Eleven from the 4000 family, same gates on different legs, with VDD/VSS as
  their datasheets name them: 4001, 4002, 4011, 4012, 4023, 4025, 4069, 4070,
  4071, 4077, 4081. [#12](https://github.com/Agustin-Delgado/repath/pull/12)
- The four dual flip-flops — 7474, 4013, 7476 and the CD4027 that started the
  whole request — with a divide-by-two example.
  [#13](https://github.com/Agustin-Delgado/repath/pull/13) (the flip-flop first
  needed a preset pin, [#10](https://github.com/Agustin-Delgado/repath/pull/10))
- Chips that decide rather than compute: the 74138 decoder, the 74157 mux and
  the 4511 BCD-to-seven-segment driver, with a `bcd-display` example that reads
  **5**. [#14](https://github.com/Agustin-Delgado/repath/pull/14)
- The 7447 (the 4511 for common-anode digits, ripple blanking included), the
  74151 8-to-1 mux and the 74161 synchronous counter.
  [#15](https://github.com/Agustin-Delgado/repath/pull/15)
- The 7490 decade counter, which clocks on the falling edge and has its supply
  on pins 5 and 10 — not the corners.
  [#16](https://github.com/Agustin-Delgado/repath/pull/16)

Thirty-four chips in all. **The palette scrolls smoothly again** with them in
it: their fine print is skipped at icon size, and the icons finally show the
whole package rather than a clipped sliver.
[#17](https://github.com/Agustin-Delgado/repath/pull/17)

## 30–31 August 2026 — Flip-flops, a digit, and a site that deploys itself

**Flip-flop examples.** `flip-flop` (a D flip-flop with a toggle and a clock —
move the input mid-run and nothing happens until the next edge, which is the
lesson) and `ripple-counter` (four stages counting 0 to 15 on lamps).
[#1](https://github.com/Agustin-Delgado/repath/pull/1). Then `d-latch` and
`master-slave`, built from bare NAND gates, because the point is that a
flip-flop is not a part but a feedback loop.
[#6](https://github.com/Agustin-Delgado/repath/pull/6)

**A seven-segment display.** Eight LEDs in a package that spells a number,
common cathode or common anode as the datasheet says, with the current in each
bar shown separately. [#8](https://github.com/Agustin-Delgado/repath/pull/8) ·
[#9](https://github.com/Agustin-Delgado/repath/pull/9)

**Production deploys itself** when CI goes green on `main`, publishing the exact
build the tests ran against — the two flip-flop examples had sat merged and
green for a day without reaching the site.
[#4](https://github.com/Agustin-Delgado/repath/pull/4) ·
[#5](https://github.com/Agustin-Delgado/repath/pull/5) ·
[#7](https://github.com/Agustin-Delgado/repath/pull/7). The Rust toolchain is
pinned so a new compiler release cannot turn the repository red on its own.
[#2](https://github.com/Agustin-Delgado/repath/pull/2) ·
[#3](https://github.com/Agustin-Delgado/repath/pull/3)

## 28 August 2026 — Adders

Three adder examples with one rule: every output drives something and every
input is set by hand. `half-adder`, `adder-4bit` (ripple carry with propagate and
generate), and the `full-adder` that was already there now takes its inputs
from logic toggles.
[`a37b431`](https://github.com/Agustin-Delgado/repath/commit/a37b431). And a
fix for the lamps that sat at half brightness for a second after you flipped an
input mid-run.
[`a153301`](https://github.com/Agustin-Delgado/repath/commit/a153301)

## 14–15 August 2026 — A timeline that is an oscilloscope

**Click a switch mid-run and the waveform shows the step.** A click used to be
written as the switch's resting position and the whole run re-solved from zero,
so the trace came out flat at the new level. Now a click is an event at the
instant you made it.
[`4d5b66b`](https://github.com/Agustin-Delgado/repath/commit/4d5b66b)

**The timeline stopped being a video.** Time only goes forward: each frame asks
the engine for the next stretch and the engine carries on from where it was,
capacitor charges and flip-flop states intact. Nothing is recalculated, so
nothing repeats. [`fb44fae`](https://github.com/Agustin-Delgado/repath/commit/fb44fae)

**A transistor's current leaves by three legs.** The gate charge of a CMOS
inverter was drawn as coming out of the supply and arriving nowhere.
[`5dff112`](https://github.com/Agustin-Delgado/repath/commit/5dff112)

A run of fixes to the moving dots and readings from the reports that followed:
the dots no longer ring at the integrator's step rather than the circuit's
[`bb972be`](https://github.com/Agustin-Delgado/repath/commit/bb972be), they
follow the charge that moved rather than the instant the frame landed on
[`83374b5`](https://github.com/Agustin-Delgado/repath/commit/83374b5), a logic
edge happens when it happens rather than at the end of a step
[`31a3d38`](https://github.com/Agustin-Delgado/repath/commit/31a3d38), a
current reading cannot survive across a contact that has opened
[`3bd7e8b`](https://github.com/Agustin-Delgado/repath/commit/3bd7e8b), and a
reading belongs to the instant it was taken, not to wherever the playhead is
now [`16df6fa`](https://github.com/Agustin-Delgado/repath/commit/16df6fa).

Also: a pasted manufacturer `.model` card keeps the bulk resistance it used
to drop [`25f5d41`](https://github.com/Agustin-Delgado/repath/commit/25f5d41), a probe
survives saving and reloading
[`664152c`](https://github.com/Agustin-Delgado/repath/commit/664152c), an
imported subcircuit shows its current on the wires
[`f78272a`](https://github.com/Agustin-Delgado/repath/commit/f78272a), any net
can be chosen for the scope whether or not a wire hangs off it
[`49a83b7`](https://github.com/Agustin-Delgado/repath/commit/49a83b7), a
MOSFET's threshold drifts with temperature like the datasheet says
[`576e8e6`](https://github.com/Agustin-Delgado/repath/commit/576e8e6), and
every reactive element now asks the step controller for the resolution it needs
[`f45311f`](https://github.com/Agustin-Delgado/repath/commit/f45311f).

## 13 August 2026 — Switches, and somewhere to try it

**A public site.** [repath-lake.vercel.app](https://repath-lake.vercel.app):
nothing to install.
[`5e17ec9`](https://github.com/Agustin-Delgado/repath/commit/5e17ec9)

**A switch you can click** while the run is going, drawn in whatever position
the run has it, and a **logic toggle** that gives a gate a clean High or Low
without a pull-down resistor.
[`3630e17`](https://github.com/Agustin-Delgado/repath/commit/3630e17) ·
[`0120d76`](https://github.com/Agustin-Delgado/repath/commit/0120d76) ·
[`312512b`](https://github.com/Agustin-Delgado/repath/commit/312512b)

**A supply terminal counts as a reference.** A 5 V rail through two switches
into a NAND used to be refused for "no ground"; the supply's other end is the
ground, so the drawing was complete all along.
[`0243539`](https://github.com/Agustin-Delgado/repath/commit/0243539)

**Gates with three and four inputs**, because a three-input AND is a real part
and chaining two-input ones costs a propagation delay that changes the answer.
[`0ba8a9f`](https://github.com/Agustin-Delgado/repath/commit/0ba8a9f)

**The app opens on an empty sheet**, not on somebody else's circuit.
[`335dbb4`](https://github.com/Agustin-Delgado/repath/commit/335dbb4)

## 4 August 2026 — A scope with knobs, and parts you can buy

**Probes.** Drop one on a wire to measure from there, named after what you are
trying to find out. And nets are named after what is attached to them, so a
trace is called `V1.+ · R1.a` rather than `n1`, and pointing at one in the
list lights that net up on the drawing.
[`7077845`](https://github.com/Agustin-Delgado/repath/commit/7077845) ·
[`17fa25d`](https://github.com/Agustin-Delgado/repath/commit/17fa25d)

**A scope you can turn.** Each trace on its own scale, slid clear of the others;
cursors to measure against; and the numbers you would otherwise read by eye —
peak-to-peak, mean, true RMS, frequency, duty, rise time, overshoot — in a
panel. [`31abee2`](https://github.com/Agustin-Delgado/repath/commit/31abee2) ·
[`4682dee`](https://github.com/Agustin-Delgado/repath/commit/4682dee) ·
[`6e2170f`](https://github.com/Agustin-Delgado/repath/commit/6e2170f)

**Parts that are the part you are going to buy.** Paste a manufacturer's
`.model` card onto a diode or transistor, or a `.subckt` for an op-amp, and it
becomes that part — with the vendor's input impedance, output resistance and
pole, so a stage runs out of gain where the real one does.
[`91da75f`](https://github.com/Agustin-Delgado/repath/commit/91da75f) ·
[`ae74266`](https://github.com/Agustin-Delgado/repath/commit/ae74266)

**An op-amp that runs out of bandwidth and slew rate**, instead of an ideal that
made every op-amp circuit work better than the bench.
[`97c8089`](https://github.com/Agustin-Delgado/repath/commit/97c8089). A diode
with bulk resistance, so a rectifier's curve bends away from the exponential at
an amp. [`642f627`](https://github.com/Agustin-Delgado/repath/commit/642f627).
One diode part covering silicon, Schottky, germanium and zener, since they are
one equation with different numbers.
[`746f019`](https://github.com/Agustin-Delgado/repath/commit/746f019)

**Temperature.** One setting for the drawing, beside the run length, reaching
every device that has an opinion — does it still work in a cold car?
[`227bd42`](https://github.com/Agustin-Delgado/repath/commit/227bd42)

**Tolerances.** A 1% resistor is a 1% resistor; run the circuit with the parts
you are going to be sent rather than the ones on the label, and see where every
sample went. [`c536ff5`](https://github.com/Agustin-Delgado/repath/commit/c536ff5) ·
[`837152b`](https://github.com/Agustin-Delgado/repath/commit/837152b)

## 3 August 2026 — Parts that fail, and models worth checking against

**An LED driven past its rating burns out during the run**, not after it, so the
waveforms downstream describe the circuit that would actually exist.
[`a27ecbb`](https://github.com/Agustin-Delgado/repath/commit/a27ecbb) ·
[`9108579`](https://github.com/Agustin-Delgado/repath/commit/9108579)

**Transistors with an Early voltage** (a stage into a high impedance no longer
amplifies without limit), **junction and gate charge** (an amplifier no longer
keeps its gain to infinite frequency), and a diode that stores charge and takes
time to turn off. [`aaae808`](https://github.com/Agustin-Delgado/repath/commit/aaae808) ·
[`a9c5968`](https://github.com/Agustin-Delgado/repath/commit/a9c5968) ·
[`8f1eb74`](https://github.com/Agustin-Delgado/repath/commit/8f1eb74)

**Current arrows mean what they draw**, and a branch carrying one amp reads
`1.00 A`, not `1.00e+3 mA`.
[`5616056`](https://github.com/Agustin-Delgado/repath/commit/5616056)

**A value applies when you stop typing**, not when you press Enter.
[`c293476`](https://github.com/Agustin-Delgado/repath/commit/c293476)

**Two parts placed pin to pin leave a wire behind when you pull them apart**,
instead of disconnecting in silence.
[`2d31ee7`](https://github.com/Agustin-Delgado/repath/commit/2d31ee7)

## 2 August 2026 — Wires that behave

A day of reports about wires, each fixed the same day: a wire goes straight when
straight is available
[`d7055be`](https://github.com/Agustin-Delgado/repath/commit/d7055be), the first
drag settles rather than the second
[`b2d999a`](https://github.com/Agustin-Delgado/repath/commit/b2d999a), a wire
leaves a terminal the way it points
[`a791fa1`](https://github.com/Agustin-Delgado/repath/commit/a791fa1), a wire
that would end in mid-air is refused
[`b7881ed`](https://github.com/Agustin-Delgado/repath/commit/b7881ed), a wire
that ends up running along another is cut back
[`001c30e`](https://github.com/Agustin-Delgado/repath/commit/001c30e), a wire
splits where another one ends on it
[`ef28f52`](https://github.com/Agustin-Delgado/repath/commit/ef28f52), the
circuit no longer comes apart when things move
[`be994cc`](https://github.com/Agustin-Delgado/repath/commit/be994cc), only the
thing you dragged moves
[`65252be`](https://github.com/Agustin-Delgado/repath/commit/65252be), and a
junction stays standing when a pin walks away from it
[`43b08a0`](https://github.com/Agustin-Delgado/repath/commit/43b08a0).

**The wire mode is gone**: dragging off a pin draws a wire, so a mode that only
duplicated that gesture was a mode worth removing.
[`7e39c60`](https://github.com/Agustin-Delgado/repath/commit/7e39c60)

**Edit a value as a number and a scale.** Arrow keys step the number, Shift for
ten at a time, Alt for a tenth; the prefix is its own control.
[`ccb41ac`](https://github.com/Agustin-Delgado/repath/commit/ccb41ac)

**Simulate when asked, then keep up.** Nothing runs on load; press Run once and
the results follow every change to the circuit from then on.
[`dfe7051`](https://github.com/Agustin-Delgado/repath/commit/dfe7051)

Labels sit against their own symbol rather than floating at the height of the
tallest part in the catalogue.
[`8ba05d9`](https://github.com/Agustin-Delgado/repath/commit/8ba05d9)

## 1 August 2026 — The first day

A mixed-signal circuit simulator in the browser: a Rust engine compiled to
WebAssembly, a Svelte front end, nothing sent to any server.
[`ea0d5a7`](https://github.com/Agustin-Delgado/repath/commit/ea0d5a7)

By the end of the day it had a proper canvas with snapping and hit testing
[`da4850d`](https://github.com/Agustin-Delgado/repath/commit/da4850d), wires
coloured by voltage and current animated along them
[`f7594a9`](https://github.com/Agustin-Delgado/repath/commit/f7594a9), AC
analysis with Bode plots
[`b224fff`](https://github.com/Agustin-Delgado/repath/commit/b224fff), wires
that are routed connections rather than loose segments, so dragging a part keeps
it wired [`3127749`](https://github.com/Agustin-Delgado/repath/commit/3127749)
· [`8a608c0`](https://github.com/Agustin-Delgado/repath/commit/8a608c0), a
delete that heals the wire through a two-pin part and rotation that orbits
the selection's centre
[`2e37d00`](https://github.com/Agustin-Delgado/repath/commit/2e37d00), and an
Escape that actually cancels a drag
[`5c3c4e1`](https://github.com/Agustin-Delgado/repath/commit/5c3c4e1).
