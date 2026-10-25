# @forgeax/engine-rhi-wgpu

> `import { rhi } from '@forgeax/engine-rhi-wgpu'` + `const adapter = (await rhi.requestAdapter()).unwrap()` — rendering through wgpu-wasm.

## Overview

This package is the dual-impl partner of `@forgeax/engine-rhi-webgpu`. Both export the same `@forgeax/engine-rhi` surface; the runtime `createRenderer` auto-select facade picks one at runtime based on `navigator.gpu` availability.

AI engine users do NOT import this package directly -- `Engine.create({ canvas })` / `createRenderer(canvas)` auto-selects Channel 2 (`rhi-webgpu`, `navigator.gpu`) or Channel 3 (`rhi-wgpu`, this package) transparently.

## Channel architecture

`createRenderer` uses a three-channel selection (plan-strategy section 7):

| Channel | Trigger | Backend | Context acquisition |
|:--|:--|:--|:--|
| 1 | `options.rhi` explicit escape hatch | caller-supplied | caller-supplied |
| 2 | `navigator.gpu` present | `rhi-webgpu` (static import) | `canvas.getContext('webgpu')` |
| 3 | `navigator.gpu` absent, or Channel 2 fails | `rhi-wgpu` (dynamic import) | wasm `createSurface(canvas)` |

Channel 3 loads the `engine-wgpu-wasm` bundle lazily when `requestAdapter()` needs it. `ensureReady()` optionally prewarms the same module. The wasm bundle (~0.53 MB gzip) is only downloaded when neither Channel 1 nor 2 succeeds, keeping browser-only bundles lean.

Native package builds select `forgeax-native` and call `ensureReady({ initFn })`,
where `initFn` initializes the explicit native Host and returns its full binding
namespace. The existing Promise cache still owns concurrency, successful
adoption and retry after failure. A missing native initializer rejects with
`RhiError` code `rhi-not-available`; the native dependency graph contains neither
the browser wgpu loader nor its WASM URL. Default browser builds retain the lazy
`@forgeax/engine-wgpu-wasm.ensureReady()` route.

`node --test scripts/forgeax/__tests__/rhi-native-loader.test.mjs` checks both
bundle graphs and actual WASM namespace initialization/parse through the ordinary
loader. Its native surface object qualifies admission only; browser/simulator
rendering remains a separate gate.

Device requests retain downlevel WebGL2 resource limits and derive texture
resolution limits from the actual adapter. A high-DPR canvas may exceed 2048
pixels when the adapter supports it; Surface validation still rejects extents
above the granted device limit. The real WebGL2 regression
`surface-resolution.browser.test.ts` covers the simulator's 2532×1170 canvas,
an extent above the actual limit, recovery to the valid extent, and complete
surface pixels after canvas-only portrait/landscape changes.

## `acquireCanvasContext(canvas)`

Single-entry surface for context acquisition. Replaces the deleted `createCanvasContext`.

```
function acquireCanvasContext(
  canvas: HTMLCanvasElement
): Result<RhiCanvasContext, RhiError>
```

The wasm surface path internally:
1. Gets the `RhiWgpuInstance` from the wasm module
2. Calls `instance.createSurface(canvas)` to create a wgpu Surface handle
3. Returns a branded `RhiCanvasContext` wrapping the Surface

After configuration, `getCurrentTexture()` follows the canvas drawing-buffer size.
When it changes, the context presents the previous image and reconfigures the
wgpu Surface before acquiring another image. Reconfiguration failures remain
structured errors; no image is acquired from the stale extent.

On failure returns `RhiError({ code: 'rhi-not-available' })` with `.hint` describing the cause.

Repeated `getCurrentTexture()` calls in one synchronous record/submit stack return
the same acquired texture. A microtask presents that lease once after submission;
the next frame acquires a new image. Reconfigure and unconfigure retire the same
lease and cancel its pending microtask by identity. This keeps scene and screen UI
passes alive through their shared submission without exposing native presentation
to Renderer consumers. Presentation failures retain their cause for the next RHI
boundary.

The next acquisition follows changed canvas drawing-buffer dimensions through
the existing configuration path. It retires any previous image before resizing
the native surface and refreshes its presentation proof; a rejected resize
returns the configuration failure without acquiring a stale image. Recorder
texture dimensions describe the configured surface, not an unaccepted canvas size.

AI users call this through `pack.rhi.acquireCanvasContext(canvas)` inside the runtime -- the runtime auto-selects between `rhi-webgpu` (which uses `canvas.getContext('webgpu')`) and `rhi-wgpu` (this path).

The command encoder forwards real render and compute passes into wgpu-wasm. Compute passes support pipeline/bind-group binding plus direct and indirect workgroup dispatch; they are not structural no-ops.

## `requestAdapter` and `compatibleSurface`

```
function requestAdapter(
  opts?: { compatibleSurface?: HTMLCanvasElement }
): Promise<Result<RhiAdapter, RhiError>>
```

When `compatibleSurface` is provided:
- The wasm path calls `RhiWgpuInstance.requestAdapterWithCanvas(canvas)` instead of `requestAdapter()`
- The `rhi-webgpu` fast path ignores this parameter (not needed for `navigator.gpu`)

This is needed by the wgpu GL backend, which requires a `compatible_surface` to enumerate adapters (plan-strategy D-9, requirements AC-11).

## Depth texture loads on WebGL2

The GLSL backend supports shaders that load depth textures with `textureLoad`
without sampling depth textures. It uses ordinary float samplers and `texelFetch`,
including helper arguments, array layers, mip levels and multisample indices.
The existing comparison-sampler path is unchanged. A shader that mixes depth
loads and depth sampling returns a structured pipeline failure: the current GLES
binding model does not provide separate raw and comparison sampler slots.
Depth/stencil textures have nearest defaults when no sampler is bound; ordinary
comparison sampler objects keep their own filtering and comparison state.
RHI Debug uses an independent load-only shader for depth readback.

## Relationship with `@forgeax/engine-wgpu-wasm`

This package is a TS-only thin shell. It:
- Imports `@forgeax/engine-wgpu-wasm` for wasm-bindgen types + `ensureReady`
- Wraps raw wasm exports into the `@forgeax/engine-rhi` interface shape
- Does NOT contain its own wasm bundle or Rust source

See `packages/wgpu-wasm/README.md` for the full wasm-bindgen method table.

## Exports

| Export | Kind | Description |
|:--|:--|:--|
| `rhi` | `RhiInstance` singleton | requestAdapter, acquireCanvasContext (the rhi-wgpu backend pack) |
| `ensureReady()` | async function | Optional WASM prewarming, or explicit native Host initialization |
| `requestAdapter(opts?)` | async function | Adapter request with optional `compatibleSurface` |
| `acquireCanvasContext(canvas)` | function | Canvas context acquisition via wasm Surface path |
| `createShaderModule(device, desc)` | async function | Async shader module factory |
| `err`, `ok`, `RhiErrorClass` | re-export | From `@forgeax/engine-rhi` |

## Constraints

Queue completion comes from the raw WASM queue's `onSubmittedWorkDone`.
It registers with the actual wgpu submission and asynchronously polls that native
device, observing the submission's existing HAL fence and retiring native
resources. All wrappers of one native queue share FIFO completion. The TypeScript
shim supplies a private timer driver and adds no GL fence or flush. Context loss,
native poll failure, bounded polling exhaustion and missing completion primitives
reject; they never become successful receipts. Real browser tests cover final
submissions, shared queue wrappers, readable pixels and context loss. Frame
callbacks and surface presentation are separate facts.

The driver calls native registration synchronously and polls a short-lived native
ticket from JavaScript, so native exceptions and WASM traps reject the Promise.
It releases the ticket on completion or failure and stops after 10,000 polls or
30 seconds, whichever is observed first. Suspended or busy host timers defer
observation until the next wake. That wake first polls the actual native ticket:
a completed ticket remains a valid receipt, while an incomplete ticket rejects
at the expired deadline without another wait. Host scheduling delay cannot alone
replace an available completion with a GPU timeout. If a trap also prevents Rust ticket release, an
`AggregateError` preserves the original failure as `cause` and both errors in
`errors`; retire that native realm. A rejected request does not block later FIFO
settlement. The real WebGL regression includes this failure path, copy-only
uploads, and earlier buffer-map ordering.

A polling exhaustion error retains bounded `detail`: elapsed time, poll count,
first-poll delay, maximum gap between polls, configured limits and the last false
completion observation. These are Host/native observation facts, not GPU duration;
they survive the Renderer error's ordinary cause chain without a profiler.

- Request the adapter with the compatible canvas before calling `rhi.acquireCanvasContext(canvas)`; the singleton retains the initialized instance for surface creation.
- The wasm bundle is lazily loaded and only downloaded when needed
- `adapter.features` reports supported features; `device.features` projects the
  actual enabled wgpu device features, using the same names. Feature-dependent
  replay admission consumes the device set.
- `device.caps` reports `false` for features unsupported by the wgpu GL backend

## Buffer mapping

`mappedAtCreation` and `mapAsync(WRITE)` retain disjoint JavaScript ranges only
for the current mapping. `unmap()` writes those ranges back before releasing the
native mapping; `mapAsync(READ)` discards JavaScript edits. `mapState`, offset and
overlap checks, cancellation, repeated unmap and destruction share that mapping
lifetime. The real WebGL2 `mapped-buffer.browser.test.ts` covers GPU copies and
vertex rendering from creation-mapped data, partial WRITE, READ and cleanup.

Unmap and destruction detach returned arrays when the host provides
`ArrayBuffer.transfer` or `structuredClone` with transfer. Restricted hosts
without both primitives retain ordinary, inert copies: their `byteLength` does
not become zero, but subsequent writes cannot reach the retired GPU mapping.
The mapping remains usable on those hosts; no persistent CPU buffer mirror is
kept. Replay bootstrap consumes writable mapping; ordinary renderer uploads use
the queue, and GPU readback consumes READ mapping.

## destroyBuffer / destroyTexture (feat-20260612)

Per-handle destroyed-state bookkeeping in the TS shim layer mirrors `rhi-webgpu` behavior. Wgpu's Rust `Buffer::destroy()` / `Texture::destroy()` are idempotent void (not drop-trait panic, confirmed by research F-1 correction). The shim adds fail-fast on second destroy with `'destroy-after-destroy'` error code via a per-handle `destroyed: boolean` field -- never crossing the wasm boundary for state checking (plan-strategy D-6).

Implementation locations:
- `packages/rhi-wgpu/src/device.ts` -- `destroyBuffer` / `destroyTexture` methods
- `packages/rhi-wgpu/src/buffer.ts` -- per-handle destroyed flag in the buffer wrapper

## Render bundles

`createRenderBundleEncoder` uses the shared render-command adapter, including wrapped
buffer resolution, 64-bit offsets and dynamic-offset slices. `finish` creates an immutable
WASM bundle; `executeBundles` preserves reuse without consuming its JS handle. Native
wgpu enforces attachment and resource compatibility. The source-built WASM artifact must
match this checkout; a stale artifact without the bundle methods is an error.

wgpu 30 does not expose native bundle debug markers. The WASM encoder validates balanced
debug groups, while RHI Debug retains their markers in captured commands.

Texture uploads and every command-copy direction use RHI's `textureCopyOrigin`
to resolve sequence or dictionary coordinates. Omitted axes default to zero;
the WASM bridge only flattens that admitted origin into its native arguments.

Command, compute-pass, render-pass and render-bundle adapters require the pinned
WASM methods they forward. Pass-only operations are excluded from the bundle
contract. Capability admission remains at the device/backend; command adapters
never treat a missing native operation as a successful no-op.
