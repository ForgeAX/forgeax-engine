#import forgeax_geometry::tangent_frame32::{decodeTangentFrame32}
#import forgeax_view::common::{forwardScreenSurface}
#import forgeax_cloud::layer::{viewLinearSampler}

#import forgeax_pbr::sky_sh_polynomial::{SkyShPolynomial}
#pragma material_slot surface
#import forgeax_material::standard_physical_inputs::{PhysicalMaterialUvs, finiteScalar, finiteColor, evaluateStandardSpecular, evaluateStandardAnisotropy, evaluateStandardIridescence, evaluateStandardTransmission, evaluateStandardDiffuseTransmission, evaluateStandardSheen, evaluateStandardClearcoat, evaluateStandardClearcoatNormal}
#import forgeax_material::alpha_hash::{materialOutputAlpha, materialOutputColor}
#import forgeax_material::displacement::{evaluateStandardVertexPosition, standardDisplacementTriangleNormal, standardDisplacementSurfaceNormal, evaluateStandardParallax}
#import forgeax_material::standard_surface_maps::{evaluateStandardTemporalAlpha}
#import forgeax_clipping::planes::{applyViewClipping, viewClippingRejected, applyLocalClipping}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardClearcoatReflection, sampleStandardDiffuseIrradiance, evaluateStandardEnvironment, evaluateStandardDirect}
#ifdef PROBE_BLEND_AVAILABLE
#import forgeax_pbr::lighting_probe::{applyStandardProbeIrradiance}
#endif
#import forgeax_pbr::gbuffer_output::{GBufferOutput, encodeStandardGBuffer, CompactGBufferOutput, StandardGBufferPassOutput, encodeCompactStandardGBuffer, encodeStandardReceiverContext, compactSubsurfaceCustomData}
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness, encodeStandardReceiverNormal}

#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData, surfaceGeometryNormal}
#import forgeax_view::common::{viewDirectionToCamera, lightingChannelsMatch, View, Mesh, meshMotionValid, meshGBufferObjectFlags, InstanceData, view, shadowMap, shadowSampler}
#ifdef TRANSMISSION_AVAILABLE
#import forgeax_view::fog::{forward_fog_transmission}
#else
#import forgeax_view::fog::{forward_fog, forward_vertex_fog}
#endif
#import forgeax_view::fog::{vertex_height_fog}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, sceneIndexMorphPosition, sceneIndexMorphNormal, sceneIndexMorphTangent, sceneInstances}
#else
#import forgeax_view::common::{meshes, instances, meshReceivesShadows}
#endif
#import forgeax_scene_temporal::{encodeSceneVelocityWithDepth, sceneFragmentViewZ, packSceneTemporalV1WithValidity, unpackSceneTemporalV1}
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_ssr::forward::{forwardSsrOpaque}
#import forgeax_view::common::{spotModifierSampler, iesProfileTexture, cookieTexture, cookieMatrices}
#endif
#import forgeax_pbr::temporal::{applyPbrTemporalCoverage, packStandardTemporalCoverage, resolvePbrTemporalReactive, surfaceTemporalReactive}
#import forgeax_pbr::brdf::{standardOpaqueF0FromDielectric, standardDielectricF0, f_schlick, v_smith, d_ggx}
#import forgeax_pbr::ibl_shared::{standardSpecularOcclusion}
#import forgeax_pbr::specular_aa::{geometricNormalSpread, shadingNormalSpread, specularAntiAliasedRoughness}
#import forgeax_pbr::ibl_sampling::{projectSpecularRadiance}
#ifdef CLEARCOAT_AVAILABLE
#import forgeax_pbr::clearcoat::{evaluateClearcoatLayer, evaluateClearcoatFresnel}
#endif
#ifdef ANISOTROPY_AVAILABLE
#import forgeax_pbr::anisotropy::{evaluateAnisotropicNormal}
#endif
#ifdef SHEEN_AVAILABLE
#import forgeax_pbr::sheen::{evaluateSheenLayer}
#endif
#ifdef IRIDESCENCE_AVAILABLE
#import forgeax_pbr::iridescence::{evaluateIridescenceFresnel}
#endif
#import forgeax_pbr::lighting_directional::{evalDirectionalNoShadow, evalDirectionalShadowFactorAtPixel}
#import forgeax_view::atmosphere::{view_apply_direct_solar}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{evaluateStandardClusterLights, sampleStandardAmbientOcclusion, sampleStandardContactShadow, sampleStandardScreenData, applyStandardScreenDecals}
#endif

#define_import_path forgeax_material::pbr-skin
#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma variant_axis PROBE_BLEND_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis TRANSMISSION_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#pragma variant_axis REFLECTION_FALLBACK_AVAILABLE
#pragma variant_axis COVERAGE_ONLY
#pragma variant_axis ALPHA_MASK
#pragma variant_axis CLIPPING_PLANES



// @forgeax/engine-shader - default-standard-pbr-skin.wgsl
// (feat-20260523-skin-skeleton-animation M3 / T-29).
//
// Engine-shipped default standard PBR material shader with GPU skinning,
// registered under the reserved path identifier `forgeax::pbr-skin`
// (plan-strategy D-3). Fragment stage is byte-for-byte identical to
// default-standard-pbr.wgsl — the two shaders share the same PBR/IBL/TBN/
// lighting helpers via #import. The vertex stage adds 4-bone weighted
// skinning before the worldFromLocal transform.
//
// Bindings (4 BG layout slots; @group(0) View / @group(1) Material+Texture
// / @group(2) Meshes+Palette — identical to default-standard-pbr except
// @group(2)@binding(1) adds the skin palette storage buffer):
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl)
//   @group(1) @binding(0) material                   uniform
//   @group(0) @binding(34..35) Sky SH and View diffuse parameters.
//   @group(2) @binding(32..34) Selected Primitive reflection environment.
//   @group(2) @binding(0) meshes                     storage   (worldFromLocal mat4
//                                                               + temporal fields,
//                                                               see common.wgsl)
//   @group(2) @binding(1) palette                    storage   (array of joint
//                                                               skinning mat4x4,
//                                                               CPU-precomputed
//                                                               world * IBM)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance
//                                                               mat4; see
//                                                               common.wgsl —
//                                                               preventive
//                                                               structural
//                                                               alignment:
//                                                               SkinInstances-
//                                                               CoexistForbidden
//                                                               blocks skin +
//                                                               instances, so
//                                                               instances[idx]
//                                                               = I identity)
//
// Skinning formula (plan-strategy D-3 / D-3a):
//   world_pos  = Sum(w_i * palette[base + skinIndex[i]] * local_pos)
//   world_norm = transpose(inverse(mat3x3(skin_matrix))) * local_normal
// 4 joints max; weighted sum of skinned positions from the palette buffer
// indexed by the per-vertex skinIndex vector.

// Surface composition generates MaterialParameters, its uniform, and the
// map bindings from the material schema. Scene color belongs to the pass.
#ifdef TRANSMISSION_AVAILABLE
@group(0) @binding(38) var transmissionBackdropTexture : texture_2d<f32>;
#endif

// Preserve filtering reflection for resources passed to the shared sampler.
#ifdef EXTENDED_LIGHTING_AVAILABLE
@group(0) @binding(27) var forwardHiZ: texture_2d<f32>;
@group(0) @binding(28) var forwardSsrColor: texture_2d<f32>;
#endif

fn materialTextureFilteringWitness() {
#ifdef DIRECT_DFG_LUT_AVAILABLE
  _ = textureSample(directDfgLut, viewLinearSampler, vec2<f32>(0.0));
#endif
#ifdef ENV_BRDF_LUT
  _ = textureSample(brdfLut, viewLinearSampler, vec2<f32>(0.0));
#endif
#ifdef TRANSMISSION_AVAILABLE
  _ = textureSample(transmissionBackdropTexture, viewLinearSampler, vec2<f32>(0.0));
#endif
}

@group(0) @binding(34) var<uniform> skySh : SkyShPolynomial;
@group(0) @binding(35) var<uniform> viewSkylight : SkylightUniforms;
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(0) @binding(40) var directDfgLut: texture_2d<f32>;
#endif
@group(2) @binding(32) var prefilterMap         : texture_2d<f32>;
@group(2) @binding(33) var prefilterSampler     : sampler;
#ifdef ENV_BRDF_LUT
@group(0) @binding(39) var brdfLut              : texture_2d<f32>;
#endif
@group(2) @binding(34) var<uniform> skylight    : SkylightUniforms;

#ifdef PROBE_BLEND_AVAILABLE
@group(3) @binding(1) var<storage, read> probeBlendRecords : array<vec4<f32>>;
#endif

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
#endif

#import forgeax_skin::task::{skinTaskDescriptor, skinTaskBlend, skinTaskPosition, skinTaskDirectCandidate, skinTaskPreviousTranslation, skinTaskHistoryValid}


struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv      : vec2<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) tangent : vec4<f32>,
#endif
  @location(4) skinIndex  : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(6) uv1     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(7) uv2     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(8) uv3     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(9) uv4     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(10) uv5    : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(11) uv6    : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(12) uv7    : vec2<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color  : vec4<f32>,
#endif
};

struct Frame32Input {
  @location(14) tangentFrame : u32,

  @location(0) pos     : vec3<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv      : vec2<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
#endif
  @location(4) skinIndex  : vec4<u32>,
  @location(5) skinWeight : vec4<f32>,
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(6) uv1     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(7) uv2     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(8) uv3     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(9) uv4     : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(10) uv5    : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(11) uv6    : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(12) uv7    : vec2<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color  : vec4<f32>,
#endif
};

fn frame32Input(input:Frame32Input)->VsIn {
  var output : VsIn;
  let frame=decodeTangentFrame32(input.tangentFrame);

  output.pos = input.pos;
  output.normal = frame.normal;
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv = input.uv;
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  output.tangent = frame.tangent;
#endif
  output.skinIndex = input.skinIndex;
  output.skinWeight = input.skinWeight;
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv1 = input.uv1;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv2 = input.uv2;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv3 = input.uv3;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv4 = input.uv4;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv5 = input.uv5;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv6 = input.uv6;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  output.uv7 = input.uv7;
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  output.color = input.color;
#endif
  return output;
}

struct VsOut {
  @builtin(position) @invariant clip : vec4<f32>,
  // Keep mesh and instance storage vertex-only: the flat object basis
  // serves transmission, triplanar object projection and object-space
  // normal maps.
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(4) @interpolate(flat) objectBasis0 : vec4<f32>,
  @location(6) @interpolate(flat) objectBasis2 : f32,
#endif
  // xyz retains the shading normal; w carries ordinary vertex-fog T.
  @location(1) worldNormal : vec4<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv0And1 : vec4<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) worldTangent : vec4<f32>,
#endif
  // View depth and NDC are read back from @builtin(position) in the
  // fragment stage (UE BasePassVertexCommon.ush:23-31 carries no clip/NDC
  // interpolant; Common.ush:1530-1542 SvPositionToScreenPosition).
#ifndef STANDARD_OBJECT_POSITION_UNUSED
  @location(7) positionOS : vec3<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(5) uv2And3 : vec4<f32>,
#endif
  // (temporal reactive lane, lighting channels): the skinned GBuffer writes
  // no visible-surface row.
  @location(9) @interpolate(flat) surfaceData : vec2<u32>,
  @location(11) clipDelta : vec4<f32>,
  // UV4/UV5 and UV6/UV7 each share one vec4 slot so the object basis, vertex
  // color and scene-index address fit 15 user locations beside front_facing.
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(10) uv4And5 : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(12) uv6And7 : vec4<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(13) @interpolate(flat) objectBasis1 : vec4<f32>,
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index variants carry the row selector in the storage-backed lane.
  // They never target the WebGL2 uniform-fallback limit, so location 15
  // stays outside its 14-location ABI.
  // The probe slot/generation lanes ride only under PROBE_BLEND_AVAILABLE
  // (UE LocalVertexFactoryCommon.ush:42-43 interpolates per-primitive facts
  // only for permutations that read them).
#ifdef PROBE_BLEND_AVAILABLE
  @location(15) @interpolate(flat) materialAddress : vec3<u32>,
#else
  @location(15) @interpolate(flat) materialAddress : u32,
#endif
#endif
};

fn standardVertexPosition(in : VsIn) -> vec3<f32> {
  return evaluateStandardVertexPosition(in.pos, in.normal,
#ifdef STANDARD_UV_INPUT_UNUSED
    array<vec2<f32>, 8>(),
#else
#ifdef STANDARD_SINGLE_UV_SET
    array<vec2<f32>, 8>(in.uv, in.uv, in.uv, in.uv, in.uv, in.uv, in.uv, in.uv),
#else
    array<vec2<f32>, 8>(in.uv, in.uv1, in.uv2, in.uv3, in.uv4, in.uv5, in.uv6, in.uv7),
#endif
#endif
  );
}

fn vs_main_impl(in : VsIn, paletteBase : u32, materialAddress : vec3<u32>, temporal : vec2<f32>, translation : vec3<f32>, previousTranslation : vec3<f32>) -> VsOut {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#ifndef STANDARD_VERTEX_MATERIAL_UNUSED
  material = selectedMaterial(materialAddress.x);
#endif
#endif
  let localPosition = standardVertexPosition(in);
  let descriptor = skinTaskDescriptor(paletteBase);

  // The actual task resolved world-joint times inverse-bind once. Both
  // current and previous reads use this candidate's transient descriptor.
  let skinMatrix = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);

  let skinnedLocal = skinTaskPosition(descriptor, skinMatrix, localPosition, translation);

  // Extract the upper-left 3x3 for normal/tangent transformation
  // (plan-strategy D-3a). WGSL mat4x4 columns are vec4:
  //   col0 = palette[i][0], col1 = palette[i][1], col2 = palette[i][2].
  // We sum the weighted columns across the 4 joints to build the 3x3.
  let m0 = skinMatrix[0].xyz;
  let m1 = skinMatrix[1].xyz;
  let m2 = skinMatrix[2].xyz;
  let skinNormal3x3 = mat3x3<f32>(m0, m1, m2);

  // world = skinnedLocal (position), no extra left-multiply --
  // palette = jointWorld * IBM is already full world-space.
  var out : VsOut;
  out.clip = view.worldViewProj * skinnedLocal;
  let previousSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, true);
  let previousWorld = skinTaskPosition(descriptor, previousSkin, localPosition,
    select(translation, previousTranslation, skinTaskHistoryValid(descriptor)));
  let currentClip = view.temporalCurrentViewProj * skinnedLocal;
  let previousClip = view.temporalPreviousViewProj * previousWorld;
  // Equal poses produce exact zero before interpolation. Reprojecting two
  // separately rounded world/clip varyings would invent stationary motion.
  out.clipDelta = currentClip - previousClip;
  let reactiveLane = packSceneTemporalV1WithValidity(
    currentClip, previousClip,
    view.temporalProjection, temporal.x, temporal.y >= 0.5 && skinTaskHistoryValid(descriptor)).w;
  out.surfaceData = vec2<u32>(bitcast<u32>(reactiveLane), 0xffffffffu);
#ifndef STANDARD_OBJECT_POSITION_UNUSED
  out.positionOS = localPosition;
#endif
  out.worldNormal = vec4<f32>(normalize(skinNormal3x3 * in.normal), vertex_height_fog(view, skinnedLocal.xyz));
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let worldTangentXyz = normalize(skinNormal3x3 * in.tangent.xyz);
  out.worldTangent = vec4<f32>(worldTangentXyz, in.tangent.w);
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  out.uv0And1 = vec4<f32>(in.uv, in.uv1);
  out.uv2And3 = vec4<f32>(in.uv2, in.uv3);
  out.uv4And5 = vec4<f32>(in.uv4, in.uv5);
  out.uv6And7 = vec4<f32>(in.uv6, in.uv7);
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  // Skin palette already contains the world-space transform. Forward its
  // affine basis so transmission does not reread Mesh/Instance storage in
  // the fragment stage.
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  out.objectBasis0 = vec4<f32>(skinMatrix[0].xyz, skinMatrix[1].x);
  out.objectBasis1 = vec4<f32>(skinMatrix[1].y, skinMatrix[1].z, skinMatrix[2].x, skinMatrix[2].y);
  out.objectBasis2 = skinMatrix[2].z;
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#ifdef PROBE_BLEND_AVAILABLE
  out.materialAddress = materialAddress;
#else
  out.materialAddress = materialAddress.x;
#endif
#endif
  return out;
}

// Signed view Z for cluster slices and CSM cascades, from the fragment's
// own depth (UE Common.ush:1530-1542 takes SceneDepth from SvPosition.w).
fn standardViewZ(in : VsOut) -> f32 {
  return sceneFragmentViewZ(in.clip, view.temporalProjection);
}

// Screen-linear NDC of the fragment (UE Common.ush:1536-1539). The View UBO
// carries the colour target extent of this View's viewport.
fn standardFragmentNdc(in : VsOut) -> vec3<f32> {
  return vec3<f32>(
    in.clip.xy / vec2<f32>(view.viewportWidth, view.viewportHeight) * vec2<f32>(2.0, -2.0)
      + vec2<f32>(-1.0, 1.0),
    in.clip.z,
  );
}

// World position rebuilt from the fragment's own SV_Position instead of an
// interpolant, as UE BasePassPixelShader.usf:955 feeds
// SvPositionToResolvedTranslatedWorld (Common.ush:1515-1520) into
// CalcMaterialParameters (MaterialTemplate.ush:4754-4757). UE folds the
// viewport scale into SVPositionToTranslatedWorld (SceneView.cpp:2638-2665);
// here standardFragmentNdc applies it and inverseViewProj is the inverse of
// the same jittered worldViewProj the vertex stage writes. Each fragment
// entry sets it once; a clipping cap moves it onto the cut plane.
var<private> standardPositionWS : vec3<f32>;

fn standardFragmentPosition(in : VsOut) -> vec3<f32> {
  let world = view.inverseViewProj * vec4<f32>(standardFragmentNdc(in), 1.0);
  return world.xyz / world.w;
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn sceneIndexVertex(source : VsIn, idx : u32, vertex : u32) -> VsOut {
  // visible = (scene instance row, material row, candidate row, LOD fade).
  // The palette already carries world space; the scene rows only name the
  // probe identity and keep the shared scene bindings referenced.
  let visible = visibleItems[idx];
  let draw = sceneIndexDraw(visible.x);
  // Morph precedes skinning, as in the per-entity morphed stream.
  var in = source;
  in.pos = sceneIndexMorphPosition(visible.x, vertex, in.pos);
  in.normal = sceneIndexMorphNormal(visible.x, vertex, in.normal);
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  in.tangent = sceneIndexMorphTangent(visible.x, vertex, in.tangent);
#endif
  _ = draw.world;
  // Scene material rows never reach bit 31; it carries the receive opt-out.
  var out = vs_main_impl(
    in,
    visible.z,
    vec3<u32>(visible.y | (draw.gbufferObjectFlags << 29u) | select(STANDARD_NO_RECEIVE_BIT, 0u, draw.receivesShadows), draw.probe),
    draw.temporal,
    draw.world[3].xyz,
    draw.previousWorld[3].xyz,
  );
  out.surfaceData.y = draw.lightingChannels;
  return out;
}
#endif

#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
fn standardMaterialRow(in : VsOut) -> u32 {
#ifdef PROBE_BLEND_AVAILABLE
  return in.materialAddress.x;
#else
  return in.materialAddress;
#endif
}
#endif

// ShadowParticipation.receive: GPU-driven rows ride the flat material lane;
// per-entity draws read the dynamic-offset Mesh slot directly.
fn standardGBufferObjectFlags(in : VsOut) -> u32 {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  return (standardMaterialRow(in) >> 29u) & 3u;
#else
#if STORAGE_BUFFER_AVAILABLE == true
  return meshGBufferObjectFlags(u32(meshes[0].temporal.y));
#else
  return meshGBufferObjectFlags(meshes[0].surface.w);
#endif
#endif
}

fn standardReceivesShadows(in : VsOut) -> bool {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  return (standardMaterialRow(in) & STANDARD_NO_RECEIVE_BIT) == 0u;
#else
#if STORAGE_BUFFER_AVAILABLE == true
  return meshReceivesShadows(meshes[0].temporal.y);
#else
  return meshReceivesShadows(f32(meshes[0].surface.w));
#endif
#endif
}

fn vs_main_impl_entry(in : VsIn, idx : u32, vertex : u32) -> VsOut {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  // This variant binds only the GPU Scene tables; every entry reads the
  // visible stream.
  return sceneIndexVertex(in, idx, vertex);
#else
  // Keep meshes[0] and instances bindings referenced so naga_oil does not
  // dead-code-eliminate the @group(2)@binding(0) and @group(3)@binding(0)
  // globals. The host-side BGL shape must remain compatible with non-skin
  // PBR pipeline layout (buildPbrSkinLayouts declares 2-entry mesh-array
  // slot + separate instances slot). Without these keep-alive references,
  // createRenderPipeline would fail at binding-count validation.
  _ = meshes[0u].worldFromLocal;
  _ = instances[idx].localFromInstance;
#if STORAGE_BUFFER_AVAILABLE == true
  let temporal = vec2<f32>(meshes[0].temporal.x, select(0.0, 1.0, meshMotionValid(meshes[0].temporal.y)));
#else
  let temporal = vec2<f32>(1.0, 1.0);
#endif
  var out = vs_main_impl(in, skinTaskDirectCandidate(), vec3<u32>(0xffffffffu, 0u, 0u), temporal,
    meshes[0u].worldFromLocal[3].xyz, skinTaskPreviousTranslation(meshes[0u]));
  out.surfaceData.y = meshes[0u].surface.z;
  return out;
#endif
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_main_impl_entry(in, idx, vertex);
}

@vertex
fn vs_main_packed(input : Frame32Input, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_main_impl_entry(frame32Input(input), idx, vertex);
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn vs_scene_index_impl_entry(in : VsIn, idx : u32, vertex : u32) -> VsOut {
  return sceneIndexVertex(in, idx, vertex);
}

@vertex
fn vs_scene_index(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_scene_index_impl_entry(in, idx, vertex);
}

@vertex
fn vs_scene_index_packed(input : Frame32Input, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return vs_scene_index_impl_entry(frame32Input(input), idx, vertex);
}
#endif

const STANDARD_NO_RECEIVE_BIT : u32 = 0x80000000u;
const STANDARD_MATERIAL_ROW_MASK : u32 = 0x1fffffffu;

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn selectedMaterial(index : u32) -> MaterialParameters {
  return sceneMaterials[index & STANDARD_MATERIAL_ROW_MASK];
}


#endif

fn physicalMaterialUvs(in : VsOut) -> PhysicalMaterialUvs {
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
#ifdef STANDARD_SINGLE_UV_SET
  return in.uv0And1.xy;
#else
  return PhysicalMaterialUvs(in.uv0And1, in.uv2And3, in.uv4And5, in.uv6And7);
#endif
#else
  return PhysicalMaterialUvs();
#endif
}

fn materialVertexColor(in : VsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
#endif
}

// Keep the cooked skinned artifact content-addressable per declared
// capability set, including axes whose imported helper/resource surface is
// otherwise identical after lowering.
fn standardSkinVariantIdentity() -> f32 {
  var identity = 0.0;
#ifdef STORAGE_BUFFER_AVAILABLE
  identity = identity + 1.0;
#endif
#ifdef CLUSTER_FORWARD_AVAILABLE
  identity = identity + 2.0;
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  identity = identity + 4.0;
#endif
#ifdef PROBE_BLEND_AVAILABLE
  identity = identity + 8.0;
#endif
#ifdef EXTENDED_LIGHTING_AVAILABLE
  identity = identity + 16.0;
#endif
#ifdef TRANSMISSION_AVAILABLE
  identity = identity + 32.0;
#endif
#ifdef DIRECTIONAL_PCSS_AVAILABLE
  identity = identity + 64.0;
#endif
  return identity;
}

// Linear object-to-world basis forwarded flat by the vertex stage.
fn standardObjectToWorld(in : VsOut) -> mat3x3<f32> {
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  return mat3x3<f32>(
    in.objectBasis0.xyz,
    vec3<f32>(in.objectBasis0.w, in.objectBasis1.xy),
    vec3<f32>(in.objectBasis1.zw, in.objectBasis2),
  );
#else
  return mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0));
#endif
}


// Parallax displacement shifts the height slot's source UV set before every
// Surface and layer sample. Derivatives precede discard and row selection.
// The march reads the derived fragment height binding, which the compiler
// projects onto its hosted pair; shared transmission withdraws it.
fn standardParallaxInput(in : VsOut) -> VsOut {
  var shifted = in;
#ifdef PARALLAX_HEIGHT_FRAGMENT_AVAILABLE
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let positionDx = dpdx(standardPositionWS);
  let positionDy = dpdy(standardPositionWS);
  let uvDx = array<vec4<f32>, 4>(dpdx(in.uv0And1), dpdx(in.uv2And3), dpdx(in.uv4And5), dpdx(in.uv6And7));
  let uvDy = array<vec4<f32>, 4>(dpdy(in.uv0And1), dpdy(in.uv2And3), dpdy(in.uv4And5), dpdy(in.uv6And7));
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  material = selectedMaterial(standardMaterialRow(in));
#endif
  let pairs = evaluateStandardParallax(array<vec4<f32>, 4>(in.uv0And1, in.uv2And3, in.uv4And5, in.uv6And7),
    uvDx, uvDy, positionDx, positionDy, in.worldNormal.xyz, in.worldTangent,
    viewDirectionToCamera(standardPositionWS), standardObjectToWorld(in));
  shifted.uv0And1 = pairs[0];
  shifted.uv2And3 = pairs[1];
  shifted.uv4And5 = pairs[2];
  shifted.uv6And7 = pairs[3];
#endif
#endif
#endif
  return shifted;
}

fn evaluateStandardSurface(in : VsOut, frontFacing : bool, geometricNormal : vec3<f32>) -> SurfaceData {
  let triangleNormal = standardDisplacementTriangleNormal(standardPositionWS, in.worldNormal.xyz);
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index Surface helpers may close over the imported `material` symbol.
  // The compiler's scene variant maps that symbol to a private provider so
  // the whole helper call graph observes the selected row, not the direct
  // material uniform.
  material = selectedMaterial(standardMaterialRow(in));
#endif

#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(standardPositionWS, false, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  let viewDirectionWS = vec3<f32>(0.0);
#else
  let viewDirectionWS = viewDirectionToCamera(standardPositionWS);
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let surfaceTangent = in.worldTangent;
#else
  let surfaceTangent = vec4<f32>(0.0);
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  let surfaceUvs = array<vec2<f32>, 8>(in.uv0And1.xy, in.uv0And1.zw, in.uv2And3.xy, in.uv2And3.zw, in.uv4And5.xy, in.uv4And5.zw,
    in.uv6And7.xy, in.uv6And7.zw);
#else
  let surfaceUvs = array<vec2<f32>, 8>();
#endif
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  let positionOS = vec3<f32>(0.0);
#else
  let positionOS = in.positionOS;
#endif
  let vertexNormal = standardDisplacementSurfaceNormal(in.worldNormal.xyz, triangleNormal);
  let input = SurfaceInput(
    positionOS, standardPositionWS, geometricNormal, vertexNormal, surfaceTangent, viewDirectionWS,
    surfaceUvs[0], surfaceUvs[1], surfaceUvs[2], surfaceUvs[3], surfaceUvs[4], surfaceUvs[5], surfaceUvs[6], surfaceUvs[7], materialVertexColor(in), frontFacing, vec4<f32>(0.0), vec4<f32>(0.0),
    standardObjectToWorld(in), view.fogHeightOpacity.w,
  );
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if TRANSMISSION_AVAILABLE == false
  return evaluate_standard_surface(input, material);
#else
  return evaluate_surface(input);
#endif
#else
  return evaluate_surface(input);
#endif
}


// ALPHA_MASK is a compile-time variant: opaque pipelines contain no reachable
// discard, so Apple TBDR keeps hidden-surface removal for the whole pass. A
// runtime branch or override does not count; the compiler still sees the
// discard and the GPU still disables early HSR for the pipeline.
fn standardSurfaceRejected(surface : SurfaceData) -> bool {
#if CLIPPING_PLANES == true
  if (viewClippingRejected(standardPositionWS, false)) { return true; }
#endif
#if ALPHA_MASK == true
  // The stock Surface raises the clip threshold only when the material declares
  // alphaCutoff; without it (hash-only or coverage-only) the cutoff test is
  // absent from the source. A custom Surface keeps the generic gate.
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#ifdef ALPHA_CLIPPING_AVAILABLE
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    return true;
  }
#endif
#else
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    return true;
  }
#endif
#endif
  return false;
}

fn alphaTestSurface(surface : SurfaceData) {
#if CLIPPING_PLANES == true
  if (standardSurfaceRejected(surface)) { discard; }
#else
#if ALPHA_MASK == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#ifdef ALPHA_CLIPPING_AVAILABLE
  if (standardSurfaceRejected(surface)) { discard; }
#endif
#else
  if (standardSurfaceRejected(surface)) { discard; }
#endif
#endif
#endif
}

struct StandardPbrOutput {
  @location(0) color : vec4<f32>,
#ifdef REFLECTION_FALLBACK_AVAILABLE
  // Linear HDR environment contribution from this same Standard BRDF callsite.
  // The detached producer names this second target S_fallback.
  @location(1) reflectionFallback : vec4<f32>,
  @location(2) reflectionResponse : vec4<f32>,
#endif
};

// Lit Standard surface before its camera-to-surface medium. The admitted
// Forward route applies interpolated height fog to opaque and blended color;
// other routes retain the existing per-fragment translucent/capture behavior.
struct StandardForwardLit {
  color : vec3<f32>,
  alpha : f32,
#ifdef TRANSMISSION_AVAILABLE
  transmittedContribution : vec3<f32>,
  transmittedCoefficient : vec3<f32>,
#endif
#ifdef REFLECTION_FALLBACK_AVAILABLE
  reflectionFallback : vec4<f32>,
  reflectionResponse : vec4<f32>,
#endif
};

fn standardForwardOutput(lit : StandardForwardLit, color : vec3<f32>) -> StandardPbrOutput {
  var output : StandardPbrOutput;
  output.color = vec4<f32>(color, lit.alpha);
#ifdef REFLECTION_FALLBACK_AVAILABLE
  output.reflectionFallback = lit.reflectionFallback;
  output.reflectionResponse = lit.reflectionResponse;
#endif
  return output;
}

fn standardForwardFogged(in : VsOut, lit : StandardForwardLit) -> StandardPbrOutput {
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardOutput(lit, forward_fog_transmission(view, standardPositionWS, in.worldNormal.w, lit.color, lit.alpha, lit.transmittedContribution, lit.transmittedCoefficient));
#else
  return standardForwardOutput(lit, forward_fog(view, standardPositionWS, in.worldNormal.w, lit.color, lit.alpha));
#endif
}

// The lighting-owned fallback alpha carries this same material admission to
// the trace. Unsupported lobes neither receive nor contribute screen radiance.
fn standardSsrCoverage() -> f32 {
  var coverage = 1.0;
#ifdef CLEARCOAT_AVAILABLE
  coverage = 0.0;
#endif
#ifdef ANISOTROPY_AVAILABLE
  coverage = 0.0;
#endif
#ifdef IRIDESCENCE_AVAILABLE
  coverage = 0.0;
#endif
  return coverage;
}

// Sampling and derivatives precede entry-owned coverage and shared lighting.
struct StandardForwardSurface {
  surface : SurfaceData,
  receiverNormal : vec3<f32>,
  geometricNormal : vec3<f32>,
  normalSpread : f32,
  useDirectDfgLut : bool,
};

fn prepareStandardForwardSurface(in : VsOut, frontFacing : bool, screenReceiver : bool) -> StandardForwardSurface {
  let _variantIdentity = standardSkinVariantIdentity();
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  let receiverNormal = surfaceGeometryNormal(dpdx(standardPositionWS), dpdy(standardPositionWS),
    in.worldNormal.xyz * select(-1.0, 1.0, frontFacing));
  let geometricNormal = receiverNormal * select(-1.0, 1.0, frontFacing);
  var normalSpread = geometricNormalSpread(in.worldNormal.xyz);
  var surface = evaluateStandardSurface(in, frontFacing, geometricNormal);
#ifdef CLUSTER_FORWARD_AVAILABLE
  if (screenReceiver) {
    let decalColor = sampleStandardScreenData(standardPositionWS, view.worldViewProj, 1u, forwardScreenSurface);
    let decalNormal = sampleStandardScreenData(standardPositionWS, view.worldViewProj, 2u, forwardScreenSurface);
    let decalRoughness = sampleStandardScreenData(standardPositionWS, view.worldViewProj, 3u, forwardScreenSurface);
    let painted = applyStandardScreenDecals(surface.baseColor, surface.normalWS, surface.roughness, decalColor, decalNormal, decalRoughness);
    surface.baseColor = painted.baseColor;
    surface.normalWS = painted.normalWS;
    surface.roughness = painted.roughness;
  }
#endif
  normalSpread = max(normalSpread, shadingNormalSpread(surface.normalWS));
#ifdef FLAT_SHADING_AVAILABLE
  // Derivatives above precede discard; Surface has now selected the GPU Scene material row.
  normalSpread = select(normalSpread, 0.0, material.flatShading != 0u);
#endif
  // Surface evaluation installs the selected scene-material row before reading its mode.
  var useDirectDfgLut = false;
#ifdef DIRECT_DFG_LUT_AVAILABLE
  useDirectDfgLut = material.directMultiscatteringLut != 0u;
#endif
  return StandardForwardSurface(surface, receiverNormal, geometricNormal, normalSpread, useDirectDfgLut);
}

fn standardSkinForwardLit(in : VsOut, frontFacing : bool, screenReceiver : bool, prepared : StandardForwardSurface) -> StandardForwardLit {
  let surface = prepared.surface;
  let receiverNormal = prepared.receiverNormal;
  let geometricNormal = prepared.geometricNormal;
  let normalSpread = prepared.normalSpread;
  let useDirectDfgLut = prepared.useDirectDfgLut;
  let alpha = materialOutputAlpha(surface.opacity, standardAlphaMode());
  let albedo = surface.baseColor;
  let metallic = clamp(finiteScalar(surface.metallic, 0.0), 0.0, 1.0);
  let iblRoughness = specularAntiAliasedRoughness(
    clamp(finiteScalar(surface.roughness, 0.5), 0.04, 1.0), normalSpread);
  let a = iblRoughness * iblRoughness;
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  let n = surface.normalWS;
#else
  let n = normalize(surface.normalWS);
#endif

  let v = viewDirectionToCamera(standardPositionWS);
  let safeIor = max(finiteScalar(material.ior, 1.5), 1.0);
  let dielectricF0 = standardDielectricF0(safeIor);
  let physicalUvs = physicalMaterialUvs(in);
  let surfaceSpecular = evaluateStandardSpecular(physicalUvs, metallic, dielectricF0);
  var dielectricSpecular = surfaceSpecular;
  var metallicF0 = albedo;
  var f0 = mix(surfaceSpecular.rgb, albedo, metallic);
  var physicalNormal = n;
#ifdef ANISOTROPY_AVAILABLE
  let anisotropy = evaluateStandardAnisotropy(physicalUvs);
  physicalNormal = evaluateAnisotropicNormal(
    n,
    in.worldTangent,
    anisotropy.z,
    anisotropy.w,
    anisotropy.xy,
  );
#endif
#ifdef IRIDESCENCE_AVAILABLE
  let iridescence = evaluateStandardIridescence(physicalUvs);
  f0 = evaluateIridescenceFresnel(
    f0,
    iridescence.x,
    iridescence.y,
    iridescence.z,
  );
  dielectricSpecular = vec4<f32>(evaluateIridescenceFresnel(dielectricSpecular.rgb,
    iridescence.x, iridescence.y, iridescence.z), dielectricSpecular.a);
  metallicF0 = evaluateIridescenceFresnel(metallicF0,
    iridescence.x, iridescence.y, iridescence.z);
#endif
  var diffuseAlbedo = albedo;
#ifdef TRANSMISSION_AVAILABLE
  let transmission = evaluateStandardTransmission(physicalUvs);
  let viewDot = finiteScalar(dot(n, v), 0.0);
  let refractionFromInside = viewDot < 0.0;
  let refractionNormal = select(n, -n, refractionFromInside);
  let refractionEta = select(1.0 / safeIor, safeIor, refractionFromInside);
  let incident = -v;
  let refracted = refract(incident, refractionNormal, refractionEta);
  let refractedLengthSquared = dot(refracted, refracted);
  let viewCos = clamp(abs(viewDot), 0.0, 1.0);
  let fresnel = clamp(f_schlick(viewCos, vec3<f32>(dielectricF0)).x, 0.0, 1.0);
  let transmittedEnergy = select(
    0.0,
    transmission.factor * (1.0 - metallic) * (1.0 - fresnel),
    refractedLengthSquared > 1e-6,
  );
  diffuseAlbedo = albedo * (1.0 - transmittedEnergy);
#endif
  // KHR_materials_diffuse_transmission: the dt fraction of the diffuse lobe
  // leaves through the opposite hemisphere. Specular transmission above
  // takes precedence, so only its remaining diffuse energy is split.
  var transmissionAlbedo = vec3<f32>(0.0);
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  let diffuseTransmission = evaluateStandardDiffuseTransmission(physicalUvs);
  // The lobe evaluators do not apply (1 - metallic) to this albedo.
  transmissionAlbedo = diffuseTransmission.w * (1.0 - metallic) * diffuseTransmission.rgb;
#ifdef TRANSMISSION_AVAILABLE
  transmissionAlbedo = transmissionAlbedo * (1.0 - transmittedEnergy);
#endif
  diffuseAlbedo = diffuseAlbedo * (1.0 - diffuseTransmission.w);
#endif
  // Shared base lighting is also consumed by the deferred resolve.
  var coatF = vec3<f32>(0.0);
#ifdef CLEARCOAT_AVAILABLE
  coatF = f_schlick(max(dot(physicalNormal, v), 0.0), vec3<f32>(0.04)) *
    clamp(finiteScalar(material.clearcoat, 0.0), 0.0, 1.0);
#endif
  let skyIrradiance = sampleStandardDiffuseIrradiance(viewSkylight, physicalNormal, transmissionAlbedo, skySh);
#ifdef PROBE_BLEND_AVAILABLE
  var probeShPreblend : array<vec4<f32>, 9>;
  var probeLocalBlendFraction = 0.0;
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  let probeBase = in.materialAddress.y * 16u;
  let probeHeader = probeBlendRecords[probeBase];
  let probeIdentityValid =
    u32(probeHeader.x) + 1u == in.materialAddress.y &&
    u32(probeHeader.y) == in.materialAddress.z;
#else
  let probeBase = 0u;
  let probeIdentityValid = true;
#endif
  probeLocalBlendFraction = select(0.0, probeBlendRecords[probeBase].z, probeIdentityValid);
  if (probeLocalBlendFraction > 0.0) {
    probeShPreblend = array<vec4<f32>, 9>(
      probeBlendRecords[probeBase + 1u], probeBlendRecords[probeBase + 2u], probeBlendRecords[probeBase + 3u],
      probeBlendRecords[probeBase + 4u], probeBlendRecords[probeBase + 5u], probeBlendRecords[probeBase + 6u],
      probeBlendRecords[probeBase + 7u], probeBlendRecords[probeBase + 8u], probeBlendRecords[probeBase + 9u],
    );
  }
  let irradiance = applyStandardProbeIrradiance(skyIrradiance, physicalNormal, transmissionAlbedo, probeShPreblend, probeLocalBlendFraction);
#else
  let irradiance = skyIrradiance;
#endif
  let environment = evaluateStandardEnvironment(standardPositionWS, physicalNormal, v,
    diffuseAlbedo, transmissionAlbedo, metallic, iblRoughness, f0, dielectricSpecular, metallicF0, skylight, viewSkylight.ambientIrradiance.xyz, irradiance,
    prefilterMap, prefilterSampler,
#ifdef ENV_BRDF_LUT
    brdfLut, viewLinearSampler,
#endif
  );
  let ao = surface.occlusion;
#ifdef CLUSTER_FORWARD_AVAILABLE
  var screenAo = 1.0;
  screenAo = sampleStandardAmbientOcclusion(standardPositionWS, view.worldViewProj,
    forwardScreenSurface, viewLinearSampler);
#else
  let screenAo = 1.0;
#endif
  let specularAo = standardSpecularOcclusion(max(dot(physicalNormal, v), 0.0), ao * screenAo, iblRoughness);
  let materialSpecularAo = standardSpecularOcclusion(max(dot(physicalNormal, v), 0.0), ao, iblRoughness);
  var ambient = (environment.diffuse * ao * screenAo + environment.specular * specularAo) * (vec3<f32>(1.0) - coatF);
  var reflectionFallback = environment.specular * (vec3<f32>(1.0) - coatF) * specularAo;
#ifdef REFLECTION_FALLBACK_AVAILABLE
  var reflectionResponse = environment.response.rgb * (vec3<f32>(1.0) - coatF) * materialSpecularAo;
#endif
#ifdef EXTENDED_LIGHTING_AVAILABLE
  if (standardSsrCoverage() > 0.0 && standardAlphaMode() < 2.0) {
    let reflection = forwardSsrOpaque(forwardHiZ, forwardSsrColor, view, standardPositionWS,
      physicalNormal, v, iblRoughness);
    let response = environment.response.rgb * (1.0 - coatF) * materialSpecularAo;
    ambient += reflection.rgb * response - reflection.a * reflectionFallback;
  }
#endif
  var color = ambient;
#ifdef TRANSMISSION_AVAILABLE
  var transmittedContribution=vec3<f32>(0.0);
  var transmittedCoefficient=vec3<f32>(0.0);
  let screenUv = standardFragmentNdc(in).xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  let objectToWorld = standardObjectToWorld(in);
  let localToWorld0 = objectToWorld[0];
  let localToWorld1 = objectToWorld[1];
  let localToWorld2 = objectToWorld[2];
  let inverseCofactor0 = cross(localToWorld1, localToWorld2);
  let inverseCofactor1 = cross(localToWorld2, localToWorld0);
  let inverseCofactor2 = cross(localToWorld0, localToWorld1);
  let localToWorldDet = dot(localToWorld0, inverseCofactor0);
  let safeLocalToWorldDet = select(1.0, localToWorldDet, abs(localToWorldDet) >= 1e-6);
  let worldToLocal0 = vec3<f32>(
    inverseCofactor0.x,
    inverseCofactor1.x,
    inverseCofactor2.x,
  ) / safeLocalToWorldDet;
  let worldToLocal1 = vec3<f32>(
    inverseCofactor0.y,
    inverseCofactor1.y,
    inverseCofactor2.y,
  ) / safeLocalToWorldDet;
  let worldToLocal2 = vec3<f32>(
    inverseCofactor0.z,
    inverseCofactor1.z,
    inverseCofactor2.z,
  ) / safeLocalToWorldDet;
  let refractedLocal = normalize(
    worldToLocal0 * refracted.x +
      worldToLocal1 * refracted.y +
      worldToLocal2 * refracted.z,
  );
  let worldRefractedDirection =
    localToWorld0 * refractedLocal.x +
    localToWorld1 * refractedLocal.y +
    localToWorld2 * refractedLocal.z;
  let worldThickness = max(
    transmission.thickness * length(worldRefractedDirection) * transmission.thicknessSample,
    0.0,
  );
  // Project the refracted ray's exit point instead of offsetting screen UVs by
  // world-space direction deltas: world +Y is screen -V, and only a projection
  // follows the camera orientation.
  let refractedExitClip = view.worldViewProj * vec4<f32>(
    standardPositionWS + refracted * inverseSqrt(max(refractedLengthSquared, 1e-12)) * worldThickness,
    1.0,
  );
  let refractedUv = refractedExitClip.xy / max(refractedExitClip.w, 1e-6) *
    vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  let guardBand = 0.02;
  let insideGuardBand = refractedExitClip.w > 1e-6 &&
    all(refractedUv >= vec2<f32>(guardBand)) &&
    all(refractedUv <= vec2<f32>(1.0 - guardBand));
  let backdropMipCount = textureNumLevels(transmissionBackdropTexture);
  let backdropMaxLod = max(f32(backdropMipCount) - 1.0, 0.0);
  let backdropLod = clamp(iblRoughness * iblRoughness * backdropMaxLod, 0.0, backdropMaxLod);
  let unrefractedBackdrop = textureSampleLevel(
    transmissionBackdropTexture,
    viewLinearSampler,
    clamp(screenUv, vec2<f32>(0.0), vec2<f32>(1.0)),
    backdropLod,
  ).rgb;
  var transmittedBackdrop = unrefractedBackdrop;
  if (refractedLengthSquared > 1e-6 && insideGuardBand) {
    transmittedBackdrop = textureSampleLevel(
      transmissionBackdropTexture,
      viewLinearSampler,
      clamp(refractedUv, vec2<f32>(0.0), vec2<f32>(1.0)),
      backdropLod,
    ).rgb;
  }
  let attenuationExponent = worldThickness / max(transmission.attenuationDistance, 1e-6);
  let beerAttenuation = select(
    vec3<f32>(1.0),
    pow(transmission.attenuationColor, vec3<f32>(attenuationExponent)),
    transmission.attenuationDistance > 1e-6 && worldThickness > 0.0,
  );
  transmittedCoefficient=transmittedEnergy*albedo*beerAttenuation;
  transmittedContribution=finiteColor(transmittedBackdrop,vec3<f32>(0.0))*transmittedCoefficient;
  color+=transmittedContribution;
#endif
  color = color + surface.emissive;
  var directionalShadowNormal = receiverNormal;
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  // A back-lit thin surface receives through its opposite face; offset the
  // shadow receiver toward the light so the leaf does not shadow itself
  // (Unreal TwoSidedBxDF uses the same flipped-normal shadow bias).
  directionalShadowNormal = select(receiverNormal, -receiverNormal,
    dot(receiverNormal, -view.lightDir) < 0.0);
#endif
  let receiveShadows = standardReceivesShadows(in);
  var directionalShadow = 1.0;
  // Keep the receiver path unless the final shading normal proves zero direct response.
  var needsDirectionalShadow = !(dot(physicalNormal, normalize(-view.lightDir)) <= 0.0);
#ifdef CLEARCOAT_AVAILABLE
  needsDirectionalShadow = true;
#endif
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  needsDirectionalShadow = true;
#endif
#ifdef TRANSMISSION_AVAILABLE
  needsDirectionalShadow = true;
#endif
  if (receiveShadows && needsDirectionalShadow) {
    directionalShadow = evalDirectionalShadowFactorAtPixel(
      select(directionalShadowNormal, physicalNormal, view.splitPlanes[0].w > 0.5),
      standardPositionWS,
      standardViewZ(in),
      0u,
      in.clip.xy,
    );
  }
#ifdef CLUSTER_FORWARD_AVAILABLE
  if (screenReceiver && receiveShadows && needsDirectionalShadow) {
    directionalShadow *= sampleStandardContactShadow(standardPositionWS, view.worldViewProj, forwardScreenSurface);
  }
#endif
  var directRadiance = evaluateStandardDirect(standardPositionWS, standardFragmentNdc(in), standardViewZ(in), in.clip.xy,
    physicalNormal, v, diffuseAlbedo, transmissionAlbedo, metallic, a, f0, directionalShadow,
    receiveShadows, in.surfaceData.y,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, viewLinearSampler,
#endif
  ).radiance;
  color += directRadiance;
// CLUSTER_FORWARD_AVAILABLE
#ifdef SHEEN_AVAILABLE
  let sheen = evaluateStandardSheen(physicalUvs, material.sheenRoughness);
  color = evaluateSheenLayer(color, sheen.rgb, sheen.a, dot(n, v));
#endif
#ifdef CLEARCOAT_AVAILABLE
  let clearcoat = evaluateStandardClearcoat(physicalUvs);
  let clearcoatFactor = clearcoat.x;
  let clearcoatRoughnessValue = specularAntiAliasedRoughness(clearcoat.y, normalSpread);
  var clearcoatBaseNormal = in.worldNormal.xyz;
#ifdef FLAT_SHADING_AVAILABLE
  clearcoatBaseNormal = select(clearcoatBaseNormal, geometricNormal, material.flatShading != 0u);
#endif
  let clearcoatNormalValue = evaluateStandardClearcoatNormal(
    physicalUvs,
    clearcoatBaseNormal,
#ifndef STANDARD_TANGENT_INPUT_UNUSED
    in.worldTangent,
#else
    vec4<f32>(0.0),
#endif
  ) * select(-1.0, 1.0, frontFacing);
  let clearcoatIbl = evaluateStandardClearcoatReflection(
    skylight, standardPositionWS, clearcoatNormalValue, v, clearcoatRoughnessValue,
    prefilterMap, prefilterSampler,
#ifdef ENV_BRDF_LUT
    brdfLut, viewLinearSampler,
#endif
  );
  let clearcoatAlpha = clearcoatRoughnessValue * clearcoatRoughnessValue;
  let clearcoatDirect = directionalShadow * evalDirectionalNoShadow(
    clearcoatNormalValue,
    v,
    vec3<f32>(0.0),
    1.0,
    clearcoatAlpha,
    vec3<f32>(0.04),
    vec3<f32>(0.0),
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, viewLinearSampler,
#endif
  );
  let directionalClearcoat = select(vec3<f32>(0.0), view_apply_direct_solar(view, clearcoatDirect, standardPositionWS),
    lightingChannelsMatch(view.lightingChannels, in.surfaceData.y));
  let clearcoatNoV = max(dot(clearcoatNormalValue, v), 0.0);
  let clearcoatEnvironment = clearcoatIbl *
    standardSpecularOcclusion(clearcoatNoV, ao * screenAo, clearcoatRoughnessValue);
  let baseAttenuation=1.0-evaluateClearcoatFresnel(dot(clearcoatNormalValue,v),clearcoatFactor);
#ifdef TRANSMISSION_AVAILABLE
  transmittedContribution*=baseAttenuation;
  transmittedCoefficient*=baseAttenuation;
#endif
  color = evaluateClearcoatLayer(
    color,
    clearcoatEnvironment + directionalClearcoat,
    dot(clearcoatNormalValue, v),
    clearcoatFactor,
  );
  reflectionFallback += clearcoatEnvironment * clearcoatFactor;
#ifdef REFLECTION_FALLBACK_AVAILABLE
  let coatResponse = projectSpecularRadiance(vec3<f32>(1.0), clearcoatNormalValue, v,
    clearcoatRoughnessValue, vec3<f32>(0.04),
#ifdef ENV_BRDF_LUT
    brdfLut, viewLinearSampler,
#endif
  ) * standardSpecularOcclusion(clearcoatNoV, ao, clearcoatRoughnessValue);
  reflectionResponse += coatResponse * clearcoatFactor;
#endif
#endif
  var lit : StandardForwardLit;
  lit.color = materialOutputColor(color, alpha, standardAlphaMode());
  lit.alpha = alpha;
#ifdef TRANSMISSION_AVAILABLE
  lit.transmittedContribution = transmittedContribution;
  lit.transmittedCoefficient = transmittedCoefficient;
#endif
#ifdef REFLECTION_FALLBACK_AVAILABLE
  lit.reflectionFallback = vec4<f32>(reflectionFallback, standardSsrCoverage());
  lit.reflectionResponse = vec4<f32>(reflectionResponse, environment.response.a);
#endif
  return lit;
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let displaced = standardParallaxInput(in);
  let prepared = prepareStandardForwardSurface(displaced, frontFacing, false);
#if CLIPPING_PLANES == true
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#else
#if ALPHA_MASK == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#ifdef ALPHA_CLIPPING_AVAILABLE
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#endif
#else
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#endif
#endif
#endif
  let lit = standardSkinForwardLit(displaced, frontFacing, false, prepared);
  return standardForwardFogged(in, lit);
}

// The base View applies height fog only on the admitted vertex-height route.
@fragment
fn fs_opaque(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let displaced = standardParallaxInput(in);
  let prepared = prepareStandardForwardSurface(displaced, frontFacing, false);
#if CLIPPING_PLANES == true
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#else
#if ALPHA_MASK == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#ifdef ALPHA_CLIPPING_AVAILABLE
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#endif
#else
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#endif
#endif
#endif
  let lit = standardSkinForwardLit(displaced, frontFacing, false, prepared);
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardFogged(in, lit);
#else
  if view.fogSky.y > 0.5 {
    return standardForwardOutput(lit, forward_vertex_fog(view, in.worldNormal.w, lit.color, lit.alpha));
  }
  return standardForwardOutput(lit, lit.color);
#endif
}

// Only the opaque pass selects the screen-surface entry; transparency keeps its own inputs.
@fragment
fn fs_forward_screen(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let displaced = standardParallaxInput(in);
  let prepared = prepareStandardForwardSurface(displaced, frontFacing, true);
#if CLIPPING_PLANES == true
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#else
#if ALPHA_MASK == true
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
#ifdef ALPHA_CLIPPING_AVAILABLE
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#endif
#else
  if (standardSurfaceRejected(prepared.surface)) { discard; }
#endif
#endif
#endif
  let lit = standardSkinForwardLit(displaced, frontFacing, true, prepared);
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardFogged(in, lit);
#else
  if view.fogSky.y > 0.5 {
    return standardForwardOutput(lit, forward_vertex_fog(view, in.worldNormal.w, lit.color, lit.alpha));
  }
  return standardForwardOutput(lit, lit.color);
#endif
}

// Keep the skinned Standard shader on the same multi-entry pass contract as
// the rigid Standard shader. Deferred draws select this entry point from the
// existing `forgeax::pbr-skin` artifact; lighting is performed by the deferred
// pass after these base surface facts are written to the shared G-buffer.
@fragment
fn fs_gbuffer(in : VsOut, @builtin(front_facing) frontFacing : bool) -> GBufferOutput {
  standardPositionWS = standardFragmentPosition(in);
  return skinGBuffer(standardParallaxInput(in), frontFacing, false).full;
}

@fragment
fn fs_gbuffer_compact(in : VsOut, @builtin(front_facing) frontFacing : bool) -> CompactGBufferOutput {
  standardPositionWS = standardFragmentPosition(in);
  return skinGBuffer(standardParallaxInput(in), frontFacing, true).compact;
}

// Forward AO sees the deformed, skinned and material-normal-mapped Surface.
fn standardAoInput(in : VsOut, frontFacing : bool) -> u32 {
  standardPositionWS = standardFragmentPosition(in);
  let rawGeometry = surfaceGeometryNormal(dpdx(standardPositionWS), dpdy(standardPositionWS), vec3<f32>(0.0));
  let receiverNormal = select(in.worldNormal.xyz * select(-1.0, 1.0, frontFacing), rawGeometry,
    dot(rawGeometry, rawGeometry) > 0.0);
  let geometricNormal = receiverNormal * select(-1.0, 1.0, frontFacing);
  let surface = evaluateStandardSurface(in, frontFacing, geometricNormal);
  alphaTestSurface(surface);
  return encodeStandardNormalRoughness(surface.normalWS, 1.0);
}

@fragment
fn fs_ao_input(in : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) u32 {
  return standardAoInput(in, frontFacing);
}

@fragment
fn fs_ao_input_msaa(in : VsOut, @builtin(front_facing) frontFacing : bool) -> @location(0) vec4<u32> {
  return (vec4<u32>(standardAoInput(in, frontFacing)) >> vec4<u32>(0u, 8u, 16u, 24u)) & vec4<u32>(255u);
}

// Deformed draws publish no visible-surface rows (their posed triangles have no
// frame-stable raster address), so a visible-surface G-buffer pass writes row 0:
// skinned pixels read as uncovered instead of keeping an occluded surface's row.
struct SkinUncoveredGBufferOutput {
  @location(0) scene_color : vec4<f32>,
  @location(1) normal_roughness : vec2<u32>,
  @location(2) dielectric_specular : u32,
  @location(3) albedo_metallic : u32,
  @location(4) lighting_context : vec2<u32>,
  @location(5) receiver_geometry : vec2<u32>,
  @location(6) visible_surface : vec4<u32>,
  @location(7) scene_temporal : vec4<f32>,
};

@fragment
fn fs_gbuffer_uncovered(in : VsOut, @builtin(front_facing) frontFacing : bool) -> SkinUncoveredGBufferOutput {
  standardPositionWS = standardFragmentPosition(in);
  let g = skinGBuffer(standardParallaxInput(in), frontFacing, false).full;
  return SkinUncoveredGBufferOutput(g.scene_color, g.normal_roughness, g.dielectric_specular,
    g.albedo_metallic, g.lighting_context, g.receiver_geometry, vec4<u32>(0u), g.scene_temporal);
}

fn skinGBuffer(in : VsOut, frontFacing : bool, compact : bool) -> StandardGBufferPassOutput {
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  let rawGeometry = surfaceGeometryNormal(dpdx(standardPositionWS), dpdy(standardPositionWS), vec3<f32>(0.0));
  let receiverNormal = select(in.worldNormal.xyz * select(-1.0, 1.0, frontFacing), rawGeometry,
    dot(rawGeometry, rawGeometry) > 0.0);
  let geometricNormal = receiverNormal * select(-1.0, 1.0, frontFacing);
  var normalSpread = geometricNormalSpread(in.worldNormal.xyz);
  let surface = evaluateStandardSurface(in, frontFacing, geometricNormal);
  normalSpread = max(normalSpread, shadingNormalSpread(surface.normalWS));
#ifdef FLAT_SHADING_AVAILABLE
  // Derivatives above precede discard; Surface has now selected the GPU Scene material row.
  normalSpread = select(normalSpread, 0.0, material.flatShading != 0u);
#endif
  // Surface evaluation installs the selected scene-material row before reading its mode.
  var useDirectDfgLut = false;
#ifdef DIRECT_DFG_LUT_AVAILABLE
  useDirectDfgLut = material.directMultiscatteringLut != 0u;
#endif
  alphaTestSurface(surface);
  var probeRow = 0u;
#ifdef PROBE_BLEND_AVAILABLE
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  let base = in.materialAddress.y * 16u;
  let header = probeBlendRecords[base];
  if (u32(header.x) + 1u == in.materialAddress.y && u32(header.y) == in.materialAddress.z && header.z > 0.0) {
    probeRow = in.materialAddress.y;
  }
#else
  let header = probeBlendRecords[0];
  if (header.z > 0.0) { probeRow = u32(header.x) + 1u; }
#endif
#endif
  var subsurface = vec4<f32>(0.0);
#ifdef SUBSURFACE_DIFFUSION_AVAILABLE
  subsurface = vec4<f32>(material.subsurfaceRadius, material.subsurfaceWeight);
#endif
  let specular = evaluateStandardSpecular(physicalMaterialUvs(in), clamp(finiteScalar(surface.metallic, 0.0), 0.0, 1.0), standardDielectricF0(max(finiteScalar(material.ior, 1.5), 1.0)));
  var hasDiffuseTransmission = false;
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  hasDiffuseTransmission = finiteScalar(material.diffuseTransmission, 0.0) > 0.0;
#endif
  let roughness = specularAntiAliasedRoughness(clamp(surface.roughness, 0.04, 1.0), normalSpread);
  let metallic = clamp(surface.metallic, 0.0, 1.0);
  let opacity = materialOutputAlpha(surface.opacity, standardAlphaMode());
  var output : StandardGBufferPassOutput;
  if (compact) {
    var customData = 0u;
#ifdef SUBSURFACE_DIFFUSION_AVAILABLE
    customData = compactSubsurfaceCustomData(subsurface, view.subsurfaceProfiles);
#endif
    output.compact = encodeCompactStandardGBuffer(surface.normalWS, roughness, surface.baseColor,
      metallic, specular.x, surface.occlusion, surface.emissive, opacity,
      vec4<u32>(in.surfaceData.y, encodeStandardReceiverContext(
        u32(skylight.diffuseScale.w), probeRow, standardReceivesShadows(in)),
        encodeStandardReceiverNormal(receiverNormal) | 0x00800000u, 0u), customData, standardGBufferObjectFlags(in), hasDiffuseTransmission);
    return output;
  }
  output.full = encodeStandardGBuffer(surface.normalWS, receiverNormal, roughness,
      surface.baseColor, metallic, specular,
      surface.occlusion, surface.emissive, opacity, u32(skylight.diffuseScale.w), probeRow,
      standardReceivesShadows(in), in.surfaceData.y, subsurface,
      useDirectDfgLut, hasDiffuseTransmission);
  // The vertex lane retains the canonical validity/reactivity encoding;
  // coverage and opacity come from the same evaluated surface as GBuffer.
  let temporal = unpackSceneTemporalV1(vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(in.surfaceData.x)));
  // Alpha hashing already commits a binary Surface mask; its sampling alpha
  // must not become source reactivity. Share the standalone producer policy.
  var reactive = resolvePbrTemporalReactive(temporal.reactive, materialOutputAlpha(surface.opacity, standardAlphaMode()), 1.0);
#ifdef ALPHA_HASH_AVAILABLE
  if (material.alphaHash > 0.5) { reactive = temporal.reactive; }
#endif
  // Unreal Responsive AA, per pixel: an animated Surface without geometric
  // motion (rippling or scrolling normals) lowers its own color history.
  // Max-combined so instance, LOD and coverage reactivity are never reduced.
  reactive = max(reactive, surfaceTemporalReactive(surface.reactive));
  let currentClip = view.temporalCurrentViewProj * vec4<f32>(standardPositionWS, 1.0);
  output.full.scene_temporal = packSceneTemporalV1WithValidity(
    currentClip, currentClip - in.clipDelta,
    view.temporalProjection, reactive, temporal.motionValid);
  return output;
}

struct TemporalVsOut {
#ifndef ALPHA_HASH_DISABLED
  @location(10) positionOS : vec3<f32>,
#endif
  @location(11) clippingPositionWS : vec3<f32>,
#ifndef STANDARD_BINARY_COVERAGE
  @location(12) @interpolate(flat) temporal : vec2<f32>,
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  @location(13) @interpolate(flat) materialIndex : u32,
#endif
  @builtin(position) @invariant clip : vec4<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(0) uv : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(1) uv1 : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv2 : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(3) uv3 : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(4) uv4 : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(5) uv5 : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(6) uv6 : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(7) uv7 : vec2<f32>,
#endif
#ifndef STANDARD_BINARY_COVERAGE
  @location(8) @interpolate(perspective) currentClip : vec4<f32>,
  @location(9) @interpolate(perspective) previousClip : vec4<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
};

fn vs_temporal_impl_entry(source : VsIn, idx : u32, vertex : u32) -> TemporalVsOut {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  let visible = visibleItems[idx];
  material = selectedMaterial(visible.y);
  var in = source;
  in.pos = sceneIndexMorphPosition(visible.x, vertex, in.pos);
  in.normal = sceneIndexMorphNormal(visible.x, vertex, in.normal);
#else
  let in = source;
#endif
  let localPosition = standardVertexPosition(in);
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index draws address the view's transient Skin task by the actual
  // candidate in visible.z, exactly as vs_scene_index does.
  let paletteBase = visible.z;
  let materialIndex = visible.y;
  let draw = sceneIndexDraw(visible.x);
  let translation = draw.world[3].xyz;
#ifndef STANDARD_BINARY_COVERAGE
  let previousTranslation = draw.previousWorld[3].xyz;
  let temporalFlags = draw.temporal;
#endif
#else
  // Direct temporal draws select their task through per-draw dynamic offsets,
  // just like the direct forward entry point.
  let paletteBase = skinTaskDirectCandidate();
  let translation = meshes[0u].worldFromLocal[3].xyz;
#ifndef STANDARD_BINARY_COVERAGE
  let previousTranslation = skinTaskPreviousTranslation(meshes[0u]);
#endif
#endif
  let descriptor = skinTaskDescriptor(paletteBase);
  let currentSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
  let currentWorld = skinTaskPosition(descriptor, currentSkin, localPosition, translation);
  var out : TemporalVsOut;
#ifndef STANDARD_BINARY_COVERAGE
  let previousSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, true);
  let previousWorld = skinTaskPosition(descriptor, previousSkin, localPosition,
    select(translation, previousTranslation, skinTaskHistoryValid(descriptor)));
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.temporal = vec2<f32>(temporalFlags.x, select(0.0, temporalFlags.y, skinTaskHistoryValid(descriptor)));
#else
#if STORAGE_BUFFER_AVAILABLE == true
  out.temporal = vec2<f32>(meshes[0].temporal.x, select(0.0, 1.0, meshMotionValid(meshes[0].temporal.y) && skinTaskHistoryValid(descriptor)));
#else
  out.temporal = vec2<f32>(1.0, select(0.0, 1.0, skinTaskHistoryValid(descriptor)));
#endif
#endif
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialIndex = materialIndex;
#endif
#ifndef ALPHA_HASH_DISABLED
  out.positionOS = localPosition;
#endif
  out.clippingPositionWS = currentWorld.xyz;
  out.clip = view.worldViewProj * currentWorld;
#ifndef STANDARD_BINARY_COVERAGE
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  out.uv = in.uv;
  out.uv1 = in.uv1;
  out.uv2 = in.uv2;
  out.uv3 = in.uv3;
  out.uv4 = in.uv4;
  out.uv5 = in.uv5;
  out.uv6 = in.uv6;
  out.uv7 = in.uv7;
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
  _ = idx;
  return out;
}

#ifdef STANDARD_BINARY_COVERAGE
@vertex
fn vs_coverage(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> TemporalVsOut {
  return vs_temporal_impl_entry(in, idx, vertex);
}

@vertex
fn vs_coverage_packed(input : Frame32Input, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> TemporalVsOut {
  return vs_temporal_impl_entry(frame32Input(input), idx, vertex);
}
#else
@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> TemporalVsOut {
  return vs_temporal_impl_entry(in, idx, vertex);
}

@vertex
fn vs_temporal_packed(input : Frame32Input, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> TemporalVsOut {
  return vs_temporal_impl_entry(frame32Input(input), idx, vertex);
}
#endif

fn temporalVertexAlpha(in : TemporalVsOut) -> f32 {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color.a;
#else
  return 1.0;
#endif
}

fn standardAlphaMode() -> f32 {
#ifdef ALPHA_MODE_AVAILABLE
  return material.alphaMode;
#else
  return 0.0;
#endif
}

#ifdef STANDARD_BINARY_COVERAGE
fn materialCoverage(in : TemporalVsOut) {
#else
fn materialTemporal(in : TemporalVsOut) -> vec4<f32> {
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  material = selectedMaterial(in.materialIndex);
#endif
#if CLIPPING_PLANES == true
  applyViewClipping(in.clippingPositionWS, false);
#endif
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.clippingPositionWS, false, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif

#ifndef STANDARD_BINARY_COVERAGE
  let reactive = in.temporal.x;
  let motionValid = in.temporal.y >= 0.5;
#endif
  var coverageInput = SurfaceInput();
  coverageInput.vertexColor.a = temporalVertexAlpha(in);
#ifndef STANDARD_UV_INPUT_UNUSED
  coverageInput.uv0 = in.uv;
  coverageInput.uv1 = in.uv1;
  coverageInput.uv2 = in.uv2;
  coverageInput.uv3 = in.uv3;
  coverageInput.uv4 = in.uv4;
  coverageInput.uv5 = in.uv5;
  coverageInput.uv6 = in.uv6;
  coverageInput.uv7 = in.uv7;
#endif
  let coverage = applyPbrTemporalCoverage(
    evaluateStandardTemporalAlpha(coverageInput, material, material.baseColor.a),
#ifdef ALPHA_CLIPPING_AVAILABLE
    material.alphaCutoff,
#else
    0.0,
#endif
#ifdef ALPHA_TO_COVERAGE_AVAILABLE
    material.alphaToCoverage,
#else
    0.0,
#endif
#ifdef ALPHA_HASH_AVAILABLE
    material.alphaHash,
#else
    0.0,
#endif
#ifndef ALPHA_HASH_DISABLED
    in.positionOS,
#else
    vec3<f32>(0.0),
#endif
  );
#ifndef STANDARD_BINARY_COVERAGE
#ifdef COVERAGE_ONLY
  return vec4<f32>(1.0);
#else
  return packStandardTemporalCoverage(
    coverage,
#ifdef ALPHA_HASH_AVAILABLE
    material.alphaHash,
#else
    0.0,
#endif
    in.currentClip,
    in.previousClip,
    view.temporalProjection,
    reactive,
    motionValid,
  );
#endif
#endif
}


#ifdef STANDARD_BINARY_COVERAGE
@fragment
fn fs_coverage(in : TemporalVsOut) -> @location(0) vec4<f32> {
  materialCoverage(in);
  return vec4<f32>(1.0);
}
#else
@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
  return materialTemporal(in);
}

@fragment
fn fs_scene_velocity(in : TemporalVsOut) -> @location(0) vec2<u32> {
  return encodeSceneVelocityWithDepth(materialTemporal(in), in.previousClip);
}
#endif
