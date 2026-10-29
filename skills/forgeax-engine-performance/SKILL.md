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
| Establish a baseline, qualify fresh product defaults, separate CPU/GPU clocks or compare captures | Measurement |
| Startup / level-load attribution: Worker boot, fetches, decodes, shader/pipeline creation, first frame, game marks | Load timeline |
| Measure CPU-side cost on a host without a usable GPU | WebGPU stub |
| Measure cache hit/miss, invalidation, rebuild and maintenance populations | Cache measurement |
| Extreme picture intervals, Worker task costs, completion waits or catch-up bursts | Slow frames and scheduling |
| Native physics phases, contact complexity, wake costs or redundant Game submissions | Physics pressure |
| Sustained destruction, accumulating update queues or slowdown after input stops | Destruction update chain |
| Expensive preparation, submission, cache checks or uploads | CPU preparation and data ownership |
| Large sampled function, temporary collections or uncertain removable phase | Private phase observation and collection ownership |
| String/composite keys, numeric slots or object identity | Key representation |
| Spatial keys, fractional coordinates or deterministic traversal | Spatial key semantics |
| Cold cooking, source races or expensive author-data decoding | Cold producer measurement |
| Sparse shader/layout caches, singleton fanout or cache lifetime | Cache shape |
| Full index copies for transaction rollback or abort | Rollback maintenance |
| Worker GC, short-lived allocation sources, heap/source attribution or retention | GC and allocation ownership |
| Idle Render churn, empty feature transactions or unchanged Skin shadow invalidation | game-3d investigation |
| Resident Worker heap versus GC sawtooth, retained-floor attribution or small CPU effects under workload noise | Heap floor case |
| Million-entity CPU scaling, Render World row ownership or Worker publication transfer | [Change-propagation bench](../../packages/render/bench/change-propagation/README.md) and [ECS steady-state bench](../../packages/ecs/bench/steady-state.mjs): keep steady allocation proportional to changes, sparse tags for flipping membership, and name constructors with the heap census |
| Texture work, static features, shader variants or uniform-derived math | Materials and shaders |
| Shadow pass cost, coverage, resolution or sampling | Shadows |
| Local smoke coverage, composite cost or temporal-safe screen bounds | Local smoke footprint case |
| Analyze an existing capture or choose a collection tool | Toolbox |
| Add another session's technique, script or scoped case | Contributing |
| Understand the initial UV/static-switch integration and its limits | Material specialization case |
| Inspect compiled feature/input pruning and heterogeneous GPU material rows | Compiled graph case |
| Interpret a real cache audit across a material ABI change | Cache maintenance case |
| Optimize scene ownership, draw-key lookup and cold-path cost | Persistent scene case |
| Audit render string keys and collection-local chunk maintenance | String-key case |
| Compare Game/Voxel numeric indexes and exact author-data decoding | Spatial keys and cold cooking case |
| Reduce feature transaction copying while preserving abort and completion leases | Feature reference case |
| Reassess new scene assets, retained geometry or first-use stalls | Full-scene resource update case |
| Reduce full-effects program/publication work and retire loading-only owners | Full-effects lifetime case |
| Reassess a restored scene, reject a shader-count shortcut, or qualify indirect geometry and draw-order evidence | Restored-scene attribution case |

## Drive the optimization

1. Record the actual source/build, backend, quality settings, scene and completed
   work. Preserve the baseline and original failures. An unexplained visual
   failure first follows [RHI Debug](../forgeax-engine-rhi-debug/SKILL.md).
2. Attribute the hotspot with the cheapest applicable tool. Keep intrusive
   diagnosis separate from final uninstrumented throughput. For an extreme
   frame, join its actual tasks and completion events before selecting a small
   sampled hotspot; follow Slow frames.
   Before implementation, establish the removable cost and a falsifier through
   evidence admission.
   Improve observation first when current evidence cannot select a worthwhile change.
3. Change the owning producer or invalidation boundary. Derive CPU layout,
   shader macros and publication from their existing authority. Measure work
   counts as well as time; a cache hit can still perform expensive preparation.
   For allocation work, prefer explicit acquire/use/release, bounded scratch,
   in-place counters and fewer temporary wrappers. Preserve detached public
   snapshots. Store prepared values on their actual owner when its inputs are
   immutable or its existing construction/commit transition replaces the value.
   Prove that owner identity survives the frames being optimized; a fresh
   per-frame wrapper cannot provide cross-frame reuse. Keep borrowed mutable
   inputs live. Avoid a second freshness witness, version scanner or registry
   merely to save allocations; numeric resource keys can remove string churn
   inside the existing resource cache without another memo table.
4. Compare a matched workload and check the cases that should invalidate reuse.
   Report implementation proof, measured improvement and unfinished target
   acceptance separately. A quality/configuration change starts a new profile.
   Batch verified owner changes around the user's requested workload and test
   budget; use batch validation
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

Run an entrypoint with `--help`; Toolbox owns arguments,
exit meanings and capture adapters. Use private output paths and retain raw
inputs. These summaries establish their stated analytical boundary only.

For a later contribution, update the topic's existing authority and its routing
links. Keep a dated result in a scoped case; do not promote one experiment's
numbers, quality settings or host paths into a universal default.
