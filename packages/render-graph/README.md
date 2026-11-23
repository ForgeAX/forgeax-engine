# @forgeax/engine-render-graph

> RHI-pure frame-graph kernel with typed resources, explicit accesses, graph-owned raster/compute/copy encoding, and immutable compiled graphs.

## Proposition

A graph author declares four facts once:

1. whether a resource is graph-created or imported;
2. which texture subresource or buffer a pass accesses;
3. the exact access mode;
4. the pass kind and declaration order.

Stock pipelines use `RenderGraphBuilder.procedure(options)`. Appending a pass emits its ordered resource operands. `bindResources()` checks inherited texture contents, finalizes attachment stores and resolves, and binds the physical resources. Authored pipelines can supply all declarations before analysis through `compile(options)` or the procedure's `'deferred'` mode. Both modes execute in declaration order and expose RAW/WAR/WAW dependencies through inspection.

```mermaid
flowchart LR
  OWNER["Pipeline or feature owner"] --> BUILDER["Declare passes"]
  BUILDER -->|stock| ORDERED["Emit ordered operands"]
  BUILDER -->|authored| DEFERRED["Analyze declarations"]
  ORDERED --> GRAPH["Bind physical resources"]
  DEFERRED --> GRAPH
  GRAPH --> EXEC["execute frames"]
  GRAPH --> INSPECT["inspect"]
  GRAPH --> RETIRE["fence-aware retire"]
  EXEC --> RHI["@forgeax/engine-rhi"]
```

> [!IMPORTANT]
> Declaration order is the observable v1 execution order. An imported resource may be read first; a graph-created resource must be initialized before its first read.

Each compiled graph retains its fixed resource order while imported resolvers
observe the current frame on every execution. Recursive execution of that same
graph is rejected before resource resolution, including calls from an imported
resolver. A failed resolution releases admission so the next frame can retry.

A replacement borrows compatible textures from their named physical owners on the same device. Logical views of the same physical texture and subresource descriptor share a native view, including pass-local aliases. The replacement retains only its active bindings. Retirement revokes lending immediately. Native texture destruction waits for the queue fence and the last lease.

## Native resource preparation

`compiled.prepareResources(current)` runs only explicitly declared native Pass
recipes and `NativeTextureImport` producers. It never receives an execution frame,
resolves ordinary imports, records commands or submits a warm draw. Each resume
releases graph admission before yielding; return, throw and reentrant cancellation
close the original recipe and its currency predicate. Recipes keep native work
bounded and retain their own real completion and retirement responsibility.

An import may explicitly supply its original owner's `prepare` generator and a
pure `current` texture lookup. Graph-owned views of that import are prepared in
the same physical-texture/descriptor cache ordinary execution uses. Ordinary
execution still resolves the real import; a different texture cannot consume the
old prepared view. Unknown dynamic imports retain their ordinary execution path.
`preparedResourcesCurrent()` checks only this declared preparation coverage; it
is not whole-Renderer, Level or gameplay readiness.

## Primary API

```ts
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { Buffer, RhiCommandEncoder } from '@forgeax/engine-rhi';

interface Frame {
  readonly encoder: RhiCommandEncoder;
  readonly particles: Buffer;
}

const builder = new RenderGraphBuilder<Frame>();
const particles = builder
  .importBuffer(
    'particles',
    { size: 64 * 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX },
    (frame) => frame.particles,
  )
  .unwrap();

builder
  .addComputePass('simulate', {
    accesses: [{ resource: particles, usage: 'storage-read-write' }],
    encode: ({ pass }) => {
      pass.setPipeline(simulatePipeline);
      pass.setBindGroup(0, simulateBindings);
      pass.dispatchWorkgroups(256);
    },
  })
  .unwrap();

const compiled = builder
  .compile({ device, surfaceSize: { width: 1280, height: 720 } })
  .unwrap();

compiled.execute({ encoder, particles }).unwrap();
console.log(compiled.inspect());
await compiled.retire();
```

Color attachment `loadOp` may be a constant or a function of the execution frame.
The compiled pass resolves it on every execution, including reused descriptors.
A dynamic operation conservatively counts as read/write during compilation, so a
graph-created attachment still needs initialization before a possible load.
This lets presentation select clear/load from actual scene output without
recompiling the graph or replacing its physical output.

### Color resolve placement

Compilation removes a private color resolve only when the same view is resolved
again unconditionally before any other access to its allocation. Intermediate
readers, aliased views, conditional writers, subgraphs and imported publication
targets retain their boundaries. Declaration validation runs first; callbacks keep
their declared resource visibility, and committed texture contents track only
retained native writes. Resource allocation and lifetime bounds remain conservative.

Color attachments may select `storeOp: 'auto'` to permit releasing dead resolved
MSAA samples. Compilation keeps `store` unless the source is graph-created and
transient, starts with an unconditional clear of the same view, and ends with an
unconditional resolve without a later source access or subgraph boundary. Aliases,
persistent/imported sources and explicit diagnostic usage retain storage. Explicit
`store` and `discard` keep their authored meanings. The RHI receives only native
store operations; committed-content facts invalidate discarded sample ranges while
the resolved image remains stored. This does not remove the MSAA allocation.

### Native raster batches

Compilation joins consecutive, unconditional raster stages with matching attachment
views and compatible loads/stores. Intermediate resolves, clears, query sets,
writable storage, subgraphs, copies and conflicting sampled aliases retain native
boundaries. No feature work is reordered. Every logical callback keeps its own
resolver and debug group; viewport, scissor, blend constant and stencil reference
restart with native defaults. A depth-bearing background needs a pipeline with the
same depth format, even when it neither tests nor writes depth.

| Observation | Meaning |
| :-- | :-- |
| `inspect().passes[].rasterBatch` | Logical names in a compiled physical group |
| `runPass` | Each logical stage, in declaration order |
| `instrumentation.begin` | One actual native pass, with `logicalPassNames` for a batch |
| `runPass.requiresPassBoundary(name)` | Explicit per-stage native observation/copy boundary |

Ordinary CPU wrappers and GPU timestamp collection preserve batching. A runner
that copies or observes attachments around its callback must declare that stage's
boundary; wrappers preserve this property. Conditional stages stay independent.

### Allocation-explicit pass callbacks

Use `encodeDirect(pass, frame, resources)` for raster/compute callbacks and
`encodeDirect(encoder, frame, resources)` for copy callbacks when an argument
record adds no meaning. The graph calls these directly without constructing a
context object or rotating a scratch record. `encode(context)` retains a fresh
argument record per invocation. Declare exactly one form; both preserve the
callback receiver and the graph's ordinary execution, error and retirement rules.

```ts
builder.addComputePass('simulate', {
  accesses: [{ resource: particles, usage: 'storage-read-write' }],
  encodeDirect: (pass, _frame, resources) => {
    pass.setPipeline(simulatePipeline);
    pass.setBindGroup(0, simulationBindings(resources.buffer(particles).unwrap()));
    pass.dispatchWorkgroups(256);
  },
}).unwrap();
```

### Resource declaration

| Method | Ownership | Physical usage |
|:--|:--|:--|
| `createTexture` / `createBuffer` | Graph allocates and retires the handle | Derived from every declared access |
| `createTextureLike(label, source)` | Independent graph-owned texture with the source's exact allocation descriptor; no content copy | Derived from declared accesses, retaining explicit descriptor usage |
| `importTexture` / `importBuffer` | Caller resolves and owns the handle | Supplied usage must contain derived usage |
| `view` | Typed texture subresource | Mip, layer, aspect, dimension, and optional format are explicit |
| `importAccelerationStructure(label, { maxInstances }, resolve)` | Caller resolves and owns the `Tlas` (BLASes stay owner-private) | None; never graph-allocated, so size is unknown (`imported-owner`) |

Resource and pass labels are unique diagnostics. Handles are opaque and builder-scoped; passing a foreign handle is a structured error.

### Access vocabulary

| Buffer | Texture |
|:--|:--|
| `uniform-read` | `sampled-read` |
| `storage-read` | `storage-read` |
| `storage-write` | `storage-write` |
| `storage-read-write` | `storage-read-write` |
| `indirect-read` | `sampled-storage-read-write` |
| `vertex-read` | `color-attachment` |
| `index-read` | `depth-stencil-read` |
| `copy-src` / `copy-dst` | `depth-stencil-write` |
|  | `copy-src` / `copy-dst` |
|  | `sampled-storage-write` |

A raster attachment with `loadOp: 'load'` is a read/write access. A clear attachment is the first write. The compiler checks overlapping texture mip/layer/aspect ranges rather than treating unrelated subresources as one hazard.

An acceleration structure has two accesses: `acceleration-structure-build` (a write,
admitted only in copy passes, which own `buildAccelerationStructures`) and
`acceleration-structure-read` (any pass that binds the TLAS). Readers order after the
latest earlier build like any other write/read hazard; a pass resolves the handle with
`resources.accelerationStructure(handle)`. A build pass that has nothing to do uses
`executeIf`, so settled structures cost no encoder work.

`sampled-storage-write` declares a compute chain that fully writes a subresource
before sampling it in a later dispatch of the same pass. It derives both texture
and storage bindings without consuming incoming contents. Use
`sampled-storage-read-write` when incoming contents are read. Each dispatch must
still use valid, disjoint read/write subresources; the graph does not synchronize
threads inside one dispatch.

### Pass declaration

| Method | Encoder ownership |
|:--|:--|
| `addRasterPass` | Graph resolves attachments and owns `beginRenderPass` / `end` |
| `addComputePass` | Graph owns `beginComputePass` / `end`; optional `begin(frame)` supplies the descriptor and `after(frame)` runs after `end` |
| `addCopyPass` | Graph lends the frame command encoder for copy commands |

Each encode callback receives a pass-local resolver. Resolving a resource not declared in that pass is rejected.
Compute pass descriptors such as `timestampWrites` come from `begin`; the graph keeps the diagnostic
label. Compute work that targets the parent command encoder, such as resolving timestamp queries,
belongs in `after`; pass commands remain in `encode`. `onBeginError` lets the pass owner terminalize
feature-local evidence before the graph returns `pass-encode-failed`.

### Pass instrumentation

Renderer-owned instrumentation may be supplied as the third argument to
`compiled.execute(frame, runPass, instrumentation)`. The graph calls
`instrumentation.begin` immediately before each executable pass and applies the
returned descriptor decorator at the actual `beginRenderPass` or
`beginComputePass` boundary. This is the single seam for pass-level timestamp
queries and similar graph-neutral observation; it preserves pass name, kind, and
execution index without moving timing policy into the graph.

```ts
compiled.execute(frame, undefined, {
  begin: (pass) =>
    pass.kind === 'compute'
      ? {
          computePassDescriptor: (descriptor) => ({
            ...descriptor,
            timestampWrites: {
              querySet,
              beginningOfPassWriteIndex: 0,
              endOfPassWriteIndex: 1,
            },
          }),
        }
      : undefined,
});
```

The graph never calls a backend-specific command-encoder timestamp helper.
Pass instrumentation must preserve any producer-owned descriptor facts; a
policy owner that cannot merge an existing `timestampWrites` pair should fail
closed instead of overwriting it. Copy passes expose `beforeCopy`/`afterCopy`
hooks for non-timing instrumentation, but WebGPU has no portable copy-pass
timestamp descriptor.
> [!NOTE]
> `timestampWrites` and an `after(frame)` callback are neutral graph seams. They
> let a pipeline owner place a backend command at a declared pass boundary, but
> Render owns the `GpuPassTiming` session, decimal tick parser, bounded facts,
> four-status observation, and benchmark validator. RenderGraph must not import
> that timing contract, name a timing status, or decide whether a measurement is
> accepted. The public route is documented in
> [`@forgeax/engine-render`](../render/README.md).

## Compile and execution

`compile({ device, surfaceSize, reuseResourcesFrom? })`:

- seals the builder;
- validates descriptors, access conflicts, initialization, import usage, and capabilities;
- derives created-resource usage and lifetime intervals;
- allocates transactionally, rolling back all staged handles and shared leases on failure;
- returns a separate immutable `CompiledRenderGraph`.

The builder snapshots descriptor data when it accepts resources, views and passes.
Caller changes to arrays, attachment values or callback properties cannot alter
compiled execution or inspection. Opaque RHI handles retain their identity;
Explicit callbacks retain their original receiver, receive the current frame, and
may read live closure or receiver state. `occlusionQuerySet` accepts an opaque
query set or an explicit `(frame) => QuerySet | undefined` callback, evaluated
once per executed raster pass. Query-page rotation and idle/resumed frames use
that callback without rebuilding the graph; descriptor getters are snapshot data.

`executeIf(frame) === false` skips only that pass. Graph-created storage persists
until retirement: a skipped producer leaves its previous contents intact, including
the backend's initialized contents before its first write (zero for WebGPU buffers).
A newly allocated graph texture has no committed-content proof until a submitted
pass writes its range.
Dependencies and `uninitialized-read` validate declared access ordering; they do not
assert that a conditional producer executed or supplied business-valid data.
Consumers must accept the retained/initial contents, share the producer's condition,
or declare an unconditional clear/write before reading. Imported contents remain
the importing owner's responsibility. Dawn and browser byte-readback regressions
cover first skip, write, later skip and first execution after rebuild.

`compiled.createdTextureView(view)` borrows the exact live native view of a
graph-created texture before any execution. It returns `undefined` for foreign,
imported, unallocated or retiring resources. The lookup neither allocates nor
invokes import resolvers; retiring one graph does not invalidate another graph's
shared lease. Callers must not destroy the borrowed view. This ownership fact is
not GPU-content readiness or permission to bypass a Pass's declared accesses.
`compiled.isRetired()` reads the same monotonic owner state: it becomes true
synchronously when retirement starts, before its completion fence settles.
Neither read creates a lease, prepares GPU contents or authorizes execution.

`resources.textureViewExtent(view)` returns the declared view’s compiled pixel width and height, including its base mip. It applies the same graph ownership and exact pass-access checks as `textureView(view)` and derives from existing allocation facts, including imported surface extents; consumers do not keep a second size catalogue.

Texture extents may use `surface`, `half-surface`, or `quarter-surface`. Relative extents resolve against each compilation's surface size, rounding each axis up. Quarter extents preserve the final odd-edge sample during cloud Mode 0 tracing; they do not change resource access, initialization, or retirement rules.

`execute(frame)` resolves imported handles for that frame and encodes passes in declaration order. Execution walks the sealed dense Pass array by index. A compute Pass with no dynamic begin descriptor reuses its graph-owned label descriptor; explicit begin and timing instrumentation still resolve on each execution. `inspect()` returns a frozen projection of pass kinds, accesses, dependencies, resource origin, derived usage, lifetime bounds, and (for graph-created resources) `resourceAllocation`.

After successful import resolution, resource rows expose the actual imported
`physicalAllocationKey`. Unexecuted or failed resolutions expose no import key.
An unchanged handle retains the inspection snapshot; replacement handles publish
a new snapshot without changing prior observations or graph-owned byte totals.

`inspect().resourceAllocation` is the single compiled-graph logical ledger:
`liveBytes` are graph-created handles currently live, and
`pendingRetirementBytes` are handles moved to retirement while the submission
fence is outstanding. `peakBytes` is that graph generation's simultaneous
logical high-water mark. Imported resources contribute an explicit owner row
and unknown byte size; they are never counted as graph-owned physical bytes.
`successfulAllocationCount` and `successfulAllocationBytes` count newly created
handles, excluding borrowed allocations. A resource row exposes a stable
`physicalAllocationKey` across generations and an `allocationState` of `live`,
`pending-retirement`, or `released`. Per-generation byte totals describe that
graph's leases; shared allocations must be deduplicated across generations.
`retire()` removes a token only after its lease releases successfully. A destroy
refusal, throw, or queue-fence failure leaves the bytes pending and returns
`resource-retire-failed`, so the renderer-wide cross-generation receipt can
keep the failed owner visible. For active/candidate/retiring generations,
read [`@forgeax/engine-render`'s allocation inspection](../render/README.md#renderer-wide-graph-allocation-inspection).

`reuseResourcesFrom` may name a live compiled graph on the same device. Exact
label and resolved physical descriptor matches share graph-created textures.
Views of that same physical texture also retain their handles when all view
fields match; graph-local ordinals only accelerate the lookup, and labels do
not affect view compatibility. Existing compiled view records own this reuse.
Buffers and imported resources are not pooled. A successor may read a persistent
texture range before writing only when this exact reused allocation has committed
stored writes covering that mip/layer/aspect range. `execute()` stages write facts;
the owner must call `commitExecution()` after accepting the submission, or
`discardExecution()` when the frame is rejected. Encoding alone never commits
content. Discarded raster stores invalidate prior proof for their range. Execute
generations sequentially on the same device queue;
shared targets do not preserve a separate image for each graph. Resizing or a
descriptor change allocates separately. A failed candidate releases only its
leases, leaving the previous graph usable for rollback.

`retire()` first waits for `device.queue.onSubmittedWorkDone()`, then releases
its leases. The final texture lease destroys the handle exactly once. A
retiring graph cannot lend resources to a new compile. Imported resources are
never destroyed by the graph.

The older string-key `RenderGraph` descriptor surface remains limited to
feature-local staging and isolated legacy tests. Renderer frame ownership uses
`RenderGraphBuilder`; new pipeline and compute work must not add string resource
keys or call the facade's compile/execute path.

The facade's `InternalizedGraph.colorTargets` contains one typed texture/view
pair per logical name. Aliases share source allocation metadata and the source pair;
resource lifetime is read from the admitted descriptor. Unchanged compiles
reuse it. Transient pools still retain descriptor generations; persistent
resources still replace by logical name. The pass resolver's existing `::tex`
spelling is interpreted at that boundary, without a second physical map row.

## Ordering and hazards

The compiler scans each resource/subresource in declaration order.

| Current access | Prior overlapping state | Dependency |
|:--|:--|:--|
| read | latest write | RAW |
| write | latest write | WAW |
| write | reads since latest write | WAR |

A later write never becomes the producer of an earlier read. This makes temporal multi-writer and ping-pong sequences unambiguous without a public resource-version type.

The RHI remains responsible for backend state transitions and synchronization. The graph exposes dependency evidence; it does not claim to insert a barrier that no RHI command executes.

## Capabilities

A compute pass requires `caps.compute`. Storage accesses require the matching storage-buffer or storage-texture capability, indirect access requires indirect drawing support, and `acceleration-structure-read`
requires `caps.rayQuery.supported` (`capability-missing`, `capability: 'ray-query'`). Capability absence fails compilation with `capability-missing`; the pipeline or feature owner selects a fallback lane before graph construction.

v1 uses one command encoder and one primary queue. There is no `asyncCompute` option until the RHI exposes a real second queue, fences, and measured overlap evidence.

## Error model

All expected builder, compile, execute, and retire failures use `Result<T, RenderGraphError>`. Every error carries `code`, `expected`, `hint`, and code-correlated `detail`.

The closed union covers these groups:

| Phase | Codes |
|:--|:--|
| Declaration | `duplicate-pass-name`, `duplicate-resource-label`, `builder-sealed`, `foreign-resource-handle`, `alias-source-missing` |
| Access analysis | `resource-not-declared-by-pass`, `uninitialized-read`, `access-conflict`, `import-usage-mismatch` |
| Compile | `capability-missing`, `resource-descriptor-invalid`, `resource-allocation-failed` |
| Execute | `resource-resolution-failed`, `pass-encode-failed`, `compiled-graph-retired` |
| Retire | `resource-retire-failed` |

The package still contains the existing string-key `RenderGraph` facade while standard renderer raster consumers move to the typed builder. New compute paths and external callers use `RenderGraphBuilder`; no new feature should add boolean `compute` flags or record a whole compute pass outside graph ownership.

## Package boundary

```mermaid
flowchart LR
  render["@forgeax/engine-render"] --> rg["@forgeax/engine-render-graph"]
  rg --> rhi["@forgeax/engine-rhi"]
  rg --> types["@forgeax/engine-types"]
```

The package does not import runtime, ECS, renderer policy, a concrete backend, or math. Color-domain policy and frame-observation policy belong in `@forgeax/engine-render`.

## Verification

Run from this package:

```bash
../../node_modules/.bin/vitest run
```

The suite covers declaration order, temporal multi-writer chains, imported first reads, typed subresource hazards, duplicate labels, builder sealing, capability rejection, transactional allocation rollback, pass-local resolution, graph-owned compute encoding, real RHI-null integration, and fence-aware retirement. Render-owned Dawn and Chromium tests additionally prove compute-generated indirect dispatch/draw args, storage-buffer ping-pong, storage-texture-to-raster pixels, imported persistent GPU Scene cull/compact work, and an HZB mip chain whose dependencies follow exact subresources.

Raster attachment count is admitted against `RhiCaps.maxColorAttachments` during
graph compilation, before resources are allocated. An excess returns
`capability-missing` with capability `color-attachments`; the caller chooses an
explicit supported graph. Material MRT reuses these ordinary raster attachments,
read/write hazards, resolve views and retirement fences.

## Frame-varying occlusion query sets

`RasterGraphPass.occlusionQuerySet` accepts a fixed RHI handle or a
`(frame) => QuerySet | undefined` resolver. Use the resolver for rotating query
pages and idle frames. The compiler snapshots the callback and its receiver;
execution resolves it once before beginning the raster pass. A descriptor getter
is a declaration-time value, not a frame callback. Graph topology and attachment
resources remain reusable while the query set changes.

The name-based `RenderGraph` declaration API also snapshots pass reads/writes, color-domain connections, resource descriptors, target sizes and view formats on admission. Color aliases share the accepted allocation metadata. Compute callback identities are captured once with their original receiver; callbacks may still consume current frame and receiver state. Change topology by declaring a new graph, and resize relative targets through `setSwapChainSize`. Snapshot admission reads the declared properties directly, including inherited accessors and prototype pass methods; it does not require enumerable own fields.
