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

The suite lives in a private repository, mounted here as the submodule `tests/`,
so a clone of this one does not have it. That changes what a pull request from
outside can check for itself, not what it is held to: describe the independent
source your change is compared against in the pull request, and the suite is
run against it before it is merged. The existing tests are the pattern:

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

If a user would notice the change, give it an entry at the top of
[CHANGELOG.md](CHANGELOG.md): what they can do now, or what stopped going wrong,
in their words rather than the code's, with a link to the pull request. The
mechanism goes in the pull request; the changelog is the tour.

What CI checks on a pull request from a fork, you can run without the suite:

```sh
cargo fmt --all --check
cargo clippy --workspace -- -D warnings

cd web
npm run check     # svelte-check, zero errors expected
npm run build
```

With the `tests/` mount there is also the suite, and CI runs it on every push:

```sh
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd web && npm test          # the editor, the canvas, the netlist, and the engine through wasm
```

And the browser checks, in `tests/e2e`: the built site served by `vite preview`
on `localhost:5202` and driven by a headless Chromium — every example opened
and run, the editing gestures, sharing and saving, the layout at three widths.
CI runs them against the same build it deploys.

```sh
cd web
npx playwright install chromium --only-shell   # once, and after a Playwright bump
npm run test:e2e                                # builds, then runs them
npx playwright test --ui                        # against the last build, to watch them
```

They find things by role and accessible name, not by class or position, so a
change of look does not break them. Where there is nothing accessible to go by,
add a `data-testid` rather than reaching for a class. A failure leaves a trace
in `web/test-results`; `npx playwright show-trace` on it replays the run.

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
  browser: the whole web suite runs in Node, in well under a minute, with no
  page to load.

## A note on the editor

Most of the subtle bugs in this project have been in one area: what stays
connected to what when things move. The rules are in `state.svelte.ts` and they
are covered by tests that fail the way the bugs did — a component dragged off its
wires, a wire torn off its pins, a rotation that quietly disconnected everything.

If you change `beginMove`, `applyMove`, `rotateSelection` or the router, say in
the pull request which gesture you checked and how; with the mount, that is a
case in `tests/web/state.edits.svelte.test.ts`. Two invariants carry most of the
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
