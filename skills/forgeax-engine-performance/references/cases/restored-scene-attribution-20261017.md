# Restored-scene attribution and rejected shortcuts

This case records one full-scene demolition workload. Its timings, source hashes
and counts are receipts, not universal budgets or recommended quality defaults.

## Follow the product changes before reusing a baseline

Restoring complete terrain materials and scene fog changed the workload. Earlier
captures with simplified materials could generate hypotheses but could not prove
the new default's throughput. Verify the current authored sources, actual build
artifacts, startup defaults and effective settings before comparing a result.

Keep a collector-only compatibility repair separate from the Runtime. In this
case a completed 30-second capture failed its post-window stage-name proof after
the product unified the stage as `performance`. The failed raw report remained;
only the stage parser changed, with the same CSM/Vogel/GTAO requirements. The
subsequent explicit captures recorded both the build and collector identities.
Do not quietly overwrite the failure or call it a qualified baseline.

## Fewer shader operations are a candidate, not a measured benefit

The shipped terrain program performed five texture samples before a varying
material-family branch. A candidate computed the original UV derivatives before
the branch and used `textureSampleGrad` inside the selected family, with 1/2/2
samples. Naga compilation, unchanged non-sampling formulas, resource/sampler/mip
policies and semantic negative controls passed. Actual cooked variants and the
served index were independently hashed; this was not a stale-cache comparison.

| Independent observation | Baseline | Candidate |
| --- | ---: | ---: |
| Ordinary completed LIVE FPS, 30 seconds | 51.76 | 50.39 |
| Minimum rolling one-second FPS | 39.63 | 38.96 |
| GBuffer mean in the separate queried GPU cohort | 5.81 ms | 5.48 ms |

The queried GPU cohorts each contained 94 complete polled frames, with different
missing populations and nonuniform time-bucket deltas. Real AI and machine load
also varied. The result did not prove a net throughput benefit; the Runtime
candidate was withdrawn and its patch, audits and observations retained.

Static source sample counts cannot establish hardware savings, the material's
share of a pass, or whether the compiler already removed work. Explicit gradients
also do not promise backend-independent bit equality: default derivative modes
can differ. Preserve the actual appearance and test the proposed cost owner.

See the full ordinary/GPU decision.

## Prove which indirect arguments were actually executed

A complete post-window GPU readback can still describe a later argument version.
Here the early GBuffer used the main indirect buffer; late finalization then
rewrote it as `early + late`. A command tagged `all` therefore decoded the final
union, while a separate late command decoded the suffix. Summing both as actual
executed work double-counted late members.

Source-qualified recovery was possible within the same Geometry receipt. It
checked exact source hashes, batch/LOD/region identity, topology and base offsets,
complete membership, ordered suffix equality and overflow rejection. Only then
could `early = union - late` recover 846,819 early and 1,320 late triangles.
Wrong source, prefix, offsets, members or capacity evidence must reject recovery.
Do not apply this equation to another producer without proving its counter rule.

Geometry identifies submitted work, not fragment invocations, visibility cost or
GPU milliseconds. The independently captured RHI tape had an unavailable
submitted-frame identity. Its PSO state was useful, but it could not be joined to
that Geometry receipt or an earlier GPU timestamp sample as the same frame.

See the counter ownership proof and negative controls.

## Establish a missing feature or scheduling boundary through execution

The actual tape already contained a depth pyramid, occlusion culling and a late
GBuffer pass. The early GBuffer had many pipeline switches, but eight indirect
slots disabled depth writes. Neither "missing HiZ" nor arbitrary opaque sorting
was an admitted optimization. Formats and their byte sum do not prove bandwidth
cost, and a zero-seed tape does not reveal actual indirect counts.

An opt-in near/far ordering experiment must retain unknown-program and unsafe
state barriers, preserve primitive/instance ordinals and tie behavior, and report
whether eligible references actually moved. A complete-source digest allowlist
is an explicit diagnostic attestation, not a generic purity guarantee or a
permission to enable sorting for arbitrary custom shaders.

Likewise, actual Host ledgers and same-frame ACKs showed three frames in flight;
capacity was not silently one. Composite completion latency was not exclusive
hardware GPU time. The current CPU cohort instead selected Feature preparation
as a large owner: about 4.12 ms of sampled weight per selected RW task. Keep its
disjoint plan/projection/target partitions separate from native call samples and
observer costs. Profile a changed scene before reopening old negative caches.

See the [actual depth/order audit](../../../../packages/render/reports/gbuffer-order-depth-structural-audit-20261017.json)
and current Worker/credit evidence.

## Include build invalidation in the feedback budget

A single terrain WGSL edit changed the material cooker's complete shader-namespace
identity. Equipment and collapse packs had no terrain source in their cooked
closures, yet conservatively missed the cache; audio remained a hit. The full
portable build changed from 112 seconds with 93 hits to 318 seconds with 26 misses.

Record this scope before repeating an edit/build loop. Do not fabricate cache
keys, copy products under a new identity, or substitute a validation-only material
profile for the product. Batch qualified changes and use existing source/contract
proof while a necessary normal build runs. A future narrower dependency key needs
its own namespace/import/invalidation proof.

## Qualify the intervention before measuring its result

| Experiment boundary | Required receipt | Result in this case |
| --- | --- | --- |
| Feature pass batching | Actual Worker startup profile and prepared Host counters | Same-build off/on/off LIVE FPS was 51.18 / 58.72 / 50.05; the enabled receipt merged 37 passes into 9 |
| Material packing reuse | Exclusive numeric/ABI ownership, exact uploads and actual cache population | Native receiver detachment preserved public mutable inputs; the production snapshot had 514,475 hits and zero mutable misses |
| GBuffer ordering | Complete current program source, encode admission and moved references | An old terrain-only digest list rejected all 374 actual batches; authenticated Standard sources predicted 219 candidates, without proving runtime movement or a speedup |

Keep explicit diagnostic overrides separate from the production policy. A
profile readback proves selection; prepared counters prove admitted work. Neither
alone proves command equivalence or net benefit. The final Null-owner batching
ABBA was mixed; the actual browser ABA supplied the subsequent positive evidence.

The integrated production build at Engine `bfb841bb` / Game `229053ed` recorded
59.70 completed LIVE FPS and a 56.44 rolling-one-second minimum. Its retained BUY
prefix minimum was 52.55 and its cold window still contained a 44.2 ms interval.
This qualified that single pressure run's LIVE floor, not the complete cold-path
objective or stability across devices. See the ordinary production receipt
and same-build ABA.

Ownership preparation has a churn boundary. The complete material owner improved
51.40% at low churn and 26.56% with 10% of materials updated each frame, but
regressed 7.09% with every material updated each frame. Those numbers include
cloning and retirement; they are CPU owner timings, not Game FPS. Retain the
[full-churn negative control](../../../../packages/render/reports/received-material-full-churn-negative-20261017.json).
Unchanged bytes do not establish stable snapshot identity; mesh updates do not
establish that every material changed.

## Locate the bad interval before naming its cause

Use the [worst completed window adapter](../../../../scripts/performance/worst-completed-window.mjs)
with the captured Game checkout. It authenticates the captured summary authority,
reuses its endpoint/count rule and returns exact World/device/frame boundaries.
Nearest HUD samples retain their time offsets; they are not same-receipt events.
The original raw, cold and full-window observations remain authoritative.

In the enabled experiment, the worst LIVE second was at +1.762 to +2.774 seconds.
The reverse control's worst second was after 27 seconds, so a four-second cold
CPU capture could cover the former, not the latter. A cold window's 59.3 ms
interval occurred before the first observed player shot. Earlier loading-period
pipeline-pending receipts were over 500 ms away and could not explain that gap.
See the [cold attribution boundary](../../../../packages/render/reports/cold-gap-attribution-boundary-20261017.json).

> [!IMPORTANT]
> Preserve complete-source digest rejection, failed cold coverage and unknown
> causes. A zero-admission run cannot test sorting, and a queue/composite tail
> cannot be renamed GPU time while later Render Worker tasks overlap it.

## Separate allocation population from a cold stall

At Engine `c6851578` / Game `558ea408`, a native GC diagnostic failed while
reading a 747,755,122-byte trace into one Node string. The raw stream and CPU
profiles survived. Offline recovery authenticated three owned threads, but the
original producer had not persisted its tracing-complete/data-loss receipt;
the capture remained failed. Its 106.8 ms BUY gap contained only a 2.636 ms
temporal union of saved complete Worker MinorGC events. That observation did not
explain most of the gap or exhaustively exclude missing events, and could not be
transferred to another ordinary capture's frame.

The consumer's bounded streaming reader processed that same original in 5.70
seconds with 137.52 MiB peak RSS. It retained 4,423 of 2,873,961 events, preserved
the exact marker identities and produced the same complete native-GC summary as
an independent recovery. The repair did not turn the failed capture green. See
the reader proof.

A separate matched-BUY allocation capture started all three samplers before
READY and excluded Home/loading from their heap intervals. Render Worker had
2,113,369,804 estimated allocated bytes over its acknowledged 4.122 to 4.294
second bounds, including the asynchronous retrieval tail. This was cumulative
sampled allocation, not resident storage, an exact LIVE rate or a frame owner.
Direct source mapping and nearest-mapped-ancestor attribution remained distinct;
the preparation chain needed a full-lifecycle owner experiment before changing
runtime code. See the capture and scope receipt.
