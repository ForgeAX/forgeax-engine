# Firefight native physics and Worker scheduling

Observation dates: 2026-10-13 through 2026-10-14. Measured Engine
`c4159a8733221d2958161d4a76dd6b8942419e3b`; the preserved source branch is
`codex/physics-frame-scheduling-20261013`. Changes were integrated into
[PR 3855](https://github.com/ForgeaX-Games/forgeax-engine/pull/3855) at
`78dc9e59ad32a26d50b8ba6b363a9474d0904af3`, retaining the concurrent absent-hook
event fix. These are dated receipts, not the current PR head or final CI verdict.

Maintained guidance: [Slow frames](../slow-frames.md), [Physics pressure](../physics.md)
and [Measurement](../measurement.md). This case does not set Engine quality defaults.

## Changes and recorded evidence

| Change | Source/regression | Established boundary |
| --- | --- | --- |
| Native default filtering without unconditional per-pair JS callbacks; direct `call4` for provided callbacks | [Rapier owner](../../../../packages/physics-rapier3d/src/rapier-physics-world-3d.ts), [patch](../../../../packages/physics-rapier3d/patches/rapier.patch), [hook test](../../../../packages/physics-rapier3d/src/__tests__/physics-hooks.unit.test.ts), [isolation test](../../../../packages/physics-rapier3d/src/__tests__/pair-isolation.unit.test.ts) | Equivalent state/events in replay; custom isolation and absent-hook events retained |
| Withdrawn experiment: simulation continued while two Render publications were held (`751f1d353`) | [Host](../../../../packages/app/src/execution/host-controller.ts), [Engine Worker](../../../../packages/app/src/execution/engine-worker-runtime.ts), [credit test](../../../../packages/app/src/__tests__/render-worker-credit.unit.test.ts), [admission test](../../../../packages/app/src/__tests__/worker-execution-admission-watchdog.unit.test.ts) | The user revoked this direction on 2026-10-14. It must not be restored as a recommended optimization; latest-state publication cannot preserve all intermediate effects |
| Collider/CCD/shape request removed from two swept-query gadgets | Game report at 112f6651 | Flying camera/laser alarm retain native dynamic integration and first-surface sweep; other devices/grenades/support unchanged; no fresh live A/B |

The original selected four-step native sample estimate was about 21.4 ms, or
5.35 ms/step. Phase wall clocks in a separate diagnostic window averaged
1.548 ms; its 9.0 ms maximum contained 8.4 ms narrow phase. These observations
do not constitute a matched cost reduction from 5.35 to 1.548 ms.

An identical-snapshot replay used 80 alternating AB/BA pairs, four warmup pairs
and twenty fixed steps per restored World: 1,600 timed steps per module.
Deserialize/serialize and event drain were outside native thread-CPU timing.

| Native thread CPU / step | Baseline | Candidate |
| --- | ---: | ---: |
| Mean | 1.334 ms | 1.284 ms |
| p95 | 1.733 ms | 1.729 ms |
| Maximum | 3.435 ms | 3.699 ms |

Mean reduction was **3.77%**, paired-bootstrap 95% interval **2.25-5.19%**
(10,000 complete-pair resamples, seed 20261013). State and event comparisons
matched. The bridge-only samples did not establish a stable independent gain;
static/static pruning skipped zero of 47,016 instrumented callbacks. Neither
the tail nor whole-game FPS improvement was established.

Shape auditing found 2,448 convex leaves with eight axis-aligned-box corners,
but none passed the existing exact f32 cuboid recognizer; 41 also had half-length
representation issues. Apparent box topology did not justify approximating the
collision shape. The exact recognition path already existed in the baseline.

## Exact task evidence, not sampled percentages

The qualified early CPU window used Game `5fa30f77e336218bc6a949c3e1a56c4387ef0dd0`,
Voxel `555f4626b7e77b2e8ddf9edc61992b0b1341e402`, normal-build HTML SHA256
`a05ab9e919c0512a55a9c39ec1e1f13a7ac554f0c60020b5db60724ac03370fc`.
All 134 captured script digests matched the immutable dist. Generated-source
excerpts were retained; authored source maps were unavailable. Sandboxed Chrome
ran 1920 x 1080, ten moving/firing combatants and original received-hit guards,
PCF5 and **three 1024 shadow maps**. GPU/profile/trace instrumentation was active.

Picture 1609 -> 1610 completed **165 ms** apart, with approximately 0.396 ms
clock-anchor uncertainty:

| Relative time | Joined event |
| --- | --- |
| +14.422 ms | Engine sends picture 1610 |
| +14.538 to +69.420 ms | Render task: 54.882 ms wall / 51.337 ms thread CPU |
| +31.608 ms | Engine sends picture 1611 |
| +69.351 ms | Render sends submitted receipt 1610 |
| +69.426 to +127.276 ms | Render task 1611: 57.850 ms wall / 53.395 ms thread CPU |
| +159.409 ms | Render sends completed receipt 1610 |
| +164.959 ms | Engine relays completion 1610 |

Ten simulation requests continued during this now-withdrawn scheduling experiment.
That observation is retained as historical timing evidence, not accepted behavior.
Approximately 57.9 ms of
the 90.1 ms submitted-to-completed notification span overlapped the next Render
task. This established substantial Render CPU work during the wait, not the
instant of physical GPU completion. Picture 1610's GPU observation was missing;
1611's 10.945 ms main pass could not substitute for it. Sample hints included
batch/shadow preparation, signatures and drawing; they were not exact function
CPU sections. Invalid Host trace rows with thread duration exceeding wall were
rejected from exact accounting.

## Live rubble investigation and retained limits

The later qualified contact report at 112f6651
records Game capture head `15e9e499fd1221f0a45eb227cc0bd4083bbaa379`, runtime
build `55590713`, the same Engine/Voxel and PCF5/three-1024 profile. Exact clock
alignment selected 1,192 native steps inside a qualified twenty-second window.

| Observation | Result and boundary |
| --- | --- |
| Native wall/step | Mean 1.071 ms, p95 2.0 ms, max 4.3 ms; longest contains 3.6 ms narrow and 0.7 ms solver |
| Shape/awake work | 76-109 rubble colliders, up to 497 compound leaves, largest collider 35 leaves; awake mean 19.38, max 41 |
| Contact graph | Up to 1,441 stored rubble manifolds; stored points do not count executed active constraints |
| Wake loop | Maximum 0.2 ms synchronous wall; completed type-publication callbacks average 8.65 seconds asynchronous latency |
| Snapshot contact suppression | Disable rubble/rubble: 22.08% lower CPU; disable rubble/terrain: 51.23%; changes state evolution, not additive shares |
| Picture 2600 -> 2601 | 332.7 ms; seven overlapping native steps total only 2.4 ms wall, maximum 0.7 ms |

The 332.7 ms interval had no accompanying task trace or GPU timestamps; its
remainder was not assigned to Render, GC or publication by subtraction. New
dropped time of 0.0667 seconds remained recorded. The user rejected contact
reductions because of gameplay impact: no rubble count, shape accuracy, contact
policy, solver or sleep reduction was adopted. GC and terrain/publication work
remained with separate owners.

Raw profiles, replay pairs and failed captures remain local private artifacts;
the tables summarize that recorded evidence rather than package a portable live
benchmark. Different geometry/combat windows are not a controlled browser A/B.
The original combined capture still failed its late received-hit guard; the
separate early CPU window passed it without weakening the guard. Full Browser
and Dawn failures remained recorded. At integration `78dc9e59ad`, build, 938
focused source tests and seven actual Worker Browser contract tests passed;
these checks did not establish full CI, final game acceptance or solved extremes.
