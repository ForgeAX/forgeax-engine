# Polygon holes, rim bevels and profile sweeps

Geometry produces ordinary `MeshAsset` values for concave polygons with disjoint
holes, inset rim chamfers/rounded bevel layers, and arbitrary polygon sections
along sampled 3D curves. Caps, walls, normals, UVs, tangents and bounds share the
existing canonical mesh preparation. Rendering ownership is unchanged.

[Public contract](../README.md#polygon-extrusion-and-profile-sweep) ·
[Geometry regression](../src/__tests__/advanced-modeling.unit.test.ts) ·
[Production Renderer/RHI fixture](../../runtime/src/__tests__/advanced-modeling.fixture.ts)

## Fixed source comparison

| Result | Three.js r184 | UE 5.8.1 | ForgeaX choice |
|:--|:--|:--|:--|
| Holes | [ExtrudeGeometry](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/src/geometries/ExtrudeGeometry.js), ShapeUtils/Earcut cap triangulation and per-loop walls | DrawPolygonTool, general polygon with holes and constrained triangulation | Strict simple-domain admission plus pinned MIT Earcut; independent cap area check; one oriented boundary for caps/walls |
| Bevel | ExtrudeGeometry offset-line movement vectors and layered rim profile | ApplyMeshBevelSelection, selected dynamic-mesh edges via FMeshBevel | Inset both extrusion rims, including hole rims. One segment gives a chamfer; more approximate a quarter-circle. Refuse collapsing edges or changed topology |
| Polygon curve extrusion | ExtrudeGeometry extrudePath and [Curve frame transport/closure](https://github.com/mrdoob/three.js/blob/d3b629c0c2097cec664ad16369bb6eae3b10e335/src/extras/core/Curve.js#L338) | AppendSimpleSweptPolygon and FGeneralizedCylinderGenerator, transported/explicit frames and optional miter scaling | Sampled points, bisector tangents, minimal-rotation transport, distributed closed-loop twist and optional caps; the section may contain holes |

> [!NOTE]
> These are the audited basic modeling results. Bevel is an extrusion-rim
> operation, rather than UE's general selected-edge mesh editing. Curve sampling
> stays with the author; sweep does not supply an editor, miter scaling or global
> self-collision clipping. It rejects consecutive duplicate points, reversals,
> invalid domains and triangles that collapse, reverse or overflow in f32.

## Real images

Browser WebGPU, 256 × 256, Standard Deferred, direct geometry lane, one directional
light, roughness 0.32, metallic 0.2, AA/Bloom/SSAO/shadows disabled. Images are actual
presented-canvas screenshots, inspected after capture. The white void is the page
behind the transparent clear; the HDR readback independently verifies empty holes.

| Scene | Presented image | Checked result |
|:--|:--|:--|
| Through hole | Through hole | The front center remains empty; inward hole walls are present |
| Concave polygon with two holes | Concave polygon with two holes | Concave outer boundary, two open holes and rim bevels |
| Filled-hole control | Filled-hole control | The same center becomes lit when the hole is removed |
| Rounded rim | Rounded rim | Six offset layers on the outer and inner rims, oblique view |
| Polygon profile on a curved path | Polygon profile on a curved path | Concave L section, 65 sampled path points and both caps |

## Geometric and GPU acceptance

The results below record the original dual-backend acceptance. Current CI keeps
the Dawn fixture as the core geometry GPU gate; dedicated Browser fixtures retain
canvas, Standard assembly and asset-publication coverage.

| Gate | Observed result |
|:--|:--|
| Independent geometric oracle | 4×4 square with 2×2 hole, depth 2: volume 24 and surface area 72. Chamfer volume agrees with the analytical inset integral. Concave multi-hole, curved-profile and nonplanar closed-loop meshes have paired opposite-oriented boundary edges |
| Stability regression | Restoring the old extrusion implementation makes four of the new tests fail. Final Geometry suite: 20 files, 188 tests passed |
| Admission and recovery | Winding reversal, closure points, collinear boundary simplification, invalid holes, edge collapse, malformed paths and f32 precision loss tested; invalid input returns `asset-parse-failed` without a partial mesh |
| Real GPU path | Both Browser WebGPU and native Dawn render every scene for 61 completed frames; ordinary Renderer extraction, asset upload, GBuffer, lighting and output transform are exercised |
| RHI Debug inspection | Strict v7 decode, work/event anchors, actual indexed draw count, vertex/index bindings and initialized resource seeds; captured VBO/IBO bytes equal the canonical MeshAsset bytes |
| Fresh-device replay | GBuffer state inspection plus post-lighting HDR readback; all five scenes have maximum live/replay channel difference 0 on both backends (gate ≤ 0.05) |
| Falsifiers | Removing the captured geometry draw changes HDR pixels by more than 0.1 in every scene; filling the hole changes the center by more than 0.1. Fresh replay validation scopes and uncaptured-error channels are clean |

Raw Dawn report, Browser report, capture/readback archive manifest and command logs preserve the work indices, pipeline descriptors, binding offsets, unseeded resources, buffer digests, failure control and raw pixels. The logs normalize terminal blank lines only.

## Measured performance

Apple M4 Pro, macOS 26.4.1, Node 26.4.0. The native adapter reports
`apple / metal-3 / apple-m4-pro`, `isFallbackAdapter: false`.
CPU samples include allocation, domain validation, tangent generation and bounds;
10 warmups and 100 samples. Three.js is converted through the same canonical
MeshAsset preparation. Both use the same contour inputs; sweep comparison includes
Three curve sampling/frame creation, while ForgeaX receives those pre-sampled points.
Measurements share the machine with local verification, so they are descriptive
samples rather than an isolated hardware performance guarantee.

| CPU scenario | Triangles | ForgeaX median / p95, ms | Three prepared median / p95, ms |
|:--|--:|--:|--:|
| square-hole | 32 | 0.050 / 0.127 | 0.054 / 0.092 |
| rounded-hole | 288 | 0.118 / 0.304 | 0.144 / 0.290 |
| 128-point-hole | 3840 | 1.892 / 2.939 | 1.374 / 2.150 |
| rectangular-sweep-64 | 516 | 0.142 / 0.195 | 0.213 / 0.274 |
| rectangular-sweep-256 | 2052 | 0.555 / 0.753 | 0.792 / 1.046 |

All three extrusion volume comparisons differ by less than 10⁻⁴. Corresponding meshes have identical vertex/triangle counts and canonical payload sizes. CPU profiling identified garbage collection and repeated wall-normal/f32-validation allocations; the implementation reuses triangle normals and validates packed triangles with scalar arithmetic. CPU data, before-fix profile.

GPU observations use 20 warmup frames and 40 measured receipts. They sum **measured
pass durations**, rather than frame latency; CPU receipt timings remain separate.

| Scene | Triangles | Dawn measured passes median / p95, ms | Browser measured passes median / p95, ms | Live/replay max delta |
|:--|--:|--:|--:|--:|
| holes | 32 | 0.590 / 0.721 | 0.588 / 0.631 | 0 / 0 |
| concave-holes | 256 | 0.590 / 0.786 | 0.589 / 0.677 | 0 / 0 |
| solid-control | 12 | 0.590 / 0.786 | 0.589 / 0.644 | 0 / 0 |
| bevel | 224 | 0.590 / 0.786 | 0.593 / 0.641 | 0 / 0 |
| profile-sweep | 776 | 0.590 / 0.721 | 0.561 / 0.588 | 0 / 0 |

> [!IMPORTANT]
> GPU status is `partial`: `deferred-lighting-prepare` and HDR observation copies
> return `timestamp-write-unavailable` because copy markers are zero. The report
> retains that structured reason; those copies are excluded from the sum.
> Native timestamps are quantized, and some very short passes have equal ticks.
> These measurements do not establish complete GPU-frame cost, a fine-grained
> speed ranking, software-renderer performance or equivalence to UE.

## Reproduce

```sh
pnpm --filter @forgeax/engine-geometry exec vitest run --config vitest.config.ts
node packages/geometry/bench/advanced-modeling.mjs <pinned-threejs-checkout>
pnpm exec vitest run --project dawn packages/runtime/src/__tests__/advanced-modeling.dawn.test.ts
```

<details>
<summary>Inspect a preserved capture</summary>

Download the `.rhitape.gz` from the fixed evidence commit, decompress it and check
its original SHA-256 against `archive-manifest.json`. Then use the ordinary tools:

```sh
gzip -dk holes.rhitape.gz
pnpm exec forgeax rhi summary --artifact holes.rhitape --json
pnpm exec forgeax rhi inspect --artifact holes.rhitape --work-index <report-work-index> --json
```

The archive restores the original canonical v7 artifact. The work index and event
anchor come from its corresponding lane report, rather than a recaptured frame.

</details>
