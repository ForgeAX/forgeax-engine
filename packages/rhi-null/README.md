# @forgeax/engine-rhi-null

> Headless no-op RHI backend for structural unit tests -- inject via `createRenderer(canvas, { rhi })`, zero GPU / DOM dependency. Covers the full `RhiDevice` surface with no-op brands and a per-device handle ledger so command-stream assertions (draw count / pass schedule / create-destroy pairing / bind-group assembly) work in `test:unit` without a real GPU.

## Access -- Channel 1 injection

```ts
import { rhi } from '@forgeax/engine-rhi-null';
import { createRenderer } from '@forgeax/engine-runtime';

// `canvas` is a required positional param. In headless CI hand it any object
// shaped like a canvas -- RhiNull never touches the DOM, so a minimal stub is
// enough (the dogfood tests use one; see packages/runtime/src/__tests__).
const canvas = { width: 1, height: 1 } as unknown as HTMLCanvasElement;
const created = await createRenderer(canvas, { rhi });
if (!created.ok) throw created.error;
const renderer = created.value;
```

The exported `rhi` singleton has the `RhiBackendPack`-mandated shape (`RhiInstance & { acquireCanvasContext; createShaderModule }`). `createRenderer` picks it up via Channel 1's `rendererOptions.rhi` escape hatch -- no backend auto-selection logic is modified, no `navigator.gpu` probe involved.

| Entry | Type | Purpose |
|:--|:--|:--|
| `rhi` | `RhiInstance & { acquireCanvasContext; createShaderModule }` | Singleton; inject into `createRenderer({ rhi })` |
| `rhi.requestAdapter(opts?, canvas?)` | `async fn` | Returns `ok(new RhiNullAdapter())` |
| `rhi.createShaderModule(device, desc)` | `async fn` | Returns `ok(ShaderModule)` without real compile |
| `rhi.acquireCanvasContext(canvas?)` | `fn` | Returns `ok(RhiNullCanvasContext)` for any canvas / null / undefined |
| `rhi.adapter.requestDevice()` | `async fn` | Returns `ok(new RhiNullDevice(queue, encoderFactory))` |
| `RhiNullDevice` | class `implements RhiDevice` | All `create*` mint legal brands + ledger entries; all `destroy*` fail-fast on double-destroy |
| `RhiNullQueue` | class `implements RhiQueue` | `submit` returns `ok`; `onSubmittedWorkDone` resolves immediately |

## Capabilities

`renderer.inspect().capabilities` reports the D-5 profile: every boolean cap is `true` except the three `@reserved-for-wgpu-native-only` fields (`multiDrawIndirect`, `pushConstants`, `textureBindingArray`), which are `false`. `maxColorAttachments` is 8. The headless backend maximizes structural coverage -- any `caps.X` gate in the engine codebase passes through:

| Cap | Value | Note |
|:--|:--|:--|
| `backendKind` | `'null'` | 4th union member alongside `'webgpu'` / `'wgpu-native'` / `'wgpu-webgl2'` |
| `compute` | `true` | |
| `timestampQuery` | `false` | Structural backend; GPU timing is refused |
| `indirectDrawing` | `true` | |
| `textureCompressionBc` | `false` | headless has no compression hardware (AC-06) |
| `textureCompressionEtc2` | `false` | headless has no compression hardware (AC-06) |
| `textureCompressionAstc` | `false` | headless has no compression hardware (AC-06) |
| `multiDrawIndirect` | `false` | `@reserved-for-wgpu-native-only` |
| `pushConstants` | `false` | `@reserved-for-wgpu-native-only` |
| `textureBindingArray` | `false` | `@reserved-for-wgpu-native-only` |
| `samplerAliasing` | `true` | |
| `firstInstanceIndirect` | `true` | |
| `storageBuffer` | `true` | |
| `storageTexture` | `true` | |
| `rgba16floatRenderable` | `true` | |
| `rg11b10ufloatRenderable` | `true` | |
| `float32Filterable` | `true` | |
| `maxColorAttachments` | `8` | >= 4 (HDRP deferred minimum) |
| `rayQuery` | `{ supported: false, reason: 'backend-has-no-ray-query' }` | `new RhiNullAdapter({ rayQuery: limits })` reports `{ supported: true, ...limits }` and admits BLAS/TLAS create/build/bind structurally: shared validators, BLAS-before-TLAS ordering, live/owned handles, built-TLAS binding. Nothing is traced. |

> [!WARNING]
> RhiNull is deliberately non-timing. Timestamp query creation returns a
> structured feature error and membership timing must terminate as
> `timestamp-query-unsupported`; do not turn the structural ledger into fake
> GPU evidence.

The adapter advertises `depth32float-stencil8` for structural descriptor replay.
`requestDevice` enables only requested advertised features and rejects unavailable
ones. Default devices retain an empty feature set; `device.limits` remains an
empty record. This enables descriptor/command bookkeeping, never depth pixels,
shader execution or GPU timing. Capability planning also reads `caps`.

## Handle bookkeeping

Every `create*` call on `RhiNullDevice` registers the returned handle in a per-device `Bookkeeper`. Each ledger row is a `HandleRecord`:

```ts
interface HandleRecord {
  readonly id: number;          // per-device monotonic
  readonly kind: string;        // 'Buffer' / 'Texture' / 'BindGroupLayout' / ...
  destroyed: boolean;           // flipped on first destroy
  readonly sourceDeviceId: number;  // cross-device validation
}
```

**Readback for assertions** -- the device ledger is an owner-local test concern. Public `Renderer` exposes no device; inject the RhiNull pack into a package-local construction test when counters are needed:

```ts
import type { RhiNullDevice } from '@forgeax/engine-rhi-null';

const device = ownerLocalDevice as RhiNullDevice;
device.totalDrawCount = 0;       // reset before a frame if you assert deltas
device.totalDispatchCount = 0;
renderer.draw(world);
const records = device.bookkeeper.allRecords(); // snapshot of all ledger rows
```

M3 unit tests read this to assert:

- **Create / destroy pairing** (`kind: 'Buffer'` count == `kind: 'Buffer'` with `destroyed === true` count)
- **Draw count >= 1** (`device.totalDrawCount` after `renderer.draw(world)`)
- **Compute dispatch count** (`device.totalDispatchCount`, including indirect dispatch)
- **Bind-group assembly counts** (`device.totalBindGroupCount`)
- **Pass schedule order** -- prefer the type-safe `renderer.perFramePassNames` (no cast needed); `device.framePassNames` is the same data on the cast `RhiNullDevice`
- **BGL / PSO shape** (ledger entries with `kind: 'BindGroupLayout'` / `kind: 'RenderPipeline'`)

**Handle-chain validation** -- `setVertexBuffer` / `setBindGroup` validate handle ownership. A handle issued by device A passed to device B returns `err({ code: 'rhi-not-available', expected, hint })`. A second `destroy` on the same handle returns `err({ code: 'destroy-after-destroy', expected, hint })`. Zero new `RhiErrorCode` members -- reuses existing closed-union codes (D-1).

## Pipeline `getBindGroupLayout`

`createRenderPipeline` and `createComputePipeline` return pipeline handles that carry a no-op `getBindGroupLayout(index)` method (D-2). The method returns a legal `BindGroupLayout` brand registered in the ledger, so the auto-layout path in `debug-draw.ts` and existing mock unit tests do not crash on a missing method.

## Boundaries

- **Structural only, never produces pixels.** RhiNull covers the command-stream protocol layer (buffer / texture / bind-group / pipeline / pass-encoder creation and submission). It does not execute shaders, write to GPU memory, or produce render-target contents. `getCurrentTexture()` returns a brand with no pixel data.
- **Does not replace dawn / browser pixel readback.** Smoke tests (`apps/hello/*`, `apps/learn-render/*`) still need a real GPU backend (`rhi-webgpu` or `rhi-wgpu`). RhiNull is for `test:unit` structural assertions, not visual verification.
- **No image-channel dependency** (charter P2). The README is ASCII-only; the backend has no screenshots, no pixel baselines, no render-target PNGs.
- **Per-renderer instances are independent.** Each `createRenderer({ rhi })` creates a fresh `RhiNullDevice` with its own `Bookkeeper`. Cross-instance handle pollution is impossible because each device's ledger keys on `sourceDeviceId`.
- **`'null'` union member meaning.** The 3 pre-existing backends (`webgpu` / `wgpu-native` / `wgpu-webgl2`) are unchanged. `'null'` is the 4th member, representing "no real GPU -- structural-only command-stream ledger." `render-graph` barrier insertion treats it as no-barrier (same equivalence group as `webgpu` / `wgpu-webgl2`).

## Distinction from vitest mocks

| Aspect | vitest mock (`vi.fn()`) | RhiNull (`createRenderer({ rhi })`) |
|:--|:--|:--|
| Surface | Partial stub (caller chooses what to mock) | Full `implements RhiDevice` (tsc-complete) |
| Ledger | None (assert `.toHaveBeenCalled()` on mocks) | `Bookkeeper.allRecords()` + `totalDrawCount` / `framePassNames` |
| Integration depth | Tests one function call at a time | Exercises real `createRenderer` -> `Result<Renderer>` -> `renderer.draw(frame)` path |
| Handle validation | None | Cross-device and double-destroy fail-fast |
| Render-graph coverage | Mock `RhiCommandEncoder` return values | Real pass scheduling through URP default pipeline |

Use vitest mocks for isolated unit tests (single function / class). Use RhiNull for structural integration tests that need the full engine lifecycle (renderer init -> draw -> command flow).

## Dependencies

- `@forgeax/engine-rhi` (workspace) -- interface contract SSOT.
- `@forgeax/engine-types` (workspace) -- POD types / `Result` SSOT.
- `@webgpu/types` (workspace) -- descriptor type alignment; no real GPU binding.

## Render bundles

Bundle recording counts commands without incrementing submitted device counters. Each
execution contributes its draws and bindings, rejects foreign bundles and destroyed
directly referenced buffers, and permits repeated execution. These are structural facts only;
Browser/Dawn pixel and native validation gates remain required.
