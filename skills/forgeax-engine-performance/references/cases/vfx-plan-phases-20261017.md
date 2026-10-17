# VFX plan phases and redundant collection ownership (2026-10-17)

## From a sampled symbol to a removable owner

Frozen Chrome Render Worker samples for Engine `9249220429` and Game `4fbf9461`
covered LIVE 4,028.3 ms. VFX `plan` was 470.353 ms inclusive, with 81.671 ms leaf
self; compute coalescing was 75.040 ms inclusive, 58.513 ms self. A function-entry
source location across a large body did not identify a deletable stage.

A private Node/Null fixture used the real Game gunshot/impact producers: nine
gun actors, 160 frames including loading, firing and tail, one/two FixedUpdates,
fresh ordinary mesh bytes, publication with transfer, Renderer completion,
feature ACK and source recycling. Six exclusive brackets separated resolution,
classification, resource/pass construction, ordering, coalescing/feedback and
finish/packing. Frame identities and enclosing/child wall totals conserved.
Build occupied about 61% of instrumented plan wall time; coalescing and finish
were about 14% each. Those wall shares rank this fixture only.

| Comparison | Active owner CPU | Complete owner CPU |
| --- | --- | --- |
| Private six-phase/helper probes, ABBA | +2.38% | +1.23% |
| Temporary-array/streaming candidate, ABBA | +2.86% | +5.35% |
| Resource uniqueness candidate, eight arms ABBA + BAAB | -2.13% | -1.53% |

The streaming candidate was withdrawn despite matching native work. Diagnostic
overhead remained in its own comparison rather than being subtracted from phase
values. Original bundles, source maps and failed tooling attempts were retained.

## Existing uniqueness authority, unchanged public observations

In [compute coalescing](../../../../packages/vfx-render/src/feature/compute-passes.ts),
the resource-owner Map already decides whether a batch acquires a resource. The
batch's Set was only iterated for cleanup. Replacing that redundant Set with an
array left the acquisition gate and all binding/provider reads in place.
Repeated cleanup deletes remain idempotent even for unusual accessor values.
The integrated Runtime commit is `a55ea8712b` (original `c40feb45eb`).

The [regression contracts](../../../../packages/vfx-render/src/__tests__/compute-passes.unit.test.ts)
cover duplicate names/getter observations through flush and reacquisition,
alongside existing alias, overlap, enablement and command barriers. Separate
static and per-frame mesh/material controls each compared 160 frames and 164,318
commands: effective command/upload oracles and resource/ACK/idle/disposal guards
matched Before/After. The dynamic control changed uploads in 150 frames, with
identical getter/provider counts between implementations. Counts alone were not
the performance verdict; both timing orders retained their complete-owner cost.

Evidence commit `306a6fe64c41a34ef5caa0632c57d8a790c6b4e3` contains the compact
`coalescer-resource-uniqueness-owner-20261017.json` and
`private-plan-six-phase-owner-20261017.json` reports under
`packages/vfx-render/reports/`, including arm values and raw hashes.

## Reuse boundary

The retained [publication observer](../../../../packages/render/bench/publication-phase-observer.mjs)
and [runner](../../../../packages/render/bench/publication-phase-runner.mjs)
demonstrate another private partition on the same producer, with exact bundle
anchors and clone/MessageChannel transport arms. They require separately prepared
frozen fixture inputs; they are not a generic Runtime transform or a standalone
Chrome collector. Receiver work is nested in draw and remains separately labeled.

> [!IMPORTANT]
> Node/Null proves its CPU owner and semantic controls. Chrome emitter population,
> Worker scheduling, native driver/GPU work and ordinary game FPS remain separate
> acceptance. The integrated batch still requires its actual product observation.
