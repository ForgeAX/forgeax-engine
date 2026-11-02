# AGENTS.md

`forgeax-modeling` is the editable mesh modeling kernel of ForgeaX, published as
`@forgeax/engine-modeling` and reached by games as `@forgeax/engine/modeling`.

## Repository form

- This repository is a required source submodule of `forgeax-engine`, mounted at
  `packages/modeling`. Build and test it only inside an Engine checkout; the Engine
  root lockfile resolves dependencies, and this repository commits no lockfile.
- Depend only on public exports of Engine packages through `workspace:*`. Runtime
  Engine packages never import this package; the `engine` umbrella forwards it and
  DevKit composes its Node-only `./tools` contributions.
- `./tools` stays Node-only: the capture Worker imports this package by its own name,
  so tsup keeps `@forgeax/engine-modeling` external and the Pack under capture shares
  the same module instance.
- Changes land on this repository's `main` first; the Engine pin bump follows.
  For a change that needs a new Engine seam, merge the Engine seam first.
- Read the Engine `AGENTS.md` before editing. Its conventions apply here: strict
  TypeScript, `Result` with closed error unions, Biome, Vitest under `__tests__/`,
  English-only source, and no comments unless the reason is non-obvious.

## Kernel invariants

- Topology is manifold paired half-edges: `twin = h ^ 1`, `edge = h >> 1`, and each
  directed edge has at most one face. Never add a code path that tolerates a third face.
- Edge flags store author intent only; derived results (normal groups, UV islands)
  are computed at export and never written back.
- Selectors are expressions evaluated at each call; never persist element ids across
  operations.
- Every operation either succeeds, or returns a structured `ModelingError` that
  poisons the session. Operations check required magnitudes explicitly; repairs that
  change topology are opt-in.
- `compact()` and FXEM output are history-independent; keep the encode/decode
  round-trip byte-exact.
- Output bytes depend only on source and parameters: no ambient state (time,
  randomness, host globals) and no implementation-approximated `Math` function in the
  kernel; use `src/dmath.ts`. `ambient.unit.test.ts` enforces it.

## Gates

Run from the Engine root: `node node_modules/typescript/bin/tsc -b packages/modeling`,
`pnpm --filter @forgeax/engine-modeling test`, and `npx biome check packages/modeling`.
The test setup runs `debugValidate` after every operation. Rebuild `dist` (`npx tsup`
in this directory) before testing: examples, tools and the determinism Workers import the
built package. A deliberate output change regenerates `src/__tests__/golden/` with
`FORGEAX_UPDATE_GOLDEN=1`. Engine `git ls-files` gates (file length, test layout) include
this submodule through `scripts/lib/tracked-files.mjs`. Before pushing, run
`pnpm test:modeling -- --candidate` from the Engine root (add `--dawn` for the
real-renderer journeys); it also runs the English check on `src` and `examples`.
A change to `examples/mech-gt` also needs `--mech-gt`: the whole-run S7 scan, which
takes minutes and a 16 GB heap (on the shared pub server, prefix it with `forgeax-heavy`).
