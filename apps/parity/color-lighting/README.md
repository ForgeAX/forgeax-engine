# Color and Lighting Parity

Minimal, evidence-first parity gate for Three.js r184 and ForgeAX color and lighting.

For a complete scene written independently through both public APIs, open
`scene-authoring.html` and read the scene authoring comparison.
It includes CSM, PBR materials, post-processing, live controls and both full sources.

## Start here

```bash
pnpm bench:color-lighting-parity
```

The command builds the consumer, starts the preview server, executes the browser
matrix, and fails closed when a required producer or report field is missing.
The browser result is returned by `window.__colorLightingParity`; the Dawn
producer gate is exercised by the direct-light Dawn test.

## Capability and matrix contract

| Capability | Required route | Authority |
| :-- | :-- | :-- |
| Direct-light parity | Three r184 plus ForgeAX `SceneCase` | [`scene-case.schema.json`](./schemas/scene-case.schema.json) |
| Named case result | One `CaseReport` per case | [`case-report.schema.json`](./schemas/case-report.schema.json) |
| Required parity backend roster | Browser WebGPU, Dawn, Chromium WebGL2 fallback | [`package.json`](./package.json) `parityMatrix`; per-case `applicableBackends`/`matrixRequiredBackends` are owned by [`required-cases.ts`](./src/coverage/required-cases.ts) |
| Chromium final-display sentinel slice | Six Chromium WebGL2 cells: default sRGB, alpha mask, alpha blend, ACES tone, direct directional URP, transparent LDR URP | [`verify-webkit-color-lighting.mjs`](../../../scripts/dev-verify/verify-webkit-color-lighting.mjs) runs ForgeAX rhi-wgpu + Three r184 in isolated Chromium processes with WebGPU disabled; the filename remains a compatibility anchor for the protected CI context |
| Required pipelines | `urp` and `hdrp` | Generated `status-index.json` |

The current backend and pipeline matrix is generated at
`report/color-lighting-parity/status-index.json`. Read
`status-index.md` for the recovery map; this README does
not duplicate per-case status values.

> [!CAUTION]
> A matrix is complete only when required, primary, and matrix counts have no
> `not-executed`, `failed`, `unsupported`, or `degraded` entries. Missing
> producer evidence remains incomplete even when a browser canvas is visible.

> [!IMPORTANT]
> `finalDisplay` is display-space diagnostic output. `linearHdr` is the only
> attachment evidence used for HDR lighting claims. A final canvas, browser
> skip, generic smoke, replay texture, or analytic-only result never upgrades
> a missing producer to pass.

> [!NOTE]
> The Chromium fallback closes only the declared final-display sentinel cells.
> Its WebGL2 path does not claim `linearHdr`, HDRP transparent, or HDR IBL
> coverage. CI proves that `navigator.gpu.requestAdapter()` is absent or
> resolves to `null`, plus a real WebGL2 context; a missing capability fails
> closed instead of becoming a skip.
> Raw byte differences remain diagnostic; finite analytic/ROI fallback budgets
> are still enforced, with no empirical gamma, multiplier, or blend correction.

## Three.js r184 common-stage contract

The auto-exposure case pins `three@0.184.0`, commit
`d3b629c0c2097cec664ad16369bb6eae3b10e335`, and the lockfile integrity. Both
adapters consume the same stable asset/camera/light/input identities. Compare
`toneMapping`, `toneMappingExposure`, and `outputColorSpace` individually, then
only the common decoded-sRGB ROI (`epsilon <= 0.05`) with raw deltas retained.
The AC-27 producers are explicitly scheduled rather than hidden behind the
aggregate parity command. `scripts/ci/auto-exposure-ac27.mjs` owns the small
Browser receiver, canonical build digest, and executable join. After building
the Engine, run all four producers with one exact revision and artifact root:

```sh
set -euo pipefail
pnpm build:app hello/taa
HEAD=$(git rev-parse HEAD)
OUT=/tmp/auto-exposure-ac27-$HEAD
PORT=${PORT:-39101}
BUILD=$(node scripts/ci/auto-exposure-ac27.mjs digest --dist apps/hello/taa/dist)
mkdir -p "$OUT"

# Run both reference sides. Each side owns an isolated receiver directory, and
# the final paths include the lane so Browser POSTs cannot overwrite one another.
run_lane() {
  LANE="$1"
  LANE_PORT="$2"
  LANE_OUT="$OUT/$LANE"
  mkdir -p "$LANE_OUT"
  node scripts/ci/auto-exposure-ac27.mjs receiver \
    --port "$LANE_PORT" --output-dir "$LANE_OUT" >"$LANE_OUT/receiver.log" 2>&1 &
  RECEIVER_PID=$!

  # Dawn writes its JSON artifact directly.
  FORGEAX_AUTO_EXPOSURE_AC27_SCHEDULED=1 \
  FORGEAX_AUTO_EXPOSURE_AC27_BACKEND=dawn \
  FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION=$HEAD \
  FORGEAX_AUTO_EXPOSURE_AC27_WIDTH=128 \
  FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT=128 \
  FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE="$LANE" \
  FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT="$OUT/three-$LANE-dawn.json" \
    pnpm vitest run --project=dawn \
    apps/parity/color-lighting/src/visual/__tests__/auto-exposure-three-r184.dawn.test.ts

  # Browser variables must use VITE_* so Vite exposes them to the page.
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_SCHEDULED=1 \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_BACKEND=browser-webgpu \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION=$HEAD \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_WIDTH=128 \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT=128 \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE="$LANE" \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT="$LANE_OUT/three-browser.json" \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_OUTPUT_URL=http://127.0.0.1:$LANE_PORT/three \
    pnpm vitest run --config config/vitest.browser.config.ts --project=browser \
    apps/parity/color-lighting/src/visual/__tests__/auto-exposure-three-r184.browser.test.ts
  mv "$LANE_OUT/three-browser.json" "$OUT/three-$LANE-browser.json"

  FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_SCHEDULED=1 \
  FORGEAX_AUTO_EXPOSURE_AC27_BACKEND=dawn \
  FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION=$HEAD \
  FORGEAX_AUTO_EXPOSURE_AC27_WIDTH=128 \
  FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT=128 \
  FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE="$LANE" \
  FORGEAX_AUTO_EXPOSURE_AC27_BUILD=$BUILD \
  FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT="$OUT/forgeax-$LANE-dawn.json" \
    pnpm vitest run --project=dawn \
    apps/parity/color-lighting/src/visual/__tests__/auto-exposure-forgeax.dawn.test.ts

  VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_SCHEDULED=1 \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_BACKEND=browser-webgpu \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_TESTED_REVISION=$HEAD \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_WIDTH=128 \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_HEIGHT=128 \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_REFERENCE_LANE="$LANE" \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_BUILD=$BUILD \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT="$LANE_OUT/forgeax-browser.json" \
  VITE_FORGEAX_AUTO_EXPOSURE_AC27_FORGEAX_OUTPUT_URL=http://127.0.0.1:$LANE_PORT/forgeax \
    pnpm vitest run --config config/vitest.browser.config.ts --project=browser \
    apps/parity/color-lighting/src/visual/__tests__/auto-exposure-forgeax.browser.test.ts
  mv "$LANE_OUT/forgeax-browser.json" "$OUT/forgeax-$LANE-browser.json"

  kill "$RECEIVER_PID" 2>/dev/null || true
  wait "$RECEIVER_PID" 2>/dev/null || true

  node scripts/ci/auto-exposure-ac27.mjs join \
    --three "$OUT/three-$LANE-browser.json" --forgeax "$OUT/forgeax-$LANE-browser.json" \
    --output "$OUT/$LANE-browser-join.json"
  node scripts/ci/auto-exposure-ac27.mjs join \
    --three "$OUT/three-$LANE-dawn.json" --forgeax "$OUT/forgeax-$LANE-dawn.json" \
    --output "$OUT/$LANE-dawn-join.json"
}

run_lane direct "$PORT"
run_lane clustered "$((PORT + 1))"
```

The receiver persists the exact POST body, emits CORS headers, and rejects
unknown routes or malformed JSON. If the Browser runner is network-isolated,
start it with `--public-host` set to a host address reachable from that runner.
A missing receiver, provenance, readback, or paired artifact is `blocked`; no
aggregate parity command or fallback path upgrades it.

## Current status

The unique report authority is the per-case `CaseReport`. Read the generated
`directLightEvidence`, `attachmentEvidence`, `readback`, `status`, `verdict`,
and `firstDivergence` fields; do not infer matrix coverage from this document.

```mermaid
flowchart TD
    A["SceneCase input"] --> B["ForgeAX live producer"]
    A --> C["Three r184 adapter"]
    B --> D["linearHdr and finalDisplay observations"]
    C --> E["independent named captures"]
    D --> F["CaseReport"]
    E --> F
    F --> G["status-index recovery"]
    F --> H["cross-pipeline audit"]
```

## Evidence vocabulary

| Field | Meaning | Required proof |
| :-- | :-- | :-- |
| `linearHdr` | Native linear HDR producer attachment | `rgba16float`, current frame, native readback bytes, raw hash, size, pipeline, backend |
| `finalDisplay` | Native canvas/display output | Final readback bytes, raw hash, size, pipeline, backend |
| `attachmentReadbackStatus` | Attachment execution state | `complete` only after the producer readback is complete |
| `missingPipelineIds` | Required producer coverage | Empty when the unified `forgeax::standard` producer is present in the required runtimes |
| `firstDivergence` | First named failure owner | A report-owned metric, never an aggregate-only claim |

## Two-hop navigation

1. Use `status-index.md` to map a report state to its one
   recovery action.
2. Open the named owner and schema:
   [`SceneCase`](./schemas/scene-case.schema.json),
   [`CaseReport`](./schemas/case-report.schema.json),
   [capture/readback](./src/capture/attachment-readback.ts),
   [error routing](./src/errors.ts), or
   [cross-pipeline audit](./src/integration/__tests__/cross-pipeline-audit.test.ts).

The engine-side recovery entry points are [`forgeax-engine-material`](../../../skills/forgeax-engine-material/SKILL.md),
[`forgeax-engine-shader`](../../../skills/forgeax-engine-shader/SKILL.md),
[`forgeax-engine-render-pipeline`](../../../skills/forgeax-engine-render-pipeline/SKILL.md),
and [`forgeax-engine-rhi`](../../../skills/forgeax-engine-rhi/SKILL.md).

## M5 vertex-color parity lane

M5 adds seven named cases. The semantic JSON under
[`cases/vertex-color/`](./cases/vertex-color/) is the only shared input; the
ForgeAX and Three.js r184 adapters build their own scene, shader, capture, and
readback. The report records `sourceSha`, fixture hash, producer/build/backend,
color domain, samples, expected/observed RGBA, verdict, confidence, and
artifact references. The schema and TypeScript owner remain the authority:
[`case-report.schema.json`](./schemas/case-report.schema.json),
[`visual-evidence.schema.json`](./schemas/visual-evidence.schema.json), and
[`required-cases.ts`](./src/coverage/required-cases.ts).

| Case | Semantic input | Declared evidence domain | Falsifier |
| :-- | :-- | :-- | :-- |
| `vertex-color-vec3` | glTF VEC3 FLOAT, implicit alpha `1` | `displayEncoded` | white color changes a colored sample |
| `vertex-color-vec4` | RGBA / VEC4 FLOAT, non-`1` alpha | `linearHdr` | white color changes RGB |
| `vertex-color-normalized` | normalized UBYTE/USHORT endpoints and midpoint | `linearHdr` | raw integer values are not treated as normalized |
| `vertex-color-skinning` | colored mesh plus deterministic joint motion | `displayEncoded` | color survives all 60 frames |
| `vertex-color-mixed-primitives` | colored and absent-color primitives | `displayEncoded` | plain primitive is not given prior primitive color |
| `vertex-color-mask-taa` | vertex alpha drives MASK and TAA history | `displayEncoded` | cutout/history samples retain alpha coverage |
| `vertex-color-no-color-baseline` | `COLOR_0` absent, same geometry/material | `displayEncoded` | stream absence and baseline bytes stay unchanged |

Each case requires Browser WebGPU and Dawn, exactly 60 frames, live
`copyTextureToBuffer` readback, and RGB/alpha $arepsilon \le 0.05$ in the
declared domain. `linearHdr` is linear working space; `displayEncoded` is the
final display space; alpha is coverage and is never sRGB encoded.

```mermaid
flowchart LR
    F["semantic fixture"] --> A["ForgeAX producer"]
    F --> B["independent Three r184 producer"]
    A --> C["Browser or Dawn 60-frame readback"]
    B --> C
    C --> D{"provenance, domain, samples, falsifier"}
    D -->|"complete"| E["named CaseReport"]
    D -->|"missing or self-comparison"| X["fail closed"]
```

Run the lane from the repository root with
`FORGEAX_BROWSER_HEADLESS=0 pnpm bench:color-lighting-parity`. The gate writes
one report per case/backend under
`report/color-lighting-parity/vertex-color/`. Missing producer, readback,
domain, threshold, provenance, or visual evidence is `blocked`/`failed`; a
visible canvas, `RhiNull`, WGSL text assertion, self-comparison, all-zero
capture, or analytic-only result is not a pass.

<details>
<summary>Recovery owners</summary>

- `producer` / `backend`: the owning Browser or Dawn scene probe.
- `readback` / `domain`: [`attachment-readback.ts`](./src/capture/attachment-readback.ts).
- `provenance` / `samples` / `epsilon`: [`evaluate-case.ts`](./src/evaluator/evaluate-case.ts).
- `falsifier`: the named case producer; restore the semantic fixture before rerunning.
- `report` / `visual artifact`: the parity evidence writer and visual reader.

</details>

## Raw capture and reruns

The live observation path is:

```ts
renderer.observeCurrentFrame({
  semantic: 'linear-hdr',
  readback,
});
```

The producer owns the current frame. The readback owner copies and maps the
native resource, then returns bytes and provenance. Parity consumes the bytes,
hash, format, size, frame, pipeline, and backend fields; it does not consume a
graph key, RHI texture, or backend-private handle.

For a focused rerun, execute the browser producer directly and use the
partitioned Dawn runner for the native producer. Its default regression scope
runs eleven cases in four fresh Vitest processes. The required color-lighting
metrics job owns the disjoint four-case HDRP producer scope in one process;
each scene is captured once and artifact checks reuse those bytes.
Keep the resulting report with the same `caseId`; do not replace a failed
producer capture with a hand-authored hash.

```bash
pnpm exec vitest run --project=browser \
  apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts
node scripts/ci/run-direct-light-dawn.mjs
FORGEAX_DAWN_PARTITION_SCOPE=producer node scripts/ci/run-direct-light-dawn.mjs
```

## Scope boundary

The direct-light gate covers the frozen Three r184 squared finite-range
authority and `KHR_lights_punctual` import semantics. M5 IBL is a later
milestone and must consume this `linearHdr` seam rather than add an IBL-only
readback path.

> [!CAUTION]
> Never accept self-comparison, final-canvas self-comparison, URP-as-HDRP
> provenance, stale observations, missing `COPY_SRC`, guessed multiplier or
> curve, arbitrary graph keys, or a second copy/map implementation.

## Render defaults comparison

Open `render-defaults.html` on this app's dev/preview server. The page runs the
production ForgeAX FXAA and Bloom WGSL from the shader manifest and the actual
pinned Three r184 WebGPU nodes on identical 256x128 textures. It isolates the
post-processing kernels; it is not whole-renderer pixel parity.

```sh
pnpm --filter @forgeax/parity-color-lighting dev --host 127.0.0.1 --port 4276 --strictPort
# In another terminal, with a configured browser GPU:
node scripts/ci/local-graphics.mjs --probe browser -- node apps/parity/color-lighting/scripts/verify-render-defaults.mjs
```

The verifier saves `artifacts/render-defaults/comparison.png` and `.json` and
rejects GPU errors, missing effects, FXAA drift or Bloom gain inconsistent with
the independent truncated-Gaussian sum. Bloom visualization uses opaque alpha
because the isolated additive component inherits the zero scene's alpha; numeric
comparisons use raw RGB readback. The native WebGPU fixture is outside the App
RHI recorder: its screenshot and float readbacks do not constitute an RHI tape.
Software adapter results establish correctness, not hardware performance.

## Environment response

Skylight versus Three.js environment lighting provides
an interactive Forward/Deferred comparison of uniform and directional HDR environments,
including rotation, material-region means, spatial errors and optional RHI capture.
Open `environment-response.html` on this app's dev or preview server.

## Rendering response

Open `rendering-response.html` for the environment, shadow, transparency, GTAO and
temporal comparison entry points. Rendering response
documents the shared inputs, current policies, intentional differences and
commands that save the numeric evidence and real engine captures.
