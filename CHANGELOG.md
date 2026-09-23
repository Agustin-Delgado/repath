# What changed, and why you might care

The story of repath from the user's side, newest first. Each entry says what
you can do now that you could not before, or what stopped going wrong, and
points at the pull request that did it. The technical account — what was wrong
underneath, how it was measured, what the tests check — lives in those pull
requests; this file is the tour.

Before 30 August 2026 the project had no pull requests, only commits, so the
early entries point at those instead.

---

## 23 September 2026 — Fuses, transformers and memory

**A fuse that blows.** It carries its rating for ever; past that it heats by
the `I²t` its datasheet prints, opens, and stays open for the rest of the run,
charred on the drawing like a burnt LED.

**Transformers and coupled inductors.** Two windings, a turns ratio and how
tightly they are coupled. A sine goes across stepped up or down, DC does not.

**A variable capacitor**, set between its smallest and largest value like a
potentiometer's wiper.

**A four-digit seven-segment display**, twelve pins for thirty-two LEDs, lit
one digit at a time. LEDs now cool down between bursts, so a segment driven at
four times its rating a quarter of the time lives, as it does on a real board,
while one held on at that current still dies.

**Memory.** The 6116 and 62256 static RAMs, and the 28C16 and 28C256 EEPROMs,
whose contents you type in the inspector as hex. The **EEPROM and a scanned
display** example uses one as the lookup table for four digits showing 1 2 3 4.
[#63](https://github.com/Agustin-Delgado/repath/pull/63)

---

## 23 September 2026 — Parts that follow their supply

**A sagging supply sags the parts on it.** An op-amp package's output stops
short of its supply as it is at that moment, not as it was when the run
started, and a Schmitt trigger switches at its share of the supply it has now.
Run an LM358 from a battery going flat and watch its ceiling come down with it.

**Regulators that protect themselves, and ones that go below ground.** Short
a 7805 and about an amp and a half flows rather than as much as the input can
give; the limit is a field of its own. The 7905, 7912 and 7915 hold their
output that far below ground.

**The L293D**, for driving a motor either way round from two logic pins, with
the clamp diodes that give its back-EMF somewhere to go.
[#62](https://github.com/Agustin-Delgado/repath/pull/62)

---

## 23 September 2026 — Chips that are not all logic

**The 555.** Wire it astable and it blinks at the rate the datasheet formula
gives; tie RESET low and it stops. There is a **555 blinker** example to start
from.

**Op-amps and comparators as the parts you buy.** The LM358 and LM324 for a
single supply, the TL072 and TL074 for a split one, and the LM741. Each one
clips where its supply says: a 5 V LM358 will not give you 5 V out. The LM393
and LM339 comparators pull their output down and need a pull-up, as the real
ones do.

**Schmitt triggers.** The 7414, 74132, 40106 and 4093 switch at two
thresholds, so a slow or noisy input gives one clean edge — and one gate with a
resistor and a capacitor is an oscillator.

**Switches, drivers and regulators.** The 4066 analog switch, the ULN2003 for
relays and motors, and a regulator part that is a 7805, 7809, 7812, 7815 or an
LM317 you set with two resistors. It drops out when the input gets too close
to the output, and draws its own few milliamps.

**An op-amp that settled nowhere now settles.** A follower on a single supply —
an op-amp whose lowest output is at ground, with its output wired straight
back to its input — could fail to find its starting point at all. It now gets
there.
[#61](https://github.com/Agustin-Delgado/repath/pull/61)

---

## 23 September 2026 — Sixty chips, and the parts around them

**Chips.** Twenty-seven more, which makes sixty, each on the legs its
datasheet gives it:
- Counters: the 74163 (synchronous clear), the 74193 up/down, the 4017 decade
  counter with ten outputs, and the 4040 twelve-stage ripple counter.
- Shift registers: the 74164 and 74165, the 74194 that shifts both ways, and
  the 74595 that every LED project chains.
- Decoders and friends: the 74139, the 74148 priority encoder, the 4028 and
  the 74153.
- Arithmetic: the 74283 four-bit adder and the 7485 comparator, which chains.
- Parts that let go of a wire, so several can share one: the 74125/74126
  buffers, the 74244 and 74245 bus drivers, the 74373 latch and the 74374
  register.
- Also: JK flip-flops that act on the falling edge (7473, 74107, 74112), the
  7411 and 7430, and the 4049/4050 buffers.
- The Chips shelf is filed by job — gates, flip-flops, counters, shift
  registers and so on — so "a counter" can be found without knowing it is
  called 4017.

**Parts.**
- A potentiometer (search "trimmer" too), set by where its wiper sits.
- A changeover switch that you throw with a click, like the plain one.
- A relay, whose contacts move when enough current runs through its coil.
- A crystal that rings at the frequency on its label, a battery that sags
  under load, a lamp, and a ten-bar LED bar graph.
- The diode's Schottky preset has its own symbol, and the diode answers to
  1N4148, 1N4007, 1N4733 and 1N5819.
[#60](https://github.com/Agustin-Delgado/repath/pull/60)

---

## 22 September 2026 — Finding things by name

The catalog, the commands and the circuit itself all keep growing, and walking
through shelves and lists to find something stops working long before they
stop growing. So everything can now be asked for by name.

**Parts.**
- Press `/` and type — `7400`, `npn`, `cap`, `zener`, `74hc00` — and `Enter`
  puts the part in your hand. Parts answer to their number, their family and
  the words people use when they do not know ours.
- The parts you placed last wait at the top of the palette, and the shelves
  fold away; the chips start folded.

**Everything else.**
- `Ctrl+K` finds any part, any command and any example, with the keyboard
  shortcut written beside each one. `Ctrl+S` and `Ctrl+O` save and open, and
  `W` picks up the wire tool.
- The examples are shelved as analog, logic and mixed signal.

**A calmer screen.**
- One Run button. The transport under the drawing used to have a Run of its
  own that carried on instead of starting over; it now says **Resume**, and
  only when there is a stopped sweep to resume.
- The scope lists what it plots, with its knobs, and finds any other net by
  name under **Add a signal**, instead of listing every net in the circuit.
- The inspector keeps the device-physics values under **More settings**, and
  with nothing selected it shows what the circuit holds and the keys to know.
- Confirmations — a link copied, the steps copied — appear for a moment at
  the bottom instead of relabelling the button that was pressed.
[#59](https://github.com/Agustin-Delgado/repath/pull/59)

---

## 22 September 2026 — An audit, and what it fixed

A read of the whole code base for wrong answers, crashes and what would not
scale. What changed, from your side:

**Answers that were wrong are right.**
- Frequency sweeps of diode and LED circuits include the diode's series
  resistance; the gain was off by up to 2.3×.
- A chip whose supply or ground leg is missing, or tied to the wrong place,
  no longer simulates perfect logic: it says it is not powered, and its
  outputs read as undetermined.
- An imported `.subckt` keeps its DC values, and a line repath cannot read
  (a waveform, an expression, `POLY`) is reported instead of misread.
- Rise time, overshoot and duty cycle read correctly on steep edges and on
  captures that are not whole cycles.
- A shared link or saved file opens at the sender's temperature, logic
  family, tolerance sample and frequency range, not yours.
- A push-button released while still bouncing registers the release on time,
  and a logic input toggled during a run takes effect from that moment.

**Things that froze or crashed don't.**
- A loop of logic gates with no delay shows an error naming the nets instead
  of freezing the tab. An infinite sweep, a circuit too large for the solver
  or a model parameter of zero gets a clear message instead of killing the
  simulator.
- A broken or newer link is refused with a message instead of leaving the
  editor stuck. Two probes with the same name, or two imported parts whose
  names differ only in case, no longer break the scope or the palette.
- A tolerance sweep no longer freezes the page.

**Editing is safer.**
- Picking an example can be undone, and so can edits made inside a block
  after leaving it. Undo can no longer fire in the middle of a drag, and a
  refused edit no longer wipes redo.
- A part pasted onto a wire goes in series instead of being shorted, and two
  wires meeting on a third are never separated by tidying.
- Fields accept units: `5ms`, `10uF`, `4.7kΩ`. Typing a probe name is one
  undo step, not one per letter.
- Keyboard users can press buttons with Space, Ctrl+C copies selected text,
  and toggle buttons say whether they are pressed.

**Big drawings stay fast.** Routing, tidying and dragging on a page of
hundreds of chips and thousands of wires went from seconds to tens of
milliseconds; the scope draws only what it shows, never dropping a spike;
the animation sleeps when nothing is running. Time labels stay readable at
any point of a long run, a trackpad zooms the scope smoothly, and a long wire
crossing a zoomed-in view keeps its live colour.
[#58](https://github.com/Agustin-Delgado/repath/pull/58)

---

## 22 September 2026 — Your work is kept as you go

**Nothing is lost to a reload, a closed tab or a power cut.** Every change is
written to the browser as it happens, and the app opens where it was left:
the drawing, the probes, the run's settings, the scope's knobs, even a block
that was open for editing. After sharing, the changes made since the link
win over the link on a reload — they are newer, and they are yours — and
opening that link again elsewhere offers the link as it was sent, one click
away. Loading an example, a file or a different link starts a fresh draft
rather than writing over the one on screen, and two tabs never overwrite each
other. Nothing leaves your machine: the drafts live in the browser, like
everything else.
[#57](https://github.com/Agustin-Delgado/repath/pull/57)

---

## 21 September 2026 — A pasted box is a block of its own

**Copying a box copies the block.** Pasting or duplicating a box used to put
down a second copy of the same block, so renaming or editing the copy changed
the original too — which is what a copy is for, until it is copied to be
turned into something else. A pasted box now gets a definition of its own,
numbered after the original ("Second Hand 2") and ready to be renamed, with
the wires pasted alongside it still on its pins. Placing a block twice from
the palette is still the same block twice, and **Make its own block** (below)
parts those.
[#56](https://github.com/Agustin-Delgado/repath/pull/56)

---

## 21 September 2026 — A copy of a box can be made a block of its own

**Make its own block, in the inspector, gives one copy of a block a definition
of its own.** A second copy of a box is the same block twice, the way two 7400s
are the same chip — rename it or edit it inside and both change. That is what
a copy is for, until it is copied to be turned into something else: a "Second
Hand" duplicated to draw the minute hand from was renamed, and the second hand
was renamed with it. The inspector now says how many copies a box is one of,
and a copy can be made its own block — numbered after the original, to be
renamed — and edited without the others following.
[#55](https://github.com/Agustin-Delgado/repath/pull/55)

---

## 21 September 2026 — A box on its side wears its name in the middle

**A block's name, and a chip's part number, sit in the middle of a body turned
a quarter.** The name runs along the bottom edge, under the ports, and is
drawn upright whichever way the box is turned — so on a box turned on its
side it straddled a side edge, half of it outside. The middle of the body is
the one place clear of the ports either way, and that is where it goes now,
on a chip too.
[#54](https://github.com/Agustin-Delgado/repath/pull/54)

**Boxing up leaves no wire inside ending in mid-air.** A wire from a part's
pin that ended on the side of a wire leaving the parts came inside with them,
while the wire it met stayed out and was re-attached to the box: a stub
ending on nothing, which is exactly the wire the editor refuses to draw. The
port on that pin is the join now, and the stub is dropped.
[#54](https://github.com/Agustin-Delgado/repath/pull/54)

---

## 20 September 2026 — Boxing up a part wired round its own outside

**A box's pins are planted clear of a wire that loops round the parts.**
Boxing up three flip-flops of a counter was refused with "would put PWR10.v
on the same net as PWR11.v": one of them had its inverted output wired to
its own clock the long way round, past the right of the package, and the
box's right-hand pins were planted a fixed step outside the parts — exactly
the column that leg ran down. Five pins on one wire, five nets as one, and
the check that refuses such a box did its job. The pins now go past
everything wired inside, not just past the parts.
[#53](https://github.com/Agustin-Delgado/repath/pull/53)

Opening that box back up is still refused on that drawing — it was before
this, too — and is written up in the backlog.

---

## 20 September 2026 — Ctrl-click picks parts one at a time

**`Ctrl`-click adds a part to the selection, and takes it out again.** Only
`Shift` did that before, and `Ctrl` — the key every file browser uses for
the same thing — did nothing. Both work now, on a part, on a group's name
and around a box dragged over things; `Cmd` on a Mac too. A `Ctrl`-click
on empty space leaves the selection as it is.
[#52](https://github.com/Agustin-Delgado/repath/pull/52)

---

## 19 September 2026 — Boxing up never rewires the circuit

**Boxing parts up keeps every net apart, and says so if it cannot.** The
wires to a box's pins were routed against a page where the other wires to
the box were still in mid-air, so several inputs fed from the same side came
down the same column beside the box, each with a corner on the last, and
were one net when the box was done. They are routed one after another now,
each around the ones already drawn. And boxing up, like turning or dragging,
is checked afterwards against the circuit it started from: if the box would
join two nets in any way at all, nothing changes and a notice names them.
[#51](https://github.com/Agustin-Delgado/repath/pull/51)

**Opening a box up keeps every net apart too.** Two things could join nets
on the way out: a wire drawn across the box while the parts were away, which
a returning pin came down on, and a wire inside the box whose end happened
to sit exactly where a pin of the box had been, which was re-routed as if it
had been plugged into the box. The first is routed out of the way; the
second is left as it was drawn; and the same check refuses anything else.
[#51](https://github.com/Agustin-Delgado/repath/pull/51)

## 19 September 2026 — Arrange the pins on a box

**A block's pins can be moved from the inspector.** Under each port of a
selected block there are now three buttons: up and down move the pin a step
along its side of the box, and the arrow puts it on the other side (which
is what makes it an input or an output). Until now the only way was to open
the block and move or reconfigure the port parts inside; that still works,
and the order set here wins over where they sit. The wires follow the pins,
and every copy of the block follows.
[#50](https://github.com/Agustin-Delgado/repath/pull/50)

## 19 September 2026 — A longer name grows the box downward, and no wire runs under the outline

**A name on more lines grows the box downward only.** The extra lines go
under the ports, so the top edge and the pins stay where they were: nothing
above the box is covered, and no wire has to move.
[#49](https://github.com/Agustin-Delgado/repath/pull/49)

**A wire no longer runs along the inside of a box's outline.** A block's
outline sits a couple of units off the grid, and the router treated the grid
line just inside it as open — so a wire routed past the box could run right
under its edge, drawn over the outline. That line is the box's now.
[#49](https://github.com/Agustin-Delgado/repath/pull/49)

## 19 September 2026 — The box stops growing

**A long name goes on more lines, and the box has a widest.** A box grew as
wide as whatever it was called, so a block with a sentence for a name was a
box the width of the sheet with its pins a long way from anything. The name
now wraps at twenty characters, on up to three lines under the ports, with an
ellipsis where a longer one is cut short; the whole name is still in the
parts list. A port name is at most twenty characters, since it is printed on
the pin's own line where there is no room to wrap it.
[#48](https://github.com/Agustin-Delgado/repath/pull/48)

## 19 September 2026 — Old drawings meet the wider box

**A drawing saved before the box grew opens with its wires on the pins.** The
box that fits its name was wider than the one every earlier drawing was drawn
to, so a link or a file from before opened with each block's wires ending
inside the box, where its narrower pins had been, and the box drawn over them.
Those wires are now brought out to the pins as the drawing arrives, blocks
inside blocks included, and the drawing is the drawing it was.
[#47](https://github.com/Agustin-Delgado/repath/pull/47)

**A shared link opens on the circuit.** Following a link used to open on an
empty stretch of sheet, with the circuit wherever its author had left it and
nothing to say which way to look; the same for a file. The view now goes to
whatever arrives whole, as it already did for an example.
[#47](https://github.com/Agustin-Delgado/repath/pull/47)

## 19 September 2026 — A box that fits its name

**A block's box grows to fit its name, and its port names stay inside when it
is turned.** "Frequency Divisor" on a box sized for CLK and OUT ran past both
edges, and once the box was turned round the port names ran out through the
edges too — the text stays upright, and its anchor had not turned with it.
The inspector's port list also no longer runs off the side of the panel.
[#46](https://github.com/Agustin-Delgado/repath/pull/46)

## 18 September 2026 — Moving things never rewires them

**Turning or dragging a part cannot join two nets any more.** Turning a boxed
block used to send its wires straight through a chip's row of pins — eight nets
became one, with nothing on the page to say so. The router now treats every pin
and every corner of every other wire as a wall rather than a cost; if it cannot
get there at all it draws one straight leg from pin to pin, which joins nothing
and is plainly waiting to be tidied. What the router cannot prevent — a pin
landing on a wire as a part turns, or grazing one as it is dragged past — is
caught afterwards: what was joined to what is compared before and after, and a
turn or a drop that would change it is put back with a notice saying what it
would have joined. Dropping a pin onto another pin or a wire's end, the join the
snap dot announced, goes through as before.
[#45](https://github.com/Agustin-Delgado/repath/pull/45)

**Deleting a probe takes its wire with it.** A wire that led only to the part
that is gone goes too, back to the last junction still doing something, so a
deletion never leaves a wire with an end in mid-air.
[#45](https://github.com/Agustin-Delgado/repath/pull/45)

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
