# GC and allocation ownership

## Produce the distribution before another broad run

For each Host, Engine Worker and Render Worker, report total allocation, ranked
source owners/functions, direct mapping, nearest-ancestor attribution and
unresolved bytes. Count each sampled node once per table. Identify a concrete
owner and a falsifiable source change before repeating whole-game profiling.
Use the [heap/source/native tools](toolbox.md#worker-heap-and-native-gc-attribution)
on existing captures first. Use a new bounded capture to resolve a material
unknown or validate a changed candidate.

| Measurement | Answers | Boundary |
| --- | --- | --- |
| Ordinary frame/completion intervals | User-visible throughput and stalls | No heap profiler or debug probe; preserve current workload/quality |
| Native Minor/Major GC events | Observed Worker GC wall/CPU durations | Exact target/thread markers; complete trace-clock interval; background threads are separate |
| SamplingHeapProfile including collected objects | Short-lived allocation owner distribution | Statistical estimates, not resident heap or exact freed bytes |
| Retained heap/after-GC size | Surviving storage and possible lifetime leak | A different population from cumulative allocation |
| Sampled JS GC stacks | GC samples within a CPU profile | Do not add these samples to native GC duration |

An accepted capture must retain its own workload and correctness guards. A failed
combat capture can supply independently valid source attribution, but remains
failed as a gameplay/performance run. Do not drop a movement/fire/hit requirement,
extend the round clock, reduce picture completion work or lower shadow quality
to obtain a favorable GC result.

## Collect without changing the Engine allocation path

Attach CDP to the actual nested Worker targets and save their target identities.
Use `HeapProfiler.startSampling` with an explicit interval and, when supported,
`includeObjectsCollectedByMinorGC` and `includeObjectsCollectedByMajorGC`. Preserve
the flags actually accepted by the browser. Unsupported flags are a capture
limit; a default surviving-object sample does not measure all short-lived churn.
The [protocol](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/)
defines these commands and sampling records. Engine allocation hooks are not
required for this path; CDP instrumentation still changes execution cost.

> [!IMPORTANT]
> Profile retrieval is not a neutral timing endpoint. The inspected
> [V8 implementation](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/inspector/v8-heap-profiler-agent-impl.cc)
> can force collection when obtaining the allocation profile. Stop the measured
> CPU window first; keep terminal read/stop and externally paused diagnostic
> phases out of natural-workload GC. Verify the actual browser/V8 version.

Emit an externally requested user-timing marker in each owned target before
tracing the workload. Match the unique marker to its trace `pid/tid`; a Worker
name or guessed process ID alone does not establish thread ownership. Record the
common CPU/trace window, complete Minor/Major events, finalization cleanup and
cppgc sweeping separately. Boundary allocation/promotion counters omit their
first observation and unobserved tail; fewer than two boundaries mean no rate.
Promotion is neither total retained storage nor proof of a leak.

## Authenticate source locations and count once

1. Save `Debugger.getScriptSource` SHA256 for each loaded script URL. Preserve
   build/source revisions, the served output bytes and hidden maps.
2. Resolve locations only against matching scripts. For bundled Engine output,
   verify the map's embedded intermediate bytes against the frozen Engine
   output, then apply its second map. Preserve original source-coordinate roots
   when cloning outputs. Never resolve an old capture against a newer build.
3. Attribute a mapped node's `selfSize` directly. For an unmapped descendant,
   follow parents to the nearest mapped caller and count those bytes there once.
   Keep direct and ancestor coverage separate; file and function tables are
   alternative partitions, not additive costs.
4. Keep truly unresolved nodes and their generated frames. No-URL `join`,
   `Map/Set`, array and iterator frames can have a well-located source caller.
   That proves the calling owner, not a particular allocation statement.

Node self-size totals and sample-record totals can differ in V8 captures. Retain
both values rather than inventing an equality check or replacing one silently.
Report raw bytes with an explicit MB/MiB convention, duration and sample interval.
Millions of allocated bytes do not mean those bytes survive simultaneously.

## Inventory retained representations

Trace strong references after the consumer has accepted its own packed payload.
A static producer can retain both its canonical prepared geometry and a complete
derived JavaScript array graph even when idle-frame allocation is low.

| Representation | Check before releasing or changing it |
| --- | --- |
| Canonical prepared coordinates/indices | Required precision, later cut/projection input and exact author/material order |
| Derived number arrays, vertex objects or flattened projections | Which live consumer still needs them after packing; whether rebuilding from the canonical owner is valid |
| Typed views and shared backing stores | Active bytes versus capacity; count one backing buffer once across views and owners |
| Decoded source Mesh roots | Whether processing needs only base geometry or the complete render dependency closure; use an owned source-data API while preserving explicit material readiness |
| Native collider/GPU copies | Accepted lifetime, recovery and teardown; reducing a source reference must not retire a live device/body resource |

Keep logical element-byte estimates, after-GC `heapUsed`, `external`,
`arrayBuffers` and RSS as distinct measurements. In Node, `arrayBuffers` is
included in `external`; adding them double-counts storage. JavaScript number-array
logical bytes are not exact V8 heap size. Preserve the original coordinate width
when cuts or ownership require it; replacing binary64 input with f32 is a
semantic change, not a free memory optimization. The
[static projection case](cases/full-scene-resources-20261016.md#retained-static-projection)
removed a redundant representation while retaining its prepared Float64 source.

When a producer already owns an independent prepared representation, use the
published root's geometry-read capability rather than retaining a complete
render Asset solely as processing input. Count actual recursive default
references separately from author overrides and explicit ground preloads.
Preserve ordinary `loadByGuid` readiness, artifact validation and invalidation
fences. `invalidate` changes publication authority; it is not a safe memory
eviction operation. The [source-read case](cases/full-scene-resources-20261016.md#decoded-source-roots-and-render-readiness)
records the public API, full producer proof and measured limits.

## Remove work at its existing authority

| Observed source | Structural change | Required falsifier |
| --- | --- | --- |
| Repeated string keys, signatures and membership collections | Capture stable material/batch facts at their existing producer; select views from that data | Same-count material/receipt/entry/state change; mutable/getter input stays observable |
| Rebuilt immutable material observations | Borrow sealed producer facts, copy unqualified inputs | Different World/catalog generation; released asset; mutable binding data |
| Broad epoch invalidates unchanged asset roots | Resolve actual asset root; reuse only when consumed facts remain equal | Material replacement/removal, entity retirement/reuse and resource recovery |
| Duplicate dispatch or hierarchy maps | Keep one existing slot/parent owner and read its dense query spans | Removal, permutation, generation reuse; held previous publication stays unchanged |
| Query result/transform/neighbor intermediates | Publish final results directly; use bounded producer scratch only within its lifetime | Retained public result, callback reentry, stable ordering, binary64 ray precision |
| Unbounded support observation growth | Grow the existing conservative observation envelope; keep exact revision verification | New/removed supports, native body movement, unrelated edits preserve progress |

Prefer deleting a redundant representation or shifting preparation to real
changes over adding another global cache, epoch, reverse index or lifecycle.
Reusing a material fact does not authorize reusing a view's visibility or depth.
Aliased ECS array views cannot be held across structural change or published as
detached snapshots. Preserve raw/custom input observation; immutable-looking
types and shallow freezing alone do not prove producer ownership.

## Batch changes around the measured owners

Use an existing source-authenticated distribution to rank a batch by allocation
rate, recurring work and expected invalidation frequency. Finish the related
producer, index and consumer changes before rebuilding and measuring the whole
scene. Keep correctness checks for raw observation, callback reentry, publication
identity and retirement; a batch is not permission to defer a known correctness
failure.

For short-lived objects, remove repeated traversals and representations before
adding pools. A common one-key lookup can store its first entry directly and
allocate a hash table only on fanout; verify SameValueZero, undefined values,
overwrite behavior and a high-fanout workload. Preserve native array-map hole and
callback semantics when sharing callbacks. Prepared numeric retention must derive
from the exact admitted draw keys, with legacy/custom publications taking the
original parser. Invocation-local Map callbacks can avoid per-row iterator
results and entry tuples without introducing shared scratch vulnerable to reentry.

Count removed source operations separately from V8 sampling records: sampled
allocation counts are not exact object counts. Keep bytes, natural GC duration,
collection frequency and surviving/promotion storage together. Do not infer an
object count by dividing bytes by a guessed size, or assume smaller objects are
always more expensive. Report the batch's combined result first; attributing a
percentage to each change requires an additional controlled comparison.

A raw iterator must retain its cached next method, tuple destructuring and
IteratorClose on exceptions. Use the original for-of path for raw inputs; a
trusted dense path can share one classifier per invocation across all rows.
Invocation-local state preserves nested reentry without a callback per row.
Keep build producers and timed captures sequential, and freeze bytes only after
all writers to those outputs have exited. Retain cold-start/contended failures;
a scoped successful replay does not qualify the original full gate.

## Verify the removed work, then the whole Worker

Use a real producer/consumer regression for the changed owner, including the
invalidation case that should refuse reuse. Local allocation microbenchmarks
must count equivalent queries/draws, result checksums and the producer work moved
outside the timed loop. Include retained storage/high-water and retirement.
Run natural GC with heap sampling disabled, followed separately by source
attribution and ordinary throughput under the fixed workload. A large local
allocation reduction does not establish elimination of most Worker GC.

[The scoped Worker case](cases/worker-gc-ownership.md) records examples where
local reductions passed correctness tests while whole-Worker churn remained high.
