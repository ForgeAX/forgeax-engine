# Native physics pressure and Game submissions

## Separate the selected slow step from ordinary cost

Record steps/update, actual fixed delta and new dropped time before dividing an
update by its step count. A sampled four-step burst is not a universal per-step
CPU cost. Use [Slow frames](slow-frames.md) to join native steps to the exact
picture interval; separately time Game queries/controllers, sync/writeback,
native execution, event drain and observation wrappers.

For cumulative CPU profiles, state the sampled window and each scope's inclusive
or self unit. Seconds accumulated over a multi-second window are not seconds in
one frame. Divide by step counts only when they cover that same interval;
picture-window counters and a longer CPU window are different denominators.

| Native observation | Interpretation/action |
| --- | --- |
| Broad, narrow, solver, island and CCD wall clocks | Find the dominating phase; timers can overlap and include scheduling pauses; retain resolution and below-resolution values |
| Awake/fixed/dynamic/kinematic bodies and collider inventory | Describe admitted work; a high fixed-collider count alone does not prove expensive contact work |
| Compound leaves, hull vertices and largest shape | Measure geometric complexity hidden by collider count before proposing simplification |
| Pair classes, manifolds, geometric points and solver points | Inspect terrain/rubble/actor contact topology; stored entries on sleeping/inactive pairs are not constraints executed in the current solver |
| Wake requests, observed sleep-to-wake transitions and impulses | Separate calls/early returns from actual transitions; retain synchronous timing and observation coverage |
| Static/dynamic publication and shape preparation | Separate synchronous preparation from asynchronous request-to-callback latency, pending requests and shared queue waiting |

Inspect the graph periodically and around expensive steps/wakes with bounded
storage. Record sampling triggers and overflow. Change-triggered topology rows
have no time-weighted mean without duration weights. Time probe work separately
and compare state with/without the observer; do not charge its enumeration to
native narrow phase or infer an unobserved internal wake.

## Test native hypotheses with the same snapshot

Restore the same native snapshot for every baseline/candidate repetition. Keep
fixed delta, geometry, masks, CCD, solver policy and actions identical for an
equivalent-work comparison. Warm up, alternate AB/BA order and retain paired
rows. Use a dedicated thread-CPU clock when available; exclude deserialize,
serialize, event drain and disposal from a native-step-only timing boundary.
Browser native phase wall clocks and Node thread-CPU replay are different targets.

Compare poses, rotations, velocities, sleeping states and collision/sensor
events, not timing alone. Report mean, tail and uncertainty over complete pairs;
an average gain with unchanged p95 or a worse maximum is not a solved tail.
Replay omits live Game controller inputs, publication and rendering unless they
are explicitly driven, so it cannot establish ordinary-game FPS.

For contact-class suppression, keep instrumentation/hooks equal in every
variant and count actually suppressed pairs. Zero skipped pairs falsifies the
proposed pruning. Even from an identical starting snapshot, contact suppression
changes subsequent state: relative timing shows sensitivity, not an exclusive
or additive contact-class cost. Treat lower solver counts, shape approximations
and disabled support/stacking as diagnostic changes until separately authorized
and verified for gameplay.

## Remove equivalent work at the existing owner

Read the [Rapier owner](../../../packages/physics-rapier3d/src/rapier-physics-world-3d.ts)
and [native patch](../../../packages/physics-rapier3d/patches/rapier.patch) before
changing the JS/WASM boundary.

| Proven unnecessary work | Candidate | Required falsifier |
| --- | --- | --- |
| Per-pair JS filters returning an unchanged default | Resolve optional callbacks once per step and execute the equivalent native default when no custom policy is active | Isolation acquire/release, immovable contacts, absent-hook behavior and sensor/contact events |
| Temporary bound function per pair | Direct native bridge call preserving receiver and arguments | Real native callback receiver/arity/value tests |
| A Game collider with no consumed contact/sensor behavior | Reuse the existing authoritative swept-query path while retaining required native body motion | Real first-wall position/normal, impact/retirement, gravity/damping and body identity |
| Game broad-phase visits between two static rubble proxies | Partition discarded static/static pairs out of Game manifold selection while retaining the native solver | Swept dynamic poses, actor capsules, both sweep directions and exact candidate equality in dense/sparse piles |
| Local geometry copied on every settle/wake publication | Retain owned Game projections by the existing Voxel Body identity and geometry revision | New native entity/motion is adopted; actual cuts, fracture, reset and replacement invalidate geometry reuse |
| Repeated unchanged shape/publication work | Reuse existing shape/revision authority rather than another dirty registry | Shape revision, static/dynamic transition, support, wake and disposal |

An absent hook object and a present object with optional callbacks may follow
different upstream native paths; preserve both when composing patches. Removing
JS crossings does not authorize changing collision response or event policy.
The [native hook](../../../packages/physics-rapier3d/src/__tests__/physics-hooks.unit.test.ts)
and [pair isolation](../../../packages/physics-rapier3d/src/__tests__/pair-isolation.unit.test.ts)
regressions exercise these boundaries.

Before reducing rubble count, shape accuracy, contact classes, CCD or wake
frequency, measure what executes in the qualified live workload and trace who
consumes it. Preserve cover, support, actor carry/crush, impact, hit queries and
mass retention under the requested gameplay contract. Visibility alone is not
collision relevance. Avoid adding a reduction when the current workload is
already below a proposed cap or contains zero affected sensors.

Use [Measurement](measurement.md) for final matched ordinary runs. A successful
device-specific collider removal remains implementation proof until its own
live A/B is measured. The [firefight case](cases/firefight-physics-scheduling.md)
records the adopted boundary cleanup and unadopted contact counterfactuals.
When physics cost grows after destruction, follow the
[whole update chain](destruction.md) before selecting a native-only fix.
