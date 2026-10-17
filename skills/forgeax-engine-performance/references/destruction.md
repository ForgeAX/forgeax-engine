# Destruction updates and stopped-input slowdown

## Reproduce the delayed workload

Use the actual weapon, impacted surface and input timeline. A sky-fire control
helps distinguish weapon effects from the impact/destruction chain. A temporary
destruction switch tests sensitivity; disabling damage or collapse changes the
workload and cannot qualify an equivalent-gameplay improvement.

Verify effective runtime settings and committed damage. A preset name, firing
counter or empty mutation queue cannot prove destruction ran. Explicitly enable
the requested destruction behavior when a newer game preset disables it. Retain
the requested shadow profile instead of inheriting a changed preset default.

| Window | Collect |
| --- | --- |
| Warm idle | Completed picture intervals, world/actor state and initial queue/roster counters |
| Sustained actual wall fire | Committed cuts, detachments, requests/completions, queue age and worst intervals |
| Early stopped fire | Zero new weapon input, continuing support/fracture/publication work and state growth |
| Long stopped-fire tail | Periodic frame distributions, physical steps, fragments/proxies and all queue owners |

Keep one continuous World through these phases; resetting removes the accumulated
state under investigation. Record wall and simulation elapsed time separately.
If the finished driver freezes its phase age, schedule the late sample from an
explicit wall-clock boundary; waiting for that age to advance never completes.
Keep ordinary throughput, CPU sampling and GPU timestamps in separate captures
with their own workload guards. Follow [Measurement](measurement.md) and
[Slow frames](slow-frames.md) for clock and picture/task attribution.

## Trace work across owners

| Owner/stage | Distinguish and measure |
| --- | --- |
| Game impact and mutation admission | Requested shots versus committed edits; foreground shots versus background cleanup capacity |
| Structural support | Seeds, plans, graph restarts/rechecks, job startup and yielded traversal work |
| Voxel preparation and publication | Geometry/projection work, Native admissions, pending revisions and request-to-callback latency |
| Physics | Actual steps, Native phases, compound complexity, contact consumers, wake transitions and static/dynamic policy changes |
| Presentation and transport | Entity/chunk churn, immutable resources, published upserts/templates and receiver-side preparation |
| Render Worker and GPU | Feature/signature/resource/graph work, completed pictures and exactly joined pass receipts |

Inspect logical queues as well as the bounded Native admission queue. A small
admission queue can coexist with thousands of support seeds, growing fragments
and slow asynchronous callbacks. Progress in a completed counter is not proof
of convergence. Compare first/last samples, peaks, oldest age and production/
completion counts; separate active work from waiting work at each owner.

Budgeted support checks can consume their slice on every fixed step while the
queue stays nonempty. A per-step budget does not bound a synchronous whole-queue
copy before the first yield. A lower slice budget alone does not establish that
the queue drains or the late slowdown recovers.

## Remove work without changing the destruction contract

| Mechanism | Correctness boundary and falsifier |
| --- | --- |
| Separate terrain-bearing changes from fragment/decorative notifications | Reseed structural support only for physical terrain changes; preserve wake, retirement protection, navigation and full visual notifications |
| Wake from changed collider bounds | Keep a distinct physical extent or explicit visual-only marker; test a small solid host with wide non-solid dressing, nearby/far piles and actual support removal |
| Read encountered support seeds lazily | Use existing insertion/replacement lifetime; test a large unrelated backlog, newer causes across yields, stale retries and real Native publication |
| Reuse unchanged local fragment projections | Fence by actual source/World/body/geometry identity; refresh Native entity, pose and motion policy; test geometry edits, replacement and disposal |
| Batch compatible sibling admissions | Retain per-step/body/shape capacity, cause/family ordering, cancellation and atomic callbacks; a removal must not overtake an earlier batch |
| Avoid irrelevant Game contact decoding | Keep native collision response, swept bounds and all actor/dynamic consumers; static/static query pruning is not removal of solver contacts |

Immutable mesh-handle reuse does not imply legal render-entity or admission
reuse. Before retaining a render tree across a Native body replacement, inspect
the current geometry revision and physics-entity publication contract. Keep the
accepted tree valid until atomic commit; cancellation, admission refusal,
generation recovery and disposal must retain exactly one owner. Do not fabricate
a revision or reuse a stale candidate to bypass that contract.

For Worker program retention, use the existing
[receiver ownership guidance](cpu-submission.md#retain-cooked-programs-across-worker-admission).
For native phase/contact investigation, use [Physics pressure](physics.md).

Require both semantic regressions and the same sustained-fire/long-tail workload
before claiming recovery. Reduced wake calls, allocations, sampled hotspots or
GPU main-pass time alone do not prove a solved end-to-end slowdown. The
[2026-10-15 case](cases/destruction-tail-20261015.md) retains an adopted wake fix
whose late runtime still approached 20 FPS.
