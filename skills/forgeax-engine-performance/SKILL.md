---
name: forgeax-engine-performance
description: >-
  Evidence-driven ForgeaX CPU and GPU optimization. Use when diagnosing slow
  frames, destruction backlogs, Worker GC or physics costs, reducing submission
  or shader work, comparing benchmarks, or adding reusable performance techniques.
---

# forgeax-engine-performance

Identify the expensive owner, remove work at its actual change frequency, and
verify the same workload through the requested runtime. Follow the checkout's
[delivery and rendering gates](../../AGENTS.md); this skill supplies diagnosis
and reusable analysis, rather than another delivery state machine.

## Select the relevant reference

| Current question | Read |
| --- | --- |
| Establish a baseline, qualify fresh product defaults, separate CPU/GPU clocks or compare captures | [Measurement](references/measurement.md) |
| Measure CPU-side cost on a host without a usable GPU | [WebGPU stub](references/measurement.md#cpu-only-measurement-with-the-webgpu-stub) |
| Measure cache hit/miss, invalidation, rebuild and maintenance populations | [Cache measurement](references/measurement.md#cache-populations-and-window-deltas) |
| Extreme picture intervals, Worker task costs, completion waits or catch-up bursts | [Slow frames and scheduling](references/slow-frames.md) |
| Native physics phases, contact complexity, wake costs or redundant Game submissions | [Physics pressure](references/physics.md) |
| Sustained destruction, accumulating update queues or slowdown after input stops | [Destruction update chain](references/destruction.md) |
| Expensive preparation, submission, cache checks or uploads | [CPU preparation and data ownership](references/cpu-submission.md) |
| Large sampled function, temporary collections or uncertain removable phase | [Private phase observation](references/measurement.md#keep-observation-cost-separate) and [collection ownership](references/cpu-submission.md#remove-temporary-collection-work-at-its-owner) |
| String/composite keys, numeric slots or object identity | [Key representation](references/cpu-submission.md#choose-keys-from-existing-identity) |
| Spatial keys, fractional coordinates or deterministic traversal | [Spatial key semantics](references/cpu-submission.md#preserve-spatial-key-semantics) |
| Cold cooking, source races or expensive author-data decoding | [Cold producer measurement](references/measurement.md#freeze-inputs-for-cold-producer-measurement) |
| Sparse shader/layout caches, singleton fanout or cache lifetime | [Cache shape](references/cpu-submission.md#avoid-sparse-cache-trees) |
| Full index copies for transaction rollback or abort | [Rollback maintenance](references/cpu-submission.md#scope-rollback-maintenance) |
| Worker GC, short-lived allocation sources, heap/source attribution or retention | [GC and allocation ownership](references/gc.md) |
| Resident Worker heap versus GC sawtooth, retained-floor attribution or small CPU effects under workload noise | [Heap floor case](references/cases/worker-heap-floor-20261023.md) |
| Texture work, static features, shader variants or uniform-derived math | [Materials and shaders](references/materials-shaders.md) |
| Shadow pass cost, coverage, resolution or sampling | [Shadows](references/shadows.md) |
| Local smoke coverage, composite cost or temporal-safe screen bounds | [Local smoke footprint case](references/cases/local-smoke-footprint-20261016.md) |
| Analyze an existing capture or choose a collection tool | [Toolbox](references/toolbox.md) |
| Add another session's technique, script or scoped case | [Contributing](references/contributing.md) |
| Understand the initial UV/static-switch integration and its limits | [Material specialization case](references/cases/material-specialization.md) |
| Inspect compiled feature/input pruning and heterogeneous GPU material rows | [Compiled graph case](references/cases/compiled-material-pruning.md) |
| Interpret a real cache audit across a material ABI change | [Cache maintenance case](references/cases/cache-maintenance-20261014.md) |
| Optimize scene ownership, draw-key lookup and cold-path cost | [Persistent scene case](references/cases/persistent-scene-prefix.md) |
| Audit render string keys and collection-local chunk maintenance | [String-key case](references/cases/render-string-keys.md) |
| Compare Game/Voxel numeric indexes and exact author-data decoding | [Spatial keys and cold cooking case](references/cases/voxel-key-indexes.md) |
| Reduce feature transaction copying while preserving abort and completion leases | [Feature reference case](references/cases/feature-transaction-references.md) |
| Reassess new scene assets, retained geometry or first-use stalls | [Full-scene resource update case](references/cases/full-scene-resources-20261016.md) |
| Reduce full-effects program/publication work and retire loading-only owners | [Full-effects lifetime case](references/cases/full-scene-resources-20261016.md#full-effects-program-publication-and-preparation-lifetimes) |
| Reassess a restored scene, reject a shader-count shortcut, or qualify indirect geometry and draw-order evidence | [Restored-scene attribution case](references/cases/restored-scene-attribution-20261017.md) |

## Drive the optimization

1. Record the actual source/build, backend, quality settings, scene and completed
   work. Preserve the baseline and original failures. An unexplained visual
   failure first follows [RHI Debug](../forgeax-engine-rhi-debug/SKILL.md).
2. Attribute the hotspot with the cheapest applicable tool. Keep intrusive
   diagnosis separate from final uninstrumented throughput. For an extreme
   frame, join its actual tasks and completion events before selecting a small
   sampled hotspot; follow [Slow frames](references/slow-frames.md).
   Before implementation, establish the removable cost and a falsifier through
   [evidence admission](references/measurement.md#select-a-change-from-evidence).
   Improve observation first when current evidence cannot select a worthwhile change.
3. Change the owning producer or invalidation boundary. Derive CPU layout,
   shader macros and publication from their existing authority. Measure work
   counts as well as time; a cache hit can still perform expensive preparation.
4. Compare a matched workload and check the cases that should invalidate reuse.
   Report implementation proof, measured improvement and unfinished target
   acceptance separately. A quality/configuration change starts a new profile.
   Batch verified owner changes around the user's requested workload and test
   budget; use [batch validation](references/measurement.md#validate-an-optimization-batch)
   before another whole-scene capture.

The tools below read local artifacts and use Node built-ins. They do not launch a
browser, acquire a GPU lease, build Engine, or qualify a delivery gate.

| Tool | Input and useful result |
| --- | --- |
| [analyze_cpu_profile.mjs](scripts/analyze_cpu_profile.mjs) | CDP/V8 profile; sampled self/inclusive time, recursion-safe symbol totals and unobserved interval |
| [analyze_cpu_windows.mjs](scripts/analyze_cpu_windows.mjs) | Existing ordinary CPU capture, clock anchors and frame receipts; separate same-capture LIVE/gap windows with coverage, identity and reordered-sample audit |
| [summarize_gpu_timing.mjs](scripts/summarize_gpu_timing.mjs) | Engine GPU observations; semantic pass costs, completeness, interval union and timestamp envelope |
| [analyze_gpu_timeline.mjs](scripts/analyze_gpu_timeline.mjs) | Existing GPU observations and same-report completion receipts; semantic interval overlap, measured envelopes and missing source population |
| [analyze_heap_profile.mjs](scripts/analyze_heap_profile.mjs) | SamplingHeapProfile; conserved direct/ancestor/unresolved byte partitions and source owner distribution |
| [symbolize_heap_profile.mjs](scripts/symbolize_heap_profile.mjs) | Captured script digests and frozen hidden maps; source locations authenticated to the selected profile |
| [compare_heap_profiles.mjs](scripts/compare_heap_profiles.mjs) | Two retained or two churn heap profiles with symbols; before/after bytes per package, file, function and unresolved frame |
| [allocation_probe.mjs](scripts/allocation_probe.mjs) | Node unit-test helper; sampled bytes per call of a warmed function, to keep a removed allocation removed |
| [summarize_native_gc.mjs](scripts/summarize_native_gc.mjs) | Owned-thread native trace; Minor/Major/finalization durations and bounded allocation/promotion counters |
| [compare_samples.mjs](scripts/compare_samples.mjs) | Raw sample arrays plus selected workload identity; matched descriptive statistics or explicit mismatch |

Run an entrypoint with `--help`; [Toolbox](references/toolbox.md) owns arguments,
exit meanings and capture adapters. Use private output paths and retain raw
inputs. These summaries establish their stated analytical boundary only.

For a later contribution, update the topic's existing authority and its routing
links. Keep a dated result in a scoped case; do not promote one experiment's
numbers, quality settings or host paths into a universal default.
