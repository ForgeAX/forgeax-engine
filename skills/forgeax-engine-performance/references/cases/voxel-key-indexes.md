# Game/Voxel spatial indexes and cold author-data cooking

> [!IMPORTANT]
> These 2026-10-14/15 results measure bounded CPU fixtures and a particular cold
> cooker. They establish neither whole-game FPS nor GPU, GC or peak-memory gains.
> The integrated Game full suite did not pass before delivery was stopped.

## Mechanism and semantic counterexamples

The delivered report
records the implementation, raw samples and failed attempts. Voxel owns chunk,
cell and surface indexes; Game consumes public exports and owns navigation,
collapse bookkeeping and temporary Shape selections. No Engine source change
was needed for these indexes.

| Change | Preserved invariant or counterexample |
| --- | --- |
| Three signed 17-bit chunk axes in an exact 51-bit number | Public packing preserves in-range values and rejects fractional/out-of-range axes; internal wide-coordinate indexes use exact string fallback |
| Source-local numeric cells and signed 15-bit Game column axes | Local bounds and fallback namespaces prevent next-row aliases; transient keys do not replace wire IDs |
| Exact number-indexed navigation positions | Fractional floors and arbitrary link endpoints stay distinct |
| Owner/child Shape selection with an ordered Set | Arbitrary textual IDs remain exact; global insertion order preserves ties and extraction/checkpoint behavior |
| Shared native/fallback base64 decoder in Workshop and character producers | Author payload bytes and material/reference mapping stay unchanged; the character generator emits the same helper |

The old chunk packer aliased `(65536,0,0)` with `(-65536,1,0)`. The regression
checks all 14 dirty chunks and actual incremental remeshing, rather than just
key round trips. Public range rejection and internal wide-coordinate support are
different contracts. Mixed key types retain explicit coordinate ordering.
General representation decisions live in
[spatial key semantics](../cpu-submission.md#preserve-spatial-key-semantics).

## Fixed CPU workload and newer baseline

Game baseline `1c8d068747d3e54c30bc31ff49c789098a94c233` and candidate
`6a1bdffc1c59f07efae343f3b2a87c769286022a` use Voxel baseline
`6da9204ee5a7c949b906b09f9e78de332be7cd2f` and merged candidate
`e066fe835f3ae7f37c2276b3b370c3195d39db78`. Both use Engine
`c8f79f5abd0ba5872d12d9e91e625d31aaa19bb5`. On an Apple M4 Pro / 64 GiB,
Node 26.4.0 loads both roots in one process, warms them and rotates six variants
over 11 samples per run. Ordered query, navigation and surface SHA-256 outputs
match. CPU denotes main-thread CPU; wall times and adverse samples are retained.

| Workload | Run 1 CPU median, baseline to candidate | Run 2 CPU median, baseline to candidate |
| --- | ---: | ---: |
| 512 sources and 512 metric queries/sample | 11.208 to 11.226 ms | 7.616 to 7.299 ms |
| Three navigation routes, 2,000-node budget | 38.081 to 23.663 ms | 28.186 to 18.364 ms |
| 15,420 cells, 5,914 surface quads | 63.104 to 24.178 ms | 40.359 to 17.203 ms |

The newer baseline already uses a two-level primary Shape map. Query
stringifications are **0 to 0**; the older 6,272-to-zero result cannot be
attributed again. Run 1 query wall median worsens from 15.335 to 17.021 ms and
P95 from 23.116 to 27.622 ms. No consistent query gain is established.
Navigation and surface improvements describe these CPU workloads only. The
joint experiment predates later Workshop/character and Body-observation changes.

## Cold failures and exact decoder comparison

The original plain build omitted its nested cause. Source-edit timestamps and a
later concrete `source added during plugin compilation` failure support a source
race interpretation, but do not recover the original diagnostic. Another fresh
run exceeded a 15-second equipment module-initialization limit. After upstream
asset changes, a Workshop build-phase timeout reproduced with all 8,578 fenced
inputs unchanged. These were distinct observations, not interchangeable causes.

Workshop producers and generated character author data still performed
`Uint8Array.from(atob(...), callback)`. Reusing the existing exact decoder removed
the per-byte iterator/callback path. Three rotated paired samples cover 4,730
payloads / 100,393,399 decoded bytes. The old, native and imperative fallback
methods produce identical complete ordered hashes.

| Decoder plus SHA hashing | CPU median | Wall median |
| --- | ---: | ---: |
| Previous iterator | 3,515.956 ms | 3,544.536 ms |
| Native decoder | 49.119 ms | 49.207 ms |
| Imperative fallback | 142.655 ms | 142.883 ms |

This measures decoding plus hashing, not whole-Pack time or retained memory.
A separate model parity receipt checks 275 weapon/rig models, 825 payloads and
31,951,008 uncompressed bytes against the earlier author data. It does not make
the format/compression integration part of the transient-key timing result.

The final fresh-cache build at Game
`369ae2ec6cba29a16cf9512bbdb180d29b5ff399`, Voxel
`4eb5f4808313b6edb6e32b1296addb27f592075b` and the same Engine `c8f79f5`
took 1,117.902 seconds. All 8,578 source inputs remained identical; all 12,685
declared artifacts / 554,280,843 bytes matched sizes and SHA-256. An unchanged
producer limit and one successful cold attempt establish that cooker result,
not a whole-build speedup against an equivalent successful baseline. Follow
[cold producer measurement](../measurement.md#freeze-inputs-for-cold-producer-measurement)
for the reusable procedure.

## Delivery is a separate boundary

Voxel #190 merged after
its 1,497-test suite and CI passed. Game #130
merged at the user's explicit request to prioritize submission and stop further
testing. Before that stop, the integrated TDM sustained-crossfire assertion
failed; independent qualification CI was cancelled. The external sensitive scan
was separately excluded by the user. Later Game-main integration retained its
Engine `ffb3645e` pin without a new run. The cold pass and microbenchmarks above
remain source-scoped receipts, not complete final Game or CI acceptance.
