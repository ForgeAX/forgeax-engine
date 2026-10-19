# @forgeax/engine-geometry

Pure-function procedural mesh geometry factories + the vertex-attribute-layout SSOT for
forgeax-engine. A **leaf** package: depends on `@forgeax/engine-ecs` (`Result`),
`@forgeax/engine-math` (AABB derivation), and `@forgeax/engine-types` (`MeshAsset` /
`AssetError` / `VertexAttributeMap`), and never imports the renderer or RHI.

## 30-second self-introduction

- **Surface**: reusable 3D procedural factories
  (`createBoxGeometry` / `createCapsuleGeometry` / `createConeGeometry` /
  `createCylinderGeometry` / `createPlaneGeometry` / `createSphereGeometry` /
  `createTorusGeometry` / `createExtrusionGeometry` / `createSweepGeometry` /
  `createRevolutionGeometry` / `createProfileSweepGeometry`),
  each returning `Result<MeshAsset, AssetError>`; the vertex-attribute-layout
  SSOT (`deriveVertexBufferLayout` / `buildMeshAttributeMapForUvSets` /
  `GpuVertexBufferLayoutEntry`); and the tangent + interleave helpers
  (`computeTangentVec4` / `meshFromInterleaved` /
  `PROCEDURAL_FLOATS_PER_VERTEX`). A single entry-point
  `import { ... } from '@forgeax/engine-geometry'`.
- **Edge conversion**: `createWireframeGeometry(source)` keeps every unique
  triangle edge, while `createEdgesGeometry(source, thresholdAngleDegrees?)`
  keeps boundary, non-manifold, and threshold-surviving surface edges. Both
  return the same `Result<MeshAsset, AssetError>` shape from the public barrel.
- **2D primitives**: `create2dGeometry` turns the twelve Bevy `2d_shapes` primitive
  definitions into triangle-list or line-list `MeshAsset` values, while
  `create2dRingGeometry` builds the reusable ring variants used by the same gallery.
- **Style**: pure functions -- no classes, no mutation, no side effects. Every
  factory returns `Result<MeshAsset, AssetError>` (charter P3 explicit failure).
  Caller owns the returned `MeshAsset`; the package never touches GPU or ECS.
- **Errors**: degenerate parameters (`dim <= 0`, `segments < minimum`, etc.)
  fail-fast with `AssetError({ code: 'asset-parse-failed' })` carrying a
  structured `.detail.field/.value/.reason`. No silent fallback, no `console.warn`,
  no `null` return (charter P3).

The canonical vertex layout is interned by its finite attribute-presence mask.
Mesh maps and packed masks resolve to the same deeply frozen projection; changing
an authoring map's attributes derives a different mask without retaining the map
or its buffers. Layout offsets, formats, and digests still derive from the one
canonical attribute schema.

`unpackInterleavedVertexAttributes` copies the complete attribute set into one
owned backing buffer with nonoverlapping typed views. Respect each view's byte
offset and length. Transferring that buffer transfers every lane together;
separate decodes and the original packed vertices keep independent storage.
Retaining one lane retains its sibling storage for that decoded mesh.

## MeshBuilder

`MeshBuilder` is the incremental authoring owner for custom geometry. Append
canonical position/normal/UV/tangent data and indexed submeshes, then call
`build()` once to obtain a `Result<MeshAsset, AssetError>`. The builder derives
the interleaved vertex layout, index width, submesh ranges, and AABB from the
same attribute-layout and bounds owners used by procedural factories; callers
do not maintain a second stride, bounds, or layout table. Malformed cardinality,
non-finite attributes, out-of-range indices, and empty commits fail with the
existing structured `asset-parse-failed` detail. A rejected build can be
repaired and retried without publishing a partial mesh.

## Edge conversion factories

Import both operations from the package barrel:

```ts
import {
  createEdgesGeometry,
  createWireframeGeometry,
} from '@forgeax/engine-geometry';

const wireframe = createWireframeGeometry(source);
const edges = createEdgesGeometry(source, 30);
if (!wireframe.ok || !edges.ok) {
  // Branch on the structured AssetError; do not parse error.message.
  const failure = !wireframe.ok ? wireframe.error : edges.error;
  if (failure.code === 'asset-parse-failed') {
    console.error(failure.detail?.field, failure.detail?.reason);
  }
  return;
}
```

| Factory | Edge rule | Default | Input contract |
|:--|:--|:--|:--|
| `createWireframeGeometry(source)` | Every unique triangle edge, including coplanar diagonals and subdivided-grid edges; exact normalized-f32 endpoint keys are sorted lexicographically. | N/A | Indexed triangle-list submeshes or exactly one complete non-indexed triangle-list submesh. |
| `createEdgesGeometry(source, thresholdAngleDegrees?)` | Fixed `1e-4` position weld; the minimum exact-f32 representative is selected for each welded endpoint. Boundary and non-manifold edges are kept; two-face edges use `dot(n0, n1) <= cos(thresholdAngleDegrees * pi / 180)`. | `1` degree | The same MeshAsset contract, plus finite `thresholdAngleDegrees` in `[0, 180]`. |

Both factories preflight `attributes.position` as finite `Float32Array` data or a
4-byte-aligned `ArrayBuffer`, validate triangle cardinality, submesh ranges,
index storage and index bounds, and skip zero-area faces. Invalid input returns
`AssetError` with `code === 'asset-parse-failed'` and
`detail.field/value/reason`; threshold values are rejected rather than clamped.

Successful output is one non-indexed `line-list` submesh with the `Default`
material slot. `attributes.position` contains the emitted endpoints; `normal`,
`uv`, and `tangent` are zero fillers with matching cardinality. The existing
`packInterleavedVertexAttributes` layout owner produces `vertices`, and
`box3.fromPositions` derives the output AABB from those emitted positions. An
empty semantic result is valid and carries the inverted-empty AABB.

The operations are pure CPU transformations: they do not mutate or retain the
source MeshAsset, register handles, or import Render/RHI policy. Canonical edge
ordering makes repeated calls, default versus explicit threshold `1`, equivalent
indexed versus non-indexed triangle soups, and triangle/submesh permutations
produce byte-stable output.

## Vertex color contract

`MeshAsset.attributes.color` is the optional geometry-owned vertex color: a
linear RGBA `Float32Array`, with exactly four finite values per vertex. It is
not an sRGB input and does not add a material flag. Procedural authors can set
the field directly; glTF `COLOR_0` is normalized into this same field at the
import boundary. Missing color is a real absence and keeps the color stream
out of the packed bytes.

Use `deriveVertexLayoutProjection` and
`packInterleavedVertexAttributes(attributes, vertexCount)` for layout and
packing. The packer returns a `Result`; callers branch on `ok` before
publishing vertex bytes. The immutable projection owns canonical offsets, stride, mask and
digest; color is host `@location(13)` (`float32x4`, 16 bytes), while existing
locations `0..12` remain unchanged. Render and asset consumers carry this
projection instead of calculating offsets or a parallel stride. See
[`VertexAttributeMap`](../types/src/index.ts) for the public POD shape.

### 30s hands-on example

```ts
import { createBoxGeometry, createSphereGeometry } from '@forgeax/engine-geometry';

// 1. Build a unit box (6 faces, 1 segment per edge)
const box = createBoxGeometry(1, 1, 1);
if (!box.ok) return; // box.error.code === 'asset-parse-failed'
console.log(box.value.vertexCount); // 24 (4 vertices * 6 faces)

// 2. Build a UV sphere and hand the MeshAsset to the AssetRegistry for a handle
const sphere = createSphereGeometry(1, 32, 24);
// ---- ⬆ the factory returns an unregistered MeshAsset POD ----
// To spawn an entity: register via renderer.assets.register(sphere.value).unwrap(),
// then hand the resulting Handle<MeshAsset> to MeshFilter.assetHandle.
```

The primitive factories cover the common built-in shapes. For reusable authored
geometry, `createExtrusionGeometry` triangulates a concave contour with holes,
adds caps and outward walls, and optionally bevels both rims.
`createProfileSweepGeometry` transports a polygon section along a sampled 3D
path; `createSweepGeometry` provides circular profiles, and
`createRevolutionGeometry` turns a `(radius, height)` profile around Y. Each operation validates finite input before
allocating a MeshAsset and returns through the same tangent, layout, and AABB
owners. For an imported
glTF mesh, use `@forgeax/engine-gltf`; FBX follows the same source-plus-Meta
route through `@forgeax/engine-fbx`. Runtime consumption is
`@forgeax/engine-assets-runtime` after the owning importer has cooked the asset.

### Polygon extrusion and profile sweep

```ts
import { createExtrusionGeometry, createProfileSweepGeometry } from '@forgeax/engine/geometry';

const contour = [{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }];
const holes = [[{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]];
const frame = createExtrusionGeometry(contour, 2, { holes, bevelSize: 0.25, bevelSegments: 6 });
const rail = createProfileSweepGeometry(
  { contour, holes },
  [[0, 0, 0], [0, 0, 4], [1, 0, 8]],
  { capped: true, up: [1, 0, 0] },
);
```

| Input | Contract |
|:--|:--|
| Contours | Copies inputs; either winding accepted; duplicate closing point accepted. Simple nonzero-area outer loop, strictly internal disjoint holes. Touching, crossing and nested hole boundaries fail. At most 4096 total contour points. |
| Bevel | `bevelSize` defaults to zero. Inset and axial radius in source units; positive size must be less than half depth. `bevelSegments` 1–64, default 1: chamfer; more segments approximate a quarter-circle. Offset-edge collapse or changed domain topology fails. Bounds stay inside the original extrusion. |
| Sweep | Receives 2–4096 sampled 3D points; sampling density belongs to the author. Minimal-rotation frames avoid independent-reference-axis flips. `up` selects the initial cross-section X axis; it must not be parallel to the initial tangent. `capped` defaults to true. `closed: true` requires a duplicate endpoint, distributes closure twist and omits caps. Consecutive duplicate points and 180-degree reversals fail. |
| Mesh | At most 262144 ring vertices, checked before ring allocation; canonical normal/UV/tangent/AABB production. Triangles that collapse or overflow after f32 conversion fail. Per-triangle wall normals retain polygon corners and beveled facets. |

> [!NOTE]
> Bevel operates on extrusion rims, including hole rims. It does not edit selected
> edges of an arbitrary imported mesh. Sweep joins use bisector frames rather than
> UE's optional miter expansion, and do not perform global self-collision clipping.
> Large profiles on tightly bent paths can overlap; use adequate curve sampling
> and a profile that fits the path. These are authoring factories, with no runtime
> curve evaluator, editor tool or renderer dependency.

The cap triangulator is the pinned MIT Earcut dependency also used by Three.js.
Geometry retains domain admission and offset checks instead of relying on a
triangulator's partial output. Source comparison, CPU benchmarks and production
Renderer/RHI Debug evidence are in the [modeling report](../../docs/advanced-modeling.md).

### 2D primitive geometry

`Shape2d` is the closed input union for circles, sectors, segments, ellipses,
annuli, capsules, rhombi, rectangles, regular polygons, triangles, segments, and
polylines. `create2dGeometry(shape)` returns a filled mesh for closed shapes and a
`line-list` mesh for `segment` / `polyline`. `create2dRingGeometry(shape, thickness)`
returns the ring form for closed non-annulus shapes; ellipse and sector rings follow
the same visual approximation as Bevy's source example. `compute2dBounds(shape, pose)`
derives the transformed AABB and bounding circle from that same shape contract.

```ts
import { create2dGeometry, create2dRingGeometry } from '@forgeax/engine-geometry';

const filled = create2dGeometry({ kind: 'circle', radius: 50 });
const ring = create2dRingGeometry({ kind: 'rectangle', width: 50, height: 100 }, 5);
const arc = create2dGeometry(
  { kind: 'circular-sector', radius: 40, angle: Math.PI / 2 },
  { uv: { kind: 'circular-mask', angle: -Math.PI / 4 } },
);
if (!filled.ok || !ring.ok) return;
```

## API surface

### Procedural geometry factories

Each returns `Result<MeshAsset, AssetError>`. Interleaved vertex layout:
position (3xf32) + normal (3xf32) + uv (2xf32) = 8 floats/vertex at creation
time; expanded to the 12-float runtime layout (adds tangent vec4) by
`meshFromInterleaved`.

| Factory | Signature | Minimum segments |
|:--|:--|:--|
| `createBoxGeometry` | `(w, h, d, wSeg?, hSeg?, dSeg?)` | 1 / dim |
| `createCapsuleGeometry` | `(radius, length, capSeg?, radSeg?)` | capSeg >= 1, radSeg >= 3; total height = length + 2*radius (Bevy `Capsule3d` convention) |
| `createConeGeometry` | `(radius, height, radSeg?, hSeg?)` | radSeg=16; delegates to cylinder with top=0 |
| `createCylinderGeometry` | `(rTop, rBottom, h, radSeg?, hSeg?)` | radSeg=16; at least one radius > 0 |
| `createPlaneGeometry` | `(w, h, wSeg?, hSeg?)` | 1 / dim; XY plane, +Z normal |
| `createSphereGeometry` | `(radius, wSeg?, hSeg?)` | wSeg >= 3, hSeg >= 2 |
| `createTorusGeometry` | `(radius, tube, radSeg?, tubSeg?)` | radSeg >= 3, tubSeg >= 3 |
| `createExtrusionGeometry` | `(contour, depth, options?)` | Simple outer contour with disjoint interior holes; depth > 0 |
| `createProfileSweepGeometry` | `(shape, path, options?)` | Simple polygon section (including holes), sampled 3D path; bounded transport frames |
| `createSweepGeometry` | `(path, radius, radialSeg?)` | 2+ distinct finite 3D points, radius > 0, radialSeg >= 3 |
| `createRevolutionGeometry` | `(profile, radialSeg?)` | 2+ finite non-negative-radius points spanning height, radialSeg >= 3 |

All factories populate `position` / `normal` / `uv` attributes with lowercase
Three.js-r184 key naming. `VertexAttributeMap` also accepts optional `color`
linear RGBA data; see
the [attribute layout](#vertex-attribute-layout-ssot) section.

### Tangent and interleave helpers

| Symbol | Kind | Purpose |
|:--|:--|:--|
| `computeTangentVec4(positions, normals, uvs, indices?)` | fn | Preflights attribute cardinality, triangle topology, and index range, then returns `Result<Float32Array, AssetError>`. Success is the per-vertex tangent (vec4): face-area-weighted average + Gram-Schmidt orthogonalise + handedness sign packed into `.w`. |
| `writeNormalPlaneTangent(out, offset, nx, ny, nz)` | fn | Writes a finite unit tangent into three consecutive output elements, preserving handedness and other elements. Returns `false` without writing for an undefined normal plane or an incomplete, negative, or noninteger output range. |
| `meshFromInterleaved(vertices, indices)` | fn | Preflights the 8-float interleaved stride and triangle index topology before slicing or allocating output, then returns `Result<MeshAsset, AssetError>` with the 12-float runtime layout. |
| `PROCEDURAL_FLOATS_PER_VERTEX` | const | `12` -- the runtime interleaved stride: position (3) + normal (3) + uv (2) + tangent (4). |

Both helpers return the existing `AssetError` vocabulary with
`error.code === 'asset-parse-failed'` for malformed input. The error detail
identifies the rejected `field`, observed `value`, and `reason`; no tangent,
mesh, or working buffer is allocated before this preflight completes. The
helpers are stateless, so corrected arrays can be passed to the next call and
produce the normal vec4 or mesh result.

| Preflight | Rejected input |
|:--|:--|
| Attribute cardinality | `positions.length` not divisible by 3, or `normals` / `uvs` not matching the derived vertex count |
| Triangle cardinality | Non-indexed vertex count or indexed index count not divisible by 3 |
| Index range | Any index that is not an integer in `[0, vertexCount)` |

### Vertex attribute layout SSOT

| Symbol | Kind | Purpose |
|:--|:--|:--|
| `deriveVertexBufferLayout(map, opts?)` | fn | Derives a fixed-order `GpuVertexBufferLayoutEntry[]` from a `VertexAttributeMap`. The canonical 14-key order (position / normal / uv / tangent / skinIndex / skinWeight / uv1..uv7 / color) assigns `@location(N)` per key. Absent keys reserve no space; `opts.shaderUvSetCount` enables clamp-to-last alias for UV sets. |
| `deriveVertexLayoutProjection(map)` | fn | Creates the immutable canonical projection (`schemaVersion`, attributes, mask, stride, digest). `color` is fixed at host location 13 and `float32x4`. |
| `packInterleavedVertexAttributes(map, vertexCount)` | fn | Packs attribute arrays using that projection and returns `Result<{ projection, vertices }, VertexAttributePackError>`; closed detail reasons identify storage, cardinality, vertex-count, or non-finite failures. |
| `DEFAULT_VERTEX_ATTRIBUTE_MAP` / `SKIN_VERTEX_ATTRIBUTE_MAP` | const | Canonical presence maps for ordinary and skinned interleaved meshes. Render, recovery, and feature assembly use these maps instead of spelling a fallback layout locally. |
| `deriveVertexCount(vertices, projection)` | fn | Validates `vertices.byteLength % projection.arrayStride === 0` and derives the integer vertex count shared by upload, LOD, update, morph, and draw-range consumers. |
| `deriveVertexLayoutProjectionFromMask(mask)` | fn | Reconstructs a wire projection through the same canonical key owner; returns a typed error for empty or unknown mask bits. |
| `buildMeshAttributeMapForUvSets(uvSetCount)` | fn | Synthesise a `VertexAttributeMap` with empty `Float32Array(0)` placeholders for `uv` + `uv1..uvN-1`. Used by the forward record stage to pre-declare UV-set slots before interleaving. |
| `GpuVertexBufferLayoutEntry` | type | `{ shaderLocation: number; offset: number; format: GPUVertexFormat }` -- one GPU vertex buffer layout entry. |

```ts
import { deriveVertexBufferLayout, type GpuVertexBufferLayoutEntry } from '@forgeax/engine-geometry';

// Given a MeshAsset.attributes map, derive the GPU vertex buffer layout
const layout: GpuVertexBufferLayoutEntry[] = deriveVertexBufferLayout(mesh.attributes, {
  shaderUvSetCount: 2, // shader expects uv + uv1; if mesh only has uv, uv1 clamps to uv
});
// layout[n].shaderLocation matches WGSL @location(N) declarations.
```

The canonical key order and per-key `GPUVertexFormat` mapping is the SSOT in
`packages/geometry/src/vertex-attribute-layout.ts` (`ATTRIBUTE_FORMAT_MAP`).
Shader `@location(N)` declarations and naga reflection deep-equal tests keep
them in sync.

> [!IMPORTANT]
> Keep vertex bytes and `VertexLayoutProjection` together across every GPU
> owner. Derive the count with `deriveVertexCount`; a non-divisible payload is
> rejected before GPU resource construction instead of being truncated into a
> fractional draw range.

## Three.js r184 mental alignment

The seven primitive factory signatures mirror Three.js `BufferGeometry` constructors
byte-for-byte: parameter order, attribute key lowercasing (`position` / `normal`
/ `uv`), and segment-count defaults. AI users migrating from Three.js can swap
the import path and the return-shape check:

```ts
// Three.js:
//   const geo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
//   const pos = geo.getAttribute('position');

// forgeax:
import { createBoxGeometry } from '@forgeax/engine-geometry';
const res = createBoxGeometry(1, 1, 1, 2, 2, 2);
if (!res.ok) return;
const pos = res.value.attributes.position; // Float32Array, same data
```

Key differences from Three.js:

| Aspect | Three.js r184 | @forgeax/engine-geometry |
|:--|:--|:--|
| Return shape | mutable `BufferGeometry` instance | `Result<MeshAsset, AssetError>` (immutable POD) |
| Tangent population | `computeTangents()` (separate call) | `meshFromInterleaved` bakes tangent into the interleaved buffer |
| Index buffer | `Uint16Array` by default | `Uint32Array` when vertex count > 65535, `Uint16Array` otherwise |
| Error on degenerate | `console.warn` + best-effort | `Result.err(AssetError)` fail-fast |

## Non-goals

| Not doing | Why |
|:--|:--|
| Loading external mesh formats (glTF, FBX, OBJ) | glTF and FBX are owned by `@forgeax/engine-gltf` / `@forgeax/engine-fbx`; runtime consumption uses `@forgeax/engine-assets-runtime` after the source-plus-Meta sidecar pipeline |
| GPU upload / handle minting | Geometry is pure-function CPU POD; registration and GPU residency are `AssetRegistry` + `GpuResourceStore` in `@forgeax/engine-runtime` |
| Procedural mesh editing (extrude, bevel, CSG) | Out of scope for the leaf geometry package; these are future `@forgeax/engine-geometry-edit` or equivalent |
| Non-procedural mesh data (skinned vertices, morph targets) | Skin data lives on the `MeshAsset` POD after import; this package only populates position / normal / uv |
| `Result.unwrap()` convenience | Caller calls `.unwrap()` from `@forgeax/engine-ecs`; this package only produces `Result` |

## Route map

| Task | Package / skill |
|:--|:--|
| "I want a box / sphere / plane / cylinder / cone / torus from code" | `@forgeax/engine-geometry` (this package) |
| "I want to register the mesh and get a handle" | `@forgeax/engine-runtime` (`renderer.assets.register(meshAsset)`) |
| "I want to spawn an entity with this mesh" | `@forgeax/engine-runtime` (`MeshFilter` + `MeshRenderer` + `MaterialAsset`) -- see `forgeax-engine-material` skill |
| "I want to load a glTF file" | `@forgeax/engine-gltf` importer, then `@forgeax/engine-assets-runtime` (`loadByGuid`) |
| "I want to read the world-space position / forward / up from a spawned entity" | `@forgeax/engine-math` (`mat4.getTranslation` / `getForward` / `getUp`) |

## Knowledge-base references

Cross-vendor reading for contributors:

- [`../math/README.md`](../math/README.md) -- leaf-package README paradigm (progressive disclosure)
- [`../runtime/README.md`](../runtime/README.md) -- MeshFilter / MeshRenderer / AssetRegistry API
  SSOT
- [`../types/src/index.ts`](../types/src/index.ts) -- `MeshAsset` / `AssetError` / `VertexAttributeMap`
  type definitions

## License

Same as workspace root.

## Mesh decals

`createDecalGeometry(source, { transform, normalThreshold? })` clips receiver
triangles against a unit box and returns `Result<MeshAsset | null, AssetError>`.
`transform` maps `[-0.5, 0.5]` into **receiver-local space**. Projector +Z faces
the receiver normal. `normalThreshold` is a cosine in `[-1, 1]`, default `0`.
The output retains local positions, interpolates normals, computes tangents and
bounds, and maps projector X/Y to UV `(x + 0.5, 0.5 - y)`. No intersecting
projectable triangles returns `null`; malformed geometry or a singular box is
an error. Input attributes are never modified.

This is a one-time CPU operation, usable inside a Pack generator/cooker or for
occasional runtime placement. Store the ordinary MeshAsset using the existing
asset path. Render it with MeshFilter/MeshRenderer and the receiver's transform
(or an identity ChildOf the receiver); rigid movement then requires no clipping.
Skin/morph deformation is not copied. Regenerate a pose snapshot explicitly if
needed. The caller selects receiver meshes; this function does not raycast a
scene or hide a full-scene triangle scan.

Use an ordinary overlay material with depth testing, disabled depth writes,
alpha blending and negative `depthBias` / `depthBiasSlopeScale`. Start with
`-2` for both and tune for the camera's depth precision and surface slope.
Give a painted marking `ShadowParticipation { cast: false }` and choose its queue/order
explicitly. A bias is a raster state, not a displacement of every vertex along
its normal. Excessive bias can show through nearby surfaces.

Reference: Three.js r184 `DecalGeometry` six-plane clipping and the official
`webgl_decals` example's polygon offset. ForgeaX keeps output receiver-local
and applies its canonical MeshAsset tangent/layout contract. The alternative
[GPU projected decal](../render/README.md#projected-decals) reads visible depth.

## Canonical Mesh preparation

`prepareMeshData` owns typed attribute cardinality, scalar storage, finite values,
morph streams and mesh-binary metadata validation. `packMeshBin` uses that contract
for ordinary v5 bytes. The shared preparation also checks interleaved vertex
bytes against the canonical attributes with `validateMeshInterleaving`; contradictory
CPU and GPU geometry is rejected. `withMeshAabb` derives bounds while preserving
producer-specified deformation bounds. These pure kernels own no Registry or GPU.

On little-endian hosts, Cook copies the validated interleaved vertex subview into
the binary body instead of rebuilding the same lanes. The output owns its bytes;
attribute consistency, non-finite rejection, and v5 wire bytes are unchanged.

## Derived mesh distance fields

`buildMeshDistanceField(positions, indices, { resolution, twoSided })` builds a
bounded local field, computed densely for its geometric sign checks and published
as shared 4-cubed bricks. Resolution defaults to 24 and accepts 8–64 along the
longest axis. The default signed-solid policy welds position seams, checks closed
outward topology and sampled winding, and rejects unresolved thin solids. It
allows 1,024 triangles and 32 million voxel/triangle sign evaluations.

Explicit `twoSided: true` stores unsigned distance to the actual triangles. It
admits open/zero-thickness and disconnected surfaces up to 65,536 triangles;
negative samples and invented interior coverage are invalid. Both policies allow
1,048,576 source vertices and use a shared closest-point spatial index. Each
sample receives `floor(32,000,000 / sampleCount)` primitive tests; exhaustion
returns `distance-field-limit` rather than publishing a partial nearest distance.
This bounds primitive work, not wall-clock bake duration or BVH node visits.
The shared spatial index uses a deterministic 12-bin surface-area split and
at most two primitives per leaf. Closest-point traversal visits the nearer
child bound first to avoid spending the sample budget on distant geometry. It still returns `distance-field-limit`
if the remaining candidates cannot be excluded within that budget; exact output
samples and the deterministic ray-hit primitive tie rule remain unchanged. Ray slab pruning is widened by
floating-point roundoff so an equal-distance candidate cannot be skipped;
triangle tests retain the caller's exact interval. The corrected primitive choice
can change sidedness votes, so derived-data producer fingerprints advance;
artifact wire formats do not change.

`policy.errorBound` covers trilinear interpolation plus sample rounding in local units.
For two-sided fields this bounds **unsigned surface distance**, not thickness,
material opacity or the sign of a solid. It can over-occlude subvoxel gaps within
the query's reported band. The signed profile's triangle-centroid check remains
a diagnostic, not proof of all subvoxel features or self-intersections. Skinned,
displaced and MASK coverage are not qualified by these geometric policies.
Never change sidedness automatically to admit a rejected source.

The geometry digest covers canonical f32 positions/u32 topology independently
of material and transform. `encodeMeshDistanceField` / `decodeMeshDistanceField`
carry version-4 metadata, the explicit `policy` union, a little-endian u32 brick
address table and exact f32 payloads, followed by a whole-artifact digest. Older
artifacts require producer rebuild. `bricks` addresses 64-sample payloads in
`values`; identical payloads share offsets, and edge padding repeats the last
valid lattice coordinate. `distanceFieldTexel(field, x, y, z)` reads this storage;
`sampleMeshDistanceField` retains trilinear semantics. Decode validates expected
geometry, bounds, addresses, padding, finite values, all referenced payloads, the
combined 32 MiB table/payload budget and logical `quality.negativeSamples`.
Physical payload length is not the logical voxel count.
The NativeCooker in `engine-import` fingerprints geometry, resolution, sidedness
and producer version. These derived bytes create no authored asset kind and are
never built during an ordinary frame.

Ordinary Mesh publications distinguish geometric fields with
`MESH_GEOMETRIC_DISTANCE_FIELD_CODEC`, derived from the encoded field policy.
The attachment validator checks the geometry digest and homogeneous section
sidedness against the signed-solid/two-sided policy; a sampled-visibility
artifact cannot be relabeled as geometric. Both codecs carry the existing
version-4 artifact under the same Mesh identity.

### Approximate sampled visibility

`buildVisibilityDistanceField(positions, indices, { voxelSize, triangleSidedness })`
prepares open or mixed-sided geometry explicitly. It returns
`policy.kind: 'sampled-visibility'`, with a separate source digest including each
triangle's 0/1 sidedness, trace bounds, finite distance band and mostly-two-sided
hint. It never claims a geometric error bound or a proved solid interior.

| Rule | Contract |
|:--|:--|
| Sampling | Closest-point magnitude capped at `4 * sqrt(3) * voxelSize`; 98 deterministic directions, negative only when more than one quarter hit a one-sided backface. Stop voting once the remaining directions cannot change that predicate. This follows UE's visibility construction, with independent sampling and BVH code. |
| Sparse generation | Visit fixed 4-cubed bricks. A nearest-distance bound at the brick center, its enclosing radius and an outward rounding guard prove when all samples lie outside the band; only then fill the positive band without sample queries. Retained samples use the original f32 coordinates and sign predicate. Exact full-payload comparisons resolve hash collisions. Geometric predicates, work budgets and the lattice do not change. |
| Geometry | Explicit source-unit voxel size; at most 1,048,576 vertices/triangles. Exact zero-area triangles are excluded from queries; original topology and flags remain in source identity. All-degenerate geometry is refused. No automatic alpha or material-ID partitioning. |
| Bounds | Positive plane extent, mostly-two-sided expansion, then a separate one-voxel gradient border. At most 514 samples per axis; distinct finite f32 centers and the existing lattice origin rule remain required. The combined brick table and exact f32 payloads must fit 32 MiB; virtual volume size does not require a dense allocation. Producer and artifact admission share these limits. Sampled visibility packs as SNORM16 into the query's unchanged 16 MiB aggregate budget; multiple fields still compete for that budget. |
| Work | Shared per-cook caps of 134,217,728 closest-point and 1,073,741,824 sign-ray primitive tests. Exhaustion refuses the entire result. These are work bounds, not a wall-clock promise. |
| Difference from UE | Exact f32 shared bricks, rather than UE UNORM8 mip/streaming data; a separate RNG; exact-zero degeneracy instead of UE's tolerance; no stochastic transparency or streaming. Unsigned thin sheets can have an interpolation floor; consumers must expose approximation errors. |

`mostlyTwoSided` uses the original triangle count and a 25% threshold. It is a
trace/coverage hint, not a claim that every surface is two-sided. The sign query
uses retained primitive flags after degenerate filtering. Saturated nearest-query
results skip sign rays: their pulled-back segment cannot reach geometry outside
the distance band. Zero negative samples
are valid. Cooked data and its policy must travel together; geometric-only
consumers must reject this policy rather than infer a distance guarantee.

## Derived mesh card layouts

`buildMeshCardLayout(positions, indices, { resolution, maxCards, triangleSidedness })`
prepares local orthographic cards from indexed geometry. It shares a build-time
triangle spatial index with the SDF closest-point pass. Defaults are resolution
16 and 24 cards; admitted limits are resolution 8–32, 1–64 cards and 1,048,576
vertices/triangles. Thirty-two deterministic samples per cell discover multiple
depth layers; eight hemisphere visibility queries per compacted surfel guide
coverage weighting. Inside rejection, projection density and a global card
budget can leave surfaces uncovered. `sampling` reports that evidence; card
count alone does not establish coverage.

Inner Card projections retain their fitted near plane, with only the existing
query precision margin. The half-voxel enclosure must not extend into the
preceding occupied cell and recapture its occluder; the far depth enclosure and
outer Card padding remain unchanged.

When a near-plane projection fails the density test, fitting considers its
eight-connected occupied-cell islands separately. Empty space between islands
does not count as surface area. Islands share a projection when their combined
weight and density meet the original thresholds. All directions share the same `maxCards` budget. A
valid combined projection keeps its existing fit. Simplified outer fitting can
retain multiple islands at the outer plane without admitting inner near planes.

`triangleSidedness` carries one 0/1 value per source triangle (omission means all
single-sided). Hit orientation and interior votes use that triangle's value,
including after degenerate-triangle removal. At least one quarter two-sided
triangles selects simplified outer fitting, following UE's mostly-two-sided hint;
it does not turn the remaining triangles double-sided. Ordinary meshes search
inner near planes even when no outer card is valid. A distinct oriented hit in
the next depth cell remains a candidate; stepping past an occupied cell does
not require an additional empty cell. Clustering still constrains its near
plane by prior hits, and visibility and the global budget still apply. Geometry and sidedness have
separate digests; material values do not change either. Material/texture evaluation
belongs to the raster capture
consumer. `encodeMeshCardLayout` / `decodeMeshCardLayout` validate version 2 (version 1 is rejected),
geometry identity, finite orthographic frames and sampling bounds. Pack/DDC
retains responsibility for byte integrity. `createMeshCardCooker` in Import
is a standalone derived-data adapter. The ordinary glTF importer instead stores
`MeshAsset.cardLayout` for the whole mesh directly in the existing mesh-bin metadata, without another
GUID or artifact registry. Both mesh decoders validate and preserve it; geometry
identity is checked by the capture consumer before GPU allocation. This preparation API
has CPU/codec/cooker tests; representative GPU capture and residency acceptance
belongs to the ongoing software-representation iteration.

Measured examples, pinned source references and RHI replay evidence: [advanced modeling report](docs/advanced-modeling.md).

### Mesh publication boundary

`MeshDistanceField` is shared POD in Types; Geometry owns its builders, identity
and codec. `meshDistanceFieldSource` validates the complete static triangle
partition and expands source section sidedness. `attachMeshDistanceField` checks
an ordinary Mesh publication against the encoded field and returns a Mesh with
validated data; it performs no work when both attachment members are absent.
The artifact codec profile and native cook fingerprint derive their policy
revision from `MESH_DISTANCE_FIELD_GENERATION_VERSION`.

`packMeshBin` only encodes geometry and rejects a decoded `distanceField` rather
than dropping it. Use Import's complete Mesh output producer for export; it
validates and emits the existing field artifact alongside either binary or JSON
geometry. `normalizeMeshPayload` likewise requires complete publication handling
when a distance-field attachment is present.

### Profile sweep UV and degeneracy

Wall U follows profile perimeter; wall V follows cumulative sampled path length,
normalized to `[0, 1]`. Uneven point spacing therefore does not stretch textures
by point ordinal. Closed paths duplicate the first ring exactly at V=1 and
omit caps; transport closure distributes twist by distance. Hard triangle
normals agree with actual f32 winding. Adjacent duplicates, reversals,
parallel/invalid initial axes and f32-collapsed triangles return structured
`asset-parse-failed` errors. Acute turns may self-intersect if the profile is too
wide; the factory guarantees finite oriented triangles, not solid CSG repair.

## Mesh collision products

`buildMeshCollision(mesh)` returns `Result<MeshCollision, AssetError>` with owned
`Float32Array` positions and `Uint32Array` triangles. It exact-welds position
seams, includes authored triangle sections, and omits degenerate triangles.
Static triangle-list sources are bounded to 1,048,576 vertices and triangles;
skinning, morph targets, nonfinite positions, invalid/overlapping section ranges
and empty nondegenerate coverage are rejected.

Attach the result as `MeshAsset.collision`. Mesh-bin metadata and JSON admission
preserve the typed payload and validate it against source geometry using
`validateMeshCollisionAttachment`; stale or malformed products are errors,
not implicit recooks. This pure producer owns no native hull or physics state.

`unpackInterleavedVertexAttributes(vertices, projection)` copies Geometry-projected bytes into independent typed attributes, including uint16 skin indices. It derives vertex count from stride, rejects incomplete vertices, and preserves byte offsets. The shared `unpackMeshBin` decoder owns finite-value validation, metadata admission and `MeshBinAssetError` projection. Both Geometry decoding and the Assets Runtime mesh loader consume that result; malformed binary tables cannot bypass validation through a second parser.

Mesh material slot projection lives in `mesh-material-slots`: runtime/sidecar
conversion and accepted reimport application share default GUID decoding.
Removed slots stay unbound, and submesh indices follow the reconciled mapping.
