# RobRun native port

A local, direct rewrite of the saved RobRun map viewer. The source modules were copied first, then adapted in place. Rendering uses the native ForgeaX App, ECS, AssetRegistry, Mesh, Material and Instances APIs. The runtime has no legacy renderer or object-model adapter.

## Run

Build the Engine once with `pnpm build:engine`, then:

```sh
cd apps/robrun
pnpm dev
# http://127.0.0.1:8848/
```

`ROBRUN_REFERENCE` selects the saved runtime's `download/` directory. The default is the sibling `robrun-reference/download` directory outside the Engine checkout. Set the variable to the absolute snapshot directory when it is stored elsewhere. Only its `/data/` files are served read-only; no asset copies are committed here.

```sh
pnpm build
pnpm preview
pnpm test
```

The build rejects legacy rendering dependencies in its module graph and emits `dist/native-runtime-modules.json`. The preview uses the same external asset directory.

| Input | Action |
|:--|:--|
| WASD / Shift / Space | Move, sprint, jump |
| Click / mouse / wheel | Pointer lock, look, zoom |
| F / C / R | Fly, descend, respawn |
| M / N / E / T | Filters, markers, details, teleport |
| L / H | Shadows, HUD |

## Ownership

| Copied module | Native implementation |
|:--|:--|
| `data.js` | Same binary format, independent meshoptimizer decoder |
| `world.js` | Original instance transforms, LOD decisions and shadow selection; managed native geometry and Instances publication |
| `materials.js` | Original surface factors, alpha rules and demand tiers; native material values |
| `textures.js`, `texture-worker.js` | Four bounded Engine Codec workers; managed native texture assets |
| `collision.js` | Original solid sections, 48-unit cells, query neighborhood and eviction; native math and a local triangle BVH |
| `main.js` | Original controls, gravity, five collision substeps, spawn search and camera behavior; native App frame ownership |
| `markers.js`, `overlay.js` | Original marker data, filtering, selection and teleport; Canvas 2D markers and DOM panels |

This remains the map-viewer scope of the acquired runtime. It does not add combat, extraction, networking or world streaming. Geometry still loads as a complete map, and texture demand only upgrades.

## Validation and limits

The local source passed real Chrome WebGPU checks for all four maps, empty texture queues, and at least 60 completed ready frames per map. Walking, grounded movement, jump/landing, filter controls and actual map-link clicks were exercised. Unit tests cover triangle/segment clearance and BVH ray traversal.

Known representation differences remain explicit: the analytic sky is sampled into an HDR equirect asset; native shadows have a different filter; water currently uses a static native Standard surface; marker icons use a 2D overlay without the original depth-tested pass. These are not pixel-parity results. Native texture conversion currently publishes RGBA8 mip chains, reconstructs normal Z, and bakes selected desaturation before upload.

One source geometry contains eight infinite UV lanes. Import maps those lanes to zero, preserves all vertices and triangles, leaves the original files intact and exposes exact source locations through `window.__looty.assetRepairs`.

## Measure

Keep benchmark output outside the source checkout:

```sh
node scripts/benchmark.mjs --session robrun-port --label native \
  --url 'http://127.0.0.1:8848/?fly=1&pos=30,50,-40' \
  --output /absolute/path/outside-checkout
```

Open the managed browser session using `scripts/browser.json` first. The collector records actual render calls, native ready completions, frame intervals, heap observations and real-input motion. Its matched workload hides marker icons in both versions. Ordinary throughput, CPU sampling and GPU timing must use separate windows. Measurements are specific to the recorded device, viewport, settings and content; HUD FPS alone is not acceptance.

Use `--profile` for a separate native diagnostic run. It enables `?gpu-timing=1`, records static and moving Chrome CPU profiles, Render scene counters and receipt-bound GPU pass observations. Retain failed timing observations separately from complete samples. Hidden build source maps support mapping the profiles back through package build outputs; archive the maps with each measured build.

Use `--cpu-stages` in a separate run to collect the Engine's nested CPU phases,
then an independent Chrome CPU profile over the same real-input motion route.
The explicit `?cpu-profile=1` entry supplies the shared Engine Profiler; it is off
by default. Manual capture completion can report `partial/stopped-before-frame`;
retain that status, count only closed phases, and reject dropped-event captures.
Parent/child phase durations and alternate call-stack projections are not additive.

Ordinary `--warm-motion` windows first drive the complete route without sampling,
reset the camera pose, settle textures, then measure. Keep these sustained-motion
cohorts separate from the default first-motion windows; use the same option for
both compared builds. Profiler and GPU-timing runs reject this throughput option.

`?rhi-capture=1` attaches the native recorder before startup and exposes `window.__looty.native.app.rhiCapture`. `?ablation=scale=0.5` enables an explicit diagnostic ablation. Both are off by default. Captures and ablations are intrusive diagnostic workloads and must not be mixed with ordinary throughput results or shipped as quality reductions.
