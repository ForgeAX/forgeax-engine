#import forgeax_geometry::tangent_frame32::{decodeTangentFrame32}
#import forgeax_view::common::{forwardScreenSurface}
#import forgeax_cloud::layer::{viewLinearSampler}

#ifdef FORWARD_SCREEN_SHADOW_RECEIVER
#import forgeax_standard::cluster::{forwardShadowVisibility, get_ssao_intensity}
#endif
#import forgeax_pbr::sky_sh_polynomial::{SkyShPolynomial}
#ifdef VISIBLE_SURFACE_AVAILABLE
enable primitive_index;
#endif
#define_import_path forgeax_material::standard
#import forgeax_material::alpha_hash::{materialOutputAlpha, materialOutputColor}
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
#import forgeax_material::fragment_output::{applyFragmentOutput}
#endif
#if TERRAIN_GEOMETRY_AVAILABLE == true
#import forgeax_material::terrain_vertex::{terrainVertex, terrainNormal, terrainGeometryNormal, terrainShadowLayerBase}
#endif
#pragma material_slot surface
#import forgeax_material::standard_physical_inputs::{PhysicalMaterialUvs, finiteScalar, finiteColor, evaluateStandardSpecular, evaluateStandardAnisotropy, evaluateStandardIridescence, evaluateStandardTransmission, evaluateStandardDiffuseTransmission, evaluateStandardSheen, evaluateStandardClearcoat, evaluateStandardClearcoatNormal}
#import forgeax_material::displacement::{evaluateStandardVertexPosition, standardDisplacementTriangleNormal, standardDisplacementSurfaceNormal, evaluateStandardParallax}
#import forgeax_material::standard_surface_maps::{evaluateStandardTemporalAlpha, evaluateStandardCoverageOnly}
#import forgeax_clipping::planes::{applyViewClipping, viewClippingRejected, applyLocalClipping, viewClippingCap}
#import forgeax_material::oit::{OitOutput, oitAccumulate}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardClearcoatReflection, sampleStandardDiffuseIrradiance, evaluateStandardEnvironment, evaluateStandardDirect}
#ifdef PROBE_BLEND_AVAILABLE
#import forgeax_pbr::lighting_probe::{applyStandardProbeIrradiance}
#endif
#import forgeax_pbr::gbuffer_output::{GBufferOutput, encodeStandardGBuffer, CompactGBufferOutput, StandardGBufferPassOutput, encodeCompactStandardGBuffer, encodeStandardReceiverContext, compactSubsurfaceCustomData}
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness, encodeStandardReceiverNormal}

#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData, surfaceGeometryNormal}
#import forgeax_view::common::{viewDirectionToCamera, lightingChannelsMatch, applyLodCoverage, meshMotionValid, meshGBufferObjectFlags, View, Mesh, InstanceData, view, shadowMap, shadowSampler, transformNormal}
#if WATER_WAVES_AVAILABLE == true
#import forgeax_material::water_waves::{waterMaterialDrawData, waterMeshCoverageContains, waterDynamicBoundsContains, waterMeshWireColor, waterMeshTileVertex, waterMeshSourceBodyIndex, waterMeshInstanceTransformIndex}
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
#import forgeax_material::slot::deformation::{deform_water_vertex}
#import forgeax_material::water_deformation_input::{waterDeformationInput, waterVertexFlowXZ, waterVertexFlowMPerSec, waterMeshFarContinuity}
#endif
#endif
#pragma material_slot deformation
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexCurrentWorld, sceneIndexDraw, sceneIndexMorphPosition, sceneIndexMorphNormal, sceneIndexMorphTangent, SCENE_INDEX_LOCAL_IDENTITY}
#else
#import forgeax_view::common::{meshes, instances, meshReceivesShadows}
#endif
#import forgeax_scene_temporal::{encodeSceneVelocityRaster, sceneFragmentViewZ, packSceneTemporalV1WithValidity, unpackSceneTemporalV1}
#ifdef TRANSMISSION_AVAILABLE
#import forgeax_view::fog::{forward_fog_transmission}
#else
#import forgeax_view::fog::{forward_fog, forward_vertex_fog}
#endif
#import forgeax_view::fog::{vertex_height_fog}
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_ssr::forward::{forwardSsrOpaque}
#import forgeax_view::common::{spotModifierSampler, iesProfileTexture, cookieTexture, cookieMatrices}
#endif
#ifdef PROJECTOR_AVAILABLE
#ifndef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{projectorTexture, projectorSampler}
#endif
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
#pragma variant_axis FORWARD_INLINE_SSR
#pragma variant_axis COVERAGE_ONLY
#pragma variant_axis VISIBLE_SURFACE_AVAILABLE
#pragma variant_axis ALPHA_MASK
#pragma variant_axis DIRECTIONAL_SHADOW_SIMPLE
#pragma variant_axis LEAN_LIGHTING
#pragma variant_axis LOD_DITHER
#pragma variant_axis CLIPPING_PLANES
#pragma variant_axis WATER_WAVES_AVAILABLE
#pragma variant_axis WATER_INFO_RGBA16
#pragma variant_axis STANDARD_LEAN_INPUTS


// @forgeax/engine-shader - default-standard-pbr.wgsl
// (feat-20260523-shader-template-instance-split M5 / T04).
//
// Engine-shipped default standard PBR material shader, registered under the
// reserved path identifier `forgeax::default-standard-pbr` (plan-strategy
// D-DefaultStandardPbr-Identifier + plan-strategy section 8.2). This file is
// the M5 successor to the monolithic `pbr.wgsl`; the BRDF / IBL / TBN /
// lighting helpers all live in independent ShaderModules and are pulled in
// via naga_oil #import (charter F1 grep gate -- AI users grep the #import
// header to enumerate every helper dependency in one shot).
//
// Bindings (4 BG layout slots; View + Mesh bindings inherited from
// forgeax_view::common; shadow map + comparison sampler at view BG
// @binding(3..4) per shadow-mapping feat; Skylight 7 bindings merged after
// the Standard user region per D-5 round-4:
//
//   @group(0) @binding(0) view                       uniform   (see common.wgsl)
//   @group(1) @binding(0) material                   uniform   (baseColor vec4
//                                                               + metallic + roughness
//                                                               + 4 channel selectors f32
//                                                               + emissive vec3 + emissiveIntensity
//                                                               + uv/alpha/specularColor = 104 B)
//   @group(0) @binding(34..35) Sky SH and View diffuse parameters.
//   @group(2) @binding(32..34) Selected Primitive reflection environment.
//   @group(2) @binding(0) meshes                     storage   (worldFromLocal mat4
//                                                               + temporal fields,
//                                                               see common.wgsl)
//   @group(3) @binding(0) instances                  storage   (per-instance
//                                                               localFromInstance mat4;
//                                                               indexed by @builtin
//                                                               (instance_index);
//                                                               see common.wgsl)
//
// 20 entries fit within `device.limits.maxBindingsPerBindGroup` (default
// 1000 across all known WebGPU devices; chrome-beta + dawn confirmed via
// the runtime probe in createRenderer.ts -- requirements R-E acceptance
// gate). Adding more bindings requires raising the entry-count fixture in
// the M5-T04 acceptanceCheck readback assertion.
//
// Two-layer fail-fast for roughness=0 NaN avoidance (plan-strategy section
// 5.3 + AC-02 b/c):
//   layer 1: AssetRegistry.register fail-fast (M1 + M4 paramValues 3-tier)
//            returns 'asset-invalid-value' / 'material-param-type-mismatch'
//            before the payload reaches the GPU.
//   layer 2: shader internal `let a = max(material.roughness, 0.04); a = a * a;`
//            keeps D_GGX finite even if a producer somehow bypasses layer 1.
//
// Normal mapping (AC-05 + plan-strategy D-4): TBN basis built from
// per-vertex tangent (vec4 with handedness sign in .w) + interpolated
// world-space normal (consumed via transformNormal from common.wgsl,
// plan-strategy D-5). RG-only tangent-space normal: sample.rg encodes
// (x,y) of the unit-length tangent normal, z is reconstructed via
// z = sqrt(1 - x^2 - y^2). Default 1x1 normal fallback texture is
// half-float RG=(0.5,0.5), which decodes exactly to tangent (0,0,1) when
// normalTexture is absent (host-side pipelineState.defaultNormalTextureView,
// distinct from the white fallback used by baseColor / metallicRoughness
// slots so a missing normal does not pollute the white-on-missing semantics
// of the other two slots). RG encoding also matches BC5 / RG normal maps
// and tolerates RGB normal maps (b is dropped, z is recomputed --
// equivalent for unit vectors).

// Surface composition generates MaterialParameters, its uniform, and the
// map bindings from the material schema. Scene color belongs to the pass.
#ifdef TRANSMISSION_AVAILABLE
@group(0) @binding(38) var transmissionBackdropTexture : texture_2d<f32>;
#endif

// Naga reflection does not retain filtering usage through the generic shared
// helper. These compile-time-only witnesses retain the binding contract while
// every runtime material sample still goes through sampleMaterialTexture.
#ifdef FORWARD_INLINE_SSR
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

// The View owns diffuse sky and the optional shared BRDF lookup textures.
// The CPU selects a reflection environment for the Primitive, using the sky
// PMREM when there is no eligible local capture.
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
// Optional consumer lane. The host provides the retained ProbeBlendRecord
// storage for the object selected by this draw. Keeping it in group(3)
// preserves the mesh/instance ownership of groups (2)/(3) without inventing a
// second probe bind group.
@group(3) @binding(1) var<storage, read> probeBlendRecords : array<vec4<f32>>;
#endif

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
// GPU-driven production binds the producer-owned Standard material table after
// the fixed physical texture range. The visible stream carries the scene
// instance row and material row selected by the compute cull.
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
#endif

// Screen-surface data and Cluster table inputs belong to the View.

#ifdef PLANAR_REFLECTION_AVAILABLE
#import forgeax_pbr::planar_reflection::{PlanarReflectionUniform, samplePlanarReflection}
@group(0) @binding(36) var standardPlanarReflectionTexture : texture_2d<f32>;
@group(0) @binding(37) var<uniform> standardPlanarReflection : PlanarReflectionUniform;
#endif

struct VsIn  {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv      : vec2<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) tangent : vec4<f32>,
#endif
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(6) uv1     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(7) uv2     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(8) uv3     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(9) uv4     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(10) uv5    : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(11) uv6    : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(12) uv7    : vec2<f32>,
#endif
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
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(6) uv1     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(7) uv2     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(8) uv3     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(9) uv4     : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(10) uv5    : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(11) uv6    : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(12) uv7    : vec2<f32>,
#endif
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
  // MaterialAsset per-slot texCoord: reserve the canonical UV0-UV7 inputs.
  // Missing mesh sets are supplied by the pipeline's clamp-to-last aliases.
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv1 = input.uv1;
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv2 = input.uv2;
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv3 = input.uv3;
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv4 = input.uv4;
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv5 = input.uv5;
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv6 = input.uv6;
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  output.uv7 = input.uv7;
#endif
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  output.color = input.color;
#endif
  return output;
}

struct VsOut {
  @builtin(position) @invariant clip : vec4<f32>,
  // xyz retains the shading normal; w carries ordinary vertex-fog T.
  @location(1) worldNormal : vec4<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  // Interpolated UV scalars follow the sets the material reads, as UE sizes
  // TexCoords[(NUM_TEX_COORD_INTERPOLATORS+1)/2] from the translator's used
  // UV count (LocalVertexFactoryCommon.ush:32-33,
  // HLSLMaterialTranslator.cpp:15709-15716).
#ifdef STANDARD_SINGLE_UV_SET
  @location(2) uvPair0 : vec2<f32>,
#else
  @location(2) uvPair0 : vec4<f32>,
#endif
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) worldTangent : vec4<f32>,
#endif
  // View depth and NDC are read back from @builtin(position) in the
  // fragment stage (UE BasePassVertexCommon.ush:23-31 carries no clip/NDC
  // interpolant; Common.ush:1530-1542 SvPositionToScreenPosition).
#ifndef STANDARD_OBJECT_POSITION_UNUSED
#if WATER_WAVES_AVAILABLE == true
  // Water keeps its mask in normal.w and packs fog into the object-position lane.
  @location(7) positionOS : vec4<f32>,
#else
  @location(7) positionOS : vec3<f32>,
#endif
#else
#if WATER_WAVES_AVAILABLE == true
  @location(7) vertexFog : f32,
#endif
#endif
  // Keep mesh and instance storage vertex-only: the flat object basis
  // serves transmission, triplanar object projection and object-space
  // normal maps.
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(4) @interpolate(flat) objectBasis0 : vec4<f32>,
  @location(6) @interpolate(flat) objectBasis2 : f32,
#endif
  // Pair UV sets without changing their interpolation or material semantics.
  // Flat surface facts and the previous clip position share the freed slots
  // with physical variants that carry both transmission basis varyings.
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(5) uvPair1 : vec4<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(8) uvPair2 : vec4<f32>,
#endif
#endif
  // Preserve the integer surface row and the encoded temporal reactive lane
  // in one flat slot. Both are constant across each submitted triangle.
#if WATER_WAVES_AVAILABLE == true
  @location(9) @interpolate(flat) surfaceData : vec4<u32>,
#ifndef DIRECTIONAL_SHADOW_SIMPLE
  @location(10) clipDelta : vec4<f32>,
#endif
  @location(11) waterCoverageAndGridXZ : vec4<f32>,
#else
#ifdef DIRECTIONAL_SHADOW_SIMPLE
  // The simple receiver is a forward-only row (fs_gbuffer is not compiled
  // into it), so the GBuffer velocity and visible-surface lanes drop and only
  // the lighting channels stay, as UE BasePassCommon.ush:110-112 declares
  // VelocityPrevScreenPosition only under WRITES_VELOCITY_TO_GBUFFER.
  @location(9) @interpolate(flat) lightingChannels : u32,
#else
  // (temporal reactive lane, lighting channels[, visible-surface row]). The
  // row lane rides only where the GBuffer writes visible_surface.
#ifdef VISIBLE_SURFACE_AVAILABLE
  @location(9) @interpolate(flat) surfaceData : vec3<u32>,
#else
  @location(9) @interpolate(flat) surfaceData : vec2<u32>,
#endif
  @location(10) clipDelta : vec4<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(12) uvPair3 : vec4<f32>,
#endif
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
  // Only the lanes the variant reads ride the flat slot: the material row
  // always, the probe slot/generation under PROBE_BLEND_AVAILABLE and the LOD
  // fade under LOD_DITHER, as UE interpolates per-primitive facts only when a
  // permutation consumes them (LocalVertexFactoryCommon.ush:42-43).
#if WATER_WAVES_AVAILABLE == true
  @location(15) @interpolate(flat) materialAddress : vec4<u32>,
#else
#ifdef PROBE_BLEND_AVAILABLE
  @location(15) @interpolate(flat) materialAddress : vec3<u32>,
#else
  @location(15) @interpolate(flat) materialAddress : u32,
#endif
#endif
#if LOD_DITHER == true
#if WATER_WAVES_AVAILABLE == false
  @location(11) @interpolate(flat) lodFade : f32,
#endif
#endif
#endif
};

// Light evaluators live in forgeax_pbr::lighting_directional +
// forgeax_pbr::lighting_punctual (M5 / T02). evalDirectional consumes the
// host's view UBO + shadowMap (LO 3.1.3 slope-scaled-bias 3x3 PCF;
// feat-20260520-directional-light-shadow-mapping byte-equivalent). evalPoint
// / evalSpot share evalPunctualBody (GGX specular + Lambertian diffuse +
// KHR_lights_punctual quartic range attenuation;
// feat-20260519-light-casters-point-spot-pbr M4 / w22 byte-equivalent).
// Charter P4: spot light is a thin cone-multiplier on top of the punctual
// body, point light is the body unchanged -- no magic-value collapse.

#if TERRAIN_GEOMETRY_AVAILABLE == true
@group(1) @binding(1) var terrainHeightTexture_sampler : sampler;
@group(1) @binding(2) var terrainHeightTexture : texture_2d<f32>;
@group(1) @binding(3) var terrainWeightTexture_sampler : sampler;
@group(1) @binding(4) var terrainWeightTexture : texture_2d<f32>;
@group(1) @binding(5) var terrainColorLayers_sampler : sampler;
@group(1) @binding(6) var terrainColorLayers : texture_2d_array<f32>;
@group(1) @binding(7) var terrainNormalHeightLayers_sampler : sampler;
@group(1) @binding(8) var terrainNormalHeightLayers : texture_2d_array<f32>;
@group(1) @binding(9) var terrainOrmLayers_sampler : sampler;
@group(1) @binding(10) var terrainOrmLayers : texture_2d_array<f32>;
@group(1) @binding(11) var terrainEmissionLayers_sampler : sampler;
@group(1) @binding(12) var terrainEmissionLayers : texture_2d_array<f32>;
#endif

fn standardVertexPosition(in : VsIn) -> vec3<f32> {
#if TERRAIN_GEOMETRY_AVAILABLE == true
  return terrainVertex(in.pos, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#else
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
#endif
}

fn standardSetLightingChannels(out : ptr<function, VsOut>, channels : u32) {
#if WATER_WAVES_AVAILABLE == true
  (*out).surfaceData.z = channels;
#else
#ifdef DIRECTIONAL_SHADOW_SIMPLE
  (*out).lightingChannels = channels;
#else
  (*out).surfaceData.y = channels;
#endif
#endif
}

fn standardLightingChannels(in : VsOut) -> u32 {
#if WATER_WAVES_AVAILABLE == true
  return in.surfaceData.z;
#else
#ifdef DIRECTIONAL_SHADOW_SIMPLE
  return in.lightingChannels;
#else
  return in.surfaceData.y;
#endif
#endif
}

fn standardWorldPosition(localToWorld : mat4x4<f32>, position : vec3<f32>) -> vec4<f32> {
  return localToWorld * vec4<f32>(position, 1.0);
}

fn standardRasterClip(world : vec4<f32>) -> vec4<f32> {
  return view.worldViewProj * world;
}

fn vs_main_impl(in : VsIn, localToWorld : mat4x4<f32>, previousLocalToWorld : mat4x4<f32>, materialAddress : vec4<u32>, temporal : vec3<f32>, meshInstanceIndex : u32) -> VsOut {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#ifndef STANDARD_VERTEX_MATERIAL_UNUSED
  material = selectedMaterial(materialAddress.x);
#endif
#endif
  var localPosition = standardVertexPosition(in);
  var waterMeshInstanceIndex = 0u;
#if WATER_WAVES_AVAILABLE == true
  let waterMeshVertex = waterMeshTileVertex(localPosition, meshInstanceIndex);
  localPosition = waterMeshVertex.position;
  var waterCoverageXZ = waterMeshVertex.coverageXZ;
  waterMeshInstanceIndex = meshInstanceIndex;
#endif

  // Combine entity world with the per-instance local transform. Scene-index
  // draws pass the composed GPU Scene world and an identity local.
  var world = standardWorldPosition(localToWorld, localPosition);
  var out : VsOut;
  var previousWorld = previousLocalToWorld * vec4<f32>(localPosition, 1.0);
#if WATER_WAVES_AVAILABLE == true
  var waterWaveNormal = normalize(transformNormal(localToWorld, in.normal));
  var waterMask = 1.0;
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
  var waterVertexColor = vec4<f32>(1.0);
#ifdef VERTEX_COLOR_AVAILABLE
  waterVertexColor = in.color;
#endif
  let waterVertexFlow = waterVertexFlowMPerSec(waterVertexFlowXZ(waterVertexColor, localToWorld));
  let deformationInput = waterDeformationInput(waterMeshVertex.bodyIndex, waterMeshVertex.waveBodyIndex, world.xyz, previousWorld.xyz,
    normalize(transformNormal(localToWorld, in.normal)), view.cameraPos, waterMeshVertex.waveRelativeXZ, select(0u, 1u, waterMeshVertex.far), waterVertexFlow);
  let deformation = waterMeshFarContinuity(deformationInput, deform_water_vertex(deformationInput), meshInstanceIndex);
  world = vec4<f32>(deformation.currentPositionM, 1.0);
  previousWorld = vec4<f32>(deformation.previousPositionM, 1.0);
  waterWaveNormal = deformation.currentNormalYUp;
  waterMask = deformation.waterMask;
#endif
#endif
#if WATER_WAVES_AVAILABLE == true
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  out.vertexFog = vertex_height_fog(view, world.xyz);
#endif
  out.waterCoverageAndGridXZ = vec4<f32>(waterCoverageXZ, waterMeshVertex.gridXZ);
  out.surfaceData = vec4<u32>(0u, 0u, 0xffffffffu, waterMeshInstanceIndex);
#endif
#ifdef DIRECTIONAL_SHADOW_SIMPLE
  // UE BasePassVertexShader.usf:255-273 computes the previous clip position
  // only under WRITES_VELOCITY_TO_GBUFFER; forward rows have no reader.
  standardSetLightingChannels(&out, 0xffffffffu);
#else
  let currentClip = view.temporalCurrentViewProj * world;
  let previousClip = view.temporalPreviousViewProj * previousWorld;
  // Equal poses produce exact zero before interpolation. Reprojecting two
  // separately rounded world/clip varyings would invent stationary motion.
  out.clipDelta = currentClip - previousClip;
  let reactive = max(temporal.x, select(0.0, 1.0, temporal.z != 0.0));
  let reactiveLane = packSceneTemporalV1WithValidity(currentClip,
    previousClip, view.temporalProjection, reactive, meshMotionValid(temporal.y)).w;
#if WATER_WAVES_AVAILABLE == true
  out.surfaceData.y = bitcast<u32>(reactiveLane);
#else
#ifdef VISIBLE_SURFACE_AVAILABLE
  out.surfaceData = vec3<u32>(bitcast<u32>(reactiveLane), 0xffffffffu, 0u);
#else
  out.surfaceData = vec2<u32>(bitcast<u32>(reactiveLane), 0xffffffffu);
#endif
#endif
#endif
  out.clip = standardRasterClip(world);
#ifndef STANDARD_OBJECT_POSITION_UNUSED
#if WATER_WAVES_AVAILABLE == true
  out.positionOS = vec4<f32>(localPosition, vertex_height_fog(view, world.xyz));
#else
  out.positionOS = localPosition;
#endif
#endif
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  let terrainN = terrainNormal(in.pos, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
#if WATER_WAVES_AVAILABLE == true
  out.worldNormal = vec4<f32>(normalize(transformNormal(localToWorld, terrainN)), waterMask);
#else
  out.worldNormal = vec4<f32>(normalize(transformNormal(localToWorld, terrainN)), vertex_height_fog(view, world.xyz));
#endif
#else
#if WATER_WAVES_AVAILABLE == true
  out.worldNormal = vec4<f32>(normalize(waterWaveNormal), waterMask);
#else
  out.worldNormal = vec4<f32>(normalize(transformNormal(localToWorld, in.normal)), vertex_height_fog(view, world.xyz));
#endif
#endif
  // Tangent transformed by the combined entity*instance chain as a direction
  // (w=0); .w handedness preserved for bitangent reconstruction in fragment.
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let worldTangentXyz = normalize((localToWorld * vec4<f32>(in.tangent.xyz, 0.0)).xyz);
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  let terrainT = normalize(vec3<f32>(terrainN.y, -terrainN.x, 0.0));
  out.worldTangent = vec4<f32>(normalize((localToWorld * vec4<f32>(terrainT, 0.0)).xyz), -1.0);
#else
  out.worldTangent = vec4<f32>(worldTangentXyz, in.tangent.w);
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifdef STANDARD_SINGLE_UV_SET
#if TERRAIN_GEOMETRY_AVAILABLE == true
  out.uvPair0 = (localPosition.xz - material.terrainSection.xy) / material.terrainSection.z;
#else
  out.uvPair0 = in.uv;
#endif
#else
#if TERRAIN_GEOMETRY_AVAILABLE == true
  out.uvPair0 = vec4<f32>((localPosition.xz - material.terrainSection.xy) / material.terrainSection.z, in.uv1);
#else
  out.uvPair0 = vec4<f32>(in.uv, in.uv1);
#endif
  out.uvPair1 = vec4<f32>(in.uv2, in.uv3);
  out.uvPair2 = vec4<f32>(in.uv4, in.uv5);
  out.uvPair3 = vec4<f32>(in.uv6, in.uv7);
#endif
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  out.color = in.color;
#endif
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  out.objectBasis0 = vec4<f32>(
    localToWorld[0].x,
    localToWorld[0].y,
    localToWorld[0].z,
    localToWorld[1].x,
  );
  out.objectBasis1 = vec4<f32>(
    localToWorld[1].y,
    localToWorld[1].z,
    localToWorld[2].x,
    localToWorld[2].y,
  );
  out.objectBasis2 = localToWorld[2].z;
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if WATER_WAVES_AVAILABLE == true
  out.materialAddress = materialAddress;
#else
#ifdef PROBE_BLEND_AVAILABLE
  out.materialAddress = materialAddress.xyz;
#else
  out.materialAddress = materialAddress.x;
#endif
#endif
#if LOD_DITHER == true
#if WATER_WAVES_AVAILABLE == false
  out.lodFade = bitcast<f32>(materialAddress.w);
#endif
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
#if WATER_WAVES_AVAILABLE == true
var<private> standardWaterCovered : bool = true;
#endif

fn standardFragmentPosition(in : VsOut) -> vec3<f32> {
  let world = view.inverseViewProj * vec4<f32>(standardFragmentNdc(in), 1.0);
  return world.xyz / world.w;
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#ifdef VISIBLE_SURFACE_AVAILABLE
@group(3) @binding(7) var<storage, read> visibleSurfaceRows: array<u32>;
#endif
fn sceneIndexVertex(source : VsIn, idx : u32, vertex : u32) -> VsOut {
  // Rigid visible = (scene instance row, material row, candidate row, signed LOD fade).
  let visible = visibleItems[idx];
  let draw = sceneIndexDraw(visible.x);
  var in = source;
  in.pos = sceneIndexMorphPosition(visible.x, vertex, in.pos);
  in.normal = sceneIndexMorphNormal(visible.x, vertex, in.normal);
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  in.tangent = sceneIndexMorphTangent(visible.x, vertex, in.tangent);
#endif
  var out = vs_main_impl(
    in,
    draw.world,
    draw.previousWorld,
    // Scene material rows never reach bit 31; it carries the receive opt-out.
    vec4<u32>(visible.y | (draw.gbufferObjectFlags << 29u) | select(STANDARD_NO_RECEIVE_BIT, 0u, draw.receivesShadows), draw.probe, visible.w),
    vec3<f32>(draw.temporal, bitcast<f32>(visible.w)),
    idx,
  );
#ifdef VISIBLE_SURFACE_AVAILABLE
#if WATER_WAVES_AVAILABLE == true
  out.surfaceData.x = visibleSurfaceRows[visible.z];
#else
  out.surfaceData.z = visibleSurfaceRows[visible.z];
#endif
#endif
  standardSetLightingChannels(&out, draw.lightingChannels);
  return out;
}
#endif

// ShadowParticipation.receive is a per-draw value (layer 5, not a pipeline
// constant): GPU-driven rows ride the flat material lane; per-entity draws
// read the dynamic-offset Mesh slot directly. The View-level override folds
// reception away only for a proven shadow-free View.
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
fn standardMaterialRow(in : VsOut) -> u32 {
#if WATER_WAVES_AVAILABLE == true
  return in.materialAddress.x;
#else
#ifdef PROBE_BLEND_AVAILABLE
  return in.materialAddress.x;
#else
  return in.materialAddress;
#endif
#endif
}
#endif

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
  if (standardShadowReception == 0u) { return false; }
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

#ifndef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn standardLocalInstanceIndex(idx : u32) -> u32 {
#ifdef VISIBLE_SURFACE_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  return idx % max(meshes[0u].surface.y, 1u);
#endif
#endif
  return idx;
}
#endif

#ifdef STANDARD_POSITION_ONLY_AVAILABLE
#if TERRAIN_GEOMETRY_AVAILABLE == false
#if WATER_WAVES_AVAILABLE == false
struct StandardPositionOnlyOutput {
  @builtin(position) @invariant clip : vec4<f32>,
};

// Colorless opaque depth uses the same position math as the Base Pass. Render
// selects this entry only after proving that vertex displacement is disabled.
@vertex
fn vs_position_only(
  @location(0) position : vec3<f32>,
  @builtin(instance_index) idx : u32,
  @builtin(vertex_index) vertex : u32,
) -> StandardPositionOnlyOutput {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  let sceneRow = visibleItems[idx].x;
  let localPosition = sceneIndexMorphPosition(sceneRow, vertex, position);
  let localToWorld = sceneIndexDraw(sceneRow).world;
#else
  let localPosition = position;
  let localToWorld = meshes[0u].worldFromLocal *
    instances[standardLocalInstanceIndex(idx)].localFromInstance;
#endif
  var out : StandardPositionOnlyOutput;
  out.clip = standardRasterClip(standardWorldPosition(localToWorld, localPosition));
  return out;
}
#endif
#endif
#endif

fn vs_main_impl_entry(in : VsIn, idx : u32, vertex : u32) -> VsOut {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  return sceneIndexVertex(in, idx, vertex);
#else
  // The Mesh window selects the entity. Slot 3 supplies its local instances.
  var localInstance = standardLocalInstanceIndex(idx);
#if WATER_WAVES_AVAILABLE == true
  localInstance = waterMeshInstanceTransformIndex(localInstance);
#endif
  let localToWorld = meshes[0u].worldFromLocal * instances[localInstance].localFromInstance;
#if STORAGE_BUFFER_AVAILABLE == true
  let previousLocalToWorld = meshes[0u].previousWorldFromLocal * instances[localInstance].previousLocalFromInstance;
  let temporal = meshes[0u].temporal.xyz;
#else
  let previousLocalToWorld = localToWorld;
  let temporal = vec3<f32>(0.0, 1.0, 0.0);
#endif
  var out = vs_main_impl(
    in,
    localToWorld,
    previousLocalToWorld,
    // The material address is read only by scene-index draws.
    vec4<u32>(0xffffffffu, 0u, 0u, 0u),
    temporal,
    localInstance,
  );
  standardSetLightingChannels(&out, meshes[0u].surface.z);
#ifdef VISIBLE_SURFACE_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  let address = meshes[0u].surface;
#if WATER_WAVES_AVAILABLE == true
  out.surfaceData.x = select(0u, address.x + idx, address.x != 0u);
#else
  out.surfaceData.z = select(0u, address.x + idx, address.x != 0u);
#endif
#endif
#endif
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
@id(64002) override standardShadowReception: u32 = 1u;

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn selectedMaterial(index : u32) -> MaterialParameters {
  return sceneMaterials[index & STANDARD_MATERIAL_ROW_MASK];
}


#endif

fn physicalMaterialUvs(in : VsOut) -> PhysicalMaterialUvs {
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
#ifdef STANDARD_SINGLE_UV_SET
  return in.uvPair0;
#else
  return PhysicalMaterialUvs(in.uvPair0, in.uvPair1, in.uvPair2, in.uvPair3);
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


// Keep the cooked artifact content-addressable per declared capability set.
// Some capability axes only change an imported helper's resource surface; the
// witness makes that distinction explicit in the composed source as well, so
// two valid manifest keys can never alias one artifact hash.


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

// Surface discards are source macros, one axis per feature. A reachable
// discard defeats hidden-surface removal on tile GPUs even when it never
// fires, so a feature that is off leaves no discard in the program:
//   LOD_DITHER       LOD crossfade coverage; published only for scenes with
//                    cross-fading meshes (UE AllowDitheredLODTransition).
//   CLIPPING_PLANES  camera view clipping planes.
// Material-local clipping planes follow the MATERIAL_CLIPPING_AVAILABLE
// define of the cooked material and the alpha test follows ALPHA_MASK.

// Parallax displacement shifts the height slot's source UV set before every
// Surface and layer sample. Derivatives precede discard and row selection.
// The march reads the derived fragment height binding, which the compiler
// projects onto its hosted pair; shared transmission withdraws it.
fn standardParallaxInput(in : VsOut) -> VsOut {
  var shifted = in;
#ifdef PARALLAX_HEIGHT_FRAGMENT_AVAILABLE
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_TANGENT_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  let positionDx = dpdx(standardPositionWS);
  let positionDy = dpdy(standardPositionWS);
  let uvDx = array<vec4<f32>, 4>(dpdx(in.uvPair0), dpdx(in.uvPair1), dpdx(in.uvPair2), dpdx(in.uvPair3));
  let uvDy = array<vec4<f32>, 4>(dpdy(in.uvPair0), dpdy(in.uvPair1), dpdy(in.uvPair2), dpdy(in.uvPair3));
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  material = selectedMaterial(standardMaterialRow(in));
#endif
  let pairs = evaluateStandardParallax(array<vec4<f32>, 4>(in.uvPair0, in.uvPair1, in.uvPair2, in.uvPair3),
    uvDx, uvDy, positionDx, positionDy, in.worldNormal.xyz, in.worldTangent,
    viewDirectionToCamera(standardPositionWS), standardObjectToWorld(in));
  shifted.uvPair0 = pairs[0];
  shifted.uvPair1 = pairs[1];
  shifted.uvPair2 = pairs[2];
  shifted.uvPair3 = pairs[3];
#endif
#endif
#endif
#endif
  return shifted;
}

// Standard owns the lighting and pass policy; the selected Surface owns only
// the base facts exchanged through surface_v1.
fn standardSurfaceInput(in : VsOut, frontFacing : bool, geometricNormal : vec3<f32>) -> SurfaceInput {
#if WATER_WAVES_AVAILABLE == true
  standardWaterCovered = !(in.worldNormal.w <= 0.0) && waterMeshCoverageContains(in.surfaceData.w, in.waterCoverageAndGridXZ.xy)
    && waterDynamicBoundsContains(waterMeshSourceBodyIndex(in.surfaceData.w), standardPositionWS);
#endif
  let triangleNormal = standardDisplacementTriangleNormal(standardPositionWS, in.worldNormal.xyz);
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if LOD_DITHER == true
#if WATER_WAVES_AVAILABLE == true
    applyLodCoverage(in.clip.xy, bitcast<f32>(in.materialAddress.w));
#else
    applyLodCoverage(in.clip.xy, in.lodFade);
#endif
#endif
#endif
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
#ifdef STANDARD_SINGLE_UV_SET
  let surfaceUvs = array<vec2<f32>, 8>(in.uvPair0, in.uvPair0, in.uvPair0, in.uvPair0, in.uvPair0, in.uvPair0,
    in.uvPair0, in.uvPair0);
#else
#ifndef STANDARD_UV_INPUT_UNUSED
  let surfaceUvs = array<vec2<f32>, 8>(in.uvPair0.xy, in.uvPair0.zw, in.uvPair1.xy, in.uvPair1.zw, in.uvPair2.xy, in.uvPair2.zw,
    in.uvPair3.xy, in.uvPair3.zw);
#else
  let surfaceUvs = array<vec2<f32>, 8>();
#endif
#endif
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  let positionOS = vec3<f32>(0.0);
#else
#if WATER_WAVES_AVAILABLE == true
  let positionOS = in.positionOS.xyz;
#else
  let positionOS = in.positionOS;
#endif
#endif
  let vertexNormal = standardDisplacementSurfaceNormal(in.worldNormal.xyz, triangleNormal);
  return SurfaceInput(
    positionOS, standardPositionWS, geometricNormal, vertexNormal, surfaceTangent, viewDirectionWS,
    surfaceUvs[0], surfaceUvs[1], surfaceUvs[2], surfaceUvs[3], surfaceUvs[4], surfaceUvs[5], surfaceUvs[6], surfaceUvs[7], materialVertexColor(in), frontFacing, vec4<f32>(0.0), vec4<f32>(0.0),
    standardObjectToWorld(in), view.fogHeightOpacity.w,
  );
}

fn evaluateStandardSurface(in : VsOut, frontFacing : bool, geometricNormal : vec3<f32>) -> SurfaceData {
#if WATER_WAVES_AVAILABLE == true
  let waterTileEdge = waterMeshWireColor(in.surfaceData.w, in.waterCoverageAndGridXZ.zw);
#endif
  let input = standardSurfaceInput(in, frontFacing, geometricNormal);
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#if TRANSMISSION_AVAILABLE == false
  var surface = evaluate_standard_surface(input, material);
#else
  var surface = evaluate_surface(input);
#endif
#else
  var surface = evaluate_surface(input);
#endif
#if WATER_WAVES_AVAILABLE == true
  surface.baseColor = mix(surface.baseColor, waterTileEdge.rgb, waterTileEdge.a);
  surface.emissive += waterTileEdge.rgb * waterTileEdge.a * 0.5;
#endif
  return surface;
}




// linearColorDomain: transparent source and destination values are blended
// before any display encoding. The fixed-function material blend state uses
// this same equation for the render target's declared linear domain.
fn blendLinearTransparent(
  source : vec3<f32>,
  destination : vec3<f32>,
  alpha : f32,
) -> vec3<f32> {
  return source * alpha + destination * (1.0 - alpha);
}

// linearHdrColorDomain: fs_main writes linear HDR when its target is HDR.
// toneStageInput: the value remains linear until the fullscreen tone stage.

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
  @location(3) reflectionSurface : vec4<f32>,
#endif
};

// Lit Standard surface before its camera-to-surface medium. The admitted
// Forward route applies interpolated height fog to opaque and blended color;
// other routes retain the existing per-fragment translucent/capture behavior.
struct StandardForwardLit {
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
  fragmentOutput : vec4<f32>,
#endif
  color : vec3<f32>,
  alpha : f32,
#ifdef TRANSMISSION_AVAILABLE
  transmittedContribution : vec3<f32>,
  transmittedCoefficient : vec3<f32>,
#endif
#ifdef REFLECTION_FALLBACK_AVAILABLE
  reflectionFallback : vec4<f32>,
  reflectionResponse : vec4<f32>,
  reflectionSurface : vec4<f32>,
#endif
};

fn standardForwardOutput(lit : StandardForwardLit, color : vec3<f32>) -> StandardPbrOutput {
  var output : StandardPbrOutput;
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
  output.color = applyFragmentOutput(vec4<f32>(color, lit.alpha), lit.fragmentOutput);
#else
  output.color = vec4<f32>(color, lit.alpha);
#endif
#ifdef REFLECTION_FALLBACK_AVAILABLE
  output.reflectionFallback = lit.reflectionFallback;
  output.reflectionResponse = lit.reflectionResponse;
  output.reflectionSurface = lit.reflectionSurface;
#endif
  return output;
}

fn standardVertexFog(in : VsOut) -> f32 {
#if WATER_WAVES_AVAILABLE == true
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  return in.vertexFog;
#else
  return in.positionOS.w;
#endif
#else
  return in.worldNormal.w;
#endif
}

fn standardForwardFogged(in : VsOut, lit : StandardForwardLit) -> StandardPbrOutput {
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardOutput(lit, forward_fog_transmission(view, standardPositionWS, standardVertexFog(in), lit.color, lit.alpha, lit.transmittedContribution, lit.transmittedCoefficient));
#else
  return standardForwardOutput(lit, forward_fog(view, standardPositionWS, standardVertexFog(in), lit.color, lit.alpha));
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

// A clipping cap fragment is shaded as a front-facing point on the cut plane.
// The cap is resolved once per fragment; standardCappedFacing reads the
// result standardCappedInput left, so callers bind the input first.
var<private> standardFragmentCapped : bool;

fn standardCappedInput(in : VsOut, frontFacing : bool) -> VsOut {
  let cap = viewClippingCap(standardPositionWS, frontFacing);
  var capped = in;
  standardFragmentCapped = cap.capped;
  if (cap.capped) {
    standardPositionWS = cap.positionWS;
    capped.worldNormal = vec4<f32>(cap.normalWS, in.worldNormal.w);
  }
  return capped;
}

fn standardCappedFacing(frontFacing : bool) -> bool {
  return frontFacing || standardFragmentCapped;
}

// Surface sampling and derivatives complete before the entry-owned coverage gate.
// Rejected fragments never enter direct or environment lighting.
struct StandardForwardSurface {
  surface : SurfaceData,
  rawGeometry : vec3<f32>,
  receiverNormal : vec3<f32>,
  geometricNormal : vec3<f32>,
  normalSpread : f32,
  useDirectDfgLut : bool,
};

fn readStandardForwardDecals() -> array<vec4<f32>, 3> {
#ifdef CLUSTER_FORWARD_AVAILABLE
  let decalColor = sampleStandardScreenData(standardPositionWS, view.worldViewProj, 1u, forwardScreenSurface);
  let decalNormal = sampleStandardScreenData(standardPositionWS, view.worldViewProj, 2u, forwardScreenSurface);
  let decalRoughness = sampleStandardScreenData(standardPositionWS, view.worldViewProj, 3u, forwardScreenSurface);
  return array<vec4<f32>, 3>(decalColor, decalNormal, decalRoughness);
#else
  return array<vec4<f32>, 3>();
#endif
}

fn prepareStandardForwardSurface(in : VsOut, frontFacing : bool, screenReceiver : bool, decals : array<vec4<f32>, 3>) -> StandardForwardSurface {
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  var rawGeometry = surfaceGeometryNormal(dpdx(standardPositionWS), dpdy(standardPositionWS), vec3<f32>(0.0));
#if TERRAIN_GEOMETRY_AVAILABLE == true
  rawGeometry = terrainGeometryNormal(rawGeometry, frontFacing);
#endif
  let receiverNormal = select(in.worldNormal.xyz * select(-1.0, 1.0, frontFacing), rawGeometry,
    dot(rawGeometry, rawGeometry) > 0.0);
  let geometricNormal = receiverNormal * select(-1.0, 1.0, frontFacing);
  var normalSpread = geometricNormalSpread(in.worldNormal.xyz);
  var surface = evaluateStandardSurface(in, frontFacing, geometricNormal);
#ifdef CLUSTER_FORWARD_AVAILABLE
  if (screenReceiver) {
    let painted = applyStandardScreenDecals(surface.baseColor, surface.normalWS, surface.roughness, decals[0], decals[1], decals[2]);
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
  return StandardForwardSurface(surface, rawGeometry, receiverNormal, geometricNormal, normalSpread, useDirectDfgLut);
}

fn standardForwardShadingNormal(surfaceNormal : vec3<f32>) -> vec3<f32> {
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  let n = surfaceNormal;
#else
  let n = normalize(surfaceNormal);
#endif

  return n;
}

fn standardForwardPhysicalNormal(in : VsOut, surfaceNormal : vec3<f32>) -> vec3<f32> {
  let n = standardForwardShadingNormal(surfaceNormal);
  var physicalNormal = n;
#ifdef ANISOTROPY_AVAILABLE
  let anisotropy = evaluateStandardAnisotropy(physicalMaterialUvs(in));
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  physicalNormal = evaluateAnisotropicNormal(
    n,
    in.worldTangent,
    anisotropy.z,
    anisotropy.w,
    anisotropy.xy,
  );
#endif
#endif
  return physicalNormal;
}

fn standardRawDirectionalVisibility(in : VsOut, frontFacing : bool, screenReceiver : bool,
    prepared : StandardForwardSurface, physicalNormal : vec3<f32>) -> f32 {
  let receiverNormal = prepared.receiverNormal;
  var directionalShadowNormal = receiverNormal;
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  // A back-lit thin surface receives through its opposite face; offset the
  // shadow receiver toward the light so the leaf does not shadow itself
  // (Unreal TwoSidedBxDF uses the same flipped-normal shadow bias).
  directionalShadowNormal = select(receiverNormal, -receiverNormal,
    dot(receiverNormal, -view.lightDir) < 0.0);
#endif
  let receiveShadows = standardReceivesShadows(in);
  var directionalLayerBase = 0u;
#if TERRAIN_GEOMETRY_AVAILABLE == true
  directionalLayerBase = terrainShadowLayerBase(prepared.rawGeometry, frontFacing, view.lightDir,
    material.terrainShadowFamily, view.cascadeCount, view.directionalShadowFilter.x);
#endif
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
      directionalLayerBase,
      in.clip.xy,
    );
  }
#ifdef CLUSTER_FORWARD_AVAILABLE
  if (screenReceiver && receiveShadows && needsDirectionalShadow) {
    directionalShadow *= sampleStandardContactShadow(standardPositionWS, view.worldViewProj, forwardScreenSurface);
  }
#endif
  return directionalShadow;
}

fn standardForwardLitSurface(in : VsOut, frontFacing : bool, prepared : StandardForwardSurface, physicalNormal : vec3<f32>, directionalShadow : f32, screenAo : f32) -> StandardForwardLit {
  let surface = prepared.surface;
  let geometricNormal = prepared.geometricNormal;
  let normalSpread = prepared.normalSpread;
  let useDirectDfgLut = prepared.useDirectDfgLut;
  let alpha = materialOutputAlpha(surface.opacity, standardAlphaMode());
  let albedo = surface.baseColor;
  let metallic = clamp(finiteScalar(surface.metallic, 0.0), 0.0, 1.0);
  let iblRoughness = specularAntiAliasedRoughness(
    clamp(finiteScalar(surface.roughness, 0.5), 0.04, 1.0), normalSpread);
  let a = iblRoughness * iblRoughness;
  let n = standardForwardShadingNormal(surface.normalWS);

  let v = viewDirectionToCamera(standardPositionWS);
  let safeIor = max(finiteScalar(material.ior, 1.5), 1.0);
  let dielectricF0 = standardDielectricF0(safeIor);
  let physicalUvs = physicalMaterialUvs(in);
  let surfaceSpecular = evaluateStandardSpecular(physicalUvs, metallic, dielectricF0);
  var dielectricSpecular = surfaceSpecular;
  var metallicF0 = albedo;
  var f0 = mix(surfaceSpecular.rgb, albedo, metallic);
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
  // `refract` returns the zero vector for total internal reflection. Keep the
  // reflection/IBL term above authoritative and remove transmission energy
  // instead of sampling and adding a second reflected environment.
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
  // Direct draws bind one dynamically-selected record at lane zero. The
  // scene-index lane binds the retained array and carries slot+1/generation
  // beside the material row in one visible-address varying.
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
  var environment = evaluateStandardEnvironment(standardPositionWS, physicalNormal, v,
    diffuseAlbedo, transmissionAlbedo, metallic, iblRoughness, f0, dielectricSpecular, metallicF0, skylight, viewSkylight.ambientIrradiance.xyz, irradiance,
    prefilterMap, prefilterSampler,
#ifdef ENV_BRDF_LUT
    brdfLut, viewLinearSampler,
#endif
  );
#ifdef PLANAR_REFLECTION_AVAILABLE
  let planar = samplePlanarReflection(standardPlanarReflection, standardPlanarReflectionTexture,
    viewLinearSampler, standardPositionWS, physicalNormal, v, iblRoughness);
  environment.specular = planar.rgb * environment.response.rgb + environment.specular * (1.0 - planar.a);
#endif
  let ao = surface.occlusion;
  let specularAo = standardSpecularOcclusion(max(dot(physicalNormal, v), 0.0), ao * screenAo, iblRoughness);
  let materialSpecularAo = standardSpecularOcclusion(max(dot(physicalNormal, v), 0.0), ao, iblRoughness);
  var ambient = (environment.diffuse * ao * screenAo + environment.specular * specularAo) * (vec3<f32>(1.0) - coatF);
  var reflectionFallback = environment.specular * (vec3<f32>(1.0) - coatF) * specularAo;
#ifdef REFLECTION_FALLBACK_AVAILABLE
  var reflectionResponse = environment.response.rgb * (vec3<f32>(1.0) - coatF) * materialSpecularAo;
#endif
#ifdef FORWARD_INLINE_SSR
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
  // Read the affine basis forwarded by the vertex stage. This keeps the
  // fragment path within the inter-stage location budget and preserves the
  // scene-index vertex entry used by the GPU-driven lane.
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
#if STORAGE_BUFFER_AVAILABLE == false
  // GLES 3.0 has textureSize but no textureQueryLevels. The backdrop owner
  // builds a complete chain whenever rough transmission needs mip sampling.
  let backdropSize = textureDimensions(transmissionBackdropTexture, 0);
  let backdropMaxLod = floor(log2(f32(max(backdropSize.x, backdropSize.y))));
#else
  let backdropMipCount = textureNumLevels(transmissionBackdropTexture);
  let backdropMaxLod = max(f32(backdropMipCount) - 1.0, 0.0);
#endif
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
  let receiveShadows = standardReceivesShadows(in);
  var directRadiance = evaluateStandardDirect(standardPositionWS, standardFragmentNdc(in), standardViewZ(in), in.clip.xy,
    physicalNormal, v, diffuseAlbedo, transmissionAlbedo, metallic, a, f0, directionalShadow,
    receiveShadows, standardLightingChannels(in),
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, viewLinearSampler,
#endif
  ).radiance;
  color += directRadiance;
// CLUSTER_FORWARD_AVAILABLE
  // Emissive is part of the lower-energy stack and is attenuated by the
  // topcoat just like diffuse/specular radiance.
  color = color + surface.emissive;
#ifdef SHEEN_AVAILABLE
  let sheen = evaluateStandardSheen(physicalUvs, finiteScalar(material.sheenRoughness, 0.0));
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
    lightingChannelsMatch(view.lightingChannels, standardLightingChannels(in)));
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
  reflectionFallback = reflectionFallback + clearcoatEnvironment * clearcoatFactor;
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
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
  lit.fragmentOutput = material.fragmentOutput;
#endif
  lit.color = materialOutputColor(color, alpha, standardAlphaMode());
  lit.alpha = alpha;
#ifdef TRANSMISSION_AVAILABLE
  lit.transmittedContribution = transmittedContribution;
  lit.transmittedCoefficient = transmittedCoefficient;
#endif
#ifdef REFLECTION_FALLBACK_AVAILABLE
  lit.reflectionFallback = vec4<f32>(reflectionFallback, standardSsrCoverage());
  lit.reflectionResponse = vec4<f32>(reflectionResponse, environment.response.a);
  lit.reflectionSurface = vec4<f32>(physicalNormal, iblRoughness);
#endif
  return lit;
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let facing = standardCappedFacing(frontFacing);
  let prepared = prepareStandardForwardSurface(capped, facing, false, array<vec4<f32>, 3>());
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
  let lit = standardForwardRawLitSurface(capped, facing, false, prepared);
  let waterEntryOutput = standardForwardFogged(in, lit);
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return waterEntryOutput;
}

// The base View is fog-free on the screen-fog route. An admitted Forward
// vertex-height view applies its interpolated T before color blending instead.
fn readStandardForwardAo() -> f32 {
#ifdef CLUSTER_FORWARD_AVAILABLE
  return sampleStandardAmbientOcclusion(standardPositionWS, view.worldViewProj, forwardScreenSurface, viewLinearSampler);
#else
  return 1.0;
#endif
}

fn standardForwardRawLitSurface(in : VsOut, frontFacing : bool, screenReceiver : bool,
    prepared : StandardForwardSurface) -> StandardForwardLit {
  let normal = standardForwardPhysicalNormal(in, prepared.surface.normalWS);
  let visibility = standardRawDirectionalVisibility(in, frontFacing, screenReceiver, prepared, normal);
  return standardForwardLitSurface(in, frontFacing, prepared, normal, visibility, readStandardForwardAo());
}

@fragment
fn fs_opaque(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let facing = standardCappedFacing(frontFacing);
  let prepared = prepareStandardForwardSurface(capped, facing, false, array<vec4<f32>, 3>());
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
  let lit = standardForwardRawLitSurface(capped, facing, false, prepared);
#ifdef TRANSMISSION_AVAILABLE
  let waterEntryOutput = standardForwardFogged(in, lit);
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return waterEntryOutput;
#else
  if view.fogSky.y > 0.5 {
    return standardForwardOutput(lit, forward_vertex_fog(view, standardVertexFog(in), lit.color, lit.alpha));
  }
  return standardForwardOutput(lit, lit.color);
#endif
}

// Only the opaque pass selects the screen-surface entry; transparency keeps its own inputs.
@fragment
fn fs_forward_screen(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let facing = standardCappedFacing(frontFacing);
  let prepared = prepareStandardForwardSurface(capped, facing, true, readStandardForwardDecals());
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
  let lit = standardForwardRawLitSurface(capped, facing, true, prepared);
#ifdef TRANSMISSION_AVAILABLE
  let waterEntryOutput = standardForwardFogged(in, lit);
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return waterEntryOutput;
#else
  if view.fogSky.y > 0.5 {
    return standardForwardOutput(lit, forward_vertex_fog(view, standardVertexFog(in), lit.color, lit.alpha));
  }
  return standardForwardOutput(lit, lit.color);
#endif
}

#ifdef CLUSTER_FORWARD_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
#ifndef TRANSMISSION_AVAILABLE
@fragment
fn fs_forward_sun_shadow(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let facing = standardCappedFacing(frontFacing);
  let prepared = prepareStandardForwardSurface(capped, facing, false, array<vec4<f32>, 3>());
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
  return standardForwardProjectedShadow(in, capped, facing, prepared);
}

fn standardForwardProjectedShadow(in : VsOut, capped : VsOut, facing : bool,
    prepared : StandardForwardSurface) -> StandardPbrOutput {
  let normal = standardForwardPhysicalNormal(capped, prepared.surface.normalWS);
  var visibility = 1.0;
  let screenVisibility = textureLoad(forwardScreenSurface, vec2<i32>(in.clip.xy), 0);
#ifdef FORWARD_SCREEN_SHADOW_RECEIVER
  let screenAo = select(1.0, screenVisibility.a, get_ssao_intensity() > 0.0);
#else
  let screenAo = 1.0;
#endif
  if (standardReceivesShadows(capped)) {
    visibility = select(1.0, screenVisibility.r, view.temporalProjection.w > 0.5);
#ifdef FORWARD_SCREEN_SHADOW_RECEIVER
    forwardShadowVisibility = screenVisibility;
#endif
  }
  let lit = standardForwardLitSurface(capped, facing, prepared, normal, visibility, screenAo);
  if view.fogSky.y > 0.5 {
    return standardForwardOutput(lit, forward_vertex_fog(view, standardVertexFog(in), lit.color, lit.alpha));
  }
  return standardForwardOutput(lit, lit.color);
}

#endif
#endif
#endif

// Weighted blended OIT accumulation for straight-alpha blend states.
@fragment
fn fs_oit(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let facing = standardCappedFacing(frontFacing);
  let prepared = prepareStandardForwardSurface(capped, facing, false, array<vec4<f32>, 3>());
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
  let lit = standardForwardRawLitSurface(capped, facing, false, prepared);
  let color = standardForwardFogged(in, lit).color;
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return oitAccumulate(color.rgb * color.a, color.a, distance(standardPositionWS, view.cameraPos));
}

// Weighted blended OIT accumulation for premultiplied blend states.
@fragment
fn fs_oit_premultiplied(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let facing = standardCappedFacing(frontFacing);
  let prepared = prepareStandardForwardSurface(capped, facing, false, array<vec4<f32>, 3>());
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
  let lit = standardForwardRawLitSurface(capped, facing, false, prepared);
  let color = standardForwardFogged(in, lit).color;
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return oitAccumulate(color.rgb, color.a, distance(standardPositionWS, view.cameraPos));
}

#ifndef DIRECTIONAL_SHADOW_SIMPLE
@fragment
fn fs_gbuffer(in : VsOut, @builtin(front_facing) frontFacing : bool
#ifdef VISIBLE_SURFACE_AVAILABLE
  , @builtin(primitive_index) primitiveIndex : u32
#endif
) -> GBufferOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let waterEntryOutput = standardGBuffer(capped, standardCappedFacing(frontFacing), false
#ifdef VISIBLE_SURFACE_AVAILABLE
    , primitiveIndex
#endif
  );
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return waterEntryOutput.full;
}

@fragment
fn fs_gbuffer_compact(in : VsOut, @builtin(front_facing) frontFacing : bool
#ifdef VISIBLE_SURFACE_AVAILABLE
  , @builtin(primitive_index) primitiveIndex : u32
#endif
) -> CompactGBufferOutput {
  standardPositionWS = standardFragmentPosition(in);
  let capped = standardCappedInput(standardParallaxInput(in), frontFacing);
  let output = standardGBuffer(capped, standardCappedFacing(frontFacing), true
#ifdef VISIBLE_SURFACE_AVAILABLE
    , primitiveIndex
#endif
  );
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
  return output.compact;
}

fn standardGBuffer(in : VsOut, frontFacing : bool, compact : bool
#ifdef VISIBLE_SURFACE_AVAILABLE
  , primitiveIndex : u32
#endif
) -> StandardGBufferPassOutput {
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  var rawGeometry = surfaceGeometryNormal(dpdx(standardPositionWS), dpdy(standardPositionWS), vec3<f32>(0.0));
#if TERRAIN_GEOMETRY_AVAILABLE == true
  rawGeometry = terrainGeometryNormal(rawGeometry, frontFacing);
#endif
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
  var directionalLayerBase = 0u;
#if TERRAIN_GEOMETRY_AVAILABLE == true
  directionalLayerBase = terrainShadowLayerBase(rawGeometry, frontFacing, view.lightDir,
    material.terrainShadowFamily, view.cascadeCount, view.directionalShadowFilter.x);
#endif
  var output : StandardGBufferPassOutput;
#ifdef VISIBLE_SURFACE_AVAILABLE
#if WATER_WAVES_AVAILABLE == true
  let visibleSurface = in.surfaceData.x;
#else
  let visibleSurface = in.surfaceData.z;
#endif
  let valid = visibleSurface != 0u && dot(rawGeometry, rawGeometry) > 0.0;
  let identity = vec4<u32>(visibleSurface, primitiveIndex,
    encodeStandardNormalRoughness(geometricNormal, 0.0), select(0u, select(1u, 3u, frontFacing), valid));
#endif
  if (compact) {
    var customData = 0u;
#ifdef SUBSURFACE_DIFFUSION_AVAILABLE
    customData = compactSubsurfaceCustomData(subsurface, view.subsurfaceProfiles);
#endif
    output.compact = encodeCompactStandardGBuffer(surface.normalWS, roughness, surface.baseColor,
      metallic, specular.x, surface.occlusion, surface.emissive, opacity,
      vec4<u32>(standardLightingChannels(in), encodeStandardReceiverContext(
        u32(skylight.diffuseScale.w), probeRow, standardReceivesShadows(in)),
        encodeStandardReceiverNormal(receiverNormal) | 0x00800000u | (directionalLayerBase << 24u), 0u), customData, standardGBufferObjectFlags(in), hasDiffuseTransmission);
#ifdef VISIBLE_SURFACE_AVAILABLE
    output.compact.visible_surface = identity;
#endif
    return output;
  }
  output.full = encodeStandardGBuffer(surface.normalWS, receiverNormal, roughness,
      surface.baseColor, metallic, specular,
      surface.occlusion, surface.emissive, opacity, u32(skylight.diffuseScale.w), probeRow,
      standardReceivesShadows(in), standardLightingChannels(in), subsurface,
      useDirectDfgLut, hasDiffuseTransmission);
  output.full.receiver_geometry.x |= directionalLayerBase << 24u;
#if WATER_WAVES_AVAILABLE == true
  let temporal = unpackSceneTemporalV1(vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(in.surfaceData.y)));
#else
  let temporal = unpackSceneTemporalV1(vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(in.surfaceData.x)));
#endif
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
#ifdef VISIBLE_SURFACE_AVAILABLE
  output.full.visible_surface = identity;
#endif
  return output;
}
#endif

// Colorless prepass for draws that can discard: only the coverage gate runs.
// The opacity chain does not read the geometric normal, so the interpolated
// normal stands in and nothing else of the Surface stays live.
@fragment
fn fs_depth_masked(in : VsOut, @builtin(front_facing) frontFacing : bool) {
  standardPositionWS = standardFragmentPosition(in);
  let geometricNormal = in.worldNormal.xyz * select(-1.0, 1.0, frontFacing);
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  let input = standardSurfaceInput(in, frontFacing, geometricNormal);
  alphaTestSurface(evaluateStandardCoverageOnly(input, material));
#else
  alphaTestSurface(evaluateStandardSurface(in, frontFacing, geometricNormal));
#endif
#if WATER_WAVES_AVAILABLE == true
  if (!standardWaterCovered) { discard; }
#endif
}

struct TemporalVsOut {
#ifndef ALPHA_HASH_DISABLED
  @location(10) positionOS : vec3<f32>,
#endif
  @location(11) clippingPositionWS : vec3<f32>,
#ifdef STANDARD_BINARY_COVERAGE
#if LOD_DITHER == true
  @location(12) @interpolate(flat) lodCoverage : f32,
#endif
#else
  @location(12) @interpolate(flat) temporal : vec3<f32>,
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  @location(13) @interpolate(flat) materialIndex : u32,
#endif
  @builtin(position) @invariant clip : vec4<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(0) uv : vec2<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(1) uv1 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(2) uv2 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(3) uv3 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(4) uv4 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(5) uv5 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(6) uv6 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
#ifndef STANDARD_SINGLE_UV_SET
  @location(7) uv7 : vec2<f32>,
#endif
#endif
#ifndef STANDARD_BINARY_COVERAGE
  @location(8) @interpolate(perspective) currentClip : vec4<f32>,
  @location(9) @interpolate(perspective) previousClip : vec4<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
#if WATER_WAVES_AVAILABLE == false
  @location(14) color : vec4<f32>,
#endif
#endif
#if WATER_WAVES_AVAILABLE == true
  @location(14) waterCoverageXZ : vec3<f32>,
  @location(15) @interpolate(flat) waterMeshInstanceIndex : u32,
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
  var localPosition = standardVertexPosition(in);
  var temporalWaterCoverageXZ = vec2<f32>(0.0);
  var temporalWaterMeshInstanceIndex = 0u;
  var temporalWaterFar = false;
  var temporalWaterWaveRelativeXZ = vec2<f32>(0.0);
  var temporalWaterMask = 1.0;
#if WATER_WAVES_AVAILABLE == true
  let waterMeshVertex = waterMeshTileVertex(localPosition, idx);
  localPosition = waterMeshVertex.position;
  temporalWaterCoverageXZ = waterMeshVertex.coverageXZ;
  temporalWaterMeshInstanceIndex = idx;
  temporalWaterFar = waterMeshVertex.far;
  temporalWaterWaveRelativeXZ = waterMeshVertex.waveRelativeXZ;
  let temporalWaterWaveBodyIndex = waterMeshVertex.waveBodyIndex;
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#ifdef STANDARD_BINARY_COVERAGE
  let temporalLocalToWorld = sceneIndexCurrentWorld(visible.x) * SCENE_INDEX_LOCAL_IDENTITY;
#else
  let draw = sceneIndexDraw(visible.x);
  let temporalLocalToWorld = draw.world * SCENE_INDEX_LOCAL_IDENTITY;
#endif
  var currentWorld = temporalLocalToWorld * vec4<f32>(localPosition, 1.0);
#ifndef STANDARD_BINARY_COVERAGE
  var previousWorld =
    draw.previousWorld * SCENE_INDEX_LOCAL_IDENTITY * vec4<f32>(localPosition, 1.0);
#endif
  var out : TemporalVsOut;
#ifdef STANDARD_BINARY_COVERAGE
#if LOD_DITHER == true
  out.lodCoverage = bitcast<f32>(visible.w);
#endif
#else
  out.temporal = vec3<f32>(draw.temporal, bitcast<f32>(visible.w));
#endif
#else
  var temporalTransformIndex = idx;
#if WATER_WAVES_AVAILABLE == true
  temporalTransformIndex = waterMeshInstanceTransformIndex(idx);
#endif
  let temporalLocalToWorld = meshes[0u].worldFromLocal * instances[temporalTransformIndex].localFromInstance;
  var currentWorld = temporalLocalToWorld * vec4<f32>(localPosition, 1.0);
#ifndef STANDARD_BINARY_COVERAGE
  var previousWorld = currentWorld;
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0u].previousWorldFromLocal *
    instances[temporalTransformIndex].previousLocalFromInstance * vec4<f32>(localPosition, 1.0);
#endif
#endif
  var out : TemporalVsOut;
#ifdef STANDARD_BINARY_COVERAGE
#if LOD_DITHER == true
#if STORAGE_BUFFER_AVAILABLE == true
  out.lodCoverage = meshes[0u].temporal.z;
#endif
#endif
#else
#if STORAGE_BUFFER_AVAILABLE == true
  out.temporal = meshes[0u].temporal.xyz;
#else
  out.temporal = vec3<f32>(0.0, 1.0, 0.0);
#endif
#endif
#endif
#if WATER_WAVES_AVAILABLE == true
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
  var waterVertexColor = vec4<f32>(1.0);
#ifdef VERTEX_COLOR_AVAILABLE
  waterVertexColor = in.color;
#endif
  let waterVertexFlow = waterVertexFlowMPerSec(waterVertexFlowXZ(waterVertexColor, temporalLocalToWorld));
#ifdef STANDARD_BINARY_COVERAGE
  // Authored Water deformation may derive coverage from its previous pose.
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  let previousWorld = sceneIndexDraw(visible.x).previousWorld *
    SCENE_INDEX_LOCAL_IDENTITY * vec4<f32>(localPosition, 1.0);
#else
  let previousWorld = meshes[0u].previousWorldFromLocal *
    instances[temporalTransformIndex].previousLocalFromInstance * vec4<f32>(localPosition, 1.0);
#endif
#endif
  let deformationInput = waterDeformationInput(waterMeshVertex.bodyIndex, temporalWaterWaveBodyIndex, currentWorld.xyz, previousWorld.xyz,
    vec3<f32>(0.0, 1.0, 0.0), view.cameraPos, temporalWaterWaveRelativeXZ, select(0u, 1u, temporalWaterFar), waterVertexFlow);
  let deformation = waterMeshFarContinuity(deformationInput, deform_water_vertex(deformationInput), temporalWaterMeshInstanceIndex);
  currentWorld = vec4<f32>(deformation.currentPositionM, 1.0);
#ifndef STANDARD_BINARY_COVERAGE
  previousWorld = vec4<f32>(deformation.previousPositionM, 1.0);
#endif
  temporalWaterMask = deformation.waterMask;
#endif
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialIndex = visible.y;
#endif
#if WATER_WAVES_AVAILABLE == true
  out.waterCoverageXZ = vec3<f32>(temporalWaterCoverageXZ, temporalWaterMask);
  out.waterMeshInstanceIndex = temporalWaterMeshInstanceIndex;
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
#if TERRAIN_GEOMETRY_AVAILABLE == true
  out.uv = (localPosition.xz - material.terrainSection.xy) / material.terrainSection.z;
#else
  out.uv = in.uv;
#endif
#ifndef STANDARD_SINGLE_UV_SET
  out.uv1 = in.uv1;
  out.uv2 = in.uv2;
  out.uv3 = in.uv3;
  out.uv4 = in.uv4;
  out.uv5 = in.uv5;
  out.uv6 = in.uv6;
  out.uv7 = in.uv7;
#endif
#endif
#ifdef VERTEX_COLOR_AVAILABLE
#if WATER_WAVES_AVAILABLE == false
  out.color = in.color;
#endif
#endif
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
#if VERTEX_COLOR_AVAILABLE == true
#if WATER_WAVES_AVAILABLE == false
  return in.color.a;
#else
  return 1.0;
#endif
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

#if WATER_WAVES_AVAILABLE == true
fn waterTemporalRejected(in : TemporalVsOut) -> bool {
  return in.waterCoverageXZ.z <= 0.0
    || !waterMeshCoverageContains(in.waterMeshInstanceIndex, in.waterCoverageXZ.xy)
    || !waterDynamicBoundsContains(waterMeshSourceBodyIndex(in.waterMeshInstanceIndex), in.clippingPositionWS);
}
#endif

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

#if LOD_DITHER == true
#ifdef STANDARD_BINARY_COVERAGE
  applyLodCoverage(in.clip.xy, in.lodCoverage);
#else
  applyLodCoverage(in.clip.xy, in.temporal.z);
#endif
#endif
#ifndef STANDARD_BINARY_COVERAGE
  // A changing LOD silhouette must reject stale temporal history.
  let reactive = max(in.temporal.x, select(0.0, 1.0, in.temporal.z != 0.0));
  let motionValid = meshMotionValid(in.temporal.y);
#endif

  var coverageInput = SurfaceInput();
  coverageInput.vertexColor.a = temporalVertexAlpha(in);
#ifndef STANDARD_UV_INPUT_UNUSED
  coverageInput.uv0 = in.uv;
#ifdef STANDARD_SINGLE_UV_SET
  coverageInput.uv1 = in.uv;
  coverageInput.uv2 = in.uv;
  coverageInput.uv3 = in.uv;
  coverageInput.uv4 = in.uv;
  coverageInput.uv5 = in.uv;
  coverageInput.uv6 = in.uv;
  coverageInput.uv7 = in.uv;
#else
  coverageInput.uv1 = in.uv1;
  coverageInput.uv2 = in.uv2;
  coverageInput.uv3 = in.uv3;
  coverageInput.uv4 = in.uv4;
  coverageInput.uv5 = in.uv5;
  coverageInput.uv6 = in.uv6;
  coverageInput.uv7 = in.uv7;
#endif
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
#if WATER_WAVES_AVAILABLE == true
  if (waterTemporalRejected(in)) { discard; }
#endif
  materialCoverage(in);
  return vec4<f32>(1.0);
}
#else
@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
#if WATER_WAVES_AVAILABLE == true
  if (waterTemporalRejected(in)) { discard; }
#endif
  return materialTemporal(in);
}

@fragment
fn fs_temporal_depth(in : TemporalVsOut) -> @location(0) vec4<f32> {
#if WATER_WAVES_AVAILABLE == true
  if (waterTemporalRejected(in)) { discard; }
#endif
  return materialTemporal(in);
}

@fragment
fn fs_scene_velocity(in : TemporalVsOut) -> @location(0) vec2<u32> {
#if WATER_WAVES_AVAILABLE == true
  if (waterTemporalRejected(in)) { discard; }
#endif
  return encodeSceneVelocityRaster(materialTemporal(in), in.previousClip);
}
#endif
