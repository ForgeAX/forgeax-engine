# Design: scene manifest, measuring a placed scene against one output profile

Status: implemented on branch feat/fable-scene-manifest (not merged). Evidence: `examples/scene-manifest/`
and `src/__tests__/scene-manifest.unit.test.ts`.

## Goal

A game scene is many copies of a few delivered assets. The per-asset budget (`checkAssetBudget`) cannot
say what the scene costs: triangles, draw calls and bytes multiply by placement count, and the GPU sees
one call per placement unless the renderer instances. `sceneManifest` measures the placed scene once and
returns it as plain serialisable data, with a budget verdict for a scene-level profile.

## Surface

```ts
sceneManifest(assets: readonly SceneAsset[], placements: readonly ScenePlacement[],
  profile: 'mobile-scene' | SceneOutputProfile): Result<SceneManifest, SceneManifestError>

sceneTrianglesAt(manifest: SceneManifest, camera: Tuple3): number
```

A `SceneAsset` names a `DeliveredAsset` (mesh, LODs, textures) and optional `lodDistances`. A
`ScenePlacement` is an asset id, optional name, position, unit quaternion and scale. Mesh references
stay by id; the kernel embeds no geometry in the manifest.

## Decisions

- **Refusal versus verdict.** Bad input (unknown asset, non-unit quaternion, zero scale, invalid LOD
  distances, unmeasurable mesh) is a `Result` error with a closed code. A measured budget overrun is
  `budget.ok: false` with issues and still returns the manifest, so a caller can show the numbers.
- **Totals cover placed assets only.** `assets[]` and all totals count what is placed. An asset that
  is delivered but never placed is a top-level `scene-asset-unused` warning and contributes nothing.
- **Two triangle totals.** `trianglesLod0` is what the scene draws at full detail. `trianglesLowest` is
  the floor when every placement takes its coarsest LOD. `trianglesUnique` is the geometry held once.
- **Two draw-call totals.** Without instancing one call per material per placement
  (`drawCallsPerInstance`). With instancing one call per material per unique asset
  (`drawCallsInstanced`). The profile's `instancing` flag picks which one is checked.
- **Texture dedupe by identity.** A `TextureAsset` object shared by two assets is counted once
  (`textureBytes` uses RGBA8 with a full mip chain, from `textureBytes`). Only 2D textures are measured.
- **LOD selection.** LOD0 has distance 0. A placement takes the last LOD whose distance is at most the
  distance from the camera to its world-box centre. An exact tie takes the higher LOD.
- **Mirrored.** True when an odd number of scale components are negative. The consumer must flip winding.
- **World bounds.** Local bounds are the union over all LOD levels. World bounds are the box of the eight
  transformed corners (scale, then rotation, then translation). Rotation is not normalised by the kernel.
- **Measurement reuse.** Triangle, vertex and byte counts come from `assetStats` and its quantized estimate,
  so there is one byte formula (20 bytes per vertex plus indices), not a second one.

## Non-goals

No spatial index, no overlap or collision checks, no culling, no file writing in the kernel, and no
Engine imports. The manifest says what a renderer would draw; it places, culls and loads nothing.

## Open items

- The `mobile-scene` profile values are proposals. They are not calibrated against device frame budgets.
- The manifest does not know whether an Engine batches repeated placements; `instancing` is the caller's claim.
- `sceneTrianglesAt` is a pure reading of LOD distances. It does not model view frustum or occlusion.
