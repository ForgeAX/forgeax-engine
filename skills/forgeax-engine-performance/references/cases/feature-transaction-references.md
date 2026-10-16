# Feature GPU transaction reference maintenance

> [!IMPORTANT]
> This 2026-10-15 owner experiment compares frozen `6a453ef98f` with a local
> candidate. It establishes no whole-Game, GPU or completed-frame improvement.
> The Game-owned 40-item tracker
> retains the live baseline, rejected candidates and delivery state.

## Remove copying at the existing transaction owner

`createRenderFeatureGpuWorkSession` snapshots eight name/parked Maps and five
complete reference-key Sets at `beginFrame`. The candidate retains the name Map
snapshots but records only newly allocated opaque references in five arrays.
All seven reference insertion sites create a fresh frozen object. Abort removes
those additions and destroys their owned buffers through the existing disposal
guard. Accepted references, borrowed buffers, completion leases and parking keep
their existing ownership. There is no new persistent registry or index hierarchy.

The remaining name Map snapshots are still O(N). Do not describe this as fully
incremental rollback or infer that all of the session's sampled CPU was copying.
Reference retirement still follows completion release; a buffer replacement must
not destroy an older submitted allocation before its lease completes.

## Matched production-owner experiment

The [fixture](../../../../packages/render/bench/feature-rollback-references.bench.ts)
uses actual feature prepare/retain/commit/abort methods, Null RHI buffers and bind
groups, and actual completion releases. It is not a real GPU draw. The small case
has one buffer/binding; other cases have 256. After 200 warmup iterations, twelve
alternating pairs retain raw thread CPU and wall samples. CPU entries below are
medians of batch means, not frame percentiles.

| Workload | Baseline CPU ms/iteration | Candidate CPU ms/iteration | Reduction |
| --- | ---: | ---: | ---: |
| One resource, stable | 0.001890 | 0.001816 | 3.9% |
| 256 resources, stable | 0.085378 | 0.078504 | 8.1% |
| One resource size alternates | 0.105824 | 0.082752 | 21.8% |
| Create one temporary owned buffer, then abort | 0.093994 | 0.063604 | 32.3% |
| Replace all 256 resources | 1.202260 | 1.201560 | Approximately unchanged |

Every paired batch has equal output checksum and equal buffer creation,
destruction, bind-group creation, write, commit and abort counts. Wall times
include shared-host scheduling; an all-replacement wall regression remains in
the raw receipt. These measurements do not establish allocation rate, retained
heap, GPU memory or GC pause improvement.

```sh
node scripts/bench/run-feature-rollback-references.mjs \
  --baseline-ref 6a453ef98fbd212ab25a8c54dc9a2b31bba0ee0d \
  --output artifacts/feature-rollback-references
```

The [runner](../../../../scripts/bench/run-feature-rollback-references.mjs) loads
exactly one frozen owner for each bundle, shares its dependency/compiler closure,
checks work equivalence, and records owner/fixture/lockfile hashes. A runtime
without a thread CPU clock reports CPU as unavailable, preserving wall samples.

## Correctness and measurement falsifiers

Keep the existing replacement, borrowed texture/sampler, abort, recovery and
completion-retirement cases. The additional regression replaces one buffer and
its binding twice within one transaction: abort must retire both staged buffers,
invalidate both new references, preserve the accepted buffer/binding, and allow
retry with the accepted identities.

An earlier numeric entity-set prototype was rejected even though its small
benchmark was faster: it derived membership from the current slot rather than
the retained draw publication. After replacing entity 1 with 900, the original
draw keys still named entity 1 while the new set named 900. Capture canonical
identity at the producer of the actual publication; a new cached projection of
unrelated live state does not fix ownership.

The live baseline first lacked hidden source maps. A complete mapper output did
not imply nonzero mapped coverage. Rebuilding with the official hidden-map mode
and comparing captured script SHA-256 allowed offline attribution only for equal
JavaScript bytes. Keep the original unmapped result and authenticate the map
chain before ranking source owners.

## Integrated owner receipt

Candidate `291a1102ca6023fdb00b97e14f04f710eed0863c` has parent
`ec592e8f7908041f0b26ef6fcb81205345340ce7`. Its rollback owner at that parent
is byte-identical to the frozen `2128d689ef` owner used by the repeat experiment.
The common dependency closure includes the intervening material changes.

| Workload | Baseline CPU ms/iteration | Candidate CPU ms/iteration | Reduction |
| --- | ---: | ---: | ---: |
| One resource, stable | 0.003082 | 0.002740 | 11.10% |
| 256 resources, stable | 0.101416 | 0.084462 | 16.72% |
| One resource size alternates | 0.123628 | 0.099268 | 19.70% |
| Create one temporary owned buffer, then abort | 0.127786 | 0.090002 | 29.57% |
| Replace all 256 resources | 1.545100 | 1.401280 | 9.31% |

Do not select the faster repeat as universal savings. All 120 alternating raw
batches, including wall samples and work counters, are retained in the Game
tracker's CSV.
The integrated JSON SHA-256 is
`2945e22150dd246dcea381b60bfa2c204b6111848953d2aa3e6bc35e11e05183`;
baseline owner SHA-256 is
`acbc17829ff86111cea523ee35fdcbb218cdb8a3abeed9f96d6e806e7b2624fd`,
and candidate owner SHA-256 is
`297601d0455501c499bfd63d7211093c84d616856ecb8eb3ecd756a223d49159`.

The integrated 73-package source build and targeted resource tests passed.
The full Render suite ran 4355 passing tests, but a source typecheck error in
an inherited texture-digest test made that run fail. The byte-edit fixture
must explicitly prove the indexed byte exists rather than bypass the check.
Browser, Dawn and core smoke attempts subsequently failed with ENOSPC when
the host disk filled. Keep those failed logs; freeing owned inactive build
scratch and rerunning gates is required, not a performance pass.
Whole-Game before/after measurements and final delivery remain in the tracker.
