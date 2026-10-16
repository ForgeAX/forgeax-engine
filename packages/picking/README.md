# @forgeax/engine-picking

Screen-to-entity, vertex-level, and tile-cell picking as free functions. Tier 2.2
package extracted from `@forgeax/engine-runtime`
(feat-20260705-runtime-tier2-decomposition M2) so an AI user loads only the
picking concept surface — not the whole renderer — when the task is "turn a
screen coordinate into an entity / vertex / tile". First runtime-downstream
engine package: `@forgeax/engine-picking` depends on `@forgeax/engine-runtime`,
never the reverse.

## 30-second self-introduction

- **`pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)`**
  — unprojects a viewport-relative screen coordinate into a world-space ray
  through the camera, walks every renderable archetype, ray-AABB tests each
  pickable mesh's world-space bounding box, and returns the nearest
  `PickHit { entity, point, distance }` (or `undefined` on a miss). AABB
  granularity is intentional; use `pickTriangle` when exact surface and
  occlusion ordering are required.
- **`viewportToWorld(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)`**
  — exposes the same camera unprojection as a world-space `Ray` for cursor
  placement, gizmos, and custom plane/triangle queries.
- **`pickDisplay` / `computeDisplayScreenRay`** — explicit display-space
  entrypoints. They consume the effective `BarrelDistortionMapping` from the
  submitted frame, map the displayed physical pixel once, then use the existing
  unwarped camera math. The submitted mapping is mandatory, including its
  identity case; absent, retired, lost, or zero-size frame contexts return a
  miss. Legacy `pick` and `viewportToWorld` remain unwarped APIs.
- **`pickVertexDisplay` / `pickVertexOnEntityDisplay`** — display-space vertex
  queries. They project each candidate back through the same scene-to-display
  inverse before applying the optional physical-pixel radius and sorting, so a
  nonlinear warp cannot change which vertex is closest merely by correcting the
  pointer.

> [!WARNING]
> An omitted `barrelDistortion` field means that no accepted submitted display
> context is available. Treat it as a miss and wait for a new frame. An
> identity query is valid only with an explicit submitted mapping whose
> `strength` is `0`.
- **`pickTriangle`** — exact current-pose CPU triangle query for a screen ray. It
  transforms indexed or non-indexed triangle-list vertices into world space,
  returns the nearest world point, distance, barycentric weights, entity,
  triangle index, and optional Catalog GUID, or reports `unavailable` when
  CPU geometry or a valid current skinned pose cannot be tested.
- **`pickVertexOnEntity` / `pickVertex`** — per-triangle vertex-level queries
  (editor vertex-snapping workflow). Three-state static-dispatch overload:
  without options -> `VertexHit | undefined`; with `{ limit: N }` -> `VertexHit[]`
  sorted by `screenDist`. `pickVertexOnEntity` queries one entity; `pickVertex`
  walks the whole scene (AABB coarse cull, then per-entity vertex collect).
- **`pickTile(world, tilemapEntity, worldX, worldY)`** — cell-level Tilemap query:
  converts world coordinates through the full inverse of the propagated
  `GlobalTransform.world` affine matrix, walks child `TileLayer`s in descending
  `layerOrder`, and returns `Result.ok(PickTileHit { layerEntity, cellX, cellY,
  tileId })` for the topmost non-zero cell, `Result.ok(null)` for empty /
  out-of-bounds, or `Result.err(PickTileError)` for a structural break.
- **`PickError` / `PickErrorCode`** — closed single-member error union
  (`'camera-component-missing'`); the SSOT for the picking error surface. A
  `cameraEntity` without a `Camera` component throws `PickError`; ordinary "ray
  hit nothing" outcomes return `undefined` / `[]` (error channel physically
  separated from the miss channel, charter P3).
- **`pick-core`** (internal) — the shared skeleton (camera validation ->
  `view = invert(GlobalTransform.world)` -> projection branch -> `screenToRay` ->
  `readWorldMatrix`) that `pick` and `pickVertex*` both consume. Single source of
  truth (architecture-principles §2); the AI user never imports it directly.

### 30s hands-on example

```ts
import { pick, type PickHit } from '@forgeax/engine-picking';
import { MeshRenderer } from '@forgeax/engine-render';
import { propagateTransforms } from '@forgeax/engine-scene';

// Caller resolves GlobalTransform.world for the current frame first (D-9 contract):
propagateTransforms(world);

const hit: PickHit | undefined = pick(
  world,
  cameraEntity,
  pointerX, pointerY,        // viewport-relative, y-down, top-left origin
  canvas.width, canvas.height,
);
if (hit) {
  // hit.entity: the picked EntityHandle; hit.point: world-space AABB entry;
  // hit.distance: entry distance along the ray (>= 0)
  world.set(hit.entity, MeshRenderer, { materials: [highlight] });
}
```

## API surface

### Screen-to-entity (`pick`)

| Function | Signature | Return |
|:--|:--|:--|
| `pick` | `(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)` | `PickHit \| undefined` (nearest hit, or `undefined` on miss) |

`PickHit = { entity: EntityHandle; point: Vec3Like; distance: number }`. No
`face` / `uv` / `normal` — AABB picking has no triangle resolution, so those
would be a lie (use `pickTriangle` or `pickVertex` for precise geometry). Both `perspective`
and `orthographic` camera projections are supported. Reads the resolved
`GlobalTransform.world` mat4 directly (feat-20260601 D-3), so the camera + candidates
must have propagated transforms for the current frame.

### Display-space interaction

```ts
import { pickDisplay } from '@forgeax/engine-picking';

const hit = pickDisplay(
  world,
  outputPixelX,
  outputPixelY,
  submittedReceipt.barrelDistortion,
  outputWidth,
  outputHeight,
);
```

Coordinates are continuous physical output pixels. The host first converts the
CSS pointer through the actual canvas/viewport rectangle and output extent; it
does not add a half-pixel offset. Out-of-viewport and crop misses return
`undefined` before the math layer's normal screen clamp. Reuse the same receipt
mapping for labels, crosshairs, and display-space queries so a newer ECS camera
component cannot disagree with the frame on screen. The App
`subscribeBrowserFrameSubmitted(canvas, listener)` helper forwards the
deep-frozen mapping and frame identity from the accepted browser submission;
unsubscribe it when the canvas or renderer is retired. A lost or zero-size
context must be discarded and reacquired through the existing App/Renderer
recovery path. The width and height arguments are an explicit check against
`mapping.width` and `mapping.height`; a mismatch, an undefined mapping, or an
identity guess without a submitted mapping returns a miss. Display picking
never falls back to the live World camera.

### Screen-to-world (`viewportToWorld`)

| Function | Signature | Return |
|:--|:--|:--|
| `viewportToWorld` | `(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)` | `Ray \| undefined` |

The returned ray uses the same top-left/y-down viewport coordinates as `pick`.
It is the low-level cursor-to-world front door: intersect it with the game
surface you own, then place an entity or debug primitive at the result.

> [!IMPORTANT]
> **Viewport validity** — if either viewport dimension is zero, negative,
> `NaN`, or `Infinity`, `pick`, `viewportToWorld`, `pickVertex`, and
> `pickVertexOnEntity` return their ordinary no-ray/no-hit shape (`undefined`
> or `[]`). They do not delegate an invalid viewport to a fabricated origin
> ray. Restore positive, finite dimensions and retry on the same World; the
> normal mesh, vertex, and ray results recover without rebuilding the scene.

### Vertex-level (`pickVertex` / `pickVertexOnEntity`)

| Function | Signature | Return |
|:--|:--|:--|
| `pickVertexOnEntity` | `(world, cameraEntity, screenX, screenY, vpW, vpH, entity, options?)` | Without `options`: `VertexHit \| undefined` |
| `pickVertexOnEntity` | `(..., entity, { limit })` | `VertexHit[]` (sorted by `screenDist` asc, empty on miss) |
| `pickVertex` | `(world, cameraEntity, screenX, screenY, vpW, vpH, options?)` | Without `options`: `VertexHit \| undefined` |
| `pickVertex` | `(..., { limit })` | `VertexHit[]` (globally sorted by `screenDist` asc, empty on miss) |

`VertexHit = { entity, vertexIndex, worldPos: Vec3Like, screenDist, worldDist, deformed }`.
Only `triangle-list` submeshes participate. `worldPos` is the current CPU
Morph/Skin pose; `deformed=true` means position deformation was evaluated. Both the
single-entity and whole-scene query use current bounds. Behind-camera vertices
are excluded. Unavailable CPU poses yield no candidates (`undefined` / `[]`);
use `pickTriangle` to distinguish an unavailable pose from a miss. Explicit
`Instances` are omitted because `VertexHit` has no instance ordinal.

> [!IMPORTANT]
> **`propagateTransforms` precondition (D-9)** — call
> `propagateTransforms(world)` (exported from `@forgeax/engine-runtime`) for the
> current frame before `pick` / `pickVertex*`. These functions read
> `GlobalTransform.world` column-major mat4 directly; they never re-propagate. The
> contract is identical across `pick` and `pickVertex*`.

### Exact triangle (`pickTriangle`)

| Function | Signature | Return |
|:--|:--|:--|
| `pickTriangle` | `(world, cameraEntity, screenX, screenY, vpW, vpH, options?)` | `TrianglePickResult` |

`TrianglePickResult` is a closed three-state result: `hit` contains the
nearest `TriangleHit`; `miss` means every candidate was tested and no triangle
intersects the ray; `unavailable` names intersecting entities whose CPU
geometry, current Morph/Skin pose, or explicit instance transforms cannot be
tested. For an entity carrying `Instances`, the picker reads World-owned
`Instances.transforms`; a hit includes the zero-based `instanceIndex`.
No Renderer or collection resolver is needed. Pass
`AssetRegistry.guidOf` as `assetGuidOf` when provenance is needed. The query
does not mutate the World or own an asset registry.

Morph uses the live `MorphWeights.weights` in target order, applying relative
position deltas before Skin: $P'=P+\sum_k w_k\Delta P_k$. Entity weights override
authored mesh defaults: glTF/FBX scene producers materialize those defaults into
`MorphWeights`; a raw World entity without that component is neutral, as in
render extraction. Zero weights and normal/tangent-only targets preserve source
positions and bounds; omitted position deltas are valid. Active position Morph derives bounds from the same projected positions, including explicit
instances. Invalid weights or active target data report `morph-pose-unavailable`
and cannot be culled using rest bounds.

For a skinned mesh, propagate transforms after advancing animation and before
querying. `pickTriangle` reads `Skin.skeleton`, current `Skin.joints` world
matrices, CPU `skinIndex`/`skinWeight` and position attributes. It computes
$P_w = \sum_{i=0}^{3} w_i(J_i B_i^{-1})[P,1]$ with the same affine XYZ and
four influences as the Standard skin shader. The mesh node's transform is
ignored, and weights are not renormalized. A fresh posed world AABB replaces
the rest AABB, so motion outside import-time bounds remains pickable.

| Query property | Contract |
|:--|:--|
| Work | $O(J+V+T)$ per skinned entity: build joint palette and world vertices once, reject using posed bounds, then test supported triangles |
| Scratch | $12V+64J$ bytes for posed positions and palette, plus bounded query scratch; Morph+Skin reuses the one positions buffer; joints are consumed synchronously without extra matrix copies |
| Pose lifetime | Query-local; no retained pose cache, GPU readback, asynchronous wait, or World writes |
| Result | Existing nearest-world-distance, triangle ordinal, barycentric weights, world point and GUID resolver |
| Invalid skin | Missing/dangling joints, unavailable skeleton, malformed/nonfinite attributes or matrices, or Skin with Instances return `skinned-pose-unavailable` |
| Unavailable bounds | An unknown pose cannot be excluded using rest bounds; it conservatively makes the query unavailable |
| Geometry scope | CPU mesh triangles under skeletal deformation; material height displacement, shader-authored deformation, clipping and alpha coverage are not evaluated |

Vertex snapping consumes the same query-local projection. Neither query retains
pose values between calls or caches World/animation authority. Custom vertex
shaders, material displacement, clipping, alpha coverage and renderer-selected
LOD are outside this geometric CPU contract. A `hit` proves a supported CPU
triangle, not arbitrary shader visibility.

The [Browser/Dawn fixture](src/__tests__/skinned-triangle-gpu.fixture.ts)
compares exact picks at raster pixel centers with real Standard skin output,
checks captured palette/VBO provenance, replays on a fresh device, and deletes
the geometry draw as a pixel falsifier. Each backend completes 60 frames.
The repeatable CPU benchmark is `bun packages/picking/scripts/bench-skinned-triangle.ts
<optional-threejs-reference-checkout>`; it reports samples and p50/p95, includes
posed bounds, and keeps transform propagation outside query timing.

### Tile-cell (`pickTile`)

| Function | Signature | Return |
|:--|:--|:--|
| `pickTile` | `(world, tilemapEntity, worldX, worldY)` | `Result<PickTileHit \| null, PickTileError>` |

`PickTileHit = { layerEntity, cellX, cellY, tileId }`. Callers propagate the
World before picking so `GlobalTransform.world` is current; an entity without a
Transform retains the origin-default path. `Result.ok(null)` = empty cell or
out-of-bounds. A dead handle returns `tilemap-not-found`; a live entity without
`Tilemap` returns `tilemap-component-missing`. `PickTileError` is a closed
two-member discriminated union, runtime-local (not exported through
`@forgeax/engine-types`). Singular transforms use the shared `mat4.invert`
identity fallback deterministically, without widening the error union.

## Error model

`PickError` owns the package-local precondition code in `src/pick-errors.ts`, and
`PickErrorCode` derives from `PickError['code']`. The declaration proof at
`src/__tests__/pick-errors.test-d.ts` checks that owner relationship, the closed
surface, invalid literals, and exhaustive switching.

When the `cameraEntity` passed to `pick` or `pickVertex*` has no `Camera`
component, the functions throw `PickError`: no view/projection matrix can be
built, and the error carries `.expected`, `.hint`, and `.detail.cameraEntity`.
Attach a `Camera` with `world.set` as directed by `.hint`, then retry. Ordinary
ray misses still return `undefined` / `[]`; `PickTileError` remains a separate
two-member union returned (not thrown) through `Result`.

## Package boundary

Depends on `@forgeax/engine-runtime` (components: `Camera` / `Transform` /
`MeshFilter` / `MeshRenderer` / `ChildOf` / `TileLayer` / `Tilemap`;
`propagateTransforms`), `@forgeax/engine-assets-runtime` (`resolveAssetHandle`
for `MeshAsset.aabb`), `@forgeax/engine-ecs`, `@forgeax/engine-math`, and
`@forgeax/engine-types`. `@forgeax/engine-runtime` does **not** import this
package (no reverse edge — picking is a leaf consumer).

Visible acceptance: `apps/hello/picking` (click a cube to highlight) +
structural-only dawn-node smoke (asserts `pick` returns the expected entity + a
miss returns `undefined`).

## Source anchors

- `src/pick.ts` — `pick` + `PickHit`
- `src/pick-vertex.ts` — `pickVertex` / `pickVertexOnEntity` + `VertexHit`
- `src/pick-tile.ts` — `pickTile` + `PickTileHit` / `PickTileError`
- `src/pick-triangle.ts` — exact triangle/occlusion query + unavailable state
- `src/pick-errors.ts` — `PickError` / `PickErrorCode` (error SSOT)
- `src/pick-core.ts` — shared camera->ray skeleton (internal)
