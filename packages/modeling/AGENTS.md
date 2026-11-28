# AGENTS.md

`forgeax-modeling` is the editable mesh modeling kernel of ForgeaX: `@forgeax/engine-modeling`, reached by games as
`@forgeax/engine/modeling`. Contracts live in `README.md` and `reference/`; do not restate them here.

## Repository form

- Required submodule of `forgeax-engine` at `packages/modeling`. Build and test only inside an Engine checkout (the
  Engine lockfile resolves dependencies; this repository commits none). Read the Engine `AGENTS.md` first: strict
  TypeScript, `Result` with closed error unions, Biome, Vitest under `__tests__/`, English-only, no needless comments.
- Depend on public Engine exports only (`workspace:*`). Engine runtime packages never import this one. `./tools` is
  Node-only and keeps `@forgeax/engine-modeling` external so a Pack under capture shares one module instance.
- Land on this repository's `main` first; the pin bump goes to Engine `integration/modeling`, never Engine `main`
  without the owner's decision. A change needing a new Engine seam merges that seam first.
- On the pub server a PR merges only through `forgeax-merge-slot queue <PR> <owner>`; direct `gh pr merge` is refused.

## Layout

| Path | Holds |
|:--|:--|
| `src/*.ts` | Default `.` surface: `Model` session, selectors, operators, export, delivery |
| `src/compute/` | Heavy kernels; `TS_KERNEL_DIGEST` hashes their import closure (reaches shared root files) |
| `src/brep/` | Exact stage (`./brep`), guarded by `BREP_KERNEL_DIGEST` |
| `src/quad/` | Quad remesh and cross fields (`./quad`) |
| `src/recipes/` | Parametric part recipes on the session API |
| `src/tools/` | Node-only `./tools`: capture, bake and mesh-job workers, image feedback |
| `reference/` `knowledge/` `examples/` | Contract, authoring know-how (`knowledge/notes/` is lane history), runnable Packs |
| `scripts/` `bench/` `reports/` | Guards, harnesses, committed baselines |

A new reference or knowledge file gets its README map row in the same change.

## Kernel invariants

- Manifold paired half-edges (`twin = h ^ 1`, `edge = h >> 1`); at most one face per directed edge. Never tolerate a third face.
- Edge flags store author intent only; derived results (normal groups, UV islands) are computed at export.
- Selectors are expressions evaluated per call; never persist element ids across operations.
- An operation succeeds or returns a `ModelingError` that poisons the session. Magnitudes are checked explicitly;
  topology-changing repairs are opt-in.
- `compact()` and FXEM output are history-independent; encode/decode stays byte-exact.
- Output depends only on source and parameters: no time, randomness or host globals, and no approximated `Math`
  function in the kernel (use `src/dmath.ts`; `ambient.unit.test.ts` enforces it).

## Gates

From the Engine root: `node node_modules/typescript/bin/tsc -b packages/modeling`, `pnpm --filter
@forgeax/engine-modeling test`, `npx biome check packages/modeling`. Rebuild `dist` (`npx tsup` here) before testing:
examples, tools and Workers import the built package. A deliberate output change regenerates `src/__tests__/golden/`
with `FORGEAX_UPDATE_GOLDEN=1`. Before pushing run `pnpm test:modeling -- --candidate`; add `--dawn` for real-renderer
journeys and `--mech-gt` when `examples/mech-gt` changes (minutes, 16 GB heap; prefix `forgeax-heavy` on pub).

Anything under `src/brep/` must leave `TS_KERNEL_DIGEST` unchanged: `node scripts/check-exact-guard.ts [--base <rev>]
[--exact]`. `BREP_KERNEL_DIGEST` regenerates via `src/brep/__tests__/brep-digest.unit.test.ts` with
`FORGEAX_UPDATE_GOLDEN=1`. `mesh.ts`, `nurbs*.ts`, `polygon2d.ts`, `dmath.ts` and `errors.ts` sit in both closures, so
editing them moves both digests.

## Pitfalls

- Pack entry files import local modules with explicit `.ts` extensions; unit tests do not exercise the Pack loader.
  A rig Pack declares every component `rig.finish()` emits in `sceneComponents`; test the Pack load.
- Vitest collects `*.test.ts` under `src/` and `examples/`; keep scratch probes outside both. Engine-root Biome covers
  `packages/*/src/**` only, so run `npx biome check packages/modeling` for `examples/`, `scripts/`, `bench/`.
- `validate()` success can still carry issues; read `issues`, not only `ok`. A geometry gate must be able to fail:
  assert sample coverage and add falsifiers (empty input, skipped regions, non-finite limits, grid-aligned contacts).
- Fairness needs interior measures, not only boundary curves. After `shell`, `revolve` or `loft`, check closure and
  orientation per component.
- Case history sources must stay readable by `attachSourceLines` (literal session names, braced loops).
- Do not edit sources or rebuild `dist` in a tree whose tests are running; probe in a separate worktree outside the
  Engine `packages/*` glob. Rebase onto the actual merge-base and read the diff; a squash against a moved base can revert work.
