---
name: forgeax-engine-performance
description: >-
  Evidence-driven ForgeaX CPU and GPU optimization. Use when diagnosing slow
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
| Several consumers reconstruct the same admitted fact | Publish it once from the existing producer or commit | Prove that owner survives the relevant frames and owns every dependency |
| Temporary numerical storage | Use bounded scratch or explicit acquire/use/finally-release | Reentry needs independent storage; clear references on release and detach escaped results |
| A few closed immutable definitions | Share finite definitions or producer-owned derived values | Keep borrowed mutable/custom inputs live; shallow freeze and readonly types do not prove deep ownership |
| A proposed result cache | Measure actual owner identities, complete logical inputs and reuse distance during stationary and changing work | Admit a singleton or bounded FIFO only for a small stable working set with a cheap complete key and clear lifetime |

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
| Composite/string keys | Reuse existing numeric slots or producer identity before inventing another registry | Slot reuse/generation, realm transfer, collision equality and full key construction cost |
| Packed numeric/spatial keys | Validate integer ranges and exact decoding; preserve the original quantization | Safe-integer overflow, 32-bit coercion, negative/fractional coordinates and traversal order |
| Tiny/sparse lookup fanout | Use existing inline-first or singleton representations only where their limited API fits | Stored undefined, SameValueZero, insertion order, iteration-time changes and actual overflow fanout |
| Duplicate membership collections | Remove the second index only when an existing owner already proves uniqueness | Every insertion, lookup, flush and reacquisition; aliases/barriers keep command order |
| Per-instance method closures and temporary result arrays | Use shared methods or consume ordered facts directly when the contract permits | Callback receiver/detached-method behavior, getter order, throws, fact count and Object.is distinctions |
| Frame/record construction | Reduce intermediate copies and qualify actual object shape after later mutations | Public snapshots, symbol fields, optional presence and callback reentry; spread/rest/property-order results are runtime-specific |
| Transaction rollback | Journal this transaction's fresh additions when that is the existing invariant | Retain snapshots for arbitrary replacement/removal; abort/retry and completion leases still protect accepted resources |
| Context service lookup inside simulation | Resolve the injected service at plugin activation and retain it for that Fiber lifetime | Unload/reinstall and dependency invalidation; no global service cache |

Array `push` may reuse capacity; `splice` produces a result array. Reusing a
Map/Set wrapper does not prove clear/refill reuses its backing storage. Inspect
and measure actual operations rather than banning syntax by name.

Publish the final accepted projection directly when an intermediate roster adds
no independent semantics. Keep per-view visibility/culling separate from shared
preparation, and preserve the accepted-work selection across producer callbacks.
For VFX, share immutable code/layout while each Player retains independent
buffers, seed, ticks and feedback. Retained effects must keep their own complete
material/mesh/texture closure through replacement, abort, ACK and retirement.

## Reduce GPU work through its existing contract

| Work | Move/remove at this boundary | Verify |
| --- | --- | --- |
| Material-constant math such as UV coefficients | Existing cook/upload-derived ABI | f32 rounding, schema offsets and direct/Scene/rigid/skinned shader agreement; fragment-dependent math stays in the shader |
| Static feature choice and unused resources | Compiler active graph/static switches | Program, macros, parameter layout, bindings and startup sources agree; animated values remain data updates |
| Loading-only program/source ownership | Existing successful preparation/admission transition | Fresh source invalidates correctly; cold first-use cost, failure and recovery remain observable |
| Local smoke or sparse screen contribution | Existing view/composite footprint | Jitter, upsampling, filter/AA support, borders and temporal history; compare pixels and actual raster work |
| Scene batching or exact vertex welding | Authoring/publication owner | Count CPU rows, retained geometry, topology candidates and executed draws separately; weld complete attributes while preserving primitive/material/corner order |
| Shadow preparation/retention | Existing scene, view and physical-resource owners | Caster content at unchanged bounds, light/material changes, per-view frusta, receiver/filter/bias guard bands and new graph/device resources |
| Repeated GPU test startup | Reuse initialized renderer/device preparation across fresh World and asset owners | Actual native request budgets, lease/target cleanup, separate constrained/publication/cold-temporal hosts, fresh replay falsifiers and unchanged frames/pixels; see [CI workload budgets](../../scripts/ci/README.md#native-fixture-workload-budgets) |
| Repeated test readback allocation and per-texel assertion calls | Reuse unmapped staging storage at the harness lifetime; aggregate exact predicate failures | Preserve every readback, frame and pixel predicate, copy owned bytes before unmapping, replace storage on extent/device changes, and reject restored allocations or corrupted finite/coverage samples |
| GPU test replay prefixes | Project existing FrameModel metadata and batch actual selected-work reads | Exact pixel/parameter/depth bytes and provenance, original frame windows, independent falsifier devices and actual native submission budgets |

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
| Source attribution | Authenticate actual loaded JS and both map levels; count direct/ancestor/unresolved bytes once. An ancestor is not the exact allocation expression |
| JIT-sensitive allocation probe | Warm the real target, include collected objects and an escaping positive control; name the target URL/function when a marker can inline away; retain orphan bytes as unknown |
| Small effects/noisy runs | Preselect windows and order, retain all repetitions and work counts; a minimum or a local variability cutoff cannot redefine the requested budget |
| CPU and GPU clocks | Thread CPU differs from wall time; GPU interval sums, unions and envelopes differ from each other and from completed presentation |
| Ready/complete/capture state | Validate the actual readiness owner and receipt/fence; a successful draw call or queue wait alone does not establish a ready picture |
| Frozen source/native inputs | Verify the full payload identity even for a README-only input change; identical JS wrappers do not prove identical WASM/native bytes |
| CI placement costs | Use complete file/owner timings, including skipped-file process overhead; interrupted work supplies no completion sample. Preserve the full roster, assertions and deadlines; a scheduling estimate requires complete final-head CI acceptance |
| Private instrumentation or CPU stub | Separate diagnosis from ordinary acceptance; Node/Null/stub results do not establish browser/native GPU timing or FPS |

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
