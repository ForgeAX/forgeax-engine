# @forgeax/engine-debug-draw

> Immediate-mode debug visualization layer: one-line `line()` / `sphere()` / `aabb()` / `frustum()` / `arrow()` / `axes()` per frame, auto GPU flush. Wireframe overlay rendered on top of your scene -- no ECS, no component registration, no shader manifest.

[![npm](https://img.shields.io/badge/npm-%40forgeax%2Fengine--debug--draw-blue)](https://www.npmjs.com/package/@forgeax/engine-debug-draw)
[![ESM-only](https://img.shields.io/badge/module-ESM%20only-brightgreen)](https://nodejs.org/api/esm.html)
[![dependencies](https://img.shields.io/badge/deps-rhi%20%7C%20math%20%7C%20types-333)]()

## 60-second quickstart

```ts
import { createDebugDraw } from '@forgeax/engine-debug-draw';
import { createShaderModule } from '@forgeax/engine-rhi-webgpu';
import { createApp } from '@forgeax/engine-app';

// ---- runtime path (zero-config auto-flush) ----
const app = await createApp({ canvas });
app.debugDraw.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);  // red line
app.debugDraw.sphere([0, 0, 0], 1, [0, 1, 0, 1]);         // green sphere
// app.debugDraw is auto-flushed at the end of every frame -- no manual flush needed

// ---- low path (hand-rolled RHI) ----
const r = await createDebugDraw({ device, queue, createShaderModule });
if (!r.ok) { /* handle r.error */ }
const dd = r.value;
dd.line([0, 0, 0], [1, 1, 1], [1, 0, 0, 1]);
dd.aabb([-1, -1, -1], [1, 1, 1], [0, 0, 1, 1]);
dd.frustum(cameraViewProj, [1, 1, 0, 1]);
dd.flush(encoder, swapChainView, cameraViewProj);
// dd.destroy();  // when done
```

All shapes are **line-list** wireframe (never filled). No persistent storage -- every frame you call shape APIs anew.

## Package positioning

`@forgeax/engine-debug-draw` keeps shape generation at the leaf layer alongside `@forgeax/engine-math`; its RenderFeature adapter consumes only the declarative render contract. The adapter takes the active view roster, declares one frame-owned primitive buffer, and emits view-scoped line draws with each view's projection and target. Dependencies are `@forgeax/engine-render` + `@forgeax/engine-rhi` + `@forgeax/engine-math` + `@forgeax/engine-types`. It does **not** depend on `engine-ecs` / `engine-runtime` / `engine-render-graph` / `engine-shader`.

| Layer | Package | Depends on |
|:--|:--|:--|
| App | `engine-runtime` | debug-draw (thin wiring glue in `debug-draw-glue.ts`) |
| Convenience | **`engine-debug-draw`** | rhi + math + types |
| Leaf | `engine-math` | (none) |
| Leaf | `engine-rhi` | (none) |
| Leaf | `engine-types` | (none) |

Runtime auto-attach wiring lives in `packages/runtime/src/debug-draw-glue.ts` -- the debug-draw package itself stays dependency-free of the runtime graph/pipeline machinery.

## API reference

### `createDebugDraw(opts)` -- factory

```ts
export type CreateDebugDraw = (
  opts: DebugDrawOptions,
) => Promise<Result<DebugDraw, DebugDrawError>>;
```

| Option | Type | Default | Purpose |
|:--|:--|:--|:--|
| `device` | `RhiDevice` | **required** | GPU device for buffer + pipeline creation |
| `queue` | `RhiQueue` | **required** | GPU queue for per-frame `writeBuffer` uploads |
| `createShaderModule` | `(device, desc) => Promise<Result<ShaderModule, RhiError>>` | **required** | Injected WGSL compiler (import from `@forgeax/engine-rhi-webgpu`) |
| `format` | `TextureFormat` | `'bgra8unorm'` | Swap-chain color target format |
| `depthFormat` | `TextureFormat` | `undefined` | Depth-stencil format; required when `depthMode === 'less-equal'` |
| `initialVertexCapacity` | `number` | `1024` | Initial GPU vertex buffer capacity (overridable; see [Capacity behavior](#capacity-behavior)) |
| `maxVertexCapacity` | `number` | `1_000_000` | Hard upper bound on vertices per flush (see [Capacity behavior](#capacity-behavior)) |
| `depthMode` | `'always' \| 'less-equal'` | `'always'` | Depth comparison for the overlay PSO (see [Depth mode](#depth-mode)) |

Returns `Promise<Result<DebugDraw, DebugDrawError>>` -- the factory is async because GPU shader module compilation must be awaited.

### `DebugDraw` -- instance

#### Shape API (all return `void`)

All vertex accumulation is immediate (no deferred queue, no ECS component). Color parameter accepts `ColorLike` -- a plain `[r, g, b, a?]` tuple, a `Float32Array`, or a branded `Color` from `@forgeax/engine-math`.

| Method | Vertices pushed | Notes |
|:--|:--|:--|
| `dd.line(a, b, color)` | 2 | Single line segment from `a` to `b` |
| `dd.sphere(center, radius, color, segments?)` | $3 \times 2 \times \text{segments}$ | Three orthogonal great-circle rings (XY / XZ / YZ planes); `segments` defaults to 16, yielding **96 vertices** |
| `dd.aabb(min, max, color)` | 24 | 12 edges (4 along each axis) |
| `dd.frustum(viewProj, color)` | 24 | Extracts 8 corner points from the view-projection matrix, draws 12 edges; near-singular VP triggers `console.warn` + no-op (no vertices pushed) |
| `dd.arrow(start, end, color, tipLength?)` | 10 | Body segment + 4-line arrowhead at `end`, oriented along the arrow direction (`quat.fromUnitVectors`). `tipLength` defaults to `\|end − start\| / 10`; a zero-length arrow emits only the 2-vertex body. Maps Bevy `gizmos.arrow` |
| `dd.axes(worldMat, length)` | 30 | A transform's local coordinate frame as three arrows — **X = red, Y = green, Z = blue** — originating at the world matrix's translation (col 3) and pointing `length` along its local X/Y/Z (columns 0/1/2, scale included). Maps Bevy `gizmos.axes` |

> [!IMPORTANT]
> All vertices are emitted as `line-list` topology. Wireframe spheres are not tessellated triangles -- they are three orthogonal circles made of line segments. This is a visual approximation, not a pixel-accurate sphere.

#### `dd.flush(encoder, view, viewProj)` -- GPU upload

```ts
flush(
  encoder: RhiCommandEncoder,
  view: TextureView,
  viewProj: Mat4,
): Result<void, DebugDrawError>;
```

1. Writes CPU staging to GPU vertex buffer via `queue.writeBuffer` (no `mapAsync`, no staging buffer)
2. Uploads `viewProj` as uniform mat4x4 (64 bytes)
3. Calls `encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: 'load' }] })` -- preserves existing scene content
4. Issues `draw(vertexCount)` with the pre-compiled line-list PSO
5. Resets CPU staging vertex count to 0 for the next frame

If staging is empty (no shape calls this frame), the flush returns `ok(undefined)` immediately and **skips the GPU pass entirely** -- no `beginRenderPass`, no draw calls, zero visual side effect.

`dd.encode(pass, viewProj)` is the graph-owned variant: it performs the same upload and draw but accepts an already-open `RhiRenderPassEncoder`. The caller owns attachments and `pass.end()`; runtime pipelines use this form so debug drawing cannot create a nested render-pass lifetime outside RenderGraph.

> [!NOTE]
> `viewProj` is required. Omitting it returns `Result.err({ code: 'viewProj-required', hint: 'Pass a viewProj Mat4 to flush(encoder, view, viewProj).' })`.

#### `dd.destroy()` -- lifecycle

Releases GPU vertex buffer, uniform buffer, pipeline, and bind group. After `destroy()`:

- Shape calls (`line` / `sphere` / `aabb` / `frustum`) become **no-ops** -- no vertices are pushed to staging
- A single `console.warn` is emitted on the first post-destroy shape call (de-duplicated across subsequent calls)
- `flush()` returns `Result.err({ code: 'flushed-after-destroy' })`

> **Runtime auto-attach path** (`app.debugDraw`): the runtime owns the lifecycle.
> Do **not** call `app.debugDraw.destroy()` yourself; `app.dispose()` releases it.
> The low path (`createDebugDraw(...)` directly) is the only path where you call
> `dd.destroy()` explicitly.

### Depth mode

| Mode | `depthWriteEnabled` | `depthCompare` | Visual effect |
|:--|:--|:--|:--|
| `'always'` (default) | `false` | `always` | Overlay always visible on top of scene geometry (editor-style gizmo) |
| `'less-equal'` | `false` | `'greater-equal'` (native Reverse-Z) | Overlay respects scene depth -- lines behind opaque objects are occluded |

The mode names express distance: `less-equal` means nearer or equal. Camera
matrices and depth attachments use the Engine Reverse-Z convention.

A single `DebugDraw` instance compiles exactly **one** PSO at construction time (determined by the `depthMode` option). To mix both modes in the same frame, create two separate instances:

```ts
const ddAlways = await createDebugDraw({ device, queue, createShaderModule, depthMode: 'always' });
const ddLEqual = await createDebugDraw({ device, queue, createShaderModule, depthMode: 'less-equal' });
// Draw with each, flush separately, combine to two PNGs
```

##### Depth attachment for `'less-equal'` (low path only)

`depthMode: 'less-equal'` requires a depth `TextureView` at flush time. The runtime
auto-attach path (`app.debugDraw`) receives this from the render-graph context
automatically; the **low path** (caller-driven `flush()`) must inject it via the
`@internal` `dd._setDepthView(view)` accessor before each frame's `flush()`. The
underscore + `@internal` JSDoc marks it as a package-internal escape hatch — it is
intended for `apps/hello/debug-draw/` and the runtime glue, not third-party callers.

```ts
// Low-path depth setup
const depthTex = device.createTexture({ ..., format: 'depth24plus', usage: RENDER_ATTACHMENT });
dd._setDepthView(depthTex.createView()); // before flush()
dd.flush(encoder, swapchainView, viewProj);
```

### Capacity behavior

The CPU staging buffer starts at `initialVertexCapacity` (default: **1024 vertices**, approx 16 KB at 16 B/vertex). When shape calls exceed this:

| Condition | Behavior |
|:--|:--|
| Staging count exceeds current capacity but under `maxVertexCapacity` | **Double-resize**: capacity grows to $2 \times n$ (capped at `maxVertexCapacity`); `console.warn` emitted with old and new capacities |
| Would exceed `maxVertexCapacity` (default: **1,000,000 vertices**, approx 16 MB) | **Truncation**: vertices up to the limit are flushed; excess is discarded; one bounded `console.warn` is emitted for that frame |

Resize warnings describe a resize event. A truncation warning is emitted at most once between
successful `flush()` calls; the warning state and CPU staging reset together after each successful
flush, so a small next frame is quiet and starts with no overflow geometry.

The `INITIAL_VERTEX_CAPACITY` / `MAX_VERTEX_CAPACITY` / `VERTEX_STRIDE_BYTES` constants are exported for unit-test consumption:

```ts
import { INITIAL_VERTEX_CAPACITY, MAX_VERTEX_CAPACITY, VERTEX_STRIDE_BYTES } from '@forgeax/engine-debug-draw';
// INITIAL_VERTEX_CAPACITY === 1024
// MAX_VERTEX_CAPACITY     === 1_000_000
// VERTEX_STRIDE_BYTES     === 16   (12 B position float32x3 + 4 B color unorm8x4)
```

## Error codes

`DebugDrawErrorCode` is a **closed union**. Exhaustive `switch (err.code)` needs no default fallback. Each error carries `.code` / `.expected` / `.hint` / `.detail` (per [AGENTS.md](../../AGENTS.md) Error model).

| `err.code` | When | `.hint` | `.detail` |
|:--|:--|:--|:--|
| `'pipeline-create-failed'` | `device.createRenderPipeline()` or shader compilation rejected | `Pipeline creation failed: ${rhiError}. Check WGSL syntax, vertex layout, and depth-stencil state.` | `{ rhiError: string }` |
| `'buffer-allocation-failed'` | `device.createBuffer()` for GPU VBO or uniform buffer failed | `Buffer allocation failed: ${rhiError}. Check available device memory and buffer usage flags.` | `{ rhiError: string }` |
| `'flushed-after-destroy'` | `flush()` called on an already-destroyed instance | `DebugDraw was destroyed; create a new instance via createDebugDraw().` | `{}` |
| `'viewProj-required'` | `flush()` called with `undefined` / `null` / missing `viewProj` | `Pass a viewProj Mat4 to flush(encoder, view, viewProj).` | `{}` |

`DebugDrawError` is a structured four-field object:

```ts
interface DebugDrawError {
  readonly code: DebugDrawErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: DebugDrawErrorDetail;
}
```

The `.detail` field is a discriminated union narrowed by `.code` -- `switch (err.code)` gives TypeScript-narrowed access to the concrete detail shape without `as` casts.

## Distinction from `@forgeax/engine-rhi-debug`

These two packages share the word "debug" but address **orthogonal concerns**:

| | `@forgeax/engine-debug-draw` | `@forgeax/engine-rhi-debug` |
|:--|:--|:--|
| **Purpose** | Gameplay gizmo: visualize positions, colliders, camera frustums in real-time at runtime | GPU frame inspector: record every RHI call, replay deterministically, inspect draw-by-draw bindings and RT |
| **When active** | Always (opt-in per call site); tree-shaken when `app.debugDraw` is not imported | Only when `FORGEAX_ENGINE_RHI_DEBUG=1` is set in the environment |
| **User** | AI agent writing gameplay code / debugging physics / tuning camera | AI agent debugging GPU pipeline / shader miscompile / frame capture |
| **Output** | Wireframe lines drawn on the swap-chain (visible to the human eye) | Tape file (`.jsonl` + binary blob pool); RT PNGs written to disk |
| **Deps** | `rhi` + `math` + `types` | `rhi` + `types` + `rhi-webgpu` (proxy wrapping) |
| **ECS required** | No | No |
| **Render-graph** | No (package itself); runtime auto-attach lives in `engine-runtime` | No |

Think of `engine-debug-draw` as the **"`Debug.DrawLine`"** of forgeax, and `engine-rhi-debug` as the **"RenderDoc capture"** of forgeax. Both are essential debugging tools, but one draws on the screen and the other records what crossed the GPU API boundary.

## Design rationale

<details>
<summary>Why inline WGSL instead of ShaderRegistry?</summary>

Debug-draw shaders are a single, frozen vertex+fragment pair with a fixed vertex layout (`position: float32x3 + color: unorm8x4`). The `ShaderRegistry` / `MaterialShader` / naga_oil compose pipeline exists to handle variant explosion across PBR, custom BRDFs, and pipeline manifests -- none of which apply to a line-list debug overlay. Dependency on `engine-shader` would pull in the entire shader compilation infrastructure for a 20-line WGSL snippet. The custom WGSL lives inline in `debug-draw.ts` and compiles via direct `device.createShaderModule` + `device.createRenderPipeline` calls.
</details>

<details>
<summary>Why CPU staging + queue.writeBuffer instead of mapAsync?</summary>

`queue.writeBuffer` is a synchronous CPU-to-GPU copy that does not require a staging buffer or a fence. The debug-draw vertex count is small relative to scene geometry (typically hundreds of vertices, not millions), and the entire staging array fits in CPU memory trivially. `mapAsync` would add an async round-trip per frame, which is unnecessary overhead for an overlay that redraws from scratch every frame anyway.
</details>

<details>
<summary>Why no triangle-list fill?</summary>

v1 is exclusively line-list topology (OOS-1, OOS-10). All shapes decompose to line segments: `sphere` is 3 orthogonal great-circle rings, `aabb` is 12 edges, `frustum` is 12 edges. GPU line width is restricted to 1px on most platforms (OOS-5), so wireframe is inherently thin -- this is the expected visual for a debug overlay, not a rendering defect. Filled triangle-based spheres and boxes would require a second PSO and a different vertex layout, which is deferred to v2.
</details>

<details>
<summary>Why no depthBias parameter?</summary>

In `'always'` mode, depth is never tested -- bias is irrelevant. In `'less-equal'` mode, z-fighting between the line overlay and the underlying triangle mesh is possible but minor (line-list vs triangle-list are different topologies). A `depthBias` numeric parameter is deferred to a future feature (OOS-3). If you need it today, create two `DebugDraw` instances -- one for `always` (on-top annotations) and one for `less-equal` (depth-occluded lines).
</details>

## Edge cases

| Scenario | Behavior |
|:--|:--|
| Frame with zero shape calls | `flush()` returns `ok(undefined)` immediately; no `beginRenderPass`, no draw calls |
| `destroy()` then `line()` / `sphere()` / `aabb()` / `frustum()` | No-op (no vertices pushed); single `console.warn` on first post-destroy call |
| `destroy()` then `flush()` | `Result.err({ code: 'flushed-after-destroy' })` |
| `flush()` without `viewProj` | `Result.err({ code: 'viewProj-required' })` |
| Near-singular view-projection matrix on `frustum()` | `console.warn` + no-op for that frame (zero vertices pushed) |
| Exceeding `maxVertexCapacity` | Truncation warning; vertices up to the limit are flushed |
| Consecutive `flush()` calls with no shape in between | First flush resets staging to 0; second flush returns `ok(undefined)` immediately |
| Massive `segments` on `sphere()` (e.g., `segments=10000`) | Produces $3 \times 2 \times 10000 = 60000$ vertices; may trigger capacity resize but otherwise works correctly |
