# `@forgeax/hello-ssr`

> [!IMPORTANT]
> This is the paired Browser/Dawn carrier for the SSR v1 acceptance path. It
> owns the scene and evidence production only; `@forgeax/engine-render` owns
> authoring, admission, graph, history, and reflection-consumer behavior.

## Interactive comparison

Run `pnpm --filter @forgeax/hello-ssr dev` and open the page for the plane and cube
at 512 by 512 with temporal antialiasing enabled by default. Use `aa=none` to inspect the raw
reflection silhouette; the paired pixel-evidence scripts explicitly select it. The controls
above the canvas independently toggle SSR and the local probe, and select the
probe update mode. The interactive default is `on-change`: moving the cube or
changing the sky triggers a bounded new capture. `Capture now` also works in
once mode. Turning the probe off disables both update controls. AO quality,
Atmosphere sky/haze and cube position controls allow independent comparisons.
Turn SSR off to observe the probe's amortized update without screen-space
reflections covering it. The canvas and controls fit narrow windows without
horizontal scrolling.

A box-projected probe approximates the environment from one capture position;
it does not reproduce the cube's planar mirror image. SSR supplies that visible
object detail. The Atmosphere toggle selects a neutral Skylight tint so global lighting and
local captures use the same sky radiance. Without local geometry, toggling the
probe must not paint its influence box onto the floor.

Normal demo rendering does not enable reflection pixel readback. The dedicated
evidence scripts explicitly request that diagnostic capability.

The browser smoke additionally runs an Atmosphere + SSAO + probe journey:
60 completed frames, explicit and automatic sky updates, no stationary
recapture, GPU-driven lighting on every frame, one probe work step per frame,
and same-tape Dawn pixel parity. Optional GPU pass timings remain per-pass
observations; their overlapping intervals are not added into frame latency.

## One request, one status

The scene puts `ScreenSpaceReflection` on the active camera and supplies
Skylight lighting. The bounded `cube`, `tiles`, `probe-updates`, and `underside`
fixtures exercise the `ReflectionProbe -> Skylight -> neutral` chain; the large
`objects` showcase intentionally remains probe-free, so its SSR fallback stays
neutral instead of applying a box projection. The consumer reads detached
receipts and reports one of the following states:

| State | Meaning | SSR work |
|:--|:--|:--:|
| `not-requested` | camera has no SSR component | zero |
| `requested` | authoring exists, admission is incomplete | zero |
| `fallback-only` | a closed owner/capability/identity check failed | zero |
| `structural-only` | graph topology exists without an executable shader carrier | topology only |
| `admitted` | Standard deferred graph and shader manifest are bound | inspect before accepting |

The recovery route is always `inspect -> read the closed error/action -> repair
the owning producer -> submit -> reinspect`. A failed submit keeps the previous
owner receipt and hides the candidate; device recovery requires a new device
generation before another frame is accepted.

## Reproduce the carrier

```bash
FORGEAX_SKIP_HARNESS_SYNC=1 pnpm --filter @forgeax/hello-ssr build
FORGEAX_SKIP_HARNESS_SYNC=1 SMOKE_MIN_FRAMES=60 pnpm --filter @forgeax/hello-ssr smoke:browser
FORGEAX_SKIP_HARNESS_SYNC=1 SMOKE_MIN_FRAMES=60 pnpm --filter @forgeax/hello-ssr smoke
pnpm --filter @forgeax/hello-ssr smoke:paired
pnpm --filter @forgeax/hello-ssr smoke:falsify
pnpm --filter @forgeax/hello-ssr smoke:performance
```

Browser uses the smoke-owned URL
`http://127.0.0.1:4173/?forgeax-evidence=ssr`; Dawn runs the same scene with
`dawn://hello/ssr?forgeax-evidence=ssr`. Both lanes require 60 completed
frames, the current source/tree/lock/build identity, a real backend, the same
pass roster, and a readback bound to the completed receipt.

## Evidence contract

### Bounded static TAA comparison

For a storage-bounded display comparison, run from this app directory:

```bash
VITE_REFLECTION_PROBE_EVIDENCE=1 SSR_FIXTURE=tiles SSR_ANTIALIAS=taa \
SMOKE_MIN_FRAMES=60 SMOKE_WIDTH=1024 SMOKE_HEIGHT=1024 \
SMOKE_DISPLAY_DIR=.forgeax-debug/tiles-display \
node scripts/smoke-dawn.mjs
```

This drives the real paused App to temporal frame 1024, then retains nine
consecutive display PNGs and `frames.json`. Each frame must advance exactly
one committed temporal step without a reset, view change, or device change.
The manifest records the compiled shader catalog digest. Fixed submitted age
and Halton phase make repeated runs comparable despite host callback timing.
Choose a distinct output directory for each implementation.
Set `SMOKE_DISPLAY_CAMERA_STEP=0.05` for the native move/hold journey:
seven camera updates, 160 held frames with 8/32/64/128 checkpoints, then
nine native frames at temporal indices 1192–1200. Each advance also verifies
one completed App receipt with zero in-flight work on both sides.
For actual moving-reflection recovery, select `SSR_FIXTURE=objects` and
`SMOKE_DISPLAY_OBJECT_MOTION=1` instead of camera motion. The object advances
by 0.1 units per submitted frame, stops at +0.5, and uses the same bounded
160-frame recovery and nine-frame tail. This executes SSR and TAA together;
it is not the cached-input TAA-only settle splice. Camera/object offsets and
the separate capture-motion mode cannot be combined with this journey.
With `FORGEAX_ENGINE_RHI_DEBUG=1`, `SMOKE_DISPLAY_TAPE_FRAME=0..8` captures
one of those nine frames through the existing RHI capture owner instead of
an ordinary step. The same frame receipt records the tape path and digest;
the remaining frames stay PNG-only to bound storage.
Nine images cover all eight adjacent jitter transitions; eight images omit
one transition. For headed Browser evidence, the visual-skill wrapper can run
`scripts/capture-display-cycle.mjs` against the tile URL with a unique
`captureRun` query parameter. It retains nine canvas screenshots and returns
their temporal receipt coordinates, without downloading additional tapes.
The Browser report also records CSS bounds, borders, intrinsic extent, and
device pixel ratio. Its screenshots are page-composited pixels; fractional
canvas placement can filter away local variation and is not native readback.

Measure the native sequence with:

```bash
node apps/hello/ssr/scripts/measure-display-cycle.mjs /absolute/capture/frames.json
```

The measurement refuses incomplete cycles, discontinuous receipts, resets,
view/device changes, or resized images. It reports each phase's local peak
and pixel coordinates alongside regional means, without declaring visual
acceptance from a low mean. This native PNG route does not decode Browser
screenshots.

The same headed Browser capture supports a bounded move/hold recovery journey:

| Query | Meaning |
|:--|:--|
| `captureRun` | Unique artifact name prefix; required |
| `captureCameraStep` | Finite offset per moving frame in `[-0.1,0.1]`; default 0 keeps the static cycle |
| `captureSsr` | `on` (default) or `off` for the existing scene control |

For example, append `&captureCameraStep=0.05&captureSsr=on` to the tile URL.
After at least 128 valid TAA frames, the script retains a baseline, moves the
camera through seven authored World updates, holds for 160 submitted frames,
and captures the final nine-frame cycle. It saves motion-end and recovery
checkpoints at 8/32/64/128 held frames, plus every temporal and App frame-credit
transition. It restores the camera and original SSR toggle in `finally`.

Each step waits for `app.execution.report().frame.inFlight === 0` before and
after `app.stepFrame(0)` and verifies one submitted/completed receipt. A single
browser animation callback is not a GPU fence; using it as one can exhaust
App frame credit even when static screenshot-per-frame runs appear healthy.
This is a Browser-path smoke and recovery measurement, not the full-fleet
gate or independent visual acceptance.

> [!NOTE]
> Display frames are not per-pass HDR evidence. Use `SMOKE_CAPTURE_FILE` with
> `FORGEAX_ENGINE_RHI_DEBUG=1` for a canonical RHI tape and replay inspection.
> Display capture cannot be combined with the separate `SMOKE_CAPTURE_FILE`
> journey; use `SMOKE_DISPLAY_TAPE_FRAME` for one selected display frame. It does not
> replace the paired Browser/Dawn, motion-recovery, or performance gates.

### Recovery and static quality gates

`check-motion-recovery.mjs <frames.json>` compares the fixed 3496-pixel old
reflection ROI against a settled frame at the same terminal pose and jitter
phase. At eight held frames it requires mean <= 2, p95 <= 4, maximum <= 24
RGB code difference and <= 5% of pixels above four. This matches the prior
32-frame recovery; it is a convergence reference rather than physical truth.
`check-static-quality.mjs <baseline-cycle.json> <candidate-cycle.json>` additionally
checks local peaks, counts and persistent ranges from `measure-display-cycle.mjs`.
A recovery pass cannot excuse degraded static detail or flashing thin edges.

`smoke-motion-browser.mjs` uses the real development Pack route, App pause/step
controls and raw canvas pixels. Set `SSR_MOTION_BROWSER_URL` to the SSR dev server
and `SSR_MOTION_BROWSER_DIR` to an isolated output directory. Keep
`VITE_REFLECTION_PROBE_EVIDENCE=1` for this browser fixture; `0` selects the
separate lightweight bootstrap and does not open the SSR showcase.
`SSR_ANTIALIAS=none|taa|taau|taa-dynamic` selects an independent motion run.
Every mode requires stable admitted SSR history and one completed submission
per step; modes with TAA additionally require its advancing frame and valid
history. SSR-only runs use completed submissions for warmup because TAA's
disabled history counter is not a rendered-frame counter.
`SMOKE_DISPLAY_TAPE_RECOVERY=1 FORGEAX_ENGINE_RHI_DEBUG=1` captures the actual eighth
Dawn recovery frame; `inspect-motion-recovery.mjs <tape> <display.png>` replays it
on a fresh device, checks trace/temporal/mask/TAA lineage and exact final pixels.
Use `SMOKE_DISPLAY_TAPE_FRAME=7` for the settled reference at the same eight-phase
jitter as recovery frame eight.

For paired cost measurements, `tiles` supplies textured mixed-roughness receivers
and emissive wall tiles; `objects` supports `SMOKE_ANIMATE_RECEIVER=1` with bounded
`SMOKE_ANIMATION_AMPLITUDE` (default 0.4, range 0..3) and
`SMOKE_ANIMATION_SPEED` (default 0.04, range >0..1 radians per frame).
The `no-hit` fixture keeps a reflective receiver and the normal SSR trace budget,
without reflected scene objects or a local probe. Its lack of hits must be
verified from captured trace confidence. `SSR_ANTIALIAS=taau` fixes internal scale
at 0.67; `taa-dynamic` exercises GPU-driven scale changes over 0.5..1.

### Acceptance artifacts

The static contracts are kept beside this carrier:

- `evidence/schema.json` — paired lane, identity, visual, falsifier, and
  performance envelope;
- `evidence/inspection.schema.json` — bounded `renderer.inspect().ssr` POD;
- `evidence/visual-cases.json` — the nine visual expectations that must each
  record `observed`, `verdict`, and `confidence`.

Runtime artifacts are written under `artifacts/ssr-fallback/` and are disposable
run evidence, not a second owner or ledger. `smoke-falsify` deliberately breaks
screen source, fallback, edge/roughness confidence, Hi-Z thickness, history
rejection, transaction visibility, forward exclusions, and cube-face commit;
every mutation must fail closed and remains `manifestEligible=false`.

The performance lane derives the 1920x1080 active logical descriptor independently
and checks it against Render's `estimateSsrSpatialMemory`. Four off/on/on/off
runs each complete 180 frames: 120 warmup, then 60 sampled frames. Raw pass ticks,
sum, union and envelope remain distinct. Only the ABBA shift of full-graph
envelopes enters the unchanged 3/5 ms GPU budget; the p95 shift compares per-run
p95 values, while ordinal paired deltas are diagnostic. No value represents
exclusive SSR cost or FPS. Portable RHI has no enclosing native timestamp query.

Callback submission CPU excludes receipt wait. The report separately records
completion wait and callback-to-completion time. `measurement.status` requires
complete samples and matching adapter, host and shader identities;
`budget.status` additionally requires a physical adapter. Missing timestamps,
fallback/software adapters and incomplete samples cannot pass a hardware budget.
The 0.25 ms CPU submission and 45,088,768-byte active descriptor gates are
unchanged. Logical descriptor bytes do not bound allocation peaks.

For independent Chrome evidence, start this app with `VITE_SSR_EVIDENCE=1`
and `VITE_REFLECTION_PROBE_EVIDENCE=1`, then run
`SSR_PERF_BROWSER_URL=http://127.0.0.1:4419/ SSR_PERF_BROWSER_DIR=<absolute-output-dir> node scripts/smoke-performance-browser.mjs`.
The carrier owns a fresh Chrome process and captures 1920×1080 tile-fixture
off/on/on/off samples and unscaled canvas PNGs. Every paused App step must
submit and complete exactly one frame. It reuses Renderer receipt observations
and the existing interval aggregation. Its CPU domain is the synchronous
Host App callback, excluding completion and readback; it remains separate
from the native submission gate. Browser evidence does not correct or replace
a failed native budget.

Set `SMOKE_RESOURCE_LIFECYCLE=1`, `SMOKE_CAPTURE_FILE=<path>` and
`FORGEAX_ENGINE_RHI_DEBUG=1` on the Dawn carrier to capture stable SSR,
explicit camera cut/restoration, disablement and readmission through the
existing RHI Debug owner. The camera cut must advance SSR's reset count. With
`SSR_ANTIALIAS=taa`, TAA disablement/readmission is captured as well. A 75%
backing-surface resize and restoration exercise graph/history replacement and
fence retirement on the ordinary Renderer path. These captures run outside the performance window. Live and peak bytes cover the
captured resource closure; retirement and driver allocation remain unavailable.

## Dynamic probe regression

`pnpm --filter @forgeax/hello-ssr smoke:probe-updates` is also part of
`smoke:browser`. With SSR disabled to isolate the environment, it verifies once,
on-change, explicit invalidation, continuous motion without starvation, and a
bright object behind the display camera. Frozen scene comparisons prove that
a new probe reaches final pixels. Identical material payloads must render the
same when their handle is shared across inside/outside receivers. The capture
then replays on Dawn with the same frame identity.

This regression selects the dedicated `probe-updates` fixture; the large
`objects` showcase remains probe-free for visual SSR comparisons.

The UI exposes update intent and explicit invalidation. Read
`renderer.inspect().reflectionProbes.updates` for active generation, pending
work, and latency. The shared budget is one face or mip step per submission;
a 64-pixel single probe completes a six-face/five-mip cycle in 36 submissions
after readiness. See the [Render contract](../../../packages/render/README.md#dynamic-reflection-probes)
for resolution, byte admission, and producer invalidation semantics.

Run-specific P1 captures and measurements are generated locally under the
ignored root `artifacts/ssr-fallback/` directory; they are not checked into the
repository. The scene cases and report schemas remain beside this carrier.
