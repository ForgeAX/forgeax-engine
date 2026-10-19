# @forgeax/feature-lab

One page per row of the SDK feature catalog
(`skills/forgeax-engine-sdk/references/feature-catalog.md`). Testers use it as the
executable half of the feature checklist; the prose half is the tester manual in
`<area>/<slug>` path as the feature id).

```sh
pnpm --filter @forgeax/feature-lab dev          # http://127.0.0.1:5173/ (index) or ?f=<area>/<slug>
pnpm --filter @forgeax/feature-lab test         # every headless + Node-only probe in Vitest
pnpm --filter @forgeax/feature-lab smoke:browser  # every feature in Chromium WebGPU
```

`pnpm --filter @forgeax/feature-lab build` also supports static hosting. The Lab
has no disk Pack assets; `public/pack-index.json` publishes that empty catalog
for App's default catalog URL. Individual features register their runtime assets.

`smoke:browser` knobs: `FEATURE_LAB_FILTER=<substring>`, `FEATURE_LAB_URL=<running dev
server>` (a cold Vite start compiles the engine shader set, about a minute),
`FEATURE_LAB_FRAMES` (default 60), `FEATURE_LAB_MIN_DIFF` (default 0.004). On Linux
without a GPU run it as `CI=1 xvfb-run -a pnpm --filter @forgeax/feature-lab smoke:browser`.
The report and ON/OFF screenshots land in `artifacts/feature-lab/`. `report.json`
counts `passed` / `known` / `failed` / `total`; each result carries `verdict`
(`pass` | `fail` | `known-issue`), `checks`, `failures`, page `errors`, and `diff` for
visual features. Each feature page stubs the Vite HMR socket, so source edits on a shared
dev server never reload a feature mid-run.

## Feature kinds

| Kind | Where | Proof |
|:--|:--|:--|
| `visual` | `src/features/<area>/<slug>.ts` | `toggle(on)` switches the feature off and back on; the runner screenshots both states after 60 frames and fails when the mean pixel difference is below the threshold. Optional `checks()` add structured assertions. |
| `probe` | `src/features/<area>/<slug>.ts` | Runs against the live App (renderer, input, assets). `checks()` returns structured results; every check must pass. |
| `headless` | `src/features/<area>/<slug>.ts` | Pure logic with `run(checks)`; runs in the browser panel and in Vitest. |
| `headless` (Node-only) | `src/node-features/<area>/<slug>.ts` | Build-time or Node-host owners (Pack, importers, CLI, shader compiler). Vitest only; the browser bundle never imports this directory. |

## Authoring a feature

The following rows use existing owner browser gates because their fixtures
need native device/PCM lifetime, a Worker boundary, or a producer-backed project.
They remain part of the complete `pnpm test:browser` roster.

| Catalog row | Owning gate | Evidence boundary |
|:--|:--|:--|
| Gamepad feedback | `packages/input/src/__tests__/gamepad-feedback.browser.test.ts` | Actual DOM ownership and Worker POD transport; actuator double, physical compatibility unverified. |
| Long audio windows | `packages/audio-webaudio/src/__tests__/pcm-stream.browser.test.ts` | Native Web Audio output and real HTTP Range windows; original PCM, clock, cleanup and budget assertions. |
| Acoustic regions | `packages/audio-webaudio/src/__tests__/acoustic-regions.browser.test.ts` | Real OfflineAudioContext PCM, bus/send ramps and accepted regional routing. |
| Quantized layered music | `packages/audio-webaudio/src/__tests__/music-transport.browser.test.ts` | Native sample alignment, cancellation, late boundaries and Context lifetime. |
| Managed scene SDF collision | `packages/render/src/__tests__/scene-sdf.browser.test.ts`, `scene-sdf.dawn.test.ts` | Fresh-device field sharing, swept collision work bounds and captured-contact replay. |
| Cached asset thumbnails | `packages/devkit/__tests__/workspace-thumbnails.test.ts` | Ordinary Preview leases, real PNG alpha/color, progressive queue and persistent DDC reuse without a browser. |

- Area directories are fixed in `src/lab/areas.ts` and mirror catalog subsections. The
  file name is the slug; the registry discovers files through `import.meta.glob`, so
  adding a feature never edits a shared list.
- `catalog` is the feature row name exactly as the catalog writes it. The feature's form
  (built-in, opt-in, ...) is derived from that row in `src/lab/catalog.ts`; never restate it.
- `__tests__/catalog-coverage.test.ts` fails when a catalog row has neither a feature nor
  a `GATE_PROVED_ROWS` entry (rows proved only by a Worker, SDK, release or host gate),
  and when a `GATE_PROVED_ROWS` entry is stale. A new or changed capability updates the
  catalog row, its feature and its tester manual page in the same change.
- A visual feature must be obvious: saturated colors, one subject, and an OFF state a
  tester can describe in one sentence. `expect` says what ON and OFF look like.
- Use `src/lab/stage.ts` helpers (`spawnStage`, `spawnMesh`, `standard`, `unlit`) and
  built-in meshes; do not depend on the private asset submodule.
- Record results with `CheckList.ok/equal/near/run`; inside `run` return a detail string to pass and return `false` or throw to fail. A probe with zero checks fails.
- Feature source is English-only; the tester manual is Chinese.
- `knownIssue: '<engine bug>'` marks a reproduced engine bug. The feature must still
  fail: the runner and Vitest report it as `KNOWN` and fail once it passes, so the fix
  PR removes the flag together with the catalog's "Known issue at baseline" note.
- `expectsAppError: true` (visual/probe) inverts the app-error rule for features whose
  contract is a structured refusal: the run fails when no app error is reported.
- `main.ts` runs `checks()` once at boot (the runner owns that call under automation). A
  check that poisons the World or stops the App must create a private second App on its
  own small canvas and dispose it, or the lab App stops producing frames.
- The lab App starts rendering at the first `frames()` wait or when `setup` returns, so
  spawn the camera before the first wait. A feature that spawns no Camera gets a neutral
  lab camera, which keeps RHI, DOM and data probes free of `render-system-no-camera`.
