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
| Live edits | A value changed during a sweep — a resistance, a capacitance, an inductance, a source's level, a potentiometer's wiper or a variable capacitor's setting — lands at the newest instant, like a click on a switch, and everything solved before it stays as it was. A capacitor keeps its charge across the change and an inductor its flux, so turning a capacitance down raises the voltage across it, as on the bench. Anything else still starts the run again: a part or wire added, moved or removed, a type changed, a program loaded, the temperature, a source's frequency, timing or waveform shape, a resistor's temperature coefficients, a capacitor's initial voltage, a transformer's or fuse's values | Scrubbing back past an edit shows the samples solved with the old value, but the part's label and inspector show the value as it is now, since the drawing keeps one value per part. The edit instants are kept with the run (`retunes`), not in a `.repath` file, link or draft, so a reopened circuit starts from the newest values rather than replaying the turns. Left out of the versioned format on purpose: a document holds the circuit and how it is run, never a run — the samples and the switch operations are not in it either — and the retunes alone cannot replay one, since the drawing already holds the values they changed to and not the ones they changed from. Saving a run would mean a new format version carrying the starting netlist's values, the operations and the retunes together. A frequency changed live would make a sine's phase jump, which no real generator does, so it restarts on purpose |
| Supply | Each symbol is its own ideal source to ground, not a named net | Three on one rail is three currents rather than one, and two wired together build one source and a warning |
| Logic bridge | A tri-state net switching too fast to resolve is averaged as though it were always driven: its high-impedance intervals count as mid-rail through the bridge's output resistance | An LED or RC fed by a fast tri-state bus sits nearer mid-supply than it should; resolved edge by edge (slower nets, or a narrower window) it is right |
| Op-amp | One pole, and no CMRR, PSRR or output current limit | Bandwidth, slew rate, offset, bias current and output resistance are modelled; a design that fails on common-mode rejection will not fail here |
| Temperature | One number for the whole circuit; no self-heating and no per-part rise | A resistor dissipating a watt is at the same temperature as the air around it |
| Probe | Voltage only; no current probe and no differential pair | Measuring a current means reading it off the component, not putting a probe in the branch |
| Monte Carlo | Uniform draws, no correlation between parts, no worst-case corner search | Two halves of a matched pair drift independently here, and a random sweep can miss a corner a deliberate search would find |
| Solver | Dense LU | Fine to a few hundred nodes, quadratic-ish past that |
| Solver | A solved step is checked against its own charge-and-flux error estimate and taken again shorter when it was too long, but the heat a fuse or an LED takes is not: its limit is read from the accepted current, so a step into a sudden overload is sized by the current before it | A fuse or an LED meeting a surge with no corner to announce it heats over one step a little longer than the surge warrants, and blows up to that step late |
| Solver | The step controller steers by stored charge, never by a device's conduction | A signal small beside a junction's 26 mV converges at the default step; one that is not is under-resolved and nothing says so. A 10 mV sine into a bipolar base reads 2.29 V at the collector against 1.79 V solved properly, and the drive that binds the step is the waveform's own fifty-points-per-cycle rather than anything the transistor asked for. Tightening that heuristic is not the answer — five hundred points a cycle still reads 2.12 V — so the fix is a step control that watches the nonlinear current. Deliberately not taken: it is a heuristic rather than a truncation error — nothing there is integrated — and it would cost five to twenty times the steps on every nonlinear circuit, which is paid by the live animation. Until it is measured properly across a spread of circuits, a large-signal answer wants its step set by hand |
| Drawing | The live layer shows one number per frame, and a frame covers tens of microseconds of simulated time | An event shorter than a frame is drawn as its average rather than resolved: through a contact bouncing for 266 us, the reading beside the switch stays in the milliamps at 1x playback and falls to 110 uA at 0.25x, where the engine has picoamps. That average is deliberate — sampling one instant per frame drew a CMOS inverter as a dead circuit on almost every frame — but it is never taken across a change of state any more: the mean runs from the last digital transition inside the span, and a frame the playhead crosses an operated part on reads the instant. Before that, flipping an input of the half adder left both lamps at half brightness for about a second. The symbol keeps its actuated position throughout, which is the one thing about it that is stable and true; making the blade follow the frame instead was considered and refused, because at frame rate it would show some transitions and not others, and a symbol flickering four frames reads as a rendering fault rather than as data. The chatter is drawn sharp on the scope, which is where a sub-frame event belongs |
| Digital | An analog load on a net that is also an input of a feedback loop stops the loop settling | The four-NAND D latch with an LED straight off Q and QN sits at unknown on both outputs forever; take the lamps off and the same drawing settles to Q high, QN low in three gate delays. The loop is fine on its own — the engine walks a cross-coupled pair to a fixed point in two delta cycles, verified in `digital.rs` tests for both NAND and NOR — so it is the bridge to the analog side that costs the net its state. Both latch examples drive their lamps through a buffer, which is what a real board would do anyway, and that is a workaround rather than a fix |
| Digital | No setup/hold checking, no X-propagation through timing | A metastable design simulates as if it were fine |
| Digital | A logic input with no pull to either rail is refused rather than guessed | The gate is handed unknown and the node reads "floating"; what it would do on a real board depends on what its input capacitance picked up, which is not a thing to simulate |
| Digital | One logic family for the whole drawing, and no fan-out limit | Two families on one board is a real design, and here every input is free to drive |
| Digital | Gate delay is one number, the same for a rising and a falling edge | A real part is slower one way than the other, and slower again as it warms |
| Digital | An input switches at its family's typical threshold, the same for every part: half the supply for CMOS with 0.2 V between rising and falling, 1.25 V and 1.45 V for TTL. The guaranteed V_IL and V_IH a datasheet prints are not checked against | A part whose threshold sits at the far edge of its tolerance is not simulated, and a voltage between the guaranteed limits that a real gate might read either way is read as the typical part would |
| Supply current | A chip's own draw is one static figure off its datasheet at 5 V: typical where the sheet gives one (NE555, op-amps, comparators, L293D logic supply, 74LS parts, the ATmega328P scaled by its clock), the guaranteed maximum for static CMOS (74HC 2/4/8 µA, CD4000B 0.25/1/5 µA by size). It does not follow the supply voltage, and CMOS switching current (C_pd·V²·f) is not modelled | A 74HC counter clocked at 10 MHz draws a few milliamps on the bench and microamps here; a 555 on 15 V draws its 5 V figure. The load current an output delivers is exact either way: it comes in at the package's VCC leg and leaves by its GND leg |
| Supply current | Memories (6116, 62256, 28C16, 28C256) draw nothing of their own: their current is milliamps selected and microamps not, which follows the chip select rather than being one figure. The MAX7219 draws its 150 µA shutdown figure and none of the LED current it drives, which follows what is on the display | A memory's or a lit matrix's supply wire carries less than on the bench. What their outputs deliver into a load still comes through their supply legs |
| Supply current | A logic output's level is the drawing's logic family, not its package's VCC: the current it delivers comes through the package's legs, but a chip on a sagging rail still drives a full-height high. Gate symbols with no supply pins drawn take their output current from ground, as before | A 74HC04 on a 3 V rail in a 5 V drawing sources 5 V highs out of 3 V. On a net a package and a bare gate symbol drive at once — contention, or two outputs tied — the package's legs carry the whole of it, the symbol's share included |
| Microcontroller | A port pin reads its net as the ATmega328P's Schmitt input, 0.52 and 0.43 of its supply, only when every input on the net is a port pin. A net a gate also reads is read once, with the drawing's logic family, for both | A slow edge shared by a port pin and a gate reaches the pin at the gate's threshold, without the pin's half volt of hysteresis |
| Microcontroller | The ATmega328P only, and only its CPU, GPIO, external and pin-change interrupts, the three timers, USART0, the SPI as a master, the EEPROM, the ADC and the watchdog. The analog comparator is registers and nothing more | What is left out was made to finish rather than hang where a sketch waits on a flag, so the symptom is a wrong value, not a frozen chip — and the first time a program puts the SPI in slave mode, sends an I2C address nothing on the bus answers or reads the comparator, the run says so in the inspector and the issues box. |
| Microcontroller | The watchdog counts its 128 kHz oscillator at exactly 128 kHz, from the CPU cycle that switched it on or ran `wdr`, where the silicon's oscillator runs free and is a few percent off with voltage and temperature. It is the fuses' safety level 1 (WDTON unprogrammed, as on an Uno). On the Uno board, what Optiboot 4.4 (the Arduino AVR core's bootloader for it) does after every reset is done in its place, in no time: MCUSR read and cleared, the watchdog switched off, and the program started — it does not pass the old MCUSR on in r2, as later Optiboots do, and the second it waits for an upload after an external reset is skipped (see the start-up row). The bare ATmega328P has no bootloader, so there WDRF stays in MCUSR and holds the watchdog on at 16 ms until the sketch clears them. Two things the datasheet leaves open are decided here: a second time-out in interrupt and system reset mode, with the first interrupt not yet served, resets the chip, and the reserved prescaler values 10 to 15 never time out | A time-out comes at the datasheet's 16 ms to 8 s to the cycle, where a given chip's is early or late by its oscillator's error. On the Uno a sketch always reads MCUSR as 0, as on the bench, and a software reset through the watchdog (`wdt_enable(WDTO_15MS); while (1);`) comes back once and runs on. On the bare chip it reads WDRF after a watchdog reset, and a sketch that does not clear it and call `wdt_disable()` within 16 ms of starting resets again and again, as a bare chip does |
| Microcontroller | The ADC is the ideal converter, floor(Vin × 1024 / Vref) taken at the datasheet's sample-and-hold instant, with no offset, gain or linearity error, and its inputs draw no current: the sample-and-hold capacitor does not load the source, the internal 1.1 V is exactly 1.1 V and needs no time to settle, and it is not driven out onto AREF. Conversions start from ADSC or run free; auto-triggering from a timer, the comparator or INT0, and the start on entering ADC noise reduction sleep, are not simulated, and neither is the temperature sensor, which reads 0 V. ADC6 and ADC7 are bonded out only on the surface-mount packages, so the part has neither | A divider of any impedance reads its exact voltage, where on a real chip a source above about 10 kΩ reads low just after the channel changes; a 1.1 V reference reads as nominal, not as the 1.0 to 1.2 V a given chip has. A sketch that triggers conversions from a timer gets only the ones it starts by writing ADSC, and is told so, as is one that reads the temperature sensor |
| Microcontroller | USART0 runs off its baud-rate generator as the datasheet draws it — a down-counter reloaded from UBRR0 when it reaches zero or when UBRR0L is written — with the receiver sampling on its ticks and the transmitter starting each frame on the next edge of its bit clock, every sixteenth tick (eighth with U2X0). The datasheet does not say whether that divide-by-16 is cleared when UBRR0L is written; here it is not, and counts every tick since reset. Synchronous (USART in SPI) mode is not simulated | Where a frame from idle starts, within its bit, depends on that divider's phase after a write to UBRR0L, which the datasheet leaves open: a sketch that sets the rate once, as every Arduino sketch does, sees whole bits either way |
| Microcontroller | The serial monitor sends through a USB-serial converter on D0, which lets go of the line until the first byte is typed and idles high from then on, as an Uno's does; through the board's 1 kΩ only where D0's net reaches something analog | Typing to a chip whose D0 is also driven by another chip's TX on a net that is only logic makes the net unknown wherever the two disagree, and the chip reads unknown as low; on a real Uno the other TX wins over the 1 kΩ and the typed text is lost. Put a resistor or anything analog on D0 for the two to fight as they would on the bench |
| Microcontroller | The EEPROM is erased, every byte 0xFF, at the start of every run, and kept only through a reset within one: nothing written survives to the next run, and the `.eep` file the toolchain writes for `EEMEM` data is not loaded. Its programming times are the datasheet's typical 3.4 ms and 1.8 ms, with no spread for voltage or temperature | A sketch that counts its boots in EEPROM starts from 255 every run; a write takes as long as on a typical chip |
| Microcontroller | I2C is simulated by transaction, not on the wires: the TWI hands each address and byte straight to the devices on its bus, which are the LCD modules whose SDA is on the chip's PC4 and SCL on its PC5 (an Uno's A4 or SDA pin and A5 or SCL pin), each with its own pull-ups. Each START, STOP and byte still takes its SCL periods at the rate TWBR and TWPS set; an address nothing answers is NACKed and a byte read from nothing is 0xFF. No slave modes, no arbitration or second master, and the transfer is not driven onto SDA and SCL, which stay as the port leaves them — after `Wire.begin()`, two pull-ups | A scope on A4/A5 shows an idle bus, a load or a short on those nets does not disturb a transfer, and a sketch that bit-bangs I2C on other pins reaches nothing. A module on other pins, or with SDA and SCL swapped, is never answered, as on a real board, and the editor says why |
| Microcontroller | The SPI is simulated on the wires as a master: SCK (D13) and MOSI (D11) change edge by edge at the rate SPR1:0 and SPI2X set, in all four modes and either bit order, and MISO (D12) is read off its net as a logic level at each sampling edge, with no setup or hold time. Slave mode is not: a program that clears MSTR, or a master whose SS (D10) is an input taken low — the mode fault — drops to a slave that never clocks, and is told so. The first edge comes half an SCK period after the cycle the `SPDR` write lands in, where the silicon's prescaler runs free and starts it up to one period later. The MAX7219 matrix module latches what it is sent and shows it, with no multiplexing: a scan limit below 8 blanks the rows past it and the intensity sets a uniform brightness, but nothing flickers, the segment current set by RSET is not modelled, and the module draws nothing from its supply | A scope on D11 and D13 shows every bit, and a 74HC595 or a module clocked from them takes them in, as on the bench; at a coarse timebase the edges fold into bursts, so zoom in to a few microseconds to see them. A sketch that times its transfers against the SPI clock is off by up to one SCK period per transfer; one that makes the Uno an SPI slave gets nothing. The matrix looks like a photograph of the real one, not like what a camera at a fast shutter speed would catch |
| Microcontroller | Every sleep mode sleeps like idle: the timers keep running, and waking takes idle's four cycles, not the start-up time power-down and power-save wait for. The watchdog runs in all of them, as on the silicon | A sketch in power-down wakes on Timer0's overflow every 1.024 ms (the `millis()` interrupt) where real silicon would stay asleep until an external interrupt or the watchdog; one that stops Timer0 first and sleeps until the watchdog wakes it, as low-power sketches do, wakes on time, about 1 ms (16K clocks, an Uno's fuses) sooner than the real chip resumes |
| Microcontroller | No start-up time after power-on or any reset, no fuses, no CLKPR clock division, no bootloader: the program starts from address 0 on the first cycle, and the clock is whatever the part says | Edges come about 65 ms earlier than on an Uno, whose fuses wait that long for the crystal after power-on — and after the reset button, its bootloader listens for an upload first; a sketch that divides its own clock runs at the undivided rate |
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
| LCD | The display is read once a frame of the run, from the chip as far as the engine has committed it | What the glass shows trails the sketch by up to a millisecond of simulated time, and a change is placed in the playback history at the frame it was read, not the instant it was written |
| LCD | The A00 ROM's lower half (0x20–0x7F, with ¥ and the two arrows) is the datasheet's; its upper half shows a hollow box for every katakana and Greek character, except 0xDF (°) and 0xFF (the full block). The 5×10 font is not modelled, nor is the contrast pot | A sketch printing Japanese text shows boxes; one choosing the 5×10 font gets 5×8 characters. The glass is always at a readable contrast |
| File format | There is no way back: a document from a newer build is refused whole, and a build from before format 2 refuses a format-2 link as made by a different version. Part-level upgrades (an LED drawn as a diode, a switch's old defaults) are still recognised by their untouched values on every load, not keyed to the document's version | Someone on a stale tab who is sent a new link has to reload first. A part upgrade that cannot be recognised from the values alone has to become a document migration instead |
| LCD | CGRAM starts at zero, and the module draws its controller's 0.4 mA and nothing for the backlight | Real CGRAM powers up with whatever is in it, so a custom character used before `createChar()` is blank here and noise on a bench. The supply sees none of the 20–100 mA a backlight takes, on or off |
| Buzzer | Electrically a resistor, 1 / (2·C·1 kHz) — 25 kΩ for the default 20 nF — not the capacitor a piezo disc is: the mean supply current a disc draws on a 1 kHz square wave, C·V·f, at every frequency, without the spike of charge at each edge. Resolving that microsecond spike at every edge tripled the cost of a run and left an Uno playing a tune at 30–60 % of real time | The supply carries 0.1 mA on average from 5 V whatever the tone (0.2 mA while the pin is high), where a real disc's mean draw is in proportion to the frequency: 0.05 mA at 500 Hz, 0.4 mA at 4 kHz. No resonance, loudness or timbre either: the speaker plays a square wave at a fixed level |
| Buzzer | What it plays is read off the logic nets that drive its legs, as runs of rising edges whose periods agree within 4 %; a lone period is a click and is not shown, and a gap past 50 ms (20 Hz) is silence. A leg driven from the analog side alone (a 555, a source) is read through the logic thresholds against ground | A tone starts two periods after its first edge, a siren that glides is shown in steps of about 4 %, and a buzzer across two analog nodes that are not referenced to ground is not heard |
| Buzzer | Sound keeps the pitch the circuit drives and lets the playback speed set only how long each note lasts; it is scheduled a frame at a time, about 40 ms behind the drawing, and is silent while stopped or looking back through a stopped run | At 0.25× a note sounds four times as long as in the sketch, at a wide window many notes go by in a blink; only 1:1 (or a 4 s window at 1×) plays a melody at its tempo, and only if the run keeps up with real time |
| Servo | The horn goes where the pulse width says and turns there at a constant 600°/s (the SG90's 0.1 s per 60°), with no inertia, no load on the horn, no deadband and no dependence on the supply voltage; it keeps turning for 25 ms after the last pulse and then holds. Pulses are mapped 544–2400 µs onto 0–180°, the Servo library's defaults; one outside 400–2600 µs, or one starting less than 3 ms after the line last fell, is ignored. The supply sees a fixed 500 Ω, 10 mA at 5 V, whether the horn is still or turning | A real SG90 takes 100–250 mA while it turns and 650 mA stalled, enough to pull a USB-powered Uno's 5 V down and reset it, which is the usual servo bug on a bench; here the rail never moves. The angle is read once a frame of the run, like the LCD, so the drawn horn trails the sketch by up to a millisecond of simulated time. A servo whose real travel is not 544–2400 µs for 0–180° is off by its own difference, and a continuous-rotation servo is drawn as a positional one |
| LED | Reverse breakdown not modelled | A real LED dies a few volts backwards; here it simply blocks |
| LED | Failure is thermal-free: one dose rule, no junction temperature | A part in still air and one on a heatsink fail at the same instant |
| 7-segment | Each segment is its own LED with its own heat, sharing none of it with the rest of the package; and what drives one, a logic chip's output or a microcontroller pin, is the logic family's 50 Ω with no current limit and no package total | A segment with no resistor off an Uno pin draws 60 mA and burns in about 0.6 ms, where a real pin's output sags harder as the current climbs and the segment may take longer to go, or the pin may go first. A 74HC595 lighting all eight at 20 mA each is 160 mA through a chip rated for 70 mA, and nothing says so |
| Animation | BJT base current approximated as zero when distributing wire current | Base-net current dots are missing rather than wrong |
| Animation | Wires closing a loop show no current | Genuinely undefined for ideal wires in parallel; shown as nothing rather than guessed |
| Animation | Speed is scaled to the 90th percentile of what is on screen, not the peak | A spike ten times everything else is drawn at full speed rather than flattening the rest of the circuit to a standstill |
| Canvas | Layer-level invalidation, no dirty rectangles | A full-screen repaint per interaction on the affected layer |
| Canvas | Labels are placed per part, with no collision avoidance between them | Two parts a symbol's width apart can have a name and a reading land on each other |
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
   overshoot, and a timebase turned from the header, the wheel or a pinch. A
   trigger is what it still lacks.)*

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
- [x] **Convergence diagnostics** — when a solve fails, say *which node* and *which
      device* stopped converging, not just that it did. A singular matrix names
      the unknowns nothing pins down (two sources fighting, a coil across a
      source, a node fed by nothing), a Newton failure the nodes still moving
      on its last step and the nonlinear devices on them, and a collapsed
      timestep what its last attempt failed on. *What is left:* the AC sweep
      only names the one row its complex solve stopped at; a source shorted by
      a wire has no node of its own in the matrix, so only the part is named
      (the editor marks the net from its pins).

### Editor

- [x] **Touch and pen input.** Pinch to zoom and two-finger pan on the drawing and
      the scope, the palette and inspector as drawers, and a row of buttons for
      the keys a phone does not have (#21).
- [ ] **Keyboard-only editing and screen reader support.** Currently the canvas is
      opaque to assistive technology. At minimum: tab through components, announce
      selection, edit values from the inspector without a mouse.
- [x] **Errors that point at the circuit.** "Singular matrix near v(n3)" should
      highlight that net on the canvas, not just print a name the user never chose.
      A failed solve now marks the parts and nets it blames in the danger colour,
      lists them in the issues box (hover a net to light it, click a part to
      select it), and the banner says it in the drawing's names. *What is left:*
      the "check the wiring" warnings still only print; they could mark the
      canvas the same way.
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

- [x] **A real file format** with a version field and a migration path. A `.repath`
      file, a share link and a draft are one versioned document (`format.ts`),
      read through an ordered list of migrations; a document from a newer build
      is refused with the reason.
- [ ] **Performance budget and benchmarks** — a 500-component circuit that pans at
      60 fps and simulates in under a second, measured in CI rather than assumed.

---

## Should

### Analyses

- [x] **DC sweep in the UI.** The engine has `dc_sweep`; nothing exposes it. I-V
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
      inspector value that a running sweep takes in at the instant it changes;
      there is still no knob to drag on the drawing itself).
- [x] Transformer and coupled inductors: two windings, a turns ratio and a
      coupling. The core never saturates.
- [x] Relay, and an SPDT switch. The relay reads its coil current, pulls in at
      its pull-in voltage and lets go at its drop-out, holding between, and has
      no armature delay or contact bounce.
- [x] Crystal / resonator, as the Butterworth–Van Dyke model.
- [ ] Voltage-controlled oscillator, comparator with hysteresis.
- [x] Counters, shift registers, decoders, encoders, multiplexers, adders,
      comparators and three-state bus parts, as 74xx and 4000-series chips,
      and byte-wide memory: the 6116 and 62256 RAMs, and the 28C16 and 28C256
      EEPROMs programmed as hex in the inspector, which a circuit can also write
      at the part's own pace: page loads, write time, data polling on I/O7.
      *What is left:* the toggle bit and software data protection.
- [x] 7-segment display, a four-digit multiplexed one, and a bar graph, built
      on the LED that already lights; driven from an Uno directly or through a
      74HC595, and each segment burns out on its own.
- [x] A 16×2 character LCD on an I2C backpack (HD44780 behind a PCF8574), the
      first part on a microcontroller's I2C bus.
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
- [x] **Component search** in the palette, by name or part number, and `Ctrl+K`
      for every part, command and example.
- [ ] **A trigger**, so a repeating waveform holds still instead of being read
      from wherever the run happened to start. The timebase is done — the window
      field, the wheel and a pinch turn it, and a stopped trace zooms — and so is
      the vertical: gain, position, split scales, two cursors and a measure panel.
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
- [x] **Local persistence** — the drawing is kept as a draft as you work and
      reopened where you left off (#57).
- [ ] **A list of recent circuits** to go back to, beyond the draft of the one
      you were working on.
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
