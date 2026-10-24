# GC and allocation ownership

## Produce the distribution before another broad run

For each Host, Engine Worker and Render Worker, report total allocation, ranked
source owners/functions, direct mapping, nearest-ancestor attribution and
unresolved bytes. Count each sampled node once per table. Identify a concrete
owner and a falsifiable source change before repeating whole-game profiling.
Use the [heap/source/native tools](toolbox.md#worker-heap-and-native-gc-attribution)
on existing captures first. Use a new bounded capture to resolve a material
unknown or validate a changed candidate.

Keep an actionable row per source owner: Worker, file/function, direct or
nearest-caller attribution, bytes/rate, observed source operations, change
frequency, proposed ownership change, invalidation counterexample and outcome.
Mark unresolved object types explicitly; an ancestor such as ray-box can own
callee allocations without allocating a hit record itself. Source shares rank
investigation; they are not percentages already eliminated by a patch.

| Measurement | Answers | Boundary |
| --- | --- | --- |
| Ordinary frame/completion intervals | User-visible throughput and stalls | No heap profiler or debug probe; preserve current workload/quality |
| Native Minor/Major GC events | Observed Worker GC wall/CPU durations | Exact target/thread markers; complete trace-clock interval; background threads are separate |
| SamplingHeapProfile including collected objects | Short-lived allocation owner distribution | Statistical estimates, not resident heap or exact freed bytes |
| Retained heap/after-GC size | Surviving storage and possible lifetime leak | A different population from cumulative allocation |
| Sampled JS GC stacks | GC samples within a CPU profile | Do not add these samples to native GC duration |

A RunTask whose `args.src_file` names V8 incremental marking, a MinorGCJob or
cppgc sweeping identifies the scheduler owner. Its whole wall interval is not a
GC subspan: it can include idle, nested callbacks and other CPU work. Keep native
explicit GC spans, sampled `(garbage collector)` weights and heap-scheduled task
intersections as separate observations. The
[late-window case](cases/late-task-clock-boundaries-20261017.md) preserves all three
boundaries without assigning a software completion tail to GPU execution.

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

### Bound the collection phase and the trace reader

Starting CPU observation on Home does not require starting heap sampling there.
When the question concerns the initial battle transition, start allocation
sampling after an actual matched, loaded BUY completion and await every owned
target's acknowledgement before sending READY. Keep that receipt, each target's
request/ack brackets and the CPU-stop/retrieval tail. A LIVE-only heap start misses
BUY allocations; a Home-start heap includes loading. Neither can be renamed to
the missing phase, and timestamp-less samples cannot be cropped afterwards.

Large native traces can exceed a JavaScript string limit before analysis starts.
Drain the complete original stream to disk and persist transport completion,
data-loss status, EOF and close receipts before parsing. Frame JSON values across
arbitrary byte chunks; validate discarded values and the complete outer tail.
Retain the summary's marker, GC, counter and cleanup inputs with explicit
per-value/depth/output limits. Exceeding a bound rejects the analysis rather than
silently omitting events. Compare the filtered summary against an independent
recovery when possible; a missing original receipt stays unknown.

The [restored-scene collection case](cases/restored-scene-attribution-20261017.md#separate-allocation-population-from-a-cold-stall)
records an actual oversized trace, bounded recovery and matched-BUY heap start.

## Measure the retained floor separately

A heap that climbs between major collections and returns to the same value
after one is churn, not a leak. Record a per-Worker `Runtime.getHeapUsage`
series through loading and play, then `HeapProfiler.collectGarbage` once at the
end: the after-GC value is the floor that low-memory devices must hold.

To attribute that floor, start a surviving-object sampling profile (no collected
object flags) before loading, force collection at the end and only then stop
sampling. The profile then lists live objects by allocation site and its total
approximates the after-GC heap. Profile churn in a separate run from loaded BUY.
Forced collection perturbs timing; never place it inside a measured CPU window.
The [heap floor case](cases/worker-heap-floor-20261023.md) shows both populations
for one scene and why halving churn left the floor almost unchanged.

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

Validate each target independently without turning a failed capture green. The
[current LIVE heap audit](../../../packages/render/reports/current-a011-live-heap-source-attribution-20261017.json)
retains an Engine Worker sample whose node is absent, while separately qualifying
the unchanged Host and Render Worker profiles. Any tree-only projection must
preserve orphan rows and both byte totals outside its attributed partition.
Report sampling request/ack bounds and the CPU-stop/retrieval tail: samples have
no timestamps, so that tail cannot be removed or called exact product churn.

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
Preserve ordinary `load(guid, kind)` readiness, artifact validation and invalidation
fences. `invalidate` changes publication authority; it is not a safe memory
eviction operation. The [source-read case](cases/full-scene-resources-20261016.md#decoded-source-roots-and-render-readiness)
records the public API, full producer proof and measured limits.

### Separate moved allocation from removed storage

Eager loading can eliminate first-use construction while retaining a much larger
set than the measured route touched. Measure snapshots/selections and derived
indices separately before choosing a representation change. Count reachable
ArrayBuffer backing stores with heap changes; moving objects out of `heapUsed`
alone is not storage removal. Keep diagnostic forced-GC measurements outside
product startup and natural-GC timing.

Use the [query preparation case](cases/query-preparation-20261017.md) when deciding
between loading preparation, a compact fixed index and the existing dynamic
index. It preserves the adverse complete-loader observation alongside local
CPU and storage improvements.

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

Preserve documented public wrapper identity when removing allocation. A transient
consumer can use an existing semantic scalar-read capability without changing
every public read. For reusable scratch, a camera getter or upload callback can
reenter even when ordinary callers never do; test nested and throwing calls.

## Qualify reusable facts once at admission

Private producer admission can capture and seal detached primitive facts once,
then register that exact object in an existing realm-local ownership registry.
Consumers borrow only admitted facts. Raw/custom rows retain their original
capture path; a TypeScript readonly type, shallow freeze or public brand field
cannot establish this qualification. Repeating descriptor inspection at every
lookup can cost more than the copying it replaces.

Structural interning keys must delimit child IDs and adjacent field lengths;
exact content comparison cannot be replaced by an ambiguous concatenation or
an unchecked hash. Qualify descriptors before reading raw properties, and keep
owned parsed/Worker-cloned JSON separate from caller-owned mutable input. The
[takeover counterexamples](cases/worker-heap-floor-20261023.md#takeover-counterexamples-2026-10-24)
record actual collisions and callback reentry.

A weak read cache trades retention for a possible later fetch and parse. Compare
post-GC storage, transient decode allocation, cold loading and delayed sibling
reads after collection. A cache that does no per-frame work can still introduce
a first-use stall; warm steady CPU alone cannot accept that tradeoff.

| Recurring work | Move or remove it at this boundary | Lifetime limit |
| --- | --- | --- |
| Main and shadow rebuild the same primitive membership | Publish one reverse index from the immutable submission plan | Visibility, depth and indirect commands remain view-owned |
| Material defaults, tuples and numeric wrappers | Write scalar defaults directly and reuse the payload owner's DataView | Mutable bytes still repack; each physical upload target remains authoritative |
| Per-row closures and iterator entry tuples | One classifier per invocation; trusted dense traversal where already admitted | Raw iterators retain next/IteratorClose, getters, holes and callback receiver behavior |
| Resource, shader or contact-history result wrappers | Reuse the existing lifetime owner's immutable success/publication | Failure, replacement, append/reset and recovery invalidate their actual owner |
| ECS membership and field-name intermediates | Read the existing sorted component roster and frozen definition metadata | Public row snapshots still detach mutable values |
| Query vectors, rotated corners and losing ray hits | Scalar kernels and bounded invocation scratch; allocate final public winners | Reentry needs separate scratch; old results remain valid; binary64 precision is preserved |

Prefer a tri-state native contact prefilter over eagerly publishing manifolds
when the caller only asks whether a pair could matter. Return unknown before a
healthy completed step or for unmanaged bodies. Collision-event membership can
admit a pair, but its absence cannot reject colliders that never emitted events;
consult authoritative native adjacency before returning false. Keep public
contact snapshot and history lifetimes separate from this admission query.

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
When a task specifies a combined reduction target, compare matched before/after
Worker rates in the same units and workload window. For an 80% target, the final
sum must be at most 0.2 times the baseline sum; also report bytes per completed
frame so a lower frame rate cannot masquerade as reduced churn. Keep functional
regressions local during implementation and reserve expensive whole-scene
captures for the completed batch unless a specific unknown blocks the design.

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
Its [integration batch](cases/worker-gc-ownership.md#integration-batch-2026-10-15)
separates shipped source changes from unfinished whole-Worker acceptance.
