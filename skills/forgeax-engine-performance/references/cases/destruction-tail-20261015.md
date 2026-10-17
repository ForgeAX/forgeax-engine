# Wall destruction and the unresolved late tail

Observation date: 2026-10-15, Asia/Shanghai. Measured Game
`8b6c347349517c5ab83a6157885a0546d7ed9b8b`, Engine
`1e26ba7b173141f2fa79de37d677305de140ca6b`, Voxel
`6da9204ee5a7c949b906b09f9e78de332be7cd2f`. Game delivery later merged through
PR 129; that merge
included newer main changes and is not the measured runtime.

Maintained procedure: [Destruction updates](../destruction.md). Raw reports
`wake-a`, `wake-cpu` and `wake-gpu-tail` remain private capture receipts; this
summary is not a portable replay or a current-main benchmark.

## Workload and ordinary result

Apple M4 Pro/macOS, sandboxed Chrome 155.0.8059.41, WebGPU, 1920 x 1080 at DPR 1.
The DEMO diagnostic used the actual default AKM against the near spawn wall,
idle AI, an invulnerable player, PCF5 and three 1024 shadow cascades. It was a
continuous destruction workload, not qualified moving two-way firefight combat.
The source passed its normal build and the loaded HTML was authenticated to it.
All three captures loaded HTML SHA256
`ef8ba88fb4620cdec5c5786160cf9dd0be06fa3c3f3af2fb5969475f14807a27`.
The shared host was contended, so these phases do not qualify an A/B gain.

| Ordinary phase | Completed intervals | Seconds | FPS | p95 / max interval |
| --- | ---: | ---: | ---: | ---: |
| Warm idle | 602 | 10.0134 | 60.12 | 20.6 / 30.1 ms |
| Wall fire | 1152 | 30.0103 | 38.39 | 45.2 / 99.0 ms |
| Early recovery | 1069 | 30.0557 | 35.57 | 60.6 / 143.8 ms |
| Stopped-fire tail | 1228 | 60.0745 | 20.44 | 75.6 / 202.0 ms |

First/last periodic samples within the tail showed fragments **282 -> 474**,
support pending **2663 -> 5822**, Native completions **730 -> 1398** and Native
queued work **9 -> 7**. Fragment plans declined **441 -> 247**, but that did not
offset growing support work and retained debris. No new shots were fired in the
tail. A bounded Native queue therefore did not establish a drained update chain.

## Adopted work reductions

The frozen Game source
separates bearing changes from other notifications, lazily reads support seeds,
filters static/static Game contact candidates, retains unchanged Game geometry
projections across Native policy replacements and batches ordinary siblings.

The additional physical-wake fix preserved full presentation bounds but used
physical collider bounds for wake/retirement decisions. Its
real Native regression
used a small solid host with wide non-solid dressing: the old notification woke
seven settled bodies; the corrected path woke only the actual nearby body.
Physical and visual volume remained unchanged. Visual-only removal still
notified presentation without Native wake, pose or body-entity changes.

The measured revision passed 92 related Native/contact/debris/attachment
regressions. A later integration head passed 79 selected regressions and remote
CI; the selections differ and must not be added or presented as the same gate.
The wake reduction is implementation proof. The ordinary tail above still
failed the user's performance target.

## Separate CPU and GPU observations

The late CPU capture waited 45 wall-clock seconds after the driver's finished
phase, then sampled while firing remained stopped. Its common profile interval
was **15.741308 seconds**; completed-picture
observation covered a different **15.0359-second** interval. Engine Worker
inclusive samples included:

| Scope | Cumulative sampled time | Relationship |
| --- | ---: | --- |
| Backend physics `step` | 3156.2 ms | Includes preparation, Native execution and post-step work |
| Rapier `World.step` | 2929.6 ms | Nested inside backend `step`; do not add them |
| Collapse `before` | 1443.6 ms | Support/admission work before physics |
| Collapse `after` | 1596.8 ms | State/contact/support/presentation processing |

The roughly three seconds of Collapse before/after samples were cumulative,
not one three-second frame. These profiles did not split Native broad/narrow/
solver/CCD phases or establish exact cost for the worst picture. Dividing them
by another window's physical-step count would not produce measured per-step cost.

The independent GPU tail matched **129** source frames to GPU receipts and left
**159** source frames unobserved. Observed main-pass p50/p95 was
**6.5536 / 12.45184 ms**; missing frames were not assigned zero GPU cost. This
main-pass result neither explains whole-picture latency nor excludes other GPU
work. Its pictures and CPU-profiled FPS are not ordinary throughput acceptance.

## Failed evidence and unadopted work

The control browser/context closed during its tail, so no complete
matched control/repeat was established. Initial CPU/build attempts also failed
with ENOSPC and supplied no valid CPU sample. Preserve those failures when
interpreting the later successful captures.

A render-tree retention prototype on Voxel `6da9204` with Engine `1e26ba7b`
reused an entity at unchanged geometry revision while changing its physics
entity. The existing paired admission rejected it as `dynamic-geometry-stale`.
The prototype was withdrawn; it is not an adopted optimization. Re-read the
current publication contract before attempting that reuse again.

Further optimization was stopped at the user's request. Native phase ownership,
support-queue convergence and a matched sustained-fire/tail improvement remained
unverified; later preset changes, merges or green source gates do not resolve
those performance questions.
