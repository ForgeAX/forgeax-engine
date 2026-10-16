# Shadow stress pressure consumer

Deterministic shadow-cache pressure workload for the shadow cache and performance redesign. It shows what the shadow raster path does on every frame; it does not claim any optimization by itself.

| Fact | Fixed contract |
|:--|:--|
| Ground | One `HANDLE_CUBE` slab, `96 x 0.1 x 96`, receiving and casting |
| Static casters | Default `4,000` boxes (`statics`, `1..50000`) with seeded yaw/scale/position, split into `Instances` entities of `500` rows |
| Moving casters | Default `128` instanced boxes (`movers`, `0..4096`) in one `Instances` entity. Every Update animates the leading `activeMovers` rows (default all) and publishes them with one `World.setArrayRange` row write (`moverWrite=rows`, default) or rewrites the whole column with `World.set` (`moverWrite=set`, the whole-column reference) |
| Skinned casters | Default `4` two-joint capsules (`characters`, `0..64`) whose upper joint sways every Update |
| Debris | Opt-in `0` static 4-10 cm cubes (`debris`, `0..50000`); they fall below one or two texels in far directional cascades |
| Lights | One `DirectionalLight` with `4` cascades plus `4` shadow-casting `SpotLight`s, for `8` shadow views in total |
| Point lights | Opt-in `0` shadowed `PointLight`s (`points`, `0..4`); each adds six cube-face shadow views |
| Capsule shadows | Opt-in `capsuleShadow=1` gives every character a `CapsuleShadow`; with `renderPath=deferred` the characters leave the directional cascades and shade from their authored skeleton capsules |
| Render path | `renderPath=forward` (default) or `renderPath=deferred`; compare capsule shadows against `renderPath=deferred&capsuleShadow=0` |
| HZB occlusion | `gpuOcclusion=1` (default) runs the main view's two-phase GPU occlusion cull; `gpuOcclusion=0` is the frustum-only A/B baseline |
| Camera | `camera=static` (default), `camera=orbit`, or `camera=low`; the orbit moves the main view and cascade fit every frame, and `low` orbits at eye height (`1.5`) from radius `56` so the near casters occlude most of the field (the HZB occlusion A/B view); its ground plane extends to half-extent `256` so the horizon shows ground rather than a void |
| Occasional movers | Opt-in `0` individual (non-instanced) boxes (`occasional`, `0..4096`) on a ring; each gets exactly one `Transform` push per `occasionalPeriod` frames (`16..4000`, default `300`), staggered so at most a few move per frame; a period near the `100`-frame shadow settle threshold exercises the settle backoff |
| Spawn storm | Opt-in `0` boxes (`spawnStorm`, `0..1024`) spawned every Update while the previous frame's set is despawned |
| LOD oscillation | Opt-in `lodOscillate=1` adds a `16 x 16` sphere grid whose root `MeshAsset.lods` names two cataloged lower levels (`screenCoverage` `0.13`, `0.08`), and sweeps the camera distance between `0.45x` and `1.25x` every `2` s so the grid crosses both thresholds; it composes with `camera=orbit`. `lodGrid=<side>` (0 to 64) sets the grid side independently of the sweep, e.g. `lodGrid=40` for a denser occlusion workload without distance oscillation |
| GPU pass timing | Opt-in `gpuTiming=1` enables renderer `gpuPassTiming`; `summary.gpuPassMicros` holds per-pass (`passKind:passName`) and `TOTAL` distributions over every observed frame. Timing queries add GPU work, so compare timed runs only with timed runs |
| TAA | Opt-in `taa=1` sets `antialias: ANTIALIAS_TAA` on the main camera so temporal history and motion vectors take part; used for TAA-on pixel-parity comparisons |
| Seed | `0x5ad0c0de`, workload version `1`, included in the fingerprint |

```text
http://127.0.0.1:5208/?statics=4000&movers=0&characters=0&camera=static
```

`smoke` loads the built Vite bundle in Dawn-node. It records a complete CPU `ProfileCapture` (`profileDetail`, default `passes`) over `profileFrames` (default `30`) frames, so each shadow graph pass is attributed separately. It then samples `renderer.inspect().shadowRaster` for `sampleFrames` (default `29`) frames, so the default smoke completes 60 frames, recording each frame's raster pass count, draw count and per-view miss reason. Optionally it then drives `PERF_TIMED_FRAMES` (default `0`, opt-in for comparisons) unprofiled frames and waits for queue completion after each one; `syncedFrameMicros` therefore includes the software adapter's shadow rasterization, which the CPU phases omit. Every frame it also records the GPU-driven production counters from `renderer.inspect().renderScene.gpuDriven`; `summary.gpuDriven` holds their distributions from frame 2 on (`planRebuildBatches`, `planRebuildCandidates`, `lodSelectionChanges`, `filteredPlanBuilds` and the scene/candidate/LOD-payload/batch/palette upload bytes) plus `planRebuildFrames`, the number of frames that re-derived the submission plan. `summary.gpuDriven` also carries `shadowCasterFlips` and `shadowCasterPendingPromotions`, and `summary.shadowStaticMissCount` / `summary.shadowStaticPartialCount` / `summary.shadowMissCount` give the per-frame distributions of static-layer re-rasters, the subset redrawn only in dirty rects, and all shadow view re-rasters. `summary.shadowCameraCulled` gives the per-frame distribution of final-layer casters skipped against the camera pyramid (`shadowRaster.views[].cameraCulled`). `warmupFrames` (query, default `0`) runs that many frames before profiling and sampling start, so a value of `150` or more measures the settled caster classes instead of the start-up promotion of every caster. The smoke asserts that all eight views, plus six per point light, are reported with a static layer, that the pass count equals the miss count, that `debris > 0` observes a nonzero `texelCulled` count, that `lodOscillate=1` observes a nonzero `lodSelectionChanges`, that Deferred `camera=low` with GPU occlusion observes a nonzero `cameraCulled`, that Forward never camera-culls, that the image is not clear-only, and that no renderer errors occurred. Results go to `artifacts/dawn.json`, with a readback PNG beside them.

```bash
pnpm --filter @forgeax/perf-shadow-stress build
PERF_QUERY='?movers=0&characters=0' pnpm --filter @forgeax/perf-shadow-stress smoke
```

The Dawn samples are CPU evidence. `syncedFrameMicros` is a software-adapter wall time, not hardware GPU time.

`motion-matrix` is a diagnostic, not a CI gate. It runs the built smoke once per motion case (static/orbit camera with 0/128/1024 movers and 0/4/16 characters, `statics=20000` variants, the opt-in workloads above including an occasional period of `150`, and the mover write cases: `static/128/4/set` against the default row write, and one active row of `4096` movers through `setArrayRange` or `World.set`) with `PERF_TIMED_FRAMES=30`, writes each artifact to the ignored `artifacts/motion-matrix/`, and prints one Markdown table: CPU frame, synced frame and `renderer-draw` p50, `record` p95, the `record/gpu-driven-prepare` phase p50s, its share of `renderer-draw`, and the GPU-driven counters. `record` runs twice per frame and only one run carries the preparation, so its p95 rather than its p50 tracks that cost. It also reports the mean static-layer and all-view re-rasters per frame, mean and max caster class flips, and pending promotions. `--only='orbit/0/0;lodOscillate=1'` narrows the cases, `--timed=N` changes the synced frame count, and `--warmup=N` passes `warmupFrames`.

```bash
pnpm --filter @forgeax/perf-shadow-stress build
pnpm --filter @forgeax/perf-shadow-stress motion-matrix
```

A build with `FORGEAX_ENGINE_RHI_DEBUG=1` plus `PERF_RHI_CAPTURE=<path>` on the Dawn smoke writes one steady-state `.rhitape`; its result JSON's `rhiCapture.trailingSamples` holds the shadow-raster and GPU-driven samples of the frames rendered while the capture was pending. `scripts/inspect-shadow-tape.mjs <path>` (under the lavapipe wrapper locally) replays that tape on a fresh Dawn device and tabulates every static and final shadow array layer: its depth raster passes, and whether its depth after the last work item equals its captured initial content. It exits non-zero when a static layer without a raster pass changed, or when a static layer redrawn partially (depth `loadOp: 'load'`) changed any texel outside that pass's scissor rects. `scripts/inspect-shadow-cull-tape.mjs <path>` replays the same tape and reports the camera-culled count of every `cullViewShadowCamera` dispatch, plus the instances each depth-only raster pass submits through its indirect draws. Compare a `renderPath=deferred&camera=low` tape with its `gpuOcclusion=0` twin: the culled passes submit fewer instances while the readback PNGs stay identical.

```bash
FORGEAX_ENGINE_RHI_DEBUG=1 pnpm --filter @forgeax/perf-shadow-stress build
PERF_QUERY='?camera=static&movers=0&characters=0&occasional=512&warmupFrames=400' \
  PERF_RHI_CAPTURE=artifacts/frame.rhitape node scripts/smoke-dawn.mjs
node scripts/inspect-shadow-tape.mjs artifacts/frame.rhitape
```
