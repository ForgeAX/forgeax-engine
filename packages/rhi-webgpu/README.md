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
| `requestDevice(opts?)` | `(RequestDeviceOptions) => Promise<Result<RhiDevice, RhiError>>` | Entry 1: navigates `navigator.gpu` (default) or an injected `gpu` provider; error paths 1/2/3 originate here |
| `createShaderModule(device, desc)` | `(RhiDevice, { code, label? }) => Promise<Result<ShaderModule, RhiError>>` | Entry 2: async shader compile; `'shader-compile-failed'` forwards every `GPUCompilationMessage` field to `RhiError.detail.compilerMessages` |
| `rhi` | `{ requestDevice, createShaderModule }` const singleton | Progressive-disclosure entry (charter proposition 1); see `Engine.create({ rhi, canvas })` and `import { rhi } from '@forgeax/engine-rhi-webgpu'` |
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

## Timestamp write contract

Timestamp capture uses the WebGPU pass descriptor `timestampWrites` field on
`beginRenderPass` / `beginComputePass`. The shim maps the opaque ForgeaX
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

## Intentional differences (vs spec / wgpu)

- **`'x' in src` guard transit**: spec `?: T` vs forgeax `?: T | undefined` differ under `exactOptionalPropertyTypes:true`; the shim guards each field per F-3 anti-pattern 2.
- **`device.lost` single source**: this package only forwards the spec Promise; fan-out is the engine's job (`LostListenerRegistry`).
- **Error message keyword classification**: `requestDevice` failure routes via `feature` / `limit` keyword detection; mock and real-GPU formats may differ.
- **Real-path implementation (M4-M5 + query closure)**: command recording + queue submit + queue.writeBuffer landed; query-set creation/destruction, occlusion begin/end, resolve, and timestamp pass writes are forwarded or capability-gated. Render bundle creation, finish and execution are implemented with native WebGPU validation.
- **Escape hatch tear-down**: `getRawDevice` (no prefix) removed in `feat-20260508-rhi-surface-completion` M4 (AC-RSC-05); the single sanctioned hatch is `_internal_getRawDevice` confined to the AC-08 (h) allow-list.
- **destroyBuffer / destroyTexture (feat-20260612)**: per-handle destroyed-state bookkeeping in shim layer (`WeakMap<Handle, { destroyed: boolean }>`) on top of the spec's idempotent-void `GPUBuffer.destroy()` / `GPUTexture.destroy()`. Dual-backend behavior is symmetric: both shims track destroyed boolean per handle, fail-fast on second destroy with `'destroy-after-destroy'` error code, and never depend on wasm panic interception (plan-strategy D-6). Implementation at `packages/rhi-webgpu/src/device.ts`.

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
- [`@forgeax/engine-runtime`](../engine) — async factory entry (M3 injects via `rhi.requestDevice()`).
