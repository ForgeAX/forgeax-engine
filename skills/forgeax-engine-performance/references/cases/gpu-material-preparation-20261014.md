# GPU material preparation: fixed publication replay, 2026-10-14

Retain two changes in existing owners: derive vertex-color availability once for
scene-owned immutable vertex tables, and reuse one program-selection output per
pass collection. Borrowed mutable inputs and frozen accessors retain live reads;
forward/shadow program selection still observes the current producer each call.
A declined selection cannot overwrite the last accepted output. No second World,
revision index or visibility lifecycle is introduced.

A later integration counterexample shows that custom `map` implementations and
Array species can return frozen arrays with live getters or methods. Verify the
actual returned table before admitting either color or vertex-match caching.
Unproven results keep their original reads and failures until consumption.

## Matched workload and source

| Evidence | Value |
|:--|:--|
| Frozen Engine baseline | `df7db8766c8a6971be33fd0e068a6d36f9ec4787` |
| Frozen Engine candidate | `f4d201aadfd8d4b35d7c8bab9043cbce6bbac5db` |
| Game / Voxel source revisions | `848dad688c649b7d5906670cd5df174f5220e68a` / `555f4626` |
| Recording | Current-ABI production Demo firefight; same tape in every run |
| Tape SHA-256 | `2195b22b83df8491efaebd5ca0460bd4398f5af6d7f53a73a53d870d13a981ec` |
| Tape / warmup / measured work | 3276 / 3156 / 120 completed draws per run |
| Surface and runtime | Ordinary headed Chrome WebGPU; 1920x1080; DPR 1; Chromium sandbox enabled |
| Shadows | 3 cascades x 1024; PCF5; 12,582,912 map bytes |
| Credit / transport | Existing two-completion-credit protocol / transfer |
| Production artifacts | Clean normal Engine build; official local binding; normal mapped Game build |

The tape preserves scene changes, camera, materials, AI/combat/destruction
publications and rendering quality. Render Worker replay excludes Game simulation
and the original publication sender. Adapter/driver identity was not separately
captured; these samples do not qualify a hardware performance claim.

## Results: two reversed CPU pairs

CPU values are authenticated CDP/V8 sampled attribution divided by 120 completed
draws. Hidden Game maps are chained to the exact compiled Engine maps. Function
self time excludes separately sampled callees and GC; it is not a GPU timer.

| Round / order | Collector self before | Collector self after | Original prepared family before / after | Expanded prepared family before / after |
|:--|--:|--:|:--|:--|
| 14: baseline then candidate | 1.080 ms | 0.350 ms | 3.976 / 3.633 ms | 5.272 / 4.196 ms |
| 15: candidate then baseline | 1.126 ms | 0.560 ms | 3.412 / 4.158 ms | 4.658 / 4.790 ms |
| Collector self mean | 1.103 ms | 0.455 ms | | |

Collector self attribution falls by **58.8%**, or
approximately **0.648 sampled ms/completed draw**. The larger prepared
family is noisy and regresses in the reverse pair; its mean reduction must not
be presented as a stable whole-family improvement.

> [!IMPORTANT]
> The original prepared-family scope omitted this collection owner. The expanded
> scope explicitly includes material collection, program selection and vertex-color
> derivation in both variants. It is a reclassification, not directly comparable
> to the older 8.505 ms/frame table or to the original narrower family.

A separate process-CPU ABBA microbenchmark exercises 2048 owned rows, forward and
shadow selection, and exactly matching output receipts. Across 500 collections,
mean process CPU is 551.469 -> 374.482 ms (**32.1% lower**). This is a mechanism
measurement, not an engine frame benchmark.

## Ordinary completion throughput, no CPU profiler

| Pair / order | Baseline elapsed / completed draw | Candidate elapsed / completed draw |
|:--|--:|--:|
| 16: baseline then candidate | 21.359 ms | 21.188 ms |
| 17: candidate then baseline | 21.500 ms | 21.298 ms |
| Mean of two runs per variant | 21.430 ms | 21.243 ms |

Observed change is **0.87%**. Two runs on a shared host do not establish
statistical significance or whole-game FPS improvement. Raw samples and descriptive
percentiles remain in `ordinary-slim-comparison.json`; intervals are in each trial.

## Equal work and output across all eight final runs

| Observation | Both variants, every run |
|:--|:--|
| Measured completed draws | 120 |
| Final-frame admitted raster batches | 1553 |
| Final-frame encoded indirect draws | 1982 |
| Prepared native Bundle hits / builds, lifetime-counter window delta | 10,238 / 732 |
| Prepared native Bundle commands / evictions, window delta | 53,074 / 98 |
| Final PNG SHA-256 | `d49aac1ba4b9b77524e954112792ea1ef65c870b05c08f893811fc44a9d07852` |

The batch and encoded-draw values are final-frame counts, not totals over 120
frames. Bundle values are cumulative-counter differences. The PNG check covers
the final tape output; it does not claim every intermediate frame was read back.

## Correctness and integration

Focused tests preserve mutable vertex edits, frozen accessor observations,
accepted/declined forward and shadow programs, getter order, program refresh,
geometry/material revisions, stable indirect addresses, query boundaries and
native Bundle state. Both default fresh selection results and scratch reuse are
checked. Native transitions use real GPU execution and pixel/shadow readbacks.

- [x] Frozen candidate: 4231 Render tests; no type or source errors.
- [x] Integration with PR artifact-key capture: 4238 Render tests; no type/source errors.
- [x] Integrated native GPU: 14 tests across 4 files.
- [x] Integrated Chrome GPU: 10 tests across 4 files.
- [x] Official triangle smoke: 60 frames and pixel checks on frozen candidate.
- [x] Biome lint after integration repair; no errors (22 existing warnings).
- [ ] Complete final-head Browser/Dawn/core-smoke CI: separate delivery gate.

PR advanced during measurement. The integrated source retains upstream immutable
material-artifact keys as well as these two changes; the frozen A/B above does
not measure the later PR integrations. Integration initially produced one duplicate
palette-address test property, caught by lint/type checking; the duplicate was
removed and full Render regression passed. Failed logs remain retained.

## Rejected and deferred experiments

Prepared-admission delta and filtered-fragment reverse-membership prototypes stay
outside the delivered diff. One full capture improved the original prepared
family from 4.894 to 4.428 ms/draw, but a reversed capture was 3.863 to 3.861.
Three initial ordinary pairs averaged 23.418 to 24.995 ms/draw; later controls did
not establish a reliable benefit. A material-plus-index experiment also had noisy
whole-frame throughput. None is promoted as a production improvement.

An unconditional high-churn group index regressed its mechanism benchmark and was
rejected. The old material-row-672 tape failed current row-864 admission; those
failed trials were retained and the current production producer recorded a new
unmodified tape. A prematurely started binding/build transition was rejected by
the source-pin guard and rebuilt after binding completed. A fresh smoke checkout
was initially missing its build artifact; the normal triangle build restored it
before the successful smoke, without changing an oracle or threshold.

## Local evidence inventory

Game repository: `artifacts/gpu-prepared-incremental-20261014/` contains the
recording, immutable mapped builds, `slim-progress.json`, `slim-work-counts.json`,
`results.json`, `replay-trials/14..17-*`, authenticated CPU maps/owner summaries,
ordinary sample comparison, earlier prototypes and original failures.
Engine material worktree: `artifacts/gpu-prepared-material-20261014/` contains
clean build provenance, binding, full unit/lint, native/Chrome integration and smoke
logs. The separate retained experiment worktree owns the microbench receipts.
