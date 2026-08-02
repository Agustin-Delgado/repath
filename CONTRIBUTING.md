# Contributing to repath

Issues and pull requests are welcome, including "this answer looks wrong to me" —
that is the most valuable kind of report a simulator can get.

## The one rule

**A confident wrong answer is worse than no answer.** Someone is going to trust
this thing about a circuit they cannot easily measure. So anything that changes
what the engine computes needs a test that checks it against something derived
*independently* of the code under test: a closed-form solution, a conservation
law, a datasheet equation, hand analysis. A test that asserts today's output is
not a test, it is a snapshot of a bug waiting to be blessed.

The existing tests are the pattern:

- RC and RL step responses against the closed-form exponential.
- An LC tank against conservation of energy.
- A MOSFET's saturation current against the Shichman-Hodges equation.
- An RC low-pass that must be −3.01 dB and −45° at its corner, roll off 20 dB per
  decade, and settle at −90°.
- A NAND gate against its truth table at every sampled instant.

If a limitation cannot reasonably be fixed in the same change, write it into the
"Known limitations" table in [BACKLOG.md](BACKLOG.md) instead of leaving it for a
user to discover.

## Getting set up

You need [Rust](https://rustup.rs), [Node](https://nodejs.org) 20 or newer, and
[`wasm-pack`](https://rustwasm.github.io/wasm-pack/) 0.15 (`cargo install wasm-pack`).

```sh
git clone https://github.com/Agustin-Delgado/repath.git
cd repath

# The web app cannot even type-check without the generated bindings.
wasm-pack build crates/repath-wasm --release --target web \
  --out-dir ../../web/src/lib/wasm --out-name repath

cd web && npm install && npm run dev
```

## Before you open a pull request

Everything CI runs, you can run:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

cd web
npm run check     # svelte-check, zero errors expected
npm test          # the canvas engine, the router, the editor rules
npm run build
```

Clippy is `-D warnings` on purpose: a warning nobody is required to fix is a
warning everybody stops reading.

## How the code is laid out

```
crates/repath-core       the engine — pure Rust, no web dependencies
crates/repath-wasm       WebAssembly bindings, and nothing else
web/src/lib/canvas       a 2D editor engine that knows nothing about circuits
web/src/lib/schematic    the circuit half: symbols, netlist, routing, tools
web/src/lib/state.svelte.ts  editor state; the connection-preserving rules live here
web/src/routes           the SvelteKit shell
```

Two boundaries are worth preserving:

- **`repath-core` has no idea the web exists.** It is a normal crate you can
  depend on from anything. Keep browser concerns in `repath-wasm`.
- **`lib/canvas` has no idea circuits exist.** Viewport, layers, spatial index,
  snapping and tools are general. That is what makes them testable without a
  browser, which is why `npm test` runs in about three seconds.

## A note on the editor

Most of the subtle bugs in this project have been in one area: what stays
connected to what when things move. The rules are in `state.svelte.ts` and they
are covered by tests that fail the way the bugs did — a component dragged off its
wires, a wire torn off its pins, a rotation that quietly disconnected everything.

If you change `beginMove`, `applyMove`, `rotateSelection` or the router, please
add a case to `state.edits.svelte.test.ts`. Two invariants carry most of the
weight:

1. **A drag and its release are the same computation.** The move is a pure
   function of the total offset, recomputed from a snapshot each frame, so what
   you see mid-drag is exactly what lands. If those two can disagree, something
   has gone wrong.
2. **Moving something never silently disconnects it.** Count the loose ends
   before and after; the number must not grow.

## Style

Match the surrounding code. Comments explain *why*, not *what* — the reader can
see what a line does, and a comment that restates it is noise that goes stale.
Where a constant was chosen rather than derived, say what it is trading off.

## Licence

By contributing you agree your work is published under the [MIT licence](LICENSE),
the same as the rest of the project.
