# @forgeax/engine-rhi-webgpu

> WebGPU thin shim implementation of `@forgeax/engine-rhi`; spec-aligned descriptors; `'x' in src` guard; no field renaming.

## Charter propositions (AI users read AGENTS.md §RHI / WebGPU first)

| Proposition | This package's contract |
|:--|:--|
| 1 Progressive disclosure | Single `import { rhi } from '@forgeax/engine-rhi-webgpu'` exposes 14 opaque handles plus the entire RHI surface; one read covers entry. |
| 2 Industry practice | Descriptor mirroring uses `Pick<GPUXxxDescriptor, ...>`; `tsconfig` enables `exactOptionalPropertyTypes`; ts-morph drives the R12 lint mirror (S-2). |
| 3 Machine-readable unions | Bounds-guard hints (`'queue-write-buffer-out-of-bounds'`) carry concrete `got X` numbers, not prose; AI users parse `.hint` for self-recovery. |
| 4 Explicit failure | Real-path surfaces return `Result.err` for every D-S3 trigger. The escape hatch is renamed to `_internal_getRawDevice` and confined to a four-path allow-list (D-S1). |
| 5 Consistent abstraction | The shim never renames descriptor fields; `BufferDescriptor.size` maps byte-for-byte to `GPUBufferDescriptor.size`; descriptors use an `'x' in src` guard to preserve missing versus explicit-undefined. |
| 6 Real-GPU observation | `src/__tests__/dawn-real-gpu.dawn.test.ts` triggers the D-S3 codes against dawn.node GPU; silent-pass blind spots remain visible. |

> AI users: read [AGENTS.md §RHI / WebGPU](../../AGENTS.md) first for the shape rules (spec alignment, capability gating, opaque handles, and math-free descriptors); this package is the WebGPU thin shim that realizes the contract.

## API entries (mid-section method tables)

| Entry | Form | Purpose |
|:--|:--|:--|
| `requestAdapter(opts?)` | `(RequestAdapterOptions?) => Promise<Result<RhiAdapter, RhiError>>` | Browser-native adapter probe. A resolved `null` is `adapter-unavailable`; a rejection is `webgpu-runtime-error` and preserves the original cause in `detail.error`. |
| `requestAdapter(opts?)` / `requestAdapterFrom(gpu, opts?)` | `Promise<Result<RhiAdapter, RhiError>>` | Ambient browser or explicit provider; the returned adapter owns `requestDevice` |
| `createShaderModule(device, desc)` | `(RhiDevice, { code, label? }) => Promise<Result<ShaderModule, RhiError>>` | Entry 2: async shader compile; `'shader-compile-failed'` forwards every `GPUCompilationMessage` field to `RhiError.detail.compilerMessages` |
| `rhi` | RHI factory | `requestAdapter`, canvas acquisition and shader-module operations; device construction belongs to the returned adapter |
| `_internal_getRawDevice(device)` | `(RhiDevice) => GPUDevice \| undefined` | D-S1 single-point escape hatch (whitelist: `device.ts` def + `index.ts` createShaderModule + `apps/hello/triangle/src/main.ts:96` canvas context.configure + `dawn-real-gpu.dawn.test.ts` validation probe). `getRawDevice` (without prefix) was removed in M4 (AC-RSC-05). |
| `GpuLike` / `GpuAdapterLike` / `GpuDeviceLike` | `interface` provider seam | Mock fixture's minimal GPU subset (research §F-6) |
| `RequestDeviceOptions` | `{ gpu?, adapterOptions?, deviceDescriptor? }` | Provider seam injection arguments |
| re-export | `RhiDevice` / `Result` / `RhiError` / `_internal_getRawDevice` | Single-entry surface for downstream callers |

## D-S3 real-path error coverage

`adapter-unavailable` is scoped to this browser-native backend. Runtime may
continue through the separate `rhi-wgpu` WebGL2 lane, so consumers must not turn
this one code into a whole-machine “WebGPU unsupported” verdict. Conversely,
`GPU.requestAdapter()` throwing is not adapter absence: the shim emits
`webgpu-runtime-error` and retains `{ code: 'request-adapter-threw', name?,
message }` in `detail.error` so permission-policy, security-context, and browser
runtime failures remain distinguishable.

`feat-20260508-rhi-surface-completion` lands the real-path implementation for command recording + queue submit + queue.writeBuffer; the 4 D-S3 codes are observable through `Result.err`:

| Code | Wrapped at | Trigger |
|:--|:--|:--|
| `'command-encoder-finished'` | `device.ts:498-518` (`finish()` lifecycle) | Second `encoder.finish()` after a prior finish; void-recording APIs throw the structured error so AI users observe the failure |
| `'render-pass-not-ended'` | `device.ts:507-512` (`finish()` activePass guard) | `encoder.finish()` while a pass has not been `end()`-ed; the guard tracks `state.activePass` per `PASS_STATE` weakmap |
| `'queue-submit-failed'` | `device.ts:601-607` (`submit()` try/catch) | `rawQueue.submit()` throws (validation error / destroyed reference); message is forwarded into `.hint` |
| `'queue-write-buffer-out-of-bounds'` | `device.ts:548-567` (`writeBuffer()` bounds guard) | `bufferOffset % 4 !== 0` or `bufferOffset + writeSize > buffer.size`; `.hint` carries `got X` / `got Y` / `got Z` numbers for AI-user routing |

Real-GPU integration is in [`src/__tests__/dawn-real-gpu.dawn.test.ts`](./src/__tests__/dawn-real-gpu.dawn.test.ts) (4 describes, 4 codes triggered).

## Command encoder ownership

Command, render-pass and compute-pass encoder methods share their class prototype.
Call them on the encoder receiver, as with native WebGPU; a retained method callback
needs its receiver bound by its caller. Each command encoder still owns independent
raw state, finish/pass guards and acceleration-structure context. Sharing methods
does not reuse or reset a finished encoder or alter descriptor forwarding.

## Timestamp write contract

Timestamp capture uses the WebGPU pass descriptor `timestampWrites` field on
`beginRenderPass` / `beginComputePass`. The shim maps the opaque ForgeAX
`QuerySet` to the native `GPUQuerySet` at the pass boundary. The obsolete
command-encoder `writeTimestamp` entry is intentionally not exposed: current
Dawn rejects that method even when `timestamp-query` is advertised. A device
without a usable timestamp period remains capability-negative and produces no
synthetic ticks.
When `device.caps.timestampQuery` is true, render and compute pass descriptors
carry the mapped query set and timestamp indices. The WebGPU adapter does not
expose the removed command-encoder timestamp entry; callers that need an
encoder-position marker use an empty timestamp-enabled compute pass on the same
encoder. A marker failure is a structured `webgpu-runtime-error`; the shim
never treats it as a no-op or synthesizes timestamp ticks. Capability-disabled
devices retain the existing refusal path.
`caps.timestampPeriodNanoseconds` is 1 for W3C devices, which resolve nanoseconds. A raw
device that exposes a positive `timestampPeriod` resolves raw ticks, and its period is
published instead. That is the native wgpu `GPU` of
[`@forgeax/engine-rhi-wgpu-native`](../rhi-wgpu-native/README.md#node-binding-napi-rs).

## Ray Query extension

Browser WebGPU and Dawn expose no acceleration structures, so `caps.rayQuery` is
`backend-has-no-ray-query`. When the raw device carries wgpu's extension shape, the shim
lowers the RHI BLAS/TLAS surface onto it ([`ray-query.ts`](./src/ray-query.ts)). The
native wgpu `GPU` is one such device. The extension shape is:

- device `createBlas` / `createTlas`;
- encoder `buildAccelerationStructures`;
- the `wgpu-ray-query` feature, plus the four Ray Query limits.

The RHI rules decide what happens next:

- `deriveRayQueryCaps` derives the caps. A device without the feature or limits reports
  `adapter-lacks-feature`.
- Structural validation in `@forgeax/engine-rhi` runs before any raw call.

The shim borrows already validated TLAS entry/instance descriptors directly for
its synchronous native call: acceleration handles already are native objects and
there are no Buffer handles to unwrap in a TLAS instance. This removes one full
roster map and its per-instance object allocations. RHI descriptor/liveness
validation, native command serialization and the backend TLAS build still consume
the complete roster; this does not introduce native or GPU incremental builds.

## Query forwarding contract

The shim forwards the query surface from [`@forgeax/engine-rhi`](../rhi):

| Operation | Runtime contract | Evidence |
|:--|:--|:--|
| `createQuerySet` / `destroyQuerySet` | Occlusion sets are available without an optional capability; `count > 4096` returns `limit-exceeded`; timestamp sets require `device.caps.timestampQuery` | [`device.ts`](./src/device.ts#L1837), [Dawn create coverage](./src/__tests__/dawn-real-gpu.dawn.test.ts#L381) |
| `occlusionQuerySet` + `beginOcclusionQuery` / `endOcclusionQuery` | The pass owns the query-set state; missing set, out-of-range index, nested begin, and unmatched end produce structured errors | [`device.ts`](./src/device.ts#L542), [Dawn state/round-trip coverage](./src/__tests__/dawn-real-gpu.dawn.test.ts#L619) |
| `resolveQuerySet` | Validates 256-byte destination alignment, `QUERY_RESOLVE` usage, range, and destination size before raw forwarding | [`device.ts`](./src/device.ts#L966), [Dawn coverage](./src/__tests__/dawn-real-gpu.dawn.test.ts#L820) |
| Timestamp pass writes | `timestampWrites` maps opaque `QuerySet` handles to raw `GPUQuerySet`; a capability-negative device refuses creation and does not synthesize ticks | [`device.ts`](./src/device.ts#L745), [Dawn admission/readback coverage](./src/__tests__/dawn-real-gpu.dawn.test.ts#L1233) |
| Pass descriptor `timestampWrites` | Capability-positive devices map opaque query sets at the real render/compute pass boundary; unavailable periods remain fail-closed | [`device.ts`](./src/device.ts#L745), [unit coverage](./src/internal/__tests__/timestamp-query.unit.test.ts) |
| `createRenderBundleEncoder` / `executeBundles` | Shared native command adapter; typed immutable bundles, repeated execution and native compatibility/lifetime validation | [Browser/Dawn validation](./src/__tests__/render-bundle-validation.fixture.ts) |

> [!NOTE]
> Dawn is the current real-GPU evidence owner for query behavior. This package does not claim a separate browser query artifact merely because the browser shim and interface compile; `RhiNull` remains structural-only.

## Capabilities tri-layer

`device.caps` (hardware probe) / `device.features` (enabled set) / `device.limits` (numeric upper bounds) — three independent `readonly` fields (charter proposition 5); `caps.X = false` is an explicit signal, never an exception (proposition 4).

## Deferred membership evidence closure

The full matrix closes only at `acceptedGpu=16`: five Dawn GPU records each
for 32, 64, and 128 lights, one 256-light record, positive GPU ticks,
variance, and the 256-light overflow fingerprint. `acceptedGpu=0` is a
fail-closed blocker. CPU control, WebKit WebGL2 refusal, RhiNull refusal,
screenshots, and capability bits cannot be promoted to accepted GPU evidence.

The validator binds `sourceHead`, `carrier`, `workload`, `profile`, and
`artifactHashes`. It requires the exact 20 top-level and 32 nested records and
SHA-256 descriptors for `record`, `profile`, `membership`, and `pixel`. The
formal budgets are Dawn `100000` events, WebKit `65536` events, nested frame
limit `90`, and settle time `25` ms. The 128-light / 90-frame / `40000` event
configuration is a falsifier and must be incomplete with dropped events; it is
not the formal WebKit budget.

The producer report is the recovery entry point. Read `blocker.code`,
`blocker.expected`, `blocker.hint`, and `blocker.acceptedGpu`, then inspect the
per-attempt `identity`, `profile`, `timing`, `membership`, `pixel`, and artifact
hash records. The Render reason union remains closed: timestamp-query refusal
uses `timestamp-query-unsupported`, while a raw timestamp write failure is
`webgpu-runtime-error` at the RHI layer and `timestamp-write-unavailable` in
the Render owner contract. Neither produces synthetic ticks.

## Test infrastructure

- Hand-rolled minimal mock GPU device (decision S-2 path (b)) at `src/__tests__/__mocks__/gpu-device.ts`; zero-native dependency, pure TS.
- Provider seam injection via `gpu?: GPU` parameter (research §F-6 webgpu-utils + CTS consensus); default routes through `globalThis.navigator.gpu`.
- dawn.node real-GPU coverage: `src/__tests__/dawn-real-gpu.dawn.test.ts` (4 D-S3 triggers, candidate proposition 6 monitoring).

## WebGPU stub

`installWebGpuStub(profile)` replaces the calling realm's `navigator.gpu` and
`'webgpu'` canvas contexts with a no-op `GPU` that reports `profile`'s adapter
features, limits, info and preferred canvas format. Every ambient consumer keeps
this package's ordinary path (`caps.backendKind === 'webgpu'`, profile-derived
caps), but nothing reaches a GPU, Dawn or a software rasterizer: submissions and
`onSubmittedWorkDone` complete immediately, pipelines and shaders succeed without
validation, and mapped ranges are zero-filled. Use it for CPU-side engine and game
cost on hosts without a usable GPU, or to remove GPU cost on a GPU host. It is
never pixel, GPU-time or FPS acceptance evidence.

| Export | Contract |
|:--|:--|
| `DEFAULT_WEBGPU_STUB_PROFILE` | Chrome 155 on an Apple M4 Pro (Metal 3), captured 2026-10-22. |
| `captureWebGpuStubProfile(gpu, name)` | Captures a structured-cloneable profile from a real `GPU`; `null` without an adapter. |
| `installWebGpuStub(profile)` | Idempotent per realm. Install before any backend selection in each realm that creates a Renderer. |
| `installedWebGpuStub()` | Installed profile name, or `undefined`. |

`createApp({ gpuStub })` installs it in the main realm and every execution Worker;
generated hosts map `?forgeax-gpu-stub=1` to the default profile. Unlike
`rhi-null`, which validates RHI ownership structurally for unit tests, the stub
exists to keep the real browser WebGPU path while removing GPU work.

- **`'x' in src` guard transit**: spec `?: T` vs forgeax `?: T | undefined` differ under `exactOptionalPropertyTypes:true`; the shim guards each field per F-3 anti-pattern 2.
- **`device.lost` single source**: this package only forwards the spec Promise; fan-out is the engine's job (`LostListenerRegistry`).
- **Error message keyword classification**: `requestDevice` failure routes via `feature` / `limit` keyword detection; mock and real-GPU formats may differ.
- **Real-path implementation (M4-M5 + query closure)**: command recording + queue submit + queue.writeBuffer landed; query-set creation/destruction, occlusion begin/end, resolve, and timestamp pass writes are forwarded or capability-gated. Render bundle creation, finish and execution are implemented with native WebGPU validation.
- **Escape hatch tear-down**: `getRawDevice` (no prefix) removed in `feat-20260508-rhi-surface-completion` M4 (AC-RSC-05); the single sanctioned hatch is `_internal_getRawDevice` confined to the AC-08 (h) allow-list.
- **destroyBuffer / destroyTexture (feat-20260612)**: per-handle destroyed-state bookkeeping in shim layer (`WeakMap<Handle, { destroyed: boolean }>`) on top of the spec's idempotent-void `GPUBuffer.destroy()` / `GPUTexture.destroy()`. Dual-backend behavior is symmetric: both shims track destroyed boolean per handle, fail-fast on second destroy with `'destroy-after-destroy'` error code, and never depend on wasm panic interception (plan-strategy D-6). Implementation at `packages/rhi-webgpu/src/device.ts`.

## Command counts

Every realm keeps cumulative counts of the commands it encodes through this
package. Each wrapper adds an integer on its existing path, so the counts are
always on and identical with the stub and a real GPU. They are CPU-side call
counts, not GPU cost.

| Export | Contract |
|:--|:--|
| `readRhiCommandCounts()` | Snapshot (`RhiCommandCounts`) since the realm loaded the package. |
| `subtractRhiCommandCounts(after, before)` | Counts encoded between two snapshots. |
| `RHI_COMMAND_COUNT_KEYS` | Field list, in report order. |

Pass fields (`draws`, `pipelineSets`, `bindGroupSets`, `vertexBufferSets`,
`dispatches`) count commands encoded into render and compute passes. `bundle*`
fields count commands recorded into render bundles; replays count only as
`bundlesExecuted`. `bufferWrites`/`bufferWriteBytes` and
`textureWrites`/`textureWriteBytes` count queue writes and their copied source
bytes; `bindGroupCreates`, `bufferCreates`, `textureCreates` count creation. The
App Render Worker attaches the difference since its previous submitted frame to
each `frame-submitted` as `rhiCommands`. The wasm `rhi-wgpu` backend does not
count.

## FAQ

**Q: Why not directly `implements GPUDevice` for the full interface?**

A: charter proposition 1 — progressive disclosure: the shim only touches descriptors actually used (`createX` + `features` / `limits` / `lost` / `queue` + command recording). Mock fixtures need not implement `wgslLanguageFeatures` / `getPreferredCanvasFormat`.

**Q: Are real `GPUDevice` and mock semantics aligned for `device.lost.reason` / `message`?**

A: No — spec and wgpu impl format are not interchangeable (research §F-4). This package forwards the Promise without classification; consumers should `switch` over `'destroyed' | 'unknown'`.

**Q: Why does `_internal_getRawDevice` exist if escape hatches are forbidden?**

A: D-S1 single-point exemption — `apps/hello/triangle/src/main.ts:96` `context.configure({device: rawDevice})` requires raw `GPUDevice` because `RhiCanvasContext` is owned by `feat-future-rhi-adapter-surface`. The hatch is renamed (no bare `getRawDevice`), confined to a 4-path allow-list (AC-08 (h)), and grep-fenced.

## Upgrade path

- `@webgpu/types ^0.1.69`: caret range tracks v0.1.x patches; v0.2.x triggers major-upgrade markers (S-4).
- After upstream spec migrates to `?: T | undefined`, the `ExplicitUndefined<>` mapped type can be removed and the mirror simplifies (L-P4 widening contract).

## Dependencies

- `@forgeax/engine-rhi` (workspace) — interface contract SSOT.
- `@forgeax/engine-types` (workspace) — POD types / union aliases SSOT.
- `@webgpu/types ^0.1.69` — spec types; lock-version policy is in repo-root [AGENTS.md](../../AGENTS.md).

## Related packages

- [`@forgeax/engine-rhi`](../rhi) — pure interface contract (14 opaque handles + descriptor projections + 7 main interfaces + `RhiError` / `Result`).
- [`@forgeax/engine-types`](../types) — POD types / enum SSOT.
- [`@forgeax/engine-runtime`](../engine) — async factory entry (M3 injects via `rhi.requestAdapter()` and `adapter.requestDevice()`).

## Device pipeline library

Every ordinary shader, bind-group layout, pipeline layout and render/compute pipeline
factory uses one library per physical device. Exact WGSL and complete pipeline state
identify reusable native handles; diagnostic labels do not. Changed sources, specialization
constants, vertex/attachment formats, blend/depth/sample state or layouts create new entries.
Feature-local descriptor caches still avoid reconstructing descriptions; they do not own
another native compilation cache. Module aliases also share one native `getCompilationInfo()`
completion, including its diagnostic messages; they never query the same native module again.
Disposal/device loss clears retained handles.

`device.pipelineLibrary.export()` returns the reachable JSON recipe graph. It contains
WGSL and descriptors, never driver binaries. `await device.pipelineLibrary.prepare(manifest)`
recreates dependencies and awaits native asynchronous pipeline completion (at most four
requests concurrently). Concurrent requests share completion. A synchronous creation is
usable but never counted as evidence that native compilation finished. Known asynchronous
validation failure evicts an earlier unverified handle and remains retryable.

`RendererOptions.pipelineLibrary` / `CreateAppOptions.pipelineLibrary` runs this preparation
before renderer readiness, including a replacement device. `renderer.inspect()` exposes
counts; `renderer.inspect({pipelineLibrary:true})` additionally exports the manifest.
Worker execution uses `await execution.inspectRenderer({pipelineLibrary:true})`.
`inspect().pending` lists every currently recorded scheduled or native pipeline
compilation, plus `unidentified` requests whose dependencies could not be recorded. Each row carries the runtime/startup/background origin, queued/compiling
stage, elapsed milliseconds, complete recipe, bind-group layouts and shader-source
SHA-256 digests. Its semantic identity excludes labels and device-local module
numbers, so screenshots can identify an exact state variant across devices.
The inspection contains no shader source or native handles and is detached from
the library. It describes live native requests, not CPU preparation, not-yet-issued
warmup entries, or a proof of coverage for gameplay paths that have not requested a pipeline.
`preload` compares the exact recipe against all libraries supplied to this device:
`startup`, `background`, or `both` means declared; `absent` means no indexed library
contains it; `indexing` keeps the answer unresolved while a supplied library is
still constructing its dependency/recipe roster. The complete roster is indexed
before native warmup requests are scheduled, so a later background entry is not
misreported as missing when gameplay requests it first. The request `origin`
alone is not a coverage verdict. No pending row is fabricated for a backend
without this inspection.
Watch new synchronous/asynchronous creations after loading to find missing scenario coverage.
For a late observer, `inspect({runtimeRequests:true}).runtimeRequests` materializes
the last 32 runtime-demanded native requests, including completed/failed requests
and runtime demands joining an already compiling background entry. Ordinary
inspection does not materialize this history. Explicit history inspection omits
the legacy `pending` recipe list, whose uncached identities may require source hashing;
the compilation counters remain available. Historical recipes use cached nullable
digests and device-local identities only, including while requests are pending.
Renderer and Worker callers opt in
with `inspect({runtimeRequests:true})` and
`execution.inspectRenderer({runtimeRequests:true, fields:['pipelineLibrary']})`.
Recording adds only bounded metadata and references to the existing Program on a
runtime miss/demand; completed cache hits and undemanded warmup do not record.
Recording does not copy descriptors/WGSL, hash sources, schedule GPU work or alter
compilation concurrency. Complete recipes and cached identities are read only by
the explicit inspection. Disposal clears this history with its device owner. Its Program references are weak; a released recipe appears as null rather than extending GPU lifetime.
The tuple `(libraryId, sequence)` identifies a request on that renderer realm;
the semantic pipeline identity identifies the recipe across devices. `overwritten`
is cumulative ring eviction, not a count of current-incident losses. A null pipeline
and `preloadAtDemand:'unavailable'` preserve an unrecordable request without
inventing a missing-manifest verdict. `returned` means a synchronous handle returned,
not native compilation-completion evidence. Timestamps and `observedAtMs` use the
library performance clock; caller/Worker receipt times have their own clock boundary.
This is bounded diagnostic evidence, not a permanent trace or driver compiler timing.
`prepare(manifest, {concurrency, background})` bounds outstanding native requests
(default `pipelineWarmupConcurrency`, half the logical processors in 4..16; background
default 1..4, capped independently of core count). Explicit background concurrency
must be in 1..4; blocking concurrency must be in 1..16. Shader validation uses the same
bound and preserves manifest dependency order. Background workers yield
8 ms before each request, including cache hits, and stop scheduling after disposal.
Native compilations already submitted cannot be cancelled or reprioritized; bounded
concurrency is not proof of battle-frame nonregression. Qualify that path through
the actual consumer's loading and combat windows.
Each program becomes a library hit as soon as its native
creation resolves; the returned Result still never reports a partial import ready.
`RendererOptions.backgroundPipelineLibrary` / `CreateAppOptions.backgroundPipelineLibrary`
starts a `background: true` prepare after first renderer readiness without awaiting it,
so menus and Engine Worker loading overlap native compilation. Its progress is
`inspect().backgroundWarmup` (`requested`, `completed`, `failed`, `elapsedMs`,
`state: 'idle' | 'running' | 'done' | 'failed'`). A failure logs one console warning and
never fails the renderer; affected pipelines compile on first use. Device recovery
replays the blocking library before readiness and restarts the background lane on the
replacement device after readiness. First readiness therefore does not imply that
the entire background library is warm, including after recovery.
The cumulative `warmup.elapsedMs` reports preparation wall time, including failed attempts.
Export refuses in-flight compilation so pending requirements cannot silently disappear.
Registration never drops resource identity because of cumulative source bytes or
entry counts. Records follow live native handles and their dependency owners through
weak content indices; there is no additional strong device reuse cache. Renderer
rosters retain their completed warmup graph for their generation, pending requests
retain dependencies until settlement, and command/bundle owners retain them through
execution and queue completion. Disposal clears the device indices. Collected
content keys are removed without requiring deterministic GC timing.

Source bodies belong to immutable CPU owners. Raw strings remain whole; runtime
does not split or copy them into a fragment pool. Source hashing occurs once on
actual identity demand, not while receiving unused startup/background libraries.
Managed factory descriptors
carry that owner through the existing code/label seam; a completed source hit does
not expand or hash WGSL. Explicit raw-text calls remain a cold input path.

`export(limits?)` exports the retained live graph selected at invocation, not an
implicit history of released resources. A route collector uses `collect()` to retain the current and subsequent graph, then
disposes the returned scope after export. This diagnostic holding is explicit and
ends on device disposal. Unknown native dependencies and in-flight work still fail
strictly. Output, transient allocation and input safety are finite action policies:
`PIPELINE_LIBRARY_LIMITS` defaults to 512 MiB conservative JSON output, 4 GiB logical
transient allocation and 65,536 entries. These are not live-resource capacities.
`temporaryBytes` includes source expansion, cloning/encoding and Worker transport;
the estimate is not a process-memory cap. Estimation precedes source expansion and
cloning, including JSON escaping and descriptors. A failure returns `limit-exceeded`
with `detail.kind='pipeline-library-limit'`, operation, limit, requested and maximum;
it changes no resource or preparation state and may be retried with another policy.
`prepare(manifest,{inputLimits})` declares its independent finite read policy. Default
export/read policies are compatible; a complete export must fit its declared matching
read policy. Increasing export limits never silently increases input permissions.

The optional internal `prepare` owner is a generation/roster object. Retention ends
with that owner; an ordinary successful `prepare()` does not grant permanent holding.
The portable manifest stays version 1 and contains full WGSL only when serialized.

The manifest version/backend and all dependency references are checked before native
creation. Native validation still enforces the current device's features and limits;
an incompatible or invalid library fails startup explicitly. Generate a library for the
supported device/profile family and refresh it when content changes. Exact source/state
keys prevent stale reuse but cannot predict unvisited gameplay. Browser/driver caches
may persist compiled code across launches; WebGPU does not expose persistence or guarantee
zero driver compilation at the next launch. Library warmup moves that work before play.

Managed Render selections admit an immutable final state during cold CPU preparation.
The optional internal `selectRender` / `selectCompute` seam binds that state to the
current native modules and layout. It queries the same device Program as raw requests
and warmup; ready and pending hits do not materialize or canonicalize a complete
native descriptor. Compute projection is applied before selection. Raw descriptors
remain a cold path, and absent optional selection support uses the existing factory.

`findRenderState` can borrow the state already admitted by warmup using a lazy
field projection and stage/layout dependencies. The material path uses the same
projection for equality and a true cold miss. The scan runs only on a local selection
miss; it does not create a parallel device index or hash complete state again.
