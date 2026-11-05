---
name: forgeax-engine-performance
description: >-
  Evidence-driven ForgeAX CPU and GPU optimization. Use when diagnosing slow
  frames, destruction backlogs, Worker GC or physics costs, reducing submission
  or shader work, comparing benchmarks, or adding reusable performance techniques.
---

# forgeax-engine-performance

Identify the expensive owner, remove redundant work at its actual change
frequency, and verify the requested workload. Follow the checkout's
[delivery and rendering gates](../../AGENTS.md).

This Engine entrypoint owns the reusable action rules below. Detailed methods,
counterexamples and dated measurements stay in the linked Harness references;
raw captures stay outside source. Integrate later experience into the applicable
rule here as well as its evidence reference.

## Numeric allocation ownership

Choose storage by the last reader: World frame scratch for synchronous work,
World-owned buffers for persistent system state, existing publication/page/device
owners for suspended or submitted work. Preserve persistent semantic facts.
Measure backing allocations, view/Result objects, copying/zeroing, retained
capacity and metadata separately. Repeated large allocate/release can discard
backing while leaking slot metadata. Fault-inject allocation admission and test
spike/drain/trim before claiming a production pool. See the
[ECS memory contract](../../packages/ecs/README.md#numeric-memory-services).
Guard synchronous lifetime at each actual system invocation; a manual scope
wrapper alone does not prevent a suspended system from escaping reset.
For allocate/fill/copy stages, pass explicit output windows and consume them
before scope close; account for nonzero offsets and initialize reused lanes.
Normalize a finished accumulator in place when no later reader needs its old
values. Scope adapters must return expected domain failures through `Result`
so a retryable validation error does not become a poisoned World. Include
cumulative multi-view/pass demand in arena admission controls. Tiny backing
savings can cost more view/Result objects; retain small factory allocations
when complete-owner measurements do not support migration.
For repeated borrows of one physical allocation, validate once and retain its
current typed window with that allocation. Invalidate after successful resize,
not failed admission, and drop the owner cache on retirement. Keep independent
completion capabilities and detached release callbacks; recycling a public lease
would let an old callback release a newer tenant. Compare overlapping readers,
periodic/dense resize and cold allocate/retire, not just warm acquisition.

## Drive the optimization

1. Freeze source/build and native payload identity, scene, backend, Workers,
   quality and actions. Preserve original failures. A content/profile/ABI change
   needs a fresh baseline. Unexplained rendering follows
   [RHI Debug](../forgeax-engine-rhi-debug/SKILL.md).
2. Attribute the actual expensive population before editing. Separate ordinary
   completion throughput, intrusive profiling and private diagnostic controls.
   Name removable work and a counterexample that could falsify the change.
3. Apply the ownership and hot-path rules below. Measure the complete replacement
   owner, including key construction, validation, allocation, retained storage,
   publication, uploads and retirement where affected.
4. Validate semantic controls, then compare preselected matched windows. Report
   implementation proof, helper results, whole-Worker results and unfinished
   targets separately. Batch verified owner changes before another broad run.

## Choose the producer before adding reuse

| Observed repeated work | Action | Correctness boundary |
| --- | --- | --- |
| A partial query builds a complete publication and discards most fields | Produce the required value directly through shared validation, as with Fog-only selection | Keep validation/getter order, independent last-known-good values and detached old results |
| Fixed parameters are uploaded every frame | Initialize them with each physical resource; update only dynamic fields | Boot, per-view creation and recovery replacements all initialize; preserve error propagation and capture bootstrap |
| Stable view composition or Feature resource names are reconstructed per consumer | Keep source membership, roles and scoped name routes with their existing view/Feature owner; adopt frame leases and resource values separately | Publish actual relationship changes through ordinary ECS versions; hold prior frame results independently and keep raw borrowed declarations live |
| An incremental residual roster is expanded into dense frame arrays | Consume fixed slot membership directly and apply publication/availability changes to its readable subset | Ranked access, removed/reused slots, missing publication, held frames and full fallback after lost journal history |
| Every shadow pass rebuilds fixed physical ABI dependencies before a GPU-cache hit | Publish the fixed binding route from the physical PipelineState producer; observe only its actual growing/replaced slots and reuse the existing cache leaf | Prove fixed-field ownership at construction; include layout, conditional ABI resources and recovery root; borrowed states and copied owners retain ordinary live reads |
| Several consumers reconstruct the same admitted fact | Publish it once from the existing producer or commit | Prove that owner survives the relevant frames and owns every dependency |
| A stable entity/resource relationship is projected again each frame | Keep compact numeric membership and shared immutable values with the existing phase; apply its changed membership | Slot/generation reuse, removal, held old frames, current accepted versions/scopes and live borrowed/custom inputs |
| Temporary numerical storage | Use bounded scratch or explicit acquire/use/finally-release | Reentry needs independent storage; clear references on release and detach escaped results |
| A few closed immutable definitions | Share finite definitions or producer-owned derived values | Keep borrowed mutable/custom inputs live; shallow freeze and readonly types do not prove deep ownership |
| A proposed result cache | Measure actual owner identities, complete logical inputs and reuse distance during stationary and changing work | Admit a singleton or bounded FIFO only for a small stable working set with a cheap complete key and clear lifetime |

Keep unique immutable visibility facts at the extraction producer, then let
Feature frames share that snapshot when no additional reports change its meaning.
Do not rebuild a copy and dedup Set every frame for inactive rows. Borrowed arrays,
getters and custom additions remain live; shallow freeze alone is no ownership
proof. Include producer capture and cold/periodic changes in the complete-owner
comparison, and avoid argument expansion for unbounded entity populations.

Clearing reused small Maps/Sets can cost more CPU than fresh collections while
leaving sampled allocation unchanged. Do not infer backing reuse from wrapper
reuse. Prefer removing a duplicate producer envelope, comparing admitted fields
before materialization, or packing a large synchronous index workspace into one
arena span. Return structured allocation failures through the scope and prove a
warm backing plateau, held output independence and smaller-demand recovery.
Keep preparation/settlement admission closed to callback reentry before reusing
private state; old candidates remain once-only capabilities.

Keep numerical membership with its admitted view when the complete binning inputs
are unchanged; refresh unrelated light payloads independently. Capture numeric
dependencies rather than retaining an old frame bag, validate budgets before hits,
and replace the fact only after successful computation. Preserve old outputs on
change, failure and disposal. Prove the actual pipeline and configuration producer:
a borrowed frozen copy is not the owned default. Compare stable, periodic, dense
and cold work, including output backing separately from sampled JS. A cache can
remove backing churn while adding cold metadata. Inspect disabled profiling too:
per-item callbacks can allocate lexical environments even without an active timer.
Use a direct shared numeric kernel for ordinary execution and preserve the
instrumented path's phase order and exact output.

Carry a fixed value fact from the actual material producer through its existing
resource, then pass that fact to phase-local consumers. A global identity lookup
on every ownership query can slow borrowed inputs; prefer direct owner evidence
at the caller. Keep live readiness, proxy/getter behavior and old accepted
versions independent of the current proof. Include receive/adoption cost, one
material, many materials, continuous changes and borrowed controls; warm short
CPU cases sufficiently and preserve the original caller in the baseline.
Trace the actual receive/schema-rebinding chain: an intermediate copy can lose
a producer proof before its consumer. Preserve fixed value ownership across
metadata-only derivations and exact-snapshot adoption while keeping public aliases
borrowed. Keep the fact with the existing resource authority instead of copying,
freezing or registering every derived snapshot again. Include continuous-rebinding
CPU: extra proof maintenance can cost more despite lower allocation.
A snapshot fact must outlive its latest mutable resource owner. Preserve it in
the existing identity authority, independently of the owner's current version;
qualify multiple holders, rejected candidates, exact-snapshot clones and fresh
copies. Keep borrowed entries cheap instead of adding metadata to every input.

Keep a prepared plan's fixed material/class slot projection with that actual
producer capture. Let its first consumer supply the ordinary index instead of
building another index before consumption; keep current accepted values and World
scopes in each recording. Borrowed arrays and mixed CPU/GPU demand retain their
ordinary live merge. Measure stable, periodically replaced and continuously
replaced plans: a retained index can save steady work while adding cold cost.

Separate cold Scene identity/content columns from pose/version columns so a pose
edit does not copy static relations. Protect matrix windows returned even before
a pending page is captured; a later write or slot reuse cannot overwrite an old
observation. Include real copied bytes, old-root/old-window controls and complete
owner CPU in the comparison. A numeric copy reduction alone does not prove that
the complete renderer scales independently of its retained row population.

Keep retained source identity separate from requested raster work. An empty GPU
eligibility list does not itself imply CPU fallback: hidden and zero-instance
sources need neither lane. Fix the membership producer and use the same demand
predicate for receipts, diagnostic summaries and presentation. Keep real visible
resource failures observable. Qualify hide/show, zero/nonzero transitions, held
old rosters and actual Renderer N/K controls; a counter-only fix cannot remove
unnecessary traversal.
Profile diagnostic consumers as well as rendering. A warning that never fires
can repeatedly scan every inactive row. Keep ordered demand membership with the
captured source root and consume it directly; do not infer demand through custom
projections. Bail out disabled diagnostics before reading rows, after cheaper
light/latch guards. Include lit, dense-change, cold and borrowed controls so
producer maintenance and small-path regressions stay visible. Full exports of N
records still cost O(N); report them separately from ordinary draw work.
Resolve bounded diagnostic identities through the producer's captured immutable
index when it already supplies that fact; do not eagerly scan N rows for a
64-sample quota that may never fill. Preserve held roots and address generations.
A borrowed array can change without changing identity, and a custom projection
can change membership facts. Count and sample their current rows in one coherent
observation instead of adding a second correctness scan. Compare the complete
producer/record/query path, including sparse late candidates, actual pose edits,
explicit queries and custom inputs; keep GPU and whole-game qualification separate.
Forward diagnostic field selection to the owner before producing large
inventories, rather than only selecting before cloning or serialization. Scalar
status/capability reads must not build per-entity material, instance or LOD
exports. Omitted selection keeps the full detached result; qualify empty and
explicit full selections, old observations and cross-Worker cloning. Keep
diagnostic retention/export side effects independent of output selection.

A small matrix window can retain a complete old numeric page. Repeated lane edits
can leave the current row cache holding many old page buffers even after external
readers close. Measure unique reachable backing through actual current outputs,
including cold, rotating edits, held roots and drain. Split independently changing
numeric storage into smaller immutable chunks when that reduces copying and
retention; count extra chunk/view metadata, dense-write CPU and JS allocations too.
Clear removed observations from the current copied page while preserving old
roots. Chunking reduces the retained unit; it does not establish explicit page
leases or authorize recycling storage still visible to automatic readers.

Treat bulk disposal separately from per-row removal. Clearing one authority can
leave derived hierarchy maps, numerical bounds columns, staging arrays and journal
capacity retained by the still reachable owner. Drive the actual bounds/cache
consumers before spike/dispose tests. Return discarded history to cold capacity,
keep cursor positions monotonic so old evidence cannot become current again, and
verify old captured values independently of lazy wrapper identity after disposal.
Count remaining cold owner storage; an empty row root does not prove zero backing.
Inspect strong heap paths when retired Worlds survive a completed lifecycle.
Closures created in one function can share a lexical environment: a returned
callback may retain `previous` even when only a sibling cache predicate reads it.
Create escaping products in a separate scope with their actual admitted data;
keep old held products valid and prove replaced unheld products collect. Exclude
WeakMap ephemeron-value edges from a purported strong retaining path, and repeat
with data-only observation copies before attributing retention to the owner.

Keep full byte/DataView windows with a persistent numeric table's actual physical
backing; use offsets for row writes, clearing and queue uploads. Refresh views only
when that backing changes and verify nonzero source offsets through real payload
assertions. CPU table retirement follows the last synchronous reader, independently
of held GPU versions. Reject update/commit reentry, defer CPU release through an
active queue call, and fault-inject disposal at create/upload/retire boundaries
before adopting growth. Include held versions and repeated grow/dispose cycles.

Read only the allocation columns a hot consumer needs instead of materializing a
complete row view. Keep full detached views for real whole-row observations.
Traverse existing publication groups in their original order instead of copying
their full population into an intermediate array; build membership indexes directly
without mapped temporary key arrays. Qualify sparse pose, content, instance-only
and dense-change paths, including zero addresses and independently held versions.

Measure retained products through their next consumer, including serialization.
Fewer object allocations can still make a native graph-key path much slower when
the produced object representation changes. Keep borrowed getter/toJSON semantics
live and retain cold and changing controls. A plain-object sensitivity probe does
not justify shipping a shared mutable product or a custom serializer; withdraw a
cache whose complete-path CPU cost outweighs the allocation saving.

Share fixed stage facts and synchronous finalizer functions at their installation
owner. Pass the exact preparation and accepted work into the runner instead of
capturing them in new callbacks or retargeting a shared frame context. Reordering
must replace event facts without changing held frames. Keep producer contexts and
native-plan capabilities fresh; test throwing submit/abort/source callbacks,
sibling cleanup, retry and queue-fenced retirement. Compare accepted, aborted and
changing complete-owner paths before claiming a normal-frame CPU gain.

A small record pool can reduce bytes while increasing CPU through lookup and
field clearing. For graph callbacks that only consume the resolved encoder,
frame and resource resolver, use `encodeDirect` to remove the argument record.
Keep the context form for callbacks that need that record, preserve bound
receivers, and measure the complete graph owner with ordinary CPU separate from
allocation sampling. No helper result establishes a whole-Worker improvement.

For derived World facts, record dependencies from the actual read queries and
reuse StateProjection for candidate membership, additions, removals and generation
replacement. Optional absence and required pose joins are inputs too. Keep
resource values, time dependence, asset admission and routed failures explicit;
restore observation scopes after nested or failed extraction. Arbitrary extractors
retain conservative behavior until their complete read route is owned. Numeric
publication ranges can feed canonical rows within admission without per-row
matrix copies; return detached deltas rather than borrowed packet windows.

Compare incoming numerical columns with canonical values before hydrating row
observations or staging per-identity work. A previously staged operation owns its
current value: do not compare a later span only with the old columns. Read a
borrowed source window once, leave missing-row windows unread, and preserve source
offsets, parity, strict numeric equality, duplicate edits and removal/recreation.
For large validated transform-only admission, stage numeric source coordinates in
arena chunks and share the owner's existing commit-local slot index instead of
creating full per-row pending records or another N-sized index. Admit all chunks
before canonical writes, clear touched indices on denial, and keep sticky parity
through duplicate/reverting edits. Keep borrowed getters on their ordinary route.
Measure small selected inputs too: scope, view and Result overhead can outweigh
the removed records, so retain tiny ordinary staging when evidence supports it.

Measure complete admission with full unchanged/partly changed input and selected/
fully changing controls. Work on an incoming N-row payload still scales with that
payload; this does not prove N-independent maintenance or whole-game savings.

A hot call count does not imply a large working set; a long-lived object does
not imply stable values. Avoid one cache per entity/material, pose-history FIFOs,
output signatures that cost as much as the avoided work, and new age/version/
dependency scanners added solely to reduce allocation. Keep existing GPU caches,
resource leases, intrinsic invalidation and recovery with their current owners.
Do not attach metadata to foreign or frozen inputs.

## Select the numeric hot path

Use the implemented [ECS contract](../../packages/ecs/README.md#physical-numeric-batches)
and [Math contract](../../packages/math/README.md); retain queries at their actual
World/system lifetime, with reentry and replacement handled by that owner.

| Work | Prefer | Preserve |
| --- | --- | --- |
| Read-only, non-temporal numeric selection, including sparse/optional data | Prepared `query.batches()` and columns resolved once per batch | Real ranges use physical `[start, end)`; indexed selections use `rows[0..count)`; test optional absence at the batch boundary |
| Dense required-component numeric writes | Existing spans/shared numeric kernels | Declared writes, version publication, structural fences and shared-kernel eligibility |
| Tiny selection or known entity | Existing numeric `worldRead` probes | Optional membership, numeric representation and bounds; fragmented one-row tables may favor probes over batches |
| Incremental derived output | Existing changed Query/StateProjection | Reconcile complete dependencies, membership, removals and recovery; changed rows alone cannot replace a full aggregate |
| Managed strings or coherent public declarations | Existing semantic snapshot path | String decoding and detached value semantics |

Batches reject write, changed and added descriptors; use their existing write/
temporal paths. Keep entity windows, column lookup and field positioning
outside inner loops.
For repeated span preparation, retain the latest complete physical column window
at the column owner, including its actual backing, range and managed field type.
Keep shape records fresh where callers can replace fields; retain frozen managed
readers with their original bound storage, own enumeration and detached-call
behavior. Partial changed-row windows must not evict the complete-table route.
Replacement/growth must drop the old route instead of retargeting held readers.
Measure the full query traversal and numerical work, not a cached getter alone.

Do not gather sparse rows into copied dense columns or add a row-wrapper class.
Do not expand optional fields into every component combination. Borrow columns
only through the valid batch/span lifetime. Structural callbacks and suspended
iteration retain their original checks and temporal cursor semantics.

Require output storage for output-writing Math APIs. Returning that same output,
or an independent boolean/status, is supported; factories remain explicit
allocation sites. Preserve precision, aliasing and result lifetime; measure
internal temporaries too. `?? 0` does not allocate;
use direct indexed values after proving bounds, and retain meaningful absence
handling. Do not trade clarity for many callbacks to eliminate a small fixed
traversal cost without a complete-owner CPU/allocation win.

Engine implementation uses the fast paths enforced by
`pnpm check:ecs-iteration`, `pnpm check:required-output` and
`pnpm check:foundation-allocations`; apps/templates retain their gameplay APIs.
These finite gates do not prove every caller is optimal or zero-allocation.

## Remove CPU preparation and collection work

| Owner or population | Apply this rule | Counterexample/control |
| --- | --- | --- |
| Exact nearest-geometry queries | Visit nearer conservative bounds first and tighten the existing exact minimum before farther siblings | Exhaustive distances from both ends and on the surface, bounded actual triangle reads, identical complete motion reports and whole-owner cold/query CPU |
| Native-only material test production | Use the existing backend target, file-owned bounded cooker and package-local program codec; retain validated byte views until real wire encoding | Portable producer parity, complete consumed artifacts, fresh Registry/device state, current and held material values, native pixels and complete ordinary-owner timing |
| Composite/string keys | Reuse existing numeric slots or producer identity before inventing another registry | Slot reuse/generation, realm transfer, collision equality and full key construction cost |
| Packed numeric/spatial keys | Validate integer ranges and exact decoding; preserve the original quantization | Safe-integer overflow, 32-bit coercion, negative/fractional coordinates and traversal order |
| Tiny/sparse lookup fanout | Use existing inline-first or singleton representations only where their limited API fits | Stored undefined, SameValueZero, insertion order, iteration-time changes and actual overflow fanout |
| Duplicate membership collections | Remove the second index only when an existing owner already proves uniqueness | Every insertion, lookup, flush and reacquisition; aliases/barriers keep command order |
| Per-instance methods/accessors and temporary result arrays | Share functions/accessor descriptors or consume ordered facts directly when the contract permits | Callback receiver, lazy/own/enumerable getter behavior, ordering, throws, fact count and Object.is distinctions |
| Lazy collections consumed more than once | Keep numeric membership with its existing owner and traverse through explicit bounded cursors; remove nested generator result allocation | Fixed membership, independent walks, early return, held row values and ordinary public iterator result lifetime; measure the complete traversal |
| Frame/record construction | Keep mutable internal records at their actual owner lifetime and publish detached immutable results; qualify the final object shape | Held snapshots, asynchronous completion facts, physical replacement, callback reentry and symbol/optional fields; sharing accessors must preserve enumeration and laziness |
| Systems with no deferred structural work | Declare `commands: 'none'` at registration so the scheduler omits the transaction | Default command buffers keep fresh invocation identity; denial, replacement, reentry, predecessor flush and poisoning remain correct |
| Per-frame cache-domain rotation | Retain hot weak entries at their Mesh/resource owner and rebuild against actual distinct reads | Cold, sparse, unread and replaced domains retire; include retained capacity and lookup CPU |
| Reusable private ledgers | Reuse pending/accepted cells with bounded numeric generations; detach callbacks from mutable work domains | Commit, rejection, clear and held callbacks preserve exact facts without retaining retired resources |
| Transaction rollback | Journal this transaction's fresh additions when that is the existing invariant | Retain snapshots for arbitrary replacement/removal; abort/retry and completion leases still protect accepted resources |
| Context service lookup inside simulation | Resolve the injected service at plugin activation and retain it for that Fiber lifetime | Unload/reinstall and dependency invalidation; no global service cache |
| A collection whose count changes every frame (spawned/retired members) reallocates GPU Scene rows, direct instance buffers, bind groups or bounds hierarchies | Reserve through the shared `dynamicCapacity`/`shouldShrinkCapacity` policy at each owner; a count change inside the reservation resizes in place, keeps addresses, buffers and bind groups, and clears only the released tail | First publication stays exact; growth past the reservation and large shrinks still reallocate; retained rows keep their temporal history and diff-only uploads; the uniform fallback keeps its fixed array |
| A full re-derive walks the same rows in separate validate, copy and reduce passes | Fuse the passes per leaf node and use branch-free `Math.min`/`Math.max` folds; build identity columns with a loop and memoize their uniqueness proof | Measure on scattered real data: a compare-and-store branch mispredicts there and loses to the shared fold; keep invalid-row and NaN rejection |

A cache hit can still allocate its optional-input or diagnostic collections.
Read the same live flags in their original order, then build names/descriptors
only in the miss or failure branch that consumes them. Keep finite numeric slots
already owned by the cache. Include shared hits, ordinary hits, periodic recovery
and cold descriptor production; a function-level heap attribution alone does not
prove its final resource cache is missing.

A small fixed restriction must not enumerate a much larger member universe.
Retain source-derived membership bounds with the immutable query and traverse the
smaller valid domain; nested restrictions can pass their bound without computing
an eager intersection. Preserve sorted order and member multiplicity, deduplicate
restriction keys where membership is boolean, and cache exact counts only with
that fixed owner. Prove attempted membership checks follow K, test both operand
orders, and separate required output/tree lookups from whole-population maintenance.

Adopt borrowed key cursors only for intrinsic fixed numerical roots. Preserve the
ordinary result lifetime of public Set iterators and keep arbitrary input iterables
on their live path. Each walk owns independent traversal state; break/throw closes
inner cursors. Empty borrowed walks can share immutable termination. Fuse nested
cursor bookkeeping before adding a pool and measure the complete sparse consumer.

Clearing an array's length can discard its backing even when the wrapper is
retained. At a quiet immutable output owner, retain a second ledger's capacity only
when both ledgers reference the exact detached entries already held by the current
root. Clear candidate/retired entries on change, failure, shrink and disposal. Do
not retain borrowed source rows to save capacity. Compare the full output walk and
address consumer with sparse/dense changes, duplicate/reorder controls and repeated
spike/drain; removing quiet writes through an extra per-entry branch can slow the
changing path more than retaining a bounded second ledger.

Index invalidation by the complete consumer dependency domain. A binding's
coverage may follow a peer execution with the same material/group, World, Mesh
and draw; checking only the exact binding misses changes, while rechecking every
batch scales with unrelated work. Maintain the adjacency with existing source
batch diffs and prune retired routes. A fixed source roster does not prove its
consumer selection's routes are immutable: admit that evidence separately at
the actual producer, and keep complete re-judgment for borrowed selections.
Count attempted checks as well as changed outputs: a zero-write result can still hide a complete scan.

A copy-on-write page pool can duplicate backing when automatic immutable row
observations must detach their numeric values before reuse. Account for those
escaped values and explicit root-edge bookkeeping in the complete replacement
owner. Passing last-reader tests is necessary but does not establish a memory or
CPU win. Migrate internal consumers to scoped numeric rows/deltas before enabling
physical page reuse; preserve automatic public observations separately. Reject
an otherwise-correct pool when total backing or CPU grows.

When reconciling persistent membership, submit only actual membership flips. A
row publication that changes pose or contents can leave membership unchanged;
filter those no-op writes before copying bitmap pages or building an edit batch.
Keep real entry/removal, availability recovery and held-frame controls.

Array `push` may reuse capacity; `splice` produces a result array. Reusing a
Map/Set wrapper does not prove clear/refill reuses its backing storage. Inspect
and measure actual operations rather than banning syntax by name.

Publish the final accepted projection directly when an intermediate roster adds
no independent semantics. Keep per-view visibility/culling separate from shared
preparation, and preserve the accepted-work selection across producer callbacks.
For VFX, share immutable code/layout while each Player retains independent
buffers, seed, ticks and feedback. Retained effects must keep their own complete
material/mesh/texture closure through replacement, abort, ACK and retirement.

Ordered compute dispatches may share one physical pass when the producer owns
predicate semantics and no required copy, timing or resource boundary intervenes.
Declare the full resource union and keep each kernel's pipeline/bindings explicit.
Retain separate passes for custom predicates unless explicitly admitted. Verify
indirect readback, Skin overflow ordering, real pixels and GPU timestamps; fewer
pass API calls alone do not establish less shader work or lower frame time. Physical
pass changes also change per-pass query instrumentation. Compare an equal-write,
same-scope control before attributing GPU timing changes; keep every cold/steady
window and unresolved asynchronous readback visible.

## Reduce GPU work through its existing contract

| Work | Move/remove at this boundary | Verify |
| --- | --- | --- |
| Material-constant math such as UV coefficients | Existing cook/upload-derived ABI | f32 rounding, schema offsets and direct/Scene/rigid/skinned shader agreement; fragment-dependent math stays in the shader |
| Static feature choice and unused resources | Compiler active graph/static switches | Program, macros, parameter layout, bindings and startup sources agree; animated values remain data updates |
| Counter-only telemetry copies full member/indirect capacity | Size the persistent producer's storage, graph imports and copies from its declared demand | Keep default detailed readback, original-frame fences, pending-map skips and replacement cleanup |
| Loading-only program/source ownership | Existing successful preparation/admission transition | Fresh source invalidates correctly; cold first-use cost, failure and recovery remain observable |
| Local smoke or sparse screen contribution | Existing view/composite footprint | Jitter, upsampling, filter/AA support, borders and temporal history; compare pixels and actual raster work |
| Scene batching or exact vertex welding | Authoring/publication owner | Count CPU rows, retained geometry, topology candidates and executed draws separately; weld complete attributes while preserving primitive/material/corner order |
| Shadow preparation/retention | Existing scene, view and physical-resource owners | Caster content at unchanged bounds, light/material changes, per-view frusta, receiver/filter/bias guard bands and new graph/device resources |
| Repeated GPU test startup | Reuse initialized renderer/device preparation across fresh World and asset owners | Actual native request budgets, lease/target cleanup, separate constrained/publication/cold-temporal hosts, fresh replay falsifiers and unchanged frames/pixels; see [CI workload budgets](../../scripts/ci/README.md#native-fixture-workload-budgets) |
| Repeated test readback allocation and per-texel assertion calls | Reuse unmapped staging storage at the harness lifetime; aggregate exact predicate failures | Preserve every readback, frame and pixel predicate, copy owned bytes before unmapping, replace storage on extent/device changes, and reject restored allocations or corrupted finite/coverage samples |
| GPU test replay prefixes | Project existing FrameModel metadata and batch actual selected-work reads | Exact pixel/parameter/depth bytes and provenance, original frame windows, independent falsifier devices and actual native submission budgets |
| GPU snapshot and reference assertions | Compare complete payloads through the shared byte helper; use explicit identity oracles for references | Preserve all bytes, metadata, provenance and negative controls; qualify the real matcher work guard and full native gate through [CI payload work](../../scripts/ci/README.md#native-payload-and-startup-work) |
| Material program wire keys | Encode the complete canonical artifact byte view alongside unchanged JSON metadata | Real enumeration and serializer work gates, differing bytes under identical claims, subviews, metadata collisions and real source/decode/adoption; see [Pack transport](../../packages/pack/README.md#shared-material-program-transport) |
| Material fixture cooking | Declare storage WebGPU or storage WebGPU with rays only for fixtures with that actual backend contract | Full selected-program byte/selection parity, both eligible ray/Card contexts, distinct producer identities, actual output-context guards and unchanged portable/constrained/fallback owners; normalize numeric views once after publication digests and wire encoding |
| Gzip capture transport | Use the package-owned native codec in Node and portable codec in browsers/Workers | Preserve complete payload bytes, stored-payload digests, corruption failures and real replay; qualify conditional packaging and the actual Node codec-call budget before complete timing |

Fewer shader operations or taps are hypotheses until the actual backend shows
both acceptable pixels and lower GPU cost. Resolution, cascade count, distance,
filters and quality changes start a different comparison profile.

Fresh Skin wrappers and recycled pages do not establish unchanged pose content.
Preserve the current conservative Skin-task demand path. A logical retained
result cannot initialize a replacement physical GPU resource.

## Preserve scheduling, physics and delayed work

| Symptom | Next action | Invariant |
| --- | --- | --- |
| Long completed-picture interval | Join exact World/device/frame tasks, submissions, completions and valid thread clocks | Task wall, thread CPU, notification delay and GPU duration are distinct; preserve unknown gaps and right-censored tails |
| Render backpressure and catch-up bursts | Reduce work holding existing publication credit | Admission precedes input/World mutation; keep each admitted update's ordered effects, fixed delta and dropped-time policy |
| Native CPU/allocation grows during GPU completion | Split actual thread CPU at draw/completion and separately census provider event pumping | Keep operations/pixels and raw regressions; diagnostic scheduler overrides do not become production or browser gains |
| Native physics pressure | Restore the same snapshot; compare actual phases, shapes, compound leaves, active contacts and steps | Native-only replay excludes controllers/publication; compare poses, velocities, sleep and events; contact suppression changes behavior |
| Default callback/event overhead | Keep filtering native when no JS hook is needed; decode only required contacts | Custom callbacks, sensors, collision response and unmanaged/unknown pair handling remain correct |
| Destruction slows after input stops | Keep one World through warmup, real sustained impacts and the stopped-input tail; trace support, fracture, admission and publication queues | Track oldest age and produced/completed work at every queue; a bounded queue or completed counter alone does not prove convergence |

Keep broad terrain/fragment wake bounds and visual-only changes distinct at their
actual producer. Avoid whole-queue copying before a budgeted traversal's first
yield. Disabling collision, damage, effects, shadows or publication is a
sensitivity control, not an equivalent-work optimization.

## Qualify allocation and performance evidence

| Evidence | Required accounting |
| --- | --- |
| Allocation churn versus retained storage | Measure rate, promotion, after-GC floor and peak separately; their product is not a GC equation. Include TypedArray backing stores, retained pool capacity and duplicate object graphs |
| A scaling gain with a small current-scene effect | Report both populations and the marginal benefit from the new retained baseline; accept an explicit storage/update tradeoff for the selected objective without claiming CPU, GC or FPS improvement |
| Source attribution | Authenticate actual loaded JS and both map levels; count direct/ancestor/unresolved bytes once. An ancestor is not the exact allocation expression |
| JIT-sensitive allocation probe | Warm the real target, include collected objects and an escaping positive control; name the target URL/function when a marker can inline away; retain orphan bytes as unknown |
| Small effects/noisy runs | Preselect windows and order, retain all repetitions and work counts; a minimum or a local variability cutoff cannot redefine the requested budget |
| CPU and GPU clocks | Thread CPU differs from wall time; GPU interval sums, unions and envelopes differ from each other and from completed presentation |
| Ready/complete/capture state | Validate the actual readiness owner and receipt/fence; a successful draw call or queue wait alone does not establish a ready picture |
| Frozen source/native inputs | Verify the full payload identity even for a README-only input change; identical JS wrappers do not prove identical WASM/native bytes |
| Backend commands and bundle replay | Count virtual preparation/matching separately from native execution; one bundle call can follow many source command checks |
| CI placement costs | Use complete file/owner timings, including skipped-file process overhead; interrupted work supplies no completion sample. Preserve the full roster, assertions and deadlines; a scheduling estimate requires complete final-head CI acceptance |
| Selected coverage evidence | Apply the actual project wrapper's exclusions and type mode before deriving membership; verify the intended cases in the result JSON before claiming qualification |
| Sampled test attribution | Check actual operation and phase durations before choosing an owner; keep intrusive probes separate from complete ordinary windows and compare full outputs after conservative predicate rejection |
| Private instrumentation or CPU stub | Separate diagnosis from ordinary acceptance; Node/Null/stub results do not establish browser/native GPU timing or FPS |
| Vsync-capped FPS | A capped mean near the display rate hides headroom; also report main-thread busy ms/frame from a CPU profile (non-idle samples over frames) and an uncapped heavier workload measured identically on both builds |
| Shared or loaded host | Record load before and after each run, gate starts on a load ceiling and interleave before/after builds; a run that the host stalled is noise for both builds, not a regression or a gain |
| Node microbenchmarks of a hot loop | Use the real data distribution (scattered transforms, real counts); a uniform synthetic input can reverse a branch-versus-fold decision. Confirm every kept change in the real game profile |

A queue fake retaining synchronous upload input must copy its exact byte window
before scratch reuse. Keep byte assertions and separately verify real GPU
readback. When moving uploads to creation, validate capture bootstrap and fresh
replay as well as live pixels. Removing allocation from one owner does not prove
lower whole-Worker allocation, a smaller retained heap, or a solved runtime target.

## Select detailed methods and evidence

| Need | Reference |
| --- | --- |
| Baseline admission, clocks, cold input identity and batch comparison | Measurement |
| Completed gaps, native task joins and publication backpressure | Slow frames |
| Keys, fanout, rollback, VFX and producer/publication boundaries | CPU preparation |
| Heap attribution, scratch, ECS, outputs and ownership counterexamples | GC |
| Static contracts, uniform-derived math and cold resource ownership | Materials and shaders |
| Coverage, filtering and retained shadow correctness | Shadows |
| Native phases, contact complexity and replay | Physics |
| Support/publication queues and stopped-input tails | Destruction |
| Few stable logical values and finite immutable producer definitions | Working-set case |
| Direct Fog production, resource-owned shadow initialization and measurement limits | Fog/shadow case |
| Allocation ownership and lifecycle controls | game-3d allocation case |
| Cache regressions, cold ownership and Native completion attribution | Regression repair case |
| Capture adapters and analytical tools | Toolbox |

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

Keep reusable decisions in this Engine entrypoint; add detailed method and
counterexample evidence to the existing topic, and dated results to one scoped
case using Contributing. Remove superseded guidance. Preserve raw failures privately and retain useful
counterexamples; do not promote one run's numbers, host paths, quality settings
or an unimplemented prototype into a universal rule.

When animation times are externally sampled, zero playback speed does not permit
skipping pose evaluation. Retain events, normalization and target updates while
avoiding unchanged clock writes; verify paused, wrapping and externally edited
targets through the same animation owner.

For fixed-input material builds, capture WGSL records and their complete path
namespace through the existing Pack source fence, then pass an explicit
`captureMaterialSourceSnapshot` result to the material cooker. Never apply this
lifetime to live/default callers. Transport DDC admission requires the product
cache's producer checks and an explicit pure, sink-free policy identity; cached
dependency topology may order work but cannot admit or skip publication.
