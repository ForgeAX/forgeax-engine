---
name: forgeax-engine-shader
description: ForgeaX WGSL composition, reflection, and cooked shader contracts. Use when authoring or debugging custom shaders, parameter schemas, bindings, or shader readiness.
---

# forgeax-engine-shader

## Contract index

The shader compiler is build-time only: it composes real module slots, reflects
the closed compiler context, and records actual WASM provenance. Material
identity is layered across `materialContractDigest`, `sourceClosureDigest`,
`layoutIdentity`, `programIdentity`, `cookIdentity`, and
`materialPublicationIdentity`; runtime receives the Pack projection and never
compiles, cooks, or interprets feature macros.

> [!IMPORTANT]
> The authoring route is WGSL source plus one MaterialAsset contract. Build-time composition and reflection publish a module manifest entry; material cook publishes the artifact and receipt; runtime resolves both through the catalog. App code never installs or duplicates a shader artifact. The recovery route is source or cook repair.

Publication shares source fragments and ABI receipts. Registry admission verifies
every source and variant before atomic adoption, but retains composed WGSL only
when consumed. Rebuild obsolete prepared/shared profiles with the source producer;
do not skip digest checks or prune capability variants to make a manifest smaller.

## Color-lighting parity handoff

When the parity report names a shader or output-domain divergence, start at the [parity README](../../apps/parity/color-lighting/README.md) and use the [status recovery map](../../apps/parity/color-lighting/status-index.md) to select the owner. Compare the same `SceneCase` and `CaseReport`; a source-name match without independent producer evidence is not a pass.

## Route

The recovery route is structured error inspection followed by source or cook
repair before the first draw. Per-slot `coordinates` stay on the material
texture value.

1. Give the WGSL source a package-owned `#define_import_path`.
2. Import engine modules such as `forgeax_view::common` and
   `forgeax_pbr::brdf`.
3. Declare the same fields in the root MaterialAsset `parameters`, optional
   `parent`, and `values`; use `passes[].program.module` for the module identity.
4. Run build composition, reflection, and material cook.
5. Load the MaterialAsset by GUID and inspect structured readiness errors before
   the first draw.

```ts
assets.configurePackIndex('/pack-index.json');
const result = await assets.loadByGuid<MaterialAsset>(materialGuid);
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = world.allocSharedRef('MaterialAsset', result.value);
```

## External (video) textures

A parameter `{ name: 'videoTexture', type: 'texture_external' }` reflects to a
WGSL `texture_external` binding plus its `videoTexture_sampler`, and derives an
`externalTexture` layout entry. Import both from
`forgeax_material::parameters` and sample with
`textureSampleBaseClampToEdge(videoTexture, videoTexture_sampler, uv)` (no
mips, no `textureSample`). The same slot accepts a zero-copy video
frame, a copied frame when `caps.externalTexture` is false, or an imported
`GPUTexture`, so one shader serves every backend. The frame keeps source
orientation: `uv.y = 0` is the image top (no flip).

## Blended custom materials and fog

A custom WGSL material drawn with a blend state imports
`forgeax_view::fog::{translucent_fog}` and returns
`translucent_fog(view, worldPos, color, alpha)` as its final color, applying it once
per writer. The renderer picks straight, premultiplied or additive composition from
the blend state and binds the unfogged View for opaque draws, so the same program
serves both. Clip-space producers reconstruct `worldPos` with `ndc_world`.

## Coordinate inputs

The built-in and custom paths use named texture values. `coordinates.set`
selects the vertex coordinate input and `coordinates.transform` applies offset,
scale, and rotation. Do not add a global material coordinate selector; it
cannot represent glTF materials whose slots use different inputs.

## Built-in tone mapping

The built-in `forgeax::tonemap` module is a fullscreen output shader, not a
MaterialAsset shader. Its public mode IDs are exported as
`TONEMAP_SHADER_MODE` from `@forgeax/engine-shader`; Camera constants in
`@forgeax/engine-render` consume that typed binding contract.

The named curves are `linear`, `reinhard`, `cineon`, `aces-filmic`, `agx`, and
`neutral`, matching Three r184. `reinhard-extended` is the separate ForgeaX
luminance-domain curve. Every active mode receives linear HDR color and
exposure, writes linear LDR color, and relies on the display attachment for the
final encoded output. The WGSL formulas live in
[`src/tonemap.wgsl`](../../packages/shader/src/tonemap.wgsl); do not copy them
into a material, app, or another shader module.

To validate a change, compile the shader through the normal build composition
path and compare the resulting final capture against the Three r184 analytic
oracle. A source-name match without formula and output-domain parity is not a
passing result.

## GPU-driven scene-index materials

GPU-driven raster and shadow passes bind one visible item `vec4<u32>` per
drawn instance: `x` scene instance row, `y` scene material row, `z` skin
palette base, `w` bitcast signed LOD coverage. LOD level and coverage are
chosen by the GPU cull per view; the material never selects a level.

> [!IMPORTANT]
> Migration: a cooked scene-index material must not read `Mesh` rows or treat
> `visible.x` as a per-batch index. Resolve transforms, temporal flags and
> probe identity with `sceneIndexDraw(visible.x)` from
> `forgeax_view::common`, and pass `bitcast<f32>(visible.w)` to
> `applyLodCoverage`. See the
> [LOD coverage ABI](../../packages/shader/README.md#lod-coverage-abi).

## Contract and reflection

The compiler derives uniform layout, sampler/texture bindings, and injection
slots from the MaterialAsset parameter contract. WGSL reflection must match the
derived layout. A mismatch is a build or cook failure and must be repaired at
the source boundary.

## Recovery

| Code | Recovery |
|:--|:--|
| `shader-module-id-missing` | Add a compiler-native module identifier |
| `shader-module-id-duplicate` | Keep one source for the module id |
| `shader-module-not-found` | Add the module to the build source catalog |
| `shader-module-namespace-reserved` | Choose a user-owned namespace |
| `material-reflection-binding-mismatch` | Align WGSL bindings with the root contract and re-cook |
| `material-specialization-not-cooked` | Run the cook path for the requested selection |
| `material-specialization-stale-generation` | Re-cook after dependent source changes settle |

For every failure, switch on `error.code` and read `error.detail` and
`error.hint`. A demo failure routes to the engine or cook boundary; it is not
fixed by changing the demo's material data. This is the recovery route.

## Routing

In an Engine contributor checkout, standalone Dawn fixtures with authored
material packages use `buildEngineShaderManifest` with the CI-admitted shared
inputs: built-in rows are reused while custom materials still compile from
source. Point-shadow requests require their source profile. See the
[shader plugin contract](../../packages/vite-plugin-shader/README.md) and
[CI operating guide](../../scripts/ci/README.md) before changing preparation.
Standalone Dawn tests reuse the existing `shaderManifestUrl` fixture, which
serializes `publishShaderManifest(entries, materialShaders)`. Do not percent-encode
the expanded builder result.

- Material shape: [`forgeax-engine-material`](../forgeax-engine-material/SKILL.md)
- Asset catalog and pack roots: [`forgeax-engine-assets`](../forgeax-engine-assets/SKILL.md)
- Shader package: [`packages/shader/README.md`](../../packages/shader/README.md)
- Migration: `docs/material-asset-migration.md`
