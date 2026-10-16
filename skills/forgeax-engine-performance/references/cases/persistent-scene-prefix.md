# Persistent scene ownership under local churn

> [!IMPORTANT]
> This is a scoped CPU owner experiment from 2026-10-14. It does not establish
> whole-frame throughput, GPU time or completed visual acceptance.

The earlier Frontline capture at Engine `27e1ac5f` attributed about 1.005 ms per
completed interval to Persistent RenderScene; most samples belonged to
`deriveFramePlan`, especially ShadowCaster ownership generation. The intervention
started from PR3855 owner source at `746372ec82`. A later parent revert did not
change these two owning files.

## Remove work at its actual frequency

| Change | Authority and retained correctness |
| --- | --- |
| Reuse the unchanged ownership prefix | Compare World/entity, author visibility and complete pass facts. Membership is ordered by renderable index; rebuild the suffix from the first changed row. Earlier published arrays stay immutable |
| Reuse keys only for retained membership objects | A weak object-keyed memo is queried only for a proven reused prefix. New/cold rows build keys directly, avoiding another cold-path lookup or a second retained key array |
| Cull shadow volumes on demand | Build the dispatch caster set and light frusta only when an off-camera CPU candidate needs them. Read the current light matrices for each frame that needs the test |
| Read dispatch slots directly | The existing ordered slot snapshot has the same order as materialization. Avoid a second World/entity lookup for each dispatch row |

This remains an O(N) ownership comparison and Set assembly on changed rosters;
it is not producer-driven O(D) maintenance. A change near the beginning retains
little useful prefix. The weak key memo does not hold removed membership objects
alive; older published frames still own their own immutable members.

## Matched owner experiment

The [fixture](../../../../packages/render/bench/shadow-ownership-churn.ts) has
775 entities and two passes each. Inputs are prepared before measurement;
baseline and candidate outputs are compared exactly. Twelve alternating pairs
measure 500 calls per batch after warmup, using Node 26 thread CPU and a separate
wall clock on a contended M4 Pro host. Values below are medians of batch mean CPU
costs, rather than per-frame percentiles.

| Input | Baseline ms/call | Candidate ms/call | Observed change |
| --- | ---: | ---: | ---: |
| Unchanged | 0.003242 | 0.003240 | Within 0.000002 ms |
| One middle row changed | 0.275990 | 0.192478 | 30.3% lower |
| One tail row added/removed | 0.269478 | 0.103376 | 61.6% lower |
| First row removed/restored | 0.281718 | 0.286348 | 1.6% slower |
| All rows changed | 0.287596 | 0.287342 | Within 0.1% |

The changed-row counter reports rebuilt suffix rows, excluding an unchanged
prefix. A middle change rebuilds 388 of 775 rows; tail churn alternates one and
zero rebuilt rows. Front churn and all-dirty retain no prefix. A cold miss is not
an invalidation count, and row reuse does not mean Set assembly was skipped.

The first row-cache attempt reduced local-churn time but increased all-dirty CPU
by about 24%. Subsequent flat-key storage still cost about 10% on cold paths.
Removing key reuse almost removed the intended gain. The final weak memo is
restricted to actually retained members, and its counters accumulate once per
build rather than once per row. The cold suffix preserves the original allocation
and key-construction order, and skips prefix search when the first row changed.
An earlier confirmation still had 6-7% cold regression; those receipts motivated
this final change. Preserve those rejected attempts as private
receipts; do not publish only the best workload.

Reproduce the owner-file comparison from a contributor checkout:

```sh
node scripts/bench/run-shadow-ownership-churn.mjs \
  --baseline-ref 746372ec82c6d27e82ca10e456c16faddbd9f76b \
  --output artifacts/shadow-ownership-churn
```

The [runner](../../../../scripts/bench/run-shadow-ownership-churn.mjs) freezes the
baseline owner with `git show`, records both owner digests, and uses the same
current dependency closure/compiler for both versions. This is an owner-file
A/B, not two complete Engine builds. On Node without a thread CPU clock the CPU
fields and ratio remain unavailable; wall timing is retained separately.

## Correctness and remaining boundary

Regression coverage preserves old publications through material replacement,
visibility, tail add/remove, reordered rows, repeated terrain entity identities
and multi-World keys. The cull fixture checks that a visible caster constructs no
light frusta, an off-camera caster keeps its depth dispatch, a moved light cuts
it out, and a moved camera restores both forward and depth work.

An initial full Browser attempt exceeded its maintained 300-second startup
budget. Keep that failure; CPU assertions/builds cannot replace Browser, Dawn,
core smoke or actual Frontline completion evidence. The game's existing shadow
profile is unchanged. A later live comparison must retain its three 1024 maps,
coverage and filter and validate the current workload, not reuse old FPS as a
matched baseline.

## Numeric shadow claim lookup

> [!IMPORTANT]
> The follow-up removes composite string construction from membership-backed
> `ShadowClaimTable` queries. Boundary shadow keys and the key-only input path
> remain strings. These measurements do not establish Frontline FPS.

The original index formatted an entity/material/draw string for each uncached
snapshot query. The replacement hashes those existing numeric facts into one
numeric Map, then compares all three fields inside the bucket. A hash collision
is never ownership: large handles with identical low bits are explicitly tested.
No packed unique ID, new registry or Worker protocol is introduced.

An entity-local scan made lookup/build work grow with draws per entity. Three
nested numeric Maps avoided that scan but increased retained table heap by about
59%, so that version was rejected. The selected bucket index uses exact-size
single-element arrays for the common one-claim bucket and one-pass key list.
Later collisions and duplicate passes grow those arrays normally. First-seen
claim-group order, duplicate rejection and immutable publications are preserved.

Keep the cached query method small. An intermediate implementation increased
the stable workload from 0.020500 to 0.024002 ms per 1550 queries. Moving miss
resolution and cache insertion to the cold method reduced that observed penalty
to 0.000074 ms in the final capture; retain the intermediate raw result.

The final owner baseline is PR3855 `ab6bce9b05`. The same source dependency
closure/compiler bundles both owner versions. The fixture compares full claims
and boundary key order before timing. Node 26 thread CPU, twelve alternating
pairs and 200 warmup iterations are used on a contended M4 Pro. Stable batches
contain 5000 iterations; other batches contain 100. Values are medians of batch
mean CPU costs, not completed-frame durations or per-call percentiles.

| Work per iteration | Baseline ms | Candidate ms | CPU change |
| --- | ---: | ---: | ---: |
| 775 entities, 2 draws, already cached | 0.020431 | 0.020505 | 0.36% slower |
| Same membership, all snapshots replaced | 0.458190 | 0.255780 | 44.2% lower |
| Rebuild complete table and query all draws | 1.142370 | 0.848570 | 25.7% lower |
| Replaced snapshots with about 25% missing materials | 0.466510 | 0.245780 | 47.3% lower |
| 24 entities, 64 draws each, snapshots replaced | 0.282580 | 0.121090 | 57.1% lower |
| Same 64-draw shape, rebuild and query | 1.082510 | 0.828130 | 23.5% lower |
| One entity, 1024 draws, snapshot replaced | 0.387690 | 0.312620 | 19.4% lower |
| Same 1024-draw shape, rebuild and query | 0.901660 | 0.765370 | 15.1% lower |

The 775-entity workloads query 1550 candidates per iteration. Stable queries hit
the snapshot cache after warmup; replacement snapshots and new tables miss it.
An instrumented correctness test observes 16 base-key formatter calls for eight
matched/missing snapshot pairs on the verified baseline owner and zero on the
candidate. This proves that query work disappeared, not that every string in
the pipeline disappeared.

After forced GC, retaining 24 unqueried tables in each of four alternating
windows measured approximately 694707 baseline bytes versus 582575 candidate
bytes per table, about 16.1% lower. This includes captured membership, claims,
keys and indexes. It excludes fixture source storage and is neither allocation
rate, transient peak, whole-game memory nor a GC-pause measurement. Thread CPU
does not sum GC helper-thread CPU; raw wall times remain in the receipt.

```sh
node --expose-gc scripts/bench/run-shadow-claim-lookup.mjs \
  --baseline-ref ab6bce9b05 \
  --output artifacts/shadow-claim-lookup
```

The [fixture](../../../../packages/render/bench/shadow-claim-lookup.ts) and
[runner](../../../../scripts/bench/run-shadow-claim-lookup.mjs) retain raw costs,
work counts, owner/fixture/lockfile digests and verified owner-load counts. Heap
measurement is unavailable without `--expose-gc`; thread CPU is unavailable when
the Node runtime lacks its clock. Neither unavailable value becomes zero.
