# Standard renderer performance comparison

Measure two independently built Engine checkouts on the same qualified Dawn
host. The workload contains 306 spheres, 12 Standard materials, 960 triangles
per receiver, medium SSAO, FXAA and four 1024-pixel directional shadow cascades.
It runs at 320 x 180 so software GPU execution remains practical. Both fixed
and moving-camera windows submit real GPU work and await every frame receipt.

```bash
# Run from the candidate checkout, after building both checkouts.
LP_NUM_THREADS=4 /path/to/with-lavapipe node scripts/bench/standard-deferred-compare.mjs \
  --baseline /path/to/baseline --candidate /path/to/candidate \
  --path deferred --pairs 4 --warmup 60 --frames 180 \
  --output artifacts/deferred-comparison

# Repeat with --path forward and a separate output directory.
```

Use the same CPU affinity and GPU environment for all runs. Keep builds, tests
and other benchmarks off those CPUs while measuring. The driver alternates
baseline/candidate and candidate/baseline order, with a fresh process and the
same warmup for each run. It rejects odd pair counts, changed cohort builds,
different shader manifests, settings, GPU admission, pass rosters or final
image bytes. Each run saves its raw samples, log and an untimed RGBA16F readback;
`comparison.json` summarizes the paired observations.

| Evidence | Meaning |
|:--|:--|
| `cpuSubmitMs` | Synchronous `renderer.draw` duration, including JS and native driver work; World update and GPU completion wait are outside it. |
| `completedFrameMs` | Draw start through successful receipt completion. |
| `completedFps` | Completed frames divided by whole-window elapsed time, including World update and transform propagation. |
| Median / p95 | Nearest-rank frame quantiles: `sorted[ceil(p*n)-1]`. |
| Paired CPU reduction | `100 * (1 - candidateMedian / baselineMedian)`, reported per pair with the median and full range across pairs. |
| `pixelSha256` | Byte identity of a separate fixed-camera linear-HDR observation after timing ends. |
| Source / runtime identity | Git commit, tracked dirty state, SHA-256 of the built Render JavaScript inventory, and shader-manifest SHA-256. |

> [!IMPORTANT]
> Software GPU FPS is a measurement of that host and workload. It does not
> predict hardware GPU FPS. CPU submission can include native-driver blocking;
> do not call it pure JavaScript time or compute an application FPS from its
> reciprocal. Report the individual pairs and their spread, including regressions.

For diagnostics, run one cohort with profiling enabled:

```bash
LP_NUM_THREADS=4 /path/to/with-lavapipe node scripts/bench/standard-deferred.mjs \
  candidate-profile --path deferred --warmup 60 --frames 180 --profile
```

This writes a Chrome-compatible `.cpuprofile` and an Engine `.profile.json`
beside the timing report in `artifacts/standard-deferred/`. Profiling begins
after warmup; these runs are excluded from performance comparisons. The Engine
capture contains nested phases, so parent and child durations must not be
summed. `forgeax profile summary` and `phase` can inspect that capture.

RHI capture/replay is separate from timing. The Standard Deferred parity Dawn
test records rigid and skinned Forward/Deferred tapes; the Surface pipeline
tests exercise the producer variants. Inspect those tapes using
`forgeax rhi summary` and `inspect`, and replay on a fresh backend when
checking resource bytes. A capture-enabled run is correctness evidence and
must not be mixed into an uninstrumented timing cohort.

Deterministic regression gates complement noisy wall-clock measurements:
`gpu-driven-material-artifacts.unit.test.ts` bounds producer resolutions by
distinct selected requests rather than receiver count, and
`fullscreen-feature-plan.unit.test.ts` bounds graph-signature size and repeated
source scans while checking source and nested declaration invalidation.
