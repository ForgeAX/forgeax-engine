---
name: forgeax-engine-shader
description: ForgeAX WGSL composition, reflection, and cooked shader contracts. Use when authoring or debugging custom shaders, parameter schemas, bindings, or shader readiness.
---

# forgeax-engine-shader

[Simplified Chinese](SKILL.zh-CN.md)

Optional River `transitionContinuity` uses the accepted end-spline position and
actual current-generation Ocean coverage adjacency. Author finite meter reach
and blend width; the complete shared triangle is closed inside the inner reach
and upstream height is retained outside support. Source flow/depth remain
native/query-owned. WaterMesh v8 keeps a 96-byte record and adds a `WCN1` numeric
support offset in byte 92; vertex and fragment share its original-grid policy.
Use `material-pack-cooker/7` to recook. Compiled publications use `material-cook/5`.
GPU traversal, independent Baked depth, custom deformation and independent
advanced displacement are outside this initial continuity contract. See the
[owning Water contract](../../packages/water/README.md#optional-terminal-surface-continuity)
and execute the nearest production Dawn gate before claiming pixels accepted.

## Contract index

For geometric refraction and caustic concentration, import the pure optical
primitives from `forgeax_optics::interface`; read the [Shader contract](../../packages/shader/README.md#geometric-optical-interface).
Use `sampleWaterGerstnerSurface` only with the qualified `gerstner-fixed/1`
source and shared receiving Water binding. Its coordinates precede horizontal
displacement; a displaced world-XZ lookup needs its own inverse mapping.
Keep field encoding, overlapping energy accumulation and material response in
the effect; these primitives do not select receivers or lighting.

For draw-varying numeric values in a custom direct mesh shader, use
`MeshDrawParameters` from `@forgeax/engine/render`. Use the render components
plugin or register it directly in a standalone World. Read its two float vectors through `meshes[0]`
and pass them to the fragment stage through flat varyings. See the
[render contract](../../packages/render/README.md#direct-mesh-draw-parameters)
for scope and lifetime.

Ordinary `.pack.ts` materials ship a resolved source template and its WGSL
imports. Check asset admission first, then the program picked by the actual
render pass, geometry and device. Use the GPU capture to verify the selected
reflection and pixels. Direct and explicitly compiled material assets retain
their existing program receipts.

For a textured single-layer medium Surface, declare textures in the material parameters and sample the generated texture/sampler symbols. The compiler and Render derive the author region and relocate native optical resources together; never copy fixed IBL, backdrop, depth or planar bindings into a game shader.

Water uses the root-owned `water-deformation/1` declaration and canonical
input layout from Types; cook receipts cover color, depth, shadow and velocity.
A Surface-only WaterInfo reader can omit deformation. The reflected
`water-frame/3` entrypoint bindings determine the actual Water resource subset,
visibility and dynamic-offset order. Fixed/Baked Body inputs need no texture;
WaterInfo readers require a real same-view target. See the
[Water material contract](../../packages/water/README.md#material-family).
Every Body GPU row retains its accepted fixed fallback constants independently
of the sampled source mode; disabling WaterInfo must preserve that buffer path.
The Water-only input ABI carries raw `vertexColor` and vertex-decoded
`vertexFlowXZ`; decode and actor-direction transformation precede interpolation.
Static Baked/fixed switches select their source explicitly, while one Body
publication retains the real WaterInfo and Baked resources it can access.
`waterVertexMapping` lowers independently to vertex height availability and
does not prune fragment reads or waves. `waterDynamicBoundsClip` lowers to
`WATER_DYNAMIC_BOUNDS_CLIP` with default false, independently of mapping/Info.
Its stock consumer uses post-WPO fragment position and the generation-qualified
Body row's `dynamicBoundsCenterExtentXZ`, without requiring an Info texture.
Absent bounds bypass clipping. Use the compiler's `material-pack-cooker/7`
producer to invalidate older derived bytes. Compiled publications use `material-cook/5`.
`WATER_TRANSITION_AVAILABLE` derives from disabled ordinary waves plus an enabled
transition. Its default deformation requires the authored `f32` wave-mask speed
and, when vertex flow can be selected, the `f32` maximum decoded-flow speed.
Missing fields reject before compilation; an Info switch alone does not exclude
the Body's runtime vertex-flow fallback.
Water Surface input preserves pre-WPO normal/position and pre-Water scene
depth. Its appended `wavePhaseXZ` derives from small morphed WaterMesh coverage
plus target-relative tile offsets before wrapping; do not interpolate wrapped
phase or subtract large absolute `f32` positions. Only resolved stock default
deformation enables complete fragment Gerstner-normal evaluation. Source depth
uses no-WPO position, transition velocity uses post-WPO position, and target rows
select waves/time. Keep `refractionPixelNormalStrength` and `refractionDepthBias`
dimensionless, with `physicalIor` independent. The ordinary inherited
`criticalAngleDot` and `refractionBottomAmount` control underside response
independently of `specular`. Water SSR hit motion must match the exact opaque
depth texel within its FP16 log-depth precision before replacing matrix
reprojection; the coarse traced ray depth is not a layer identity.
Water hit radiance history uses unjittered screen coordinates. Reconstruct its
current raster hit with the jittered inverse View once, then project through the
unjittered current/previous matrices before applying matching opaque motion.
Water temporal entries evaluate time-dependent Surface normals at the two
accepted Body clocks and publish shading reactivity separately from geometry
velocity. Use `SingleLayerWaterSurfaceInput.frameTime` for authored animation;
frozen clocks and static normals retain accumulation. This comparison cannot
recover old contents of a producer texture that has already advanced.
Standard Surface modules that sample textures themselves under TAA/TSR should pass
`SurfaceInput.materialTextureMipBias` (UE View.MaterialTextureMipBias, negative on the display
view, zero for shadow/ray/card) to `sampleSurfaceTexture` or `textureSampleBias`.
Stock Water keeps near-wave current/previous deformation and fragment normals
at far boundaries. The retained versioned adjacency bits do not automatically
flatten the surface to a mean plane. Preserve the far material's independent
wave switches and saved height authority.
Deferred Water and opaque SSR use the same closest-depth surface traversal and exact
intersection validation, with explicit SSR iteration budgets. Water builds its
hit hierarchy from opaque depth and keeps its separate displaced receiver,
capture/sky suppression, while main AA owns history. This is an intentional departure
from the UE Water Furthest/16-step cast: stochastic sample locations and coarse
depth-difference interpolation cannot establish exact surface coordinates or
retain thin silhouettes. Do not change GPU occlusion's furthest hierarchy or
restore removed independent SSR temporal rejection or history owners.
Keep traversal progress independent of a major-axis epsilon: minor-axis cell
addresses need directional f32 boundary rounding. Screen-ray view depth is
reciprocal-affine only for perspective; orthographic rays use linear depth and
the projection's depth derivative for near clipping. A rejected surface
candidate resumes the ray under the same total iteration/refinement budgets.
`foamVelocityMPerSec` defaults to `[0, 0]`. It advects only the authored foam
texture and normal coordinates using scene time; simulation coverage and
contact history retain their producer mapping and lifetime.
The connected foam branch's
graph-owned texture and distinct clamp/wrap samplers follow the existing medium physical tail; only an
actually declared branch admits and binds it. It is not an authored texture
parameter and does not change the generic medium Surface ABI.
Shared contact foam and additive shallow-wave foam remain independent inputs.
Combine their sampled responses with the existing maximum operation; a valid
contact capture domain cannot mask a stronger wave source. Shared contact and
residual-only mapping publish bounded foam coverage. Multiply coverage by the
authored opacity/scattering texture samples; do not apply legacy height power,
boost or threshold. Retain material amount, depth fade, normals and optics.
SLW volume uses the shared diffuse-indirect sky input before surface AO and
converts E/pi to isotropic ambient with a factor of one quarter. Keep the
existing receiver AO on surface diffuse only; precomputed bent-normal lighting
is unavailable without a lighting-owned producer.

The shader compiler composes real module slots, reflects the closed compiler
context, and records actual WASM provenance. The runtime template path uses the
host-supplied portable compiler for selected Engine programs. Source-template
MaterialAssets request one Pass, device context and raster address at a time.
The producer validates the selected entry and its bindings. Pack cook validates
all addresses it publishes, including the paired vertex contract. Inspect
per-address compilation through the
[pipeline audit](../forgeax-engine-performance/SKILL.md#audit-shader-and-pipeline-work).
Cooked MaterialAsset programs retain their Pack producer. Material
identity is layered across `materialContractDigest`, `sourceClosureDigest`,
`layoutIdentity`, `programIdentity`, `cookIdentity`, and
`materialPublicationIdentity`. The runtime receives the Pack projection for
cooked programs.

Standard's raster interface reserves one default-device inter-stage input for
`front_facing`. Fragment position and NDC reconstruct from builtin position and
the inverse view projection. Water-only coverage/grid inputs retain their own
lane, and the wave mask shares the Water normal's fourth component. Keep
vertex color, all eight UV sets, object basis and scene indexing within the
remaining fifteen locations, and verify the affected runtime selections after template edits.

> [!IMPORTANT]
> The authoring route is WGSL source plus one MaterialAsset contract. Build-time composition and reflection publish a module manifest entry; material cook publishes the artifact and receipt; runtime resolves both through the catalog. App code never installs or duplicates a shader artifact. The recovery route is source or cook repair.

CI manifest transport loads the publication TypeScript source directly in native
Node. Keep that source boundary natively resolvable and verify it without a
bundler; bundled package tests alone do not exercise this route.

Publication shares source fragments and ABI receipts. Registry admission verifies
every source and variant before atomic adoption, but retains composed WGSL only
when consumed. Rebuild obsolete prepared/shared profiles with the source producer;
do not skip digest checks or prune capability variants to make a manifest smaller.
For repeated prepared-build publication cost, inspect pooled-fact serialization.
Intern immutable object identity only inside one publication; retain canonical
value deduplication, every variant, exact output bytes and fresh later-build facts.

Detached reflection facts may share equal immutable subtrees within one
publication. Keep the pool local to admission, preserve complete value/order
semantics and measure cold admission cost as well as retained storage. Borrowed
mutable descriptors must never enter an identity-based reuse path.

## Color-lighting parity handoff

When the parity report names a shader or output-domain divergence, start at the [parity README](../../apps/parity/color-lighting/README.md) and use the status recovery map to select the owner. Compare the same `SceneCase` and `CaseReport`; a source-name match without independent producer evidence is not a pass.

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
const result = await assets.load(materialGuid, 'material');
if (!result.ok) {
  report(result.error.code, result.error.detail, result.error.hint);
  return;
}
const materialHandle = result.value;
// Bind directly to MeshRenderer.materials; release the caller reference after binding.
const content = assets.read(materialHandle).unwrap(); // detached inspection only
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

Custom Standard Surface coverage uses the root's existing static choices:
`alphaClipping` selects the Surface output threshold and `alphaHash` opts into
hash coverage. `Materials.standard` defaults both off for a custom Surface;
`alphaClip` publishes `alphaClipping`, not a pass tag. JSON roots use the same
switches. Do not infer custom coverage from stock parameter names or the legacy
`alphaMask` receipt: that pair describes stock inputs, not entry side effects.
Preserve authored discard and independent LOD/view/local clipping, and verify
the cooked direct and scene-index programs before claiming an opaque entry.
Builtin Unlit and skinned Standard select camera clipping independently from
material-local planes. Unlit color/depth use the explicit alpha-mask lane;
its temporal coverage remains exact. Alpha helpers return a rejection value,
and fragment entry points own the discard; do not extend the nested-discard
allowlist to admit a new helper.

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
`neutral`, matching Three r184. `reinhard-extended` is the separate ForgeAX
luminance-domain curve; `ue-filmic` is Unreal's default Filmic curve and
settings. Every active mode receives linear HDR color and
exposure, writes linear LDR color, and relies on the display attachment for the
final encoded output. The WGSL formulas live in
[`src/tonemap.wgsl`](../../packages/shader/src/tonemap.wgsl); do not copy them
into a material, app, or another shader module.

To validate a change, compile the shader through the normal build composition
path and compare the resulting final capture against the Three r184 analytic
oracle. A source-name match without formula and output-domain parity is not a
passing result.

## GPU-driven scene-index materials

Use the [LOD coverage ABI](../../packages/shader/README.md#lod-coverage-abi)
when composing scene-index vertex entries. Import `sceneInstances` from
`forgeax_view::common` for Skin palette addressing and read
`sceneInstances[visible.x].customDataStart`. LOD selection stays with the GPU
cull; the material only applies its published coverage.

> [!IMPORTANT]
> Migration: a cooked scene-index material must not read `Mesh` rows or treat
> `visible.x` as a per-batch index. Resolve transforms, temporal flags and
> probe identity with `sceneIndexDraw(visible.x)` from
> `forgeax_view::common`, and pass `bitcast<f32>(visible.w)` to
> `applyLodCoverage`.

Scene-index Morph uses the common module's position, normal and tangent accessors
before world transformation or skinning. Its compact target records and channel
mask come from the Render producer; do not assume position-only target strides.
Canonical tangent deltas have four components; imported glTF deltas have zero W
and preserve handedness. Never read the four-component stream with an XYZ stride.

## Contract and reflection

The compiler derives uniform layout, sampler/texture bindings, and injection
slots from the MaterialAsset parameter contract. WGSL reflection must match the
derived layout. A mismatch is a build or cook failure and must be repaired at
the source boundary.

Native selected-entry `effects` accompany binding reads. Missing legacy effects
are unknown; never infer an effect-free entry from parameter names, source text
or another entry in the module. Preserve depth/sample-mask/storage effects and
pipeline alpha-to-coverage when considering a position-only prepass. Contradictory
native facts for identical source require producer repair.

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

`pnpm build:engine` prepares the Engine packages for Vite and DevKit.
`forgeaxShader()` publishes built-in templates and the runtime prepares selected
programs. Standalone Dawn fixtures use `buildEngineShaderTemplateManifest` for
built-ins and `buildProjectShaderTemplateManifest` when the fixture declares
material packages. Cook the declared material closure and retain its receipts.
Opt into `publication: 'compiled'` for an explicit composed-source contract. See the
[shader plugin contract](../../packages/vite-plugin-shader/README.md) and
[CI operating guide](../../scripts/ci/README.md) before changing preparation.
Standalone Dawn tests reuse the existing `shaderManifestUrl` fixture, which
serializes `publishShaderManifest(entries, materialShaders)`. Do not percent-encode
the expanded builder result.

After rebuilding Engine shader profiles, restart existing preview servers and
reload their pages before visual acceptance. A running Vite plugin can retain
its startup manifest while changed Render modules reload; graph labels alone
do not prove that the executing shader matches the new producer contract.
For an observed mismatch, inspect the captured pipeline's actual shader and
bindings through RHI Debug, then verify the repaired scene on the fresh server.

- Material shape: [`forgeax-engine-material`](../forgeax-engine-material/SKILL.md)
- Asset catalog and pack roots: [`forgeax-engine-assets`](../forgeax-engine-assets/SKILL.md)
- Shader package: [`packages/shader/README.md`](../../packages/shader/README.md)
- Migration: `docs/material-asset-migration.md`

## Runtime source ownership

`MaterialShaderProgram` owns immutable CPU facts and a `sourceReference`; `.source`
borrows complete WGSL from its immutable source owner. Runtime raw strings remain
whole: never rebuild a fragment pool while receiving a library or material.
Build-produced manifest references and their integrity checks remain supported.
Registry lookup indexes the same program,
without a separate facts cache. Managed module factories preserve this source owner
so prewarm/runtime hits do not expand or hash it again. Full descriptor/state equality
and device-local native completion still govern pipeline reuse.

Registry `sourceLimits` bounds new dynamic source bytes and registration/schema/module
alias slots, including failed schema retention. Fixed startup/background source inputs
are a closed constructor snapshot under finite input safety, not a runtime static flag.
Fork/adoption preserve used allowance; rejected admission leaves previous artifacts
usable. Use `sourceInspection()` and the [Shader README](../../packages/shader/README.md)
for the actual ownership and defaults; source quotas are not GPU/VRAM capacities.

## Cooked material CPU preparation

Cooked programs enter ShaderRegistry through `installMaterialArtifactBytes` with
verified byte digests, schemas and ABI/read metadata. Inspect availability with
`materialArtifactDeclaration` or `materialShaderIdentifiers`; an ordinary
`materialArtifact` / `findMaterialArtifact` lookup prepares that selected WGSL.
Keep Worker publication and device recovery on declaration/adoption paths so they
do not decode every variant. Source-dependent validation still runs before a
prepared program is returned. Artifact loading/decompression and GPU compilation
retain their existing timing; this route adds no runtime compiler.

## Three surface expression recipes

For original r187 Standard/Basic NodeMaterial expressions, use the explicit
`cookThreeSurface` build entry and `bindThreeSurface` player binding described in
[Three's owning contract](../../packages/three/README.md#cooked-surface-expressions).
Keep admission and lowering on the same private typed DAG; use native
cook/reflection for layout and publication. Preserve ordinary material fast
paths and the owning contract's explicit rebind boundary. Reject inputs outside
the documented subset with a typed source path; qualify stage consumers
independently. Do not invoke NodeMaterial.build, NodeBuilder, GLSL translation
or the compiler from the player.
An existing ordinary map slot may bind a completed native 2D target alongside
independent expression roots. Cook the slot membership and await the target write;
this does not admit render-target TextureNodes or framebuffer-dependent graphs.
