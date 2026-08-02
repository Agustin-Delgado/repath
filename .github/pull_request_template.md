<!--
Thanks for this. The checklist is short on purpose — only the things that have
actually caused problems here are on it.
-->

## What this changes

## Why

<!-- If it fixes something, what was the root cause? A fix whose cause is
     understood tends to stay fixed. -->

## How it was checked

<!-- For anything touching the engine: what independent source is the new test
     comparing against — a closed-form solution, a conservation law, a datasheet
     equation, hand analysis? Asserting today's output is not a check. -->

- [ ] `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- [ ] `npm run check`, `npm test`, `npm run build` in `web/`
- [ ] New behaviour has a test that would fail without the change
- [ ] Anything left unfixed is written into `BACKLOG.md` rather than left to be discovered
