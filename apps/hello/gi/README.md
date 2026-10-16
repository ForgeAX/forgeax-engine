# hello-gi

Visual validation demo and metrics harness for real-time diffuse GI on the ordinary
Renderer. The renderer's `StandardProfile.diffuseGi` lane is compared with GI off and with
the bounded path tracer reference (`@forgeax/engine-render` ray reference).

## Scenes

| id | What it checks |
|:--|:--|
| `cornell` | Colour bleeding and unlit-region fill in a closed box with one point light |
| `leak` | Thin-wall light leak: a lit room next to a dark room behind one thin wall (`darkRoom` region) |
| `courtyard` | Sky irradiance through an open roof with a sun |
| `sponza` | Khronos Sponza through Meta -> Cook -> Catalog (`SPONZA.sceneGuid`) |

## Dev app

```sh
pnpm --filter @forgeax/hello-gi dev
# http://127.0.0.1:5173/?scene=cornell&gi=exact&size=512
```

Query parameters, mirrored by the on-page controls:

| parameter | values |
|:--|:--|
| `scene` | `cornell` (default), `leak`, `courtyard`, `sponza` |
| `gi` | `off`, `exact` (default), `irradiance-field`, `screen-probe` |
| `tier` | `low`, `medium`, `high`, `epic`: replaces `gi=` with `resolveDiffuseGiTier`; the status line shows the resolved lane and any capability fallback |
| `light` | `off` to disable the key light |
| `moved=1` | moves the key light to its alternate position |
| `emissive` | `off` to disable the emissive panel |
| `camera` | `path` animates the camera along the scene path |
| `size`, `bounces` | canvas size (512) and GI bounce count (1) |

`window.__gi` exposes `set`, `observe(frames, warmup)`, `state()` and `capture(runId)` for
automation. Dev serve defines the RHI Debug flag, so `capture` uploads a tape through
`/__forgeax-debug/tape`.

## Smoke

```sh
pnpm --filter @forgeax/hello-gi smoke
```

60+ GI frames on Cornell under dawn-node with pixel falsifiers: GI brightens the
raster-unlit mask (AC-2), path-traced direct equals raster direct and GI indirect matches
the path-traced indirect within [0.6, 1.6] (AC-3), emission alone yields indirect light
(AC-4), and with every source off GI equals direct (F-1). A second renderer settles the
`leak` scene on the irradiance-field lane against a 256-sample path-traced reference:
its total indirect stays within ±10 % of the reference and the dark-room indirect
within [0.5, 1.0]x of it (AC-7; AC-5 and AC-6 cover the screen-probe lane on the same scene), so
light leaking through the thin wall fails the smoke. A third renderer runs the baked
lane (AC-8): the smoke cooks the leak and Cornell volumes through the irradiance-volume
NativeCooker (32 rays x 16 paths, 7 bounces), writes them as a served catalog in a temp
directory, loads the leak volume by GUID and requires indirect within ±10 % and the dark
room within [0.4, 1.3]x of the same reference, `baked-field.*` passes and no trace pass.
F-2 rebakes the leak volume (same digest, fingerprint and bytes) and gathers the Cornell
GUID over the leak scene, which must change the image.

Sponza is too heavy for the smoke; `gi-gallery.mjs` gates its irradiance-field
indirect/reference ratio to [0.9, 1.1] (b7, 512 px) and exits 1 on a violation.
Historical brightness-selected ratios do not qualify a new head.

## Reference and metrics tool

```sh
pnpm --filter @forgeax/hello-gi reference -- --scenes cornell,leak,courtyard \
  --size 128 --frames 64 --samples 1024 [--gather exact|irradiance-field|screen-probe|baked] \
  [--probe-budget N] [--capture] [--out artifacts/gi-reference] \
  [--bake-rays 128] [--bake-samples 256] [--bake-density 1] [--bake-dir <dir>]
```

`--gather baked` first cooks every selected scene's volume (`scripts/gi-bake.mjs`) with
the same integrator, ray scene, lights and bounce budget as the reference, on the live
field's probe lattice (`--bake-density` subdivides it), writes `pack-index.json`, one Pack
v2 descriptor and one `.fxiv` artifact per volume under `--bake-dir` (default
`<out>/baked`), and renders the lane from that catalog by the GUIDs in `BAKED_VOLUMES`
(`src/scenes.ts`). The report adds a `bake` table: probes, paths, bake time, artifact and
resident bytes, digest and input fingerprint. Sponza bakes with `--sponza <prepared dir>`.

For each scene it writes `<scene>-{direct,<gather>,reference,<gather>-indirect,reference-indirect}.{pfm,png}`,
`<scene>-heatmap.png` (blue under, red over the reference indirect), `contact-sheet.png`
and `report.json`. The report holds indirect mean / RMSE / relative error (all pixels,
raster-unlit pixels, and the `leak` dark room with `excessEnergy`), per-pass GPU timings
(median over the sampled frames; `giMs` sums the GI passes) and wall times.
`--capture` records one RHI tape per scene, replays it on a fresh device, compares the
final draw with the live surface and records tape size and capture/replay timings.
Requested scenes, GPU errors, failed capture and live/replay divergence fail the command
after preserving its report. Unsupported resource readbacks remain explicit.

The exact pixel-center reference's primary identities define the common coverage
mask, including dark geometry and missing GI pixels. Reports retain the old
brightness-selected denominator under `legacyLaneCoverage`, separately from the
reference-owned metrics. Unlit pixels are selected from reference direct light.
Each reference cache retains this mask and a source receipt covering Engine, assets,
prepared geometry/textures and the Catalog; a different receipt retraces it.
`--seed` selects independent reference sampling (default 47). Compare at least two
seeds before attributing error to a gather; the cache and gallery include the seed.
`--reference-only` writes an independent reference and coverage without creating
a candidate lane. Sponza uses all original Catalog materials; these tools skip the
unused procedural material cook when no procedural scene is requested.
`gi-reference-noise.mjs <candidate-dir> <independent-dir> <scene> <out-dir>` checks
matching source, integrator and geometric mask, then writes reference disagreement,
absolute-error percentiles and the candidate's error against both streams. Its PNG
uses one exposure for both references. Two streams provide a noise witness rather
than a statistical confidence interval.
`gi-gallery.mjs` requires every requested scene/lane, matching source, settings and
coverage digest. Duplicate selectors fail instead of silently changing a control.

For deeper post-work inspection of an irradiance-field tape:

```sh
FORGEAX_WEBGPU_NODE=wgpu-native node scripts/gi-inspect.mjs <frame.rhitape> <inspection.json>
```

The tool uses RHI Debug on a fresh device to read bounded producer-layout records
at the actual Card, trace, update, derive and gather works. Integer classification,
packed relocation, radiance and distance moments retain their scalar types.
Nonfinite sampled values, failed reads and an empty inspection fail explicitly.
The full tape and all-resource comparison remain the capture report's evidence;
bounded samples do not prove global cache coverage.

`reference.mjs --capture` also reads the field's actual bound buffers at each
producer work. Its gather reads retain the View uniform, field cache and moments,
plus full depth and packed-normal receiver textures. Depth/stencil reads explicitly
select `depth-only`; their producing work must precede the selected gather. These
texture bytes share the existing **64-MiB** intermediate diagnostic budget with
buffer prefixes. Every report retains bound offsets, byte coverage and structured
read failures. An unavailable following-frame depth seed remains unavailable;
intermediate replay reads do not establish live/replay depth equality.

### Balanced performance measurement

```sh
FORGEAX_WEBGPU_NODE=wgpu-native node scripts/gi-performance.mjs \
  --scene sponza --gather irradiance-field --size 512 --cycles 3 \
  --warmup 256 --frames 32 --pass-timing on --out artifacts/gi-perf-timed
FORGEAX_WEBGPU_NODE=wgpu-native node scripts/gi-performance.mjs \
  --scene sponza --gather irradiance-field --size 512 --cycles 3 \
  --warmup 256 --frames 32 --pass-timing off --out artifacts/gi-perf-bare
```

Each cycle uses off/on/on/off with completed-frame wall samples and no HDR
readback or RHI recording. Timing-on reports raw pass ticks, interval sum, union,
overlap and envelope through the Engine's existing interval parser. These are
coverage measurements; neither pass sums nor queue-completed wall latency are
exclusive GI GPU cost or a native outer timestamp. Report timing completeness,
adapter identity, temperature/contention conditions and both observer modes.

Indirect is `image - direct` on both sides; the reference direct is the path tracer with
`maxBounces: 1` and a black sky.

### Native wgpu lane (hardware Ray Query)

```sh
pnpm --filter @forgeax/engine-rhi-wgpu-native build:native
FORGEAX_WEBGPU_NODE=wgpu-native pnpm --filter @forgeax/hello-gi reference -- \
  --gather irradiance-field --scenes cornell,leak,courtyard --capture --out artifacts/gi-native-rq
FORGEAX_WEBGPU_NODE=wgpu-native FORGEAX_WGPU_NATIVE_RAY_QUERY=off pnpm --filter @forgeax/hello-gi \
  reference -- --gather irradiance-field --scenes cornell,leak,courtyard --capture --out artifacts/gi-native-sdf
```

`FORGEAX_WEBGPU_NODE=wgpu-native` swaps the scripts' Dawn `GPU` for the
[native wgpu `GPU`](../../../packages/rhi-wgpu-native/README.md#node-binding-napi-rs).
On a Ray Query adapter, such as Lavapipe 25.2 or Metal, the irradiance field selects
`traversal: 'ray-query'` itself. Withholding the feature (`=off`) runs the Global SDF
traversal on the same device, so the two reports compare the traversal alone. `smoke` and
`--capture` replay run unchanged on this lane. A missing addon fails the scripts with
`adapter-unavailable`.

### Browser lane (Sponza, WebGPU)

```sh
node scripts/browser-gi.mjs --cdp http://127.0.0.1:9222 --url http://127.0.0.1:5173/ \
  --scenes sponza --size 512 --frames 64 --capture --out artifacts/gi-browser
(cd ../../.. && node scripts/raytracing/gltf/prepare.mjs artifacts/ray-sponza)
pnpm --filter @forgeax/hello-gi reference -- --scenes sponza \
  --browser artifacts/gi-browser --sponza ../../../artifacts/ray-sponza
```

`browser-gi.mjs` opens its own page over CDP, leaves other targets untouched, and writes
`<scene>.json`. The Sponza reference traces the prepared glTF ray scene.

## Representation coverage tool (Global SDF + Cards)

```sh
pnpm --filter @forgeax/hello-gi coverage -- [--scenes leak,alcove,sponza] [--size 128] \
  [--capture] [--sponza ../../../artifacts/ray-sponza] [--out ../../../artifacts/step4-acceptance] \
  [--card-bytes 134217728]
```

Per scene it settles the ordinary Renderer's irradiance field, then dispatches the
internal coverage kernel (`IRRADIANCE_FIELD_COVERAGE_WGSL`, the exact Global SDF march,
Card candidate search and lookup the field kernels consume) over pixel-center rays and
compares every ray with the exact triangle first hit. `report.json` holds:

- **coverage**: one class per pixel (`mapped`, `not-resident`, `no-sdf`, `sdf-miss`,
  `step-budget`, `negative-start`, `no-card`, `no-candidate`, `candidate-overflow`,
  `backface`, `invalid-normal`, `rejected` depth/orientation, `stale`, `false-hit`, `sky`),
  per scene and per object; misses stay their own class, never sky.
- **correspondence**: `agree`, `grazing`, `early`, `late`, `mask-proxy` (the opaque MASK
  proxy hits where the exact trace sees through), `sdf-no-hit`, `reference-miss`, with
  distance, plane-offset, normal-angle and Card-albedo error statistics.
- **memory**: Card atlas planes, occupancy, capture/lighting buffers, bytes per Card texel,
  Global SDF bytes and the Card table (instance, atlas region, texel size).
- **edit**: one material edit re-run; generations, recaptured and changed Card tiles and
  their owners, whether Global SDF voxels stayed byte-identical, re-created resources,
  per-producer GPU cost and the peak extra allocation.
- **budgetRejection**: when the scene's authored Card capture budget rejects preparation
  (Sponza's 32 MiB: per-section triangle and attribute buffers exceed it), the structured
  `ray-reference-limit` failure is kept; `--card-bytes` then measures the scene again under
  that explicit budget, reported as `cardsProfile`.
- **rejections** (leak): blend and two-sided materials fail the field with a structured cause.
- **rhi** (`--capture`): the Card-capture frame replayed on a fresh device with every capture
  draw mapped to instance / index range / material / `workIndex`, a steady tape whose Global
  SDF and Card atlas `readResource` bytes equal the live device, and `timePasses` per kernel.

PNGs: `<scene>-{coverage,correspondence,distance-error,card-albedo,reference-albedo}.png`
and `contact-sheet.png` with the class legend. `renderer-gi-coverage.dawn.test.ts` in
`packages/runtime` is the regression gate for the same kernel, edit and rejection paths.

## Gather lanes

The gather is one profile parameter, mapped in `diffuseGiFor` (`src/scenes.ts`):
`gi=<lane>` in the app and `--gather <lane>` in the tools. `exact` traces per pixel;
`irradiance-field` and `screen-probe` share one irradiance field whose grid, probe spacing
and Card budget derive from the scene bounds (procedural box AABB, or the authored Sponza
bounds) in `fieldFor`. The field refreshes `probeBudget` probes per frame round-robin
(128 by default, `--probe-budget` in the reference tool), so steady-state cost stays bounded
regardless of probe count. Field lanes trace mesh distance fields and Cards, so the
procedural box mesh (`createGiBoxMesh`) carries both; the exact lane ignores them. The
scene, materials and reference are identical across lanes, so their metrics compare
directly.

## Temporal response

```sh
node scripts/gi-temporal.mjs --scenes cornell,leak,courtyard --lanes irradiance-field \
  --events light,none [--tail-stride 16]
```

After a settled warm-up, one event (light move, camera cut, camera teleport, or `none` as
a stationary control) is followed by per-frame linear HDR captures; the converged image averages 16
frames spaced `--tail-stride` frames apart. Spacing matters: a probe keeps its Monte Carlo
error until its next lattice sweep, so consecutive tail frames understate the stationary
noise floor and leave frames-to-90 % unreachable.
The post-event camera's same-frame `visible-surface` rows define coverage, including
dark geometry. Each run retains that mask's digest, GPU failures and four linear HDR
PFMs alongside the displayed PNGs; incomplete or failed runs exit unsuccessfully.

## Quality tier budgets

`scripts/gi-budget.mjs` settles each tier (and optionally explicit `--gathers`) under
Dawn and prints median GPU time, graph pass counts and wall time per frame:

```sh
cd apps/hello/gi
node scripts/gi-budget.mjs --scenes cornell,courtyard --size 256 --frames 8 \
  --out /tmp/gi-budget.json
```

Measured on Dawn + lavapipe (software Vulkan, so absolute numbers are CPU-bound
and only the ratios carry over), 256x256, median of 8 settled frames:

| Scene | Tier | Lane | Passes | GI passes | GPU ms | GI ms | Wall ms/frame |
|:--|:--|:--|--:|--:|--:|--:|--:|
| cornell | low | direct-ibl-ssao | 19 | 0 | 23.96 | 0.00 | 54.2 |
| cornell | medium | irradiance-field | 25 | 8 | 32.28 | 12.18 | 47.6 |
| cornell | high | screen-probe | 36 | 17 | 86.17 | 62.89 | 121.0 |
| cornell | epic | screen-probe | 37 | 18 | 238.29 | 218.13 | 282.8 |
| courtyard | low | direct-ibl-ssao | 13 | 0 | 20.95 | 0.00 | 110.1 |
| courtyard | medium | irradiance-field | 19 | 8 | 27.84 | 12.56 | 41.4 |
| courtyard | high | screen-probe | 30 | 17 | 76.51 | 59.46 | 92.3 |
| courtyard | epic | screen-probe | 31 | 18 | 240.87 | 221.64 | 307.5 |

`--passes` adds per-pass GI medians plus the lane's `inspect().diffuseGi.cards` and
`probes` counters; `--warmup <frames>` draws past readiness first. The irradiance field
radiates every Card tile for four probe sweeps after its last relight, so its static
cost needs `--warmup` of at least `4 * probes.count / probes.perFrame` frames.

### Card amortization

Card direct light (`card-surface`, `card-lighting`) runs only on frames that capture or
relight Cards (light change, edit, capture slice); static frames skip both passes.
Radiosity re-gathers a rotating `1 / irradianceFieldRadiosityPeriod(plan)` of the tiles
per frame (period ≤ 4 and ≤ one probe sweep), after four full sweeps following any
relight. `inspect().diffuseGi.cards.relit` / `.radiated` report each frame's work.

Static scene, Dawn + lavapipe, 256x256, `--warmup 100 --frames 16 --passes`, median GPU
ms per pass. `pre` is the configuration before Cards went 16→32 texels and probes became
about 7x denser; `before` is that accuracy change without amortization:

| Scene | Variant | card-surface | card-lighting | radiosity | trace-probes | gather | upsample | IF total | radiated / tiles |
|:--|:--|--:|--:|--:|--:|--:|--:|--:|--:|
| leak | pre | 3.3 | 0.4 | 2.5 | 9.9 | 2.2 | 2.9 | 23.1 | 54 / 54 |
| leak | before | 11.2 | 0.9 | 10.0 | 11.4 | 2.7 | 2.7 | 41.0 | 54 / 54 |
| leak | after | - | - | 2.9 | 12.2 | 2.8 | 2.6 | 22.5 | 14 / 54 |
| cornell | pre | 2.9 | 0.4 | 2.3 | 11.2 | 3.4 | 2.9 | 26.0 | 48 / 48 |
| cornell | before | 9.9 | 0.8 | 8.3 | 11.4 | 3.4 | 2.9 | 39.8 | 48 / 48 |
| cornell | after | - | - | 2.3 | 12.0 | 3.6 | 2.9 | 23.7 | 12 / 48 |
| courtyard | pre | 2.8 | 0.4 | 2.9 | 8.8 | 3.0 | 2.9 | 23.1 | 60 / 60 |
| courtyard | before | 9.6 | 0.9 | 10.8 | 9.2 | 3.3 | 3.0 | 39.4 | 60 / 60 |
| courtyard | after | - | - | 2.9 | 10.1 | 3.3 | 3.0 | 22.0 | 15 / 60 |
| sponza | pre | 3.5 | 0.3 | 1.8 | 12.0 | 3.2 | 3.5 | 27.0 | 36 / 36 |
| sponza | before | 11.9 | 0.7 | 7.2 | 11.9 | 3.4 | 3.7 | 41.8 | 36 / 36 |
| sponza | after | - | - | 1.9 | 13.1 | 3.3 | 3.7 | 24.7 | 9 / 36 |

Light-move frames-to-90 % (`gi-temporal.mjs --events light,none`) and the reference
ratios (cornell 1.040, leak 0.987, courtyard 0.992, Sponza 0.980) match `before`. Sharing
radiosity across 2x2 texel blocks was rejected: it leaked through thin walls (leak
dark-room ratio 1.36 → 1.48).
