# Worker GC ownership: 2026-10-14

| Field | Observation |
| --- | --- |
| Source | [Engine bf576ae8fe](https://github.com/ForgeaX-Games/forgeax-engine/commit/bf576ae8fe83cda7b0f2cd16cdad61d7186a67e7), Voxel ce84d2c, Game 848dad6 plus captured local source changes |
| Integration | [PR3855](https://github.com/ForgeaX-Games/forgeax-engine/pull/3855); subsequent scheduling/native-physics changes are outside these capture revisions |
| Workload | Browser WebGPU demolition 5v5, 1920x1080, three 1024 shadow cascades, PCF5; both teams fire/hit, player/camera move, player fires/hits/receives hits in each five-second interval; defenders may hold position |
| Natural GC | Accepted independent 15.855595-second CPU window, heap sampling disabled; environment contention unobserved, so no controlled A/B claim |
| Allocation | 32 KiB Poisson sampling including collected objects; strict trees and captured script SHA256 authenticated against frozen hidden maps |
| Allocation acceptance | Player had a five-second hit gap. Original capture remains FAILED; its profiles supply diagnostic ownership only |

## What the separate captures established

| Worker | Natural allocation rate | Minor GC wall | Major GC wall | Diagnostic allocation / direct / ancestor coverage |
| --- | ---: | ---: | ---: | --- |
| Engine | 199.815 MiB/s | 157.943 ms / 105 | 0 in this interval | 3183.21 MB / 74.873% / 99.9959% |
| Render | 480.573 MiB/s | 338.358 ms / 250 | 23.871 ms / 6 | 7474.57 MB / 62.643% / 99.9919% |

The allocation profiles cover approximately 16.45/16.98 seconds per realm,
including their profiler endpoints. Their totals cannot be substituted for the
independent natural-GC window. Counter rates exclude first/tail observations.
MB here means decimal 1,000,000 bytes; rates use binary MiB.

Nearest-caller file partitions placed Render `production-raster` at 19.87%,
production preparation at 8.71%, main-pass material at 6.24%, shadow recording at
4.82% and shadow-view preparation at 4.16%. The largest per-view projection
caller group included 285.28 MB under `join` and 129.28 MB under `next`.
Engine ownership concentrated in Voxel runtime at 19.96%, MetricVolume at 10.09%,
collapse at 8.54% and ray-box results at 7.58%. These are source callers, not an
exact statement-by-statement accounting or per-function GC pause distribution.

## Reusable changes and limits

| Change | Existing authority and correctness evidence |
| --- | --- |
| Rebased dispatch | [249b57df7c](https://github.com/ForgeaX-Games/forgeax-engine/commit/249b57df7c); replace duplicate dispatch indices with the existing slot owner; previous held publication remains unchanged after deletion/rebase |
| Material/hierarchy/claim facts | [bf576ae8fe](https://github.com/ForgeaX-Games/forgeax-engine/commit/bf576ae8fe83cda7b0f2cd16cdad61d7186a67e7); same resolved asset root, dense ChildOf span and existing shadow membership fact remain; observation sharing was subsequently withdrawn as described below |
| Retirement counterexample | Runtime material removal did not advance the observed value revision; the cache returned stale data. Include the existing structure epoch rather than introducing another clock |
| Query projection | Game final query boxes replace intermediate author projections; public outputs remain detached and ordered |
| Spatial leaf | Voxel tests a leaf's tight bounds directly while internal nodes retain conservative padded pruning; ray/bounds ordering and boundary cases remain covered |
| Support envelope | Game grows its existing coarse observation envelope geometrically while exact query-revision checks remain authoritative |

Integration found that frozen caller objects can contain live getters: sharing
them changed already captured material observations. Ten regression cases retain
this counterexample. Repeated data-descriptor checks restored correctness but
cost 2.85–3.67 times the earlier copying path in a Node 22 microbenchmark with
50,000 observations. The integration therefore restores detached observations
and removes the otherwise redundant producer freezes, without a new cache.
This local comparison is not a Game FPS result.

Local structural microbenchmarks showed substantial reductions on several paths.
The combined Engine Render/Scene regressions passed 4342 tests, with one original
skip; 21 focused native GPU tests passed at the source candidate. These prove
scoped behavior, not full final-head Browser/Dawn/core acceptance. Whole-Worker
allocation remained severe, and the 54 FPS target was unmet. A later successful
capture must add evidence rather than erase either failed workload capture.

Private raw profiles, frozen outputs and distribution reports remain with the
owning Game audit. Portable replay is provided by the skill's offline tools;
this case does not install local paths or fixed ports into future workflows.

## Follow-up: immutable prepared material keys

The Render preparation, artifact collector and per-view shadow projection rebuilt
the same four-field material/ABI key. The candidate derives it once when extract
or RenderScene seals a detached immutable draw and associates that scalar with
the existing draw lifetime. Raw, cloned, accessor and legacy input continues its
original live lookup; authoritative artifact-map reads are retained. Frozen
accessors do not qualify as captured primitive facts. No World epoch or another
entity/batch index is introduced.

A real RenderScene receiver regression first observed 128 serializations over 64
main/shadow lookup pairs; the candidate observes zero. Source-frozen CPU Worker
ABBA allocation diagnostics then executed 409600 lookups per sample with equal
checksums. Stable lookup allocation mean fell 71.7835 MB to 3.3270 MB (95.37%); a receipt
change on every iteration, including receiver/capture cost and 100 publications,
fell 115.1483 MB to 53.6320 MB (53.42%). Eight strict heap captures were retained.
Stable results exclude initial startup; producer-churn includes capture costs.
These are local allocations, with GPU disabled and instrumentation enabled, not
new whole-Worker GC/FPS or controlled hardware-throughput acceptance.

A further named-Worker replay authenticated the actually loaded script SHA256
against the frozen source bundles and validated all eight heap trees and sampling
flags. Stable mean was 73.7853 MB to 3.5589 MB (95.18%); producer-churn mean was
116.5808 MB to 56.4294 MB (51.60%), with the same query/checksum/publication counts.
The first HTTP carrier failed before measurement; its receipt remains preserved.
Both completed result sets remain evidence rather than choosing the better ratio.

## Follow-up: whole Worker remains expensive

At Engine [256104800e](https://github.com/ForgeaX-Games/forgeax-engine/commit/256104800ed523a011974d8d93210aba46099062),
the rebuilt Game passes its 1928 tests (seven original skips) and separate live
combat guards for ordinary frames, natural GC and source allocation capture.
Thirty ordinary seconds complete 777 intervals, or 25.867 FPS; 54 FPS remains
unmet. The independent 15.680884-second natural window observes Render 565.316
MiB/s, Minor 372.862 ms and Major 30.111 ms; Engine 279.909 MiB/s and Minor 173.207 ms,
with no Major event in that window. These rates are not lower than the prior
independent window. Simulation work also differs substantially, and this source
includes other owners' scheduling/physics changes. No single-change causal
throughput or whole-GC gain is established.

The accepted source capture locates Render production-raster at 15.90%,
preparation at 7.80% and main-pass material at 7.46%. No join descendant is sampled
in the per-view projection caller where the prior diagnostic assigned 285.28 MB.
The freeze/key-encoding caller groups together estimate 5.23 MB; the full
prepared-draw file is 12.90 MB including unchanged vertex admission. Source shows
the owned fast path no longer serializes there, while raw/legacy fallbacks remain.
This confirms the moved work without extrapolating a local ratio to the Worker.

Engine still concentrates in Voxel runtime 22.37%, ray-box 9.72%, collapse 9.68%,
MetricVolume 5.68% and ECS component reads 5.54%. Continue with these existing
query/publication/preparation owners rather than treating key capture as GC
completion or changing the workload to fit the desired rate.

The later [material preparation replay](gpu-material-preparation-20261014.md)
retains scoped collector attribution, reversed pairs and equal-work checks. Its
small ordinary-throughput change does not qualify the whole-game target.

## Captured shadow candidate selection

The 2026-10-14 accepted source capture estimated 224.70 MB beneath shadow
`projectPlan`. At PR baseline `c17e52a229`, the existing internal immutable-source
witness allowed direct batch selection without rebuilding the reverse join or
copying complete candidate arrays. Partial arrays remain detached; reordered
candidate rows retain canonical primitive ordering. Physical view replacement
still requires a fresh plan, and raw/getter inputs keep full observations.
No persistent cache or generation owner was introduced.

| Local source dispatch case | Before JS MB | After JS MB | Reduction |
| --- | ---: | ---: | ---: |
| Contiguous full selection | 388.787 | 12.871 | 96.69% |
| Contiguous subset | 196.150 | 72.943 | 62.81% |
| Contiguous producer churn | 491.131 | 13.999 | 97.15% |
| Interleaved full selection | 387.889 | 12.496 | 96.78% |
| Interleaved subset | 200.466 | 70.514 | 64.82% |
| Interleaved producer churn | 490.455 | 13.551 | 97.24% |

Twenty-four authenticated ABBA heap captures execute 800 actual private
projection dispatches per sample over 4096 candidates, with equal checksums.
Producer churn includes 100 changed source publications. Startup is excluded;
GPU is disabled. A minimal CPU receiver supplies the dispatch, while real
ShadowViewStatePool/production and native tests verify lifecycle correctness.
These are local instrumented JS allocations, not natural GC/FPS acceptance.

The candidate additionally requests 3.2768 MB of transient ArrayBuffer backing
per sample, excluded from JS heap sampling. Its bitmap is bounded relative to
selection cardinality; sparse historical slot numbers use a local Set. No bitmap
survives projection. Initial binary lookup and a forward-search variant both
reduced heap bytes but regressed CPU for at least one candidate layout; retain
those failed comparisons. The final bounded membership path improves both
layouts' instrumented time. Dense and interleaved membership, sparse indices,
raw observations and resource recovery are necessary falsifiers when replacing
a join with a scan; fewer allocations alone do not qualify the change.

## Material binding identity lookup

The accepted `edbeb94c04` capture estimates 284.65 MB under the material Bind Group
builder. Replacing its existing compound string key with direct World, material,
shader and probe indexing removes repeated key construction without adding a
parallel owner. Scope/probe getter order and shader/layout callback observation
remain unchanged; the original residency, physical-buffer, binding-source, IBL,
video and logical-target invalidation rules still decide reuse. Device recovery
clears the existing owner. Compound source namespace boundaries are independently
indexed rather than ambiguously joined.

Eight source-authenticated ABBA CPU Worker captures run 409600 real builder calls
per sample. Stable accepted bindings allocate 131.444 MB before and 36.861 MB after
(71.96% reduction), with zero new native groups after startup. One physical-buffer
replacement per frame, including 100 publications and 800 native groups on both
sides, allocates 295.483 MB before and 207.046 MB after (29.93% reduction).
Checksums and work counts match; both instrumented CPU times decrease. A descriptor
fixture supplies the device, GPU is disabled and startup is excluded. Additional
nested Map storage belongs to admitted identities rather than queries. These
local results do not qualify most Worker GC or ordinary throughput.

## Raster preparation and read-only projection publication

The accepted `393f80ffd7` heap capture attributes 1001.11 MB to production-raster
and 520.73 MB to preparation. Three repeated consumer operations have durable
source authorities: specialized program scalar identity, the captured prepared
draw key, and privately owned shadow projection maps. Compare program fields
without reconstructing their prefix; read the captured draw key at assembly;
publish one read-only Map capability without copying entries on each getter.
The map is consumed by the existing owner and exposes no mutation methods, even
through its forEach callback. Replacement/disable/disposal preserve held old
publications. Equivalent draw layouts can reuse their existing per-view bindings
and claims across new plan wrappers. Exact member ordinals/generations, batch
keys/epochs, LOD and physical windows still decide reuse; depth updates remain
owned by ShadowViewStatePool.

Twelve authenticated ABBA captures execute the real GpuDrivenProduction prepare
and three-view update dispatch on a null CPU carrier. Each sample retains 120
frames, 92160 projected candidates and identical batch/query/checksum counts.
Stable wrappers allocate 63.274 MB before and 24.226 MB after (61.71% reduction);
plan-revision-only changes allocate 117.687 MB and 74.878 MB (36.38%);
physical mesh replacement/retirement allocates 175.468 MB and 132.421 MB (24.53%),
including 120 replacements and 48 native group creations on both sides.
Post-terminal-GC heap differs by about 0.02-0.04 MB in this local carrier.
Startup is excluded, sandbox is enabled and GPU is disabled. These are local
JS allocation observations, not whole-Worker GC, GPU or ordinary FPS acceptance.
Raw input getter order and custom program identity equality remain covered.
