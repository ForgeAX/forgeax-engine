# Full CI throughput investigation: 2026-09-13

> [!IMPORTANT]
> Objective: complete CI within 30 minutes with the existing coverage and failure
> criteria. Test-machine timings below measure preparation changes, not an achieved
> end-to-end SLO. Operating and acceptance rules live in [README.md](README.md).

## Evidence and selected work

Baseline: [PR #3158 full CI](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34746174276),
commit `953609eee37b7262298c56fd7e5ee3a9129e900d`, 39m11s Actions latency.
Inspect job steps and producer stage logs, not just job totals:

| Work | Observed cost | Owning cause | Selected action |
|:--|--:|:--|:--|
| Pixel parity, both fixtures | 126s, including concurrent 95s builds | Metrics had no shared shader input despite each Vite plugin supporting it. | Pass the verified projection to the existing children. |
| Color matrix fixture build | 96s | Another full engine shader compilation after vertex producers. | Reuse the same projection; still build the application. |
| HDRP producer partitions | 169s across four native processes | Each process spent about 34s in import and 7s in tests; the top-level manifest builder compiled the same engine inputs. | Supply the shared manifest; retain all four processes and assertions. |
| Vertex-color producer schedule | 176s | Contains its own browser shader preparation as well as real captures. | Apply the same inherited shader input and validate the entire matrix. |
| Auxiliary Dawn evidence | 43s | Another manifest consumer; native work and cross-runtime joins remain required. | Reuse shader preparation while retaining its selected tests and reports. |
| Runtime LOD fixture build | 107s | Builds without the shared shader projection. | Reuse the projection and keep the GPU/FPS producers. |
| Smoke shards 0/1/2/3 | 736/328/545/413s | Explicit steps make shard 0 much heavier than shard 1. | Move M7 recovery and multi-world to shard 1, together with M7 evidence upload. |

A [second successful run](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34746630396)
had Smoke durations 808/319/562/420s, supporting the same placement correction.
The first baseline's M7 and multi-world steps cost 130s and 80s. Moving that work
predicts a slowest shard near 9 minutes instead of 12.3, before runner variation.
The roster, job set, test commands and assertions are conserved; only those two
tests and their associated upload change shard placement.

## Test-machine comparison

Same owned Linux checkout and software-GPU environment; existing package builds,
four Lavapipe threads, bounded Node heap, and fresh native/browser processes.
Source and shared modes run sequentially. These are preparation A/B samples on
the PR #3158 test checkout, not exact-new-commit CI or physical-GPU qualification.

| Identical workload | Source preparation | Shared preparation | Result |
|:--|--:|--:|:--|
| Four isolated HDRP Dawn producers | 154.42s | 44.31s | Both passed all four selected producers. |
| All pixel parity fixtures | 112.57s | 27.85s | Both passed the existing pixel gates. |

With the same shared-input treatment, the complete color-lighting matrix passed
in 154.14s on the test machine (CI source-mode baseline: 535s, a different runner).
Its measured stages were vertex producers 47.92s, fixture build 2.57s, browser
matrix 39.15s, four Dawn producers 45.07s, auxiliary Dawn 12.86s, and closure 2.77s.
The LOD fixture build passed in 2.82s. Do not present these cross-runner comparisons
as a controlled end-to-end speedup.

The artifact-miss rehearsal exposed an additional defect: a consumer's inherited
manifest path pointed inside the producer's output directory. The producer cleared
that directory, then tried to read the removed manifest and failed. The producer
now clears the consumer override and forces shader source generation. The existing
catalog-only integration test carries the missing-manifest regression; preparation
failure and cancellation remain fatal.

The real artifact-free browser-metrics preparation passed in 135.84s after the
fix, then the WebGL2 fallback sentinel and full color matrix passed using its
fresh output. Local contract/recovery/roster checks passed 79 tests. Parsed YAML
comparison conserved all 36 job definitions and 94 Smoke steps, with only the
three declared placement conditions changed; metric test steps were unchanged.
The real catalog-only missing-manifest integration test passed in 106.37s on
Linux, and the focused Dawn partition contract passed all 7 assertions locally.

The first optimization CI revision caught an old core-only metrics assertion in
the app-shard regression suite, outside the initial focused selection. Its remaining
work was cancelled. The assertion now requires shared shaders while still excluding
app artifacts. After package preparation, the exact CI script-regression command
passed all 239 tests locally; the operating guide now requires that complete group
for workflow and artifact-contract changes.
The unchanged regression command now runs in `ci-core` after package builds and
before publishing core outputs. A failed cross-job contract therefore blocks the
heavy fanout instead of failing late in `primary-pnpm`; it is not duplicated.

## Recent failures and scope decisions

| Run | Observed failure | Treatment |
|:--|:--|:--|
| [34746293071](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34746293071) | Dependabot checkout: required token input absent, before tests start. | Separate credential/bootstrap issue; do not change trust policy or add test retries here. |
| [34746316546](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34746316546) | Concrete TypeScript errors in the changed DevKit browser carrier. | Useful early failure; retain type checking and use focused type iteration. |
| [34747034608](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34747034608) | SSAO without local lights produced zero changed pixels. | Preserve the real pixel oracle; the log alone does not establish flakiness. |
| [34748531802](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34748531802) | Merged-main SSR browser bootstrap exceeded 25s. | Track this startup tail separately from metric preparation. Preserve its assertions and inspect initialization stages if it recurs on the optimization PR. |

## Remaining candidates and delivery limits

| Candidate | Decision and evidence needed |
|:--|:--|
| Start metrics before Smoke completes | Browser-only barrier removed in the second round after measured preparation savings and a same-cgroup overlap rehearsal below. Runtime performance metrics and the final join retain their barriers. |
| Merge Dawn partitions | Retain process isolation. Shared immutable inputs remove compilation overhead without accumulating native device state. |
| Pixel-difference gate quality | The standalone pixel runner defaults to a 999999-pixel budget on a 512x512 image (262144 pixels). That cap alone cannot reject a pixel-difference regression. Preserve capture/error checks and recorded differences; establish a measured budget and injected-difference falsifier before claiming this gate proves visual equivalence. This round does not change its threshold. |
| Add runners or parallel workers | Measure dependency-ready queue delay and actual cgroup resources first. Repository runner API returned no repository registrations; organization inventory access returned HTTP 403, so this investigation does not establish idle organization capacity. |
| Cache changes | Keep existing bounded artifact fallback. Measure the extra shared download against the saved child compilation; do not infer transfer cost from local shader speedup. |
| Full-CI acceptance | Publish one consolidated revision after focused verification. Record its exact SHA, complete roster, first-attempt outcome, queue delay, terminal latency and total job minutes. Repeat samples are needed before claiming P95. |

The expected wall reduction combines shader preparation savings with a shorter
Smoke tail; it does not assume new machines, fewer tests, looser thresholds or
more GPU concurrency. Recompute the critical path from the next complete run.

## Second round: bound software rendering and share empty projections

The first complete optimization run, [34749822870](https://github.com/ForgeaX-Games/forgeax-engine/actions/runs/34749822870),
passed at `e13154a4a3e9a0bd924d1e1de5e7fbb812e65864` in **40m19s**. Browser metrics
fell from 12m25s to 5m14s and runtime metrics from 5m41s to 2m06s, but slower
shared/app preparation and Smoke 0 absorbed the savings. This was not a 30-minute
result. All 44 expanded main-CI job names were conserved.

The full workflow had no Mesa render-thread budget, while focused CI and the
Linux rehearsals already used four threads. On the test machine, CPU affinity
exposed 96 host CPUs but the cgroup quota was eight. The default instancing
process had 77 threads. [Mesa's environment contract](https://docs.mesa3d.org/envvars.html#envvar-LP_NUM_THREADS)
allows a rendering-thread budget; full CI now uses the same four-thread setting.

Same machine, sequential runs of the unchanged instancing smoke, 300 frames and
its original directed-pixel/RHI assertions:

| Rendering threads | Wall time | Throttled cgroup periods during run | Result |
|:--|--:|--:|:--|
| Default | 74.245s | 643 | Passed |
| 4 | 28.928s | 0 | Passed |
| 8 | 29.981s | 5 | Passed |

These counters are cgroup-wide observations, not per-process attribution. The
controlled workload and thread-budget comparison supports bounding software
rendering; it does not establish the cause of every slow organization runner.

Empty app shader deltas also caused each consumer to merge and serialize the
same complete catalog again. Materialization now writes one normalized immutable
runtime file and hardlinks subsequent empty projections, retaining the existing
cross-filesystem copy fallback. Nonempty deltas keep the original merge and
validation. The regression preserves legacy field normalization and producer
bytes while asserting that identical consumers share one ordinary file.

A real 54,356,405-byte shader manifest expanded into 20 empty-delta apps took
**7.739s before and 1.212s after** on Linux. Every output SHA-256 was identical;
unique output inodes fell from 20 to 1. This removes repeated CPU/file work without
changing the runtime payload. The new regression runs in ci-core before fanout. All 245 CI script regressions
passed locally after package preparation. The complete Dawn roster shard 0 passed
on Linux in 125.55s after building its app-owned blending shader prerequisite.
The next exact-head full CI must determine the combined terminal latency; these
rehearsals alone do not prove the 30-minute objective.

The full browser color matrix and Dawn roster shard 0 then ran concurrently in
one 8-CPU/16GB cgroup with four Mesa threads per process. Both passed unchanged:
Smoke took 125.024s, the matrix 154.370s, and combined wall time was 154.401s.
This is a bounded contention rehearsal; separate CI jobs still retain independent
runner workspaces and native/browser processes. It is not a fleet-wide capacity
or physical-GPU claim.

Browser metrics have no Smoke artifact input. After this rehearsal their scheduling
barrier is removed, while core/shared input and fallback-status prerequisites stay.
The stable metrics join still requires successful Smoke and both metric producers;
runtime performance metrics retain Smoke/Bevy ordering. The workflow contract
regression verifies those dependencies so starting independent semantic work early
does not weaken final failure propagation.
