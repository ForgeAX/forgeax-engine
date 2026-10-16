# Dynamic cache maintenance across a material ABI change

Observation date: 2026-10-14. Tested Engine
[`27e1ac5f933c17f05827c6628af7b0ee9da1a6ea`](https://github.com/ForgeaX-Games/forgeax-engine/commit/27e1ac5f933c17f05827c6628af7b0ee9da1a6ea),
then the head of [PR #3855](https://github.com/ForgeaX-Games/forgeax-engine/pull/3855).
These are dated live diagnostics, not current-head evidence or a cache-disabled
net-benefit experiment. Maintain the method in [Measurement](../measurement.md)
and optimization decisions in [CPU ownership](../cpu-submission.md).

## Workload and capture boundary

| Input | Observed value |
| --- | --- |
| Game authoring | Frozen `848dad688c649b7d5906670cd5df174f5220e68a` plus recorded author changes; newly cooked against the tested Engine |
| Runtime | M4 Pro / 64 GiB, macOS 26.4.1, headed Chrome 155.0.8059.41 with sandbox, hardware WebGPU |
| Render profile | 1920x1080, DPR 1, three 1024 shadow cascades, grid PCF5, fixed standard quality |
| Workload acceptance | 10 living combatants; sustained two-way fire/hits, player movement/fire/hits/received hits, camera movement and five-second activity checks |
| Normal build | 73 Engine workspace packages; verified source binding and game browser build |
| CPU sample | Unmodified distribution; requested V8 1000 us sampling; 15.0172 seconds and 556 completed intervals |
| Primary counter window | Private integer probes plus native cumulative counters; separate 15.0153-second live run; 431 renderer frames, 432 source packets, 425 completed intervals |
| Repetition | Earlier accepted counter run: 522 renderer frames, 514 completed intervals; retained separately |
| Environment | Shared GPU lease; external CPU work and about 50 GiB swap remained. No clean-host or fixed acceleration-multiple claim |

One source packet was in flight across the primary inspector boundaries. Sender
metrics were normalized to 432 packets; renderer counters to 431 frames; sampled
CPU costs to 556 intervals from another window. Worker costs overlap. The
sampled completion rate was 37.02 FPS; diagnostic counter rates of 34.18 and
28.30 FPS were not uninstrumented throughput controls.

## Two failures that changed the measurement

| Failure | Evidence and resolution |
| --- | --- |
| Intrusive first timing design | Earlier raw windows recorded about 128,727 selected timing calls/draw. Empty probes added 0.180-0.204 us/call in calibration. Live phase and host differences prevented a causal slowdown percentage; no guessed subtraction was made. Use independent CPU sampling and cheap decision counters instead |
| Old publication tape rejected | The old 2,303-draw tape failed at renderer frame 139 with `material-abi-not-executable`: its cooked scene-index row was 672 bytes; the new consumer required 864. Retain the error, recook/recollect through production, and withdraw identical-packet A/B claims |

The replay path did not run the source World or physics. It could not measure
new publisher change detection or source asset transfer preparation. Recollection
also established these producer observations through native postMessage metadata
in a separate window rather than treating replay delivery as the full transport.

## What the counters established

CPU estimates below come from the independent profile, not timers around these
counter decisions. They are grouped cache-owner work, not GPU pass time or
measured cost of a single cache hit.

| Owner | Primary counter evidence | Sampled CPU ms/completed interval | Decision supported |
| --- | --- | ---: | --- |
| GPU preparation/filtering | Prepared-row H/M 699,961/611 (99.91% hit), about 1,625 checks/frame; residency validation H/scan 8/423 (1.86% hit) | 3.054 | Separate row reuse from the unchanged walk and residency validation |
| Shadows | Static layers 1,013/1,293 hits (78.34%); final layers 0/1,293 hits; per-view invalidation totals reconciled with rebuilds | 1.646 | Stable caster retention is active despite final-layer redraws |
| Publication | Eligible template H/M 6,148/1,648 (78.86%); 8,749 upserts emitted 2,601 templates (70.27% overall reduction) | 1.335 | Frame-local interning and total deduplication have different denominators |
| Material UBO | Content H/M 0/431; backing storage reused 430/431 times; one capacity allocation; 431 uploads totaling 288,277,248 bytes (653.18 KiB/frame) | 0.401 | Storage reuse does not eliminate content packing or queue writes |
| Prepared bundles | H/build 108,098/6,060 (94.69%); generic segments had only 36 lookups, all misses | 0.060 | Audit the active prepared cache separately from the low-traffic generic cache |
| BatchTopology | Plan H/M 864/225 (79.34%); misses equaled native planBuilds | 0.034 | Query reuse differs from a no-rebuild frame fraction |

The first counter run had 88.38% static-shadow hits and 68.01% liveRaster hits;
the primary run had 78.34% and 47.80%. Both passed sustained combat. Retain this
phase variability rather than selecting the better hit rate as universal.

The primary sender observed four numeric views with 6,920,004 active bytes and
16,975,872 backing-capacity bytes. Actual transfer-list ArrayBuffers totaled
51,011,296 bytes including additional asset transport; these are capacity facts,
not copied/compressed bytes or network bandwidth. Mesh prepare/release counts
of 250/227 were not interpreted as GPU residency misses.

## Attribution and remaining falsifiers

The CPU completion window was aligned to each realm's profiler clock and clipped
sample-by-sample; 30 original source files were authenticated through compiled
module and source-map content. Ordinary main-pass callbacks were excluded from
enclosing generic RenderBundle attribution. Unmapped generated code stayed
unmapped. Idle and GC remained separate; sparse samples limited small-owner
precision.

Publication attribution included synchronous SourceRenderWorker.publish and
SourceMeshResidency receive/complete stacks. Async mesh preparation, delivery
queueing and GPU completion were not a complete end-to-end transport clock.
High hits did not establish cache net benefit. Deletion/bypass still needs
matched dynamic input and correctness; whole-frame acceleration still needs
an admitted uninstrumented comparison across compatible cooked contracts.

## Private evidence locator

Raw artifacts remain outside this skill, under the Game checkout's
`artifacts/render-cache-retest-20261014/`; the earlier intrusive design is under
`artifacts/render-cache-timing-20261013/`. These directories are private local
evidence, not files guaranteed to exist in an installed SDK.

| Artifact | SHA-256 |
| --- | --- |
| `metrics.json` | `f82e0a2f94e36ea38b4c010737f2819bdc1c4150ede20cb33a2385847b80a519` |
| `profile-summary.json` | `11d3324024bc207c81d6123c0acb15f0553a4480e6ab330c23ab70a90e33344a` |
| `live-counters-2/report.json` | `9c84197eb931a5ff1af91f39856f1cfa030342bf24568f5f6818b0702a434b57` |
| `trials/latest-quiet-1.json` | `f9e43e47ee7e444910c1f847061290e34d9faa0eaf844784b7f8b78bba0e6df7` |

The primary report captured its loaded probe revision hash and reconciled
derived storage reuse with the actual allocation branch. Probe coverage and
individual view reasons are preserved in the raw reports. Revalidate the
current source and capture before reusing these historical numbers.
