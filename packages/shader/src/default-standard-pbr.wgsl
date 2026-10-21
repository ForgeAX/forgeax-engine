#ifdef VISIBLE_SURFACE_AVAILABLE
enable primitive_index;
#endif
#define_import_path forgeax_material::standard
#import forgeax_material::alpha_hash::{materialOutputAlpha, materialOutputColor}
#ifdef MATERIAL_FRAGMENT_OUTPUT_AVAILABLE
#import forgeax_material::fragment_output::{applyFragmentOutput}
#endif
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
#import forgeax_material::texture_coordinates::{materialUvLinear}
#endif
#if TERRAIN_GEOMETRY_AVAILABLE == true
#import forgeax_material::terrain_vertex::{terrainVertex, terrainNormal, terrainGeometryNormal, terrainShadowLayerBase}
#endif
#pragma material_slot surface
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
#import forgeax_material::displacement::{displaceVertex, displacedNormal}
#endif
#import forgeax_clipping::planes::{applyViewClipping, applyLocalClipping}
#import forgeax_material::oit::{OitOutput, oitAccumulate}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardEnvironment, evaluateStandardDirect}
#import forgeax_pbr::gbuffer_output::{GBufferOutput, encodeStandardGBuffer}
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness}

#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData, surfaceGeometryNormal}
#import forgeax_view::common::{viewDirectionToCamera, lightingChannelsMatch, applyLodCoverage, meshMotionValid, View, Mesh, InstanceData, view, shadowMap, shadowSampler, sampleMaterialTexture, transformNormal}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, SCENE_INDEX_LOCAL_IDENTITY}
#else
#import forgeax_view::common::{meshes, instances, meshReceivesShadows}
#endif
#import forgeax_scene_temporal::{sceneViewZ, packSceneTemporalV1WithValidity, unpackSceneTemporalV1}
#ifdef TRANSMISSION_AVAILABLE
#import forgeax_view::fog::{translucent_fog_transmission}
#else
#import forgeax_view::fog::{translucent_fog}
#endif
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{spotModifierSampler, iesProfileTexture, cookieTexture, cookieMatrices}
#endif
#ifdef PROJECTOR_AVAILABLE
#ifndef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{projectorTexture, projectorSampler}
#endif
#endif
#import forgeax_pbr::temporal::{projectPbrSceneTemporal, resolvePbrTemporalReactive}
#import forgeax_pbr::brdf::{standardOpaqueF0FromDielectric, standardDielectricF0, f_schlick, v_smith, d_ggx}
#import forgeax_pbr::specular_aa::{geometricNormalSpread, specularAntiAliasedRoughness}
#import forgeax_pbr::ibl_sampling::{box_project, decodeSpecularEnvironmentScale, sampleIblSpecular, sampleReflectionProbeSpecular, projectSpecularRadiance}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal, applyTBN}
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
#import forgeax_standard::cluster::{evaluateStandardClusterLights, sampleStandardAmbientOcclusion}
#endif

#pragma variant_axis STORAGE_BUFFER_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis VERTEX_COLOR_AVAILABLE
#pragma variant_axis PROBE_BLEND_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis TRANSMISSION_AVAILABLE
#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE
#pragma variant_axis GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#pragma variant_axis REFLECTION_FALLBACK_AVAILABLE
#pragma variant_axis COVERAGE_ONLY
#pragma variant_axis VISIBLE_SURFACE_AVAILABLE


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
//   @group(1) @binding(1) baseColorTexture_sampler           sampler
//   @group(1) @binding(2) baseColorTexture           texture_2d<f32>
//   @group(1) @binding(3) metallicRoughnessTexture_sampler   sampler
//   @group(1) @binding(4) metallicRoughnessTexture   texture_2d<f32>
//   @group(1) @binding(5) normalTexture_sampler              sampler
//   @group(1) @binding(6) normalTexture              texture_2d<f32>
//   @group(1) @binding(9..15) Skylight (irradiance / prefilter / brdfLut +
//                              samplers) + skylight uniform (intensity)
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

// The MaterialParameters struct and its binding-0 declaration are generated
// from the root ParamSchema during composition. Keeping the ABI out of this
// template prevents a second handwritten interface from drifting from the
// runtime UBO writer.
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
@group(1) @binding(1) var baseColorTexture_sampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
#endif
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
@group(1) @binding(3) var metallicRoughnessTexture_sampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
#endif
// The compiler remaps these named declarations from the material schema.
#ifdef METALLIC_TEXTURE_AVAILABLE
@group(1) @binding(50) var metallicTexture_sampler : sampler;
@group(1) @binding(51) var metallicTexture : texture_2d<f32>;
#endif
#ifdef ROUGHNESS_TEXTURE_AVAILABLE
@group(1) @binding(52) var roughnessTexture_sampler : sampler;
@group(1) @binding(53) var roughnessTexture : texture_2d<f32>;
#endif
#ifdef ALPHA_TEXTURE_AVAILABLE
@group(1) @binding(54) var alphaTexture_sampler : sampler;
@group(1) @binding(55) var alphaTexture : texture_2d<f32>;
#endif
#ifdef NORMAL_TEXTURE_AVAILABLE
@group(1) @binding(5) var normalTexture_sampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;
#endif
#ifdef BUMP_TEXTURE_AVAILABLE
@group(1) @binding(17) var bumpTexture_sampler : sampler;
@group(1) @binding(18) var bumpTexture : texture_2d<f32>;
#endif
#ifdef EMISSIVE_TEXTURE_AVAILABLE
@group(1) @binding(9) var emissiveTexture_sampler : sampler;
@group(1) @binding(10) var emissiveTexture : texture_2d<f32>;
#endif
#ifdef OCCLUSION_TEXTURE_AVAILABLE
@group(1) @binding(11) var occlusionTexture_sampler : sampler;
@group(1) @binding(12) var occlusionTexture : texture_2d<f32>;
#endif
#ifdef TRANSMISSION_AVAILABLE
#ifdef TRANSMISSION_TEXTURE_AVAILABLE
@group(1) @binding(13) var transmissionSampler : sampler;
@group(1) @binding(14) var transmissionTexture : texture_2d<f32>;
#endif
#ifdef THICKNESS_TEXTURE_AVAILABLE
@group(1) @binding(15) var thicknessSampler : sampler;
@group(1) @binding(16) var thicknessTexture : texture_2d<f32>;
#endif
@group(1) @binding(24) var transmissionBackdropTexture : texture_2d<f32>;
#endif
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
@group(1) @binding(26) var clearcoatSampler : sampler;
@group(1) @binding(27) var clearcoatTexture : texture_2d<f32>;
#endif
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
@group(1) @binding(28) var clearcoatRoughnessSampler : sampler;
@group(1) @binding(29) var clearcoatRoughnessTexture : texture_2d<f32>;
#endif
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
@group(1) @binding(30) var clearcoatNormalSampler : sampler;
@group(1) @binding(31) var clearcoatNormalTexture : texture_2d<f32>;
#endif
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
@group(1) @binding(32) var anisotropySampler : sampler;
@group(1) @binding(33) var anisotropyTexture : texture_2d<f32>;
#endif
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
@group(1) @binding(34) var sheenColorSampler : sampler;
@group(1) @binding(35) var sheenColorTexture : texture_2d<f32>;
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
@group(1) @binding(36) var sheenRoughnessSampler : sampler;
@group(1) @binding(37) var sheenRoughnessTexture : texture_2d<f32>;
#endif
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
@group(1) @binding(38) var iridescenceSampler : sampler;
@group(1) @binding(39) var iridescenceTexture : texture_2d<f32>;
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
@group(1) @binding(40) var iridescenceThicknessSampler : sampler;
@group(1) @binding(41) var iridescenceThicknessTexture : texture_2d<f32>;
#endif
#ifdef SPECULAR_TEXTURE_AVAILABLE
@group(1) @binding(42) var specularTextureSampler : sampler;
@group(1) @binding(43) var specularTexture : texture_2d<f32>;
#endif
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
@group(1) @binding(44) var specularColorTextureSampler : sampler;
@group(1) @binding(45) var specularColorTexture : texture_2d<f32>;
#endif
#ifdef DIFFUSE_TRANSMISSION_TEXTURE_AVAILABLE
@group(1) @binding(68) var diffuseTransmissionSampler : sampler;
@group(1) @binding(69) var diffuseTransmissionTexture : texture_2d<f32>;
#endif
#ifdef DIFFUSE_TRANSMISSION_COLOR_TEXTURE_AVAILABLE
@group(1) @binding(70) var diffuseTransmissionColorSampler : sampler;
@group(1) @binding(71) var diffuseTransmissionColorTexture : texture_2d<f32>;
#endif

// Naga reflection does not retain filtering usage through the generic shared
// helper. These compile-time-only witnesses retain the binding contract while
// every runtime material sample still goes through sampleMaterialTexture.
fn materialTextureFilteringWitness() {
#ifdef DIRECT_DFG_LUT_AVAILABLE
  let directDfgWitness = textureSample(directDfgLut, irradianceSampler, vec2<f32>(0.0));
  // The same filtering sampler also serves these shared IBL textures.
  let irradianceWitness = textureSample(irradianceMap, irradianceSampler, vec3<f32>(0.0, 0.0, 1.0));
  let brdfWitness = textureSample(brdfLut, irradianceSampler, vec2<f32>(0.0));
#endif
#ifdef BUMP_TEXTURE_AVAILABLE
  let bumpWitness = textureSample(bumpTexture, bumpTexture_sampler, vec2<f32>(0.0));
#endif

#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  let base = baseColorTexture;
#endif
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
  let metallicRoughness = metallicRoughnessTexture;
#endif
#ifdef NORMAL_TEXTURE_AVAILABLE
  let normal = normalTexture;
#endif
#ifdef EMISSIVE_TEXTURE_AVAILABLE
  let emissive = emissiveTexture;
#endif
#ifdef OCCLUSION_TEXTURE_AVAILABLE
  let occlusion = occlusionTexture;
#endif
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  let clearcoat = clearcoatTexture;
#endif
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  let clearcoatRoughness = clearcoatRoughnessTexture;
#endif
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
  let clearcoatNormal = clearcoatNormalTexture;
#endif
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
  let baseWitness = textureSample(base, baseColorTexture_sampler, vec2<f32>(0.0));
#endif
#ifdef METALLIC_ROUGHNESS_TEXTURE_AVAILABLE
  let metallicRoughnessWitness = textureSample(metallicRoughness, metallicRoughnessTexture_sampler, vec2<f32>(0.0));
#endif
#ifdef NORMAL_TEXTURE_AVAILABLE
  let normalWitness = textureSample(normal, normalTexture_sampler, vec2<f32>(0.0));
#endif
#ifdef EMISSIVE_TEXTURE_AVAILABLE
  let emissiveWitness = textureSample(emissive, emissiveTexture_sampler, vec2<f32>(0.0));
#endif
#ifdef OCCLUSION_TEXTURE_AVAILABLE
  let occlusionWitness = textureSample(occlusion, occlusionTexture_sampler, vec2<f32>(0.0));
#endif
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  let clearcoatWitness = textureSample(clearcoat, clearcoatSampler, vec2<f32>(0.0));
#endif
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  let clearcoatRoughnessWitness = textureSample(clearcoatRoughness, clearcoatRoughnessSampler, vec2<f32>(0.0));
#endif
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
  let clearcoatNormalWitness = textureSample(clearcoatNormal, clearcoatNormalSampler, vec2<f32>(0.0));
#endif
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
  let anisotropyWitness = textureSample(anisotropyTexture, anisotropySampler, vec2<f32>(0.0));
#endif
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  let sheenColorWitness = textureSample(sheenColorTexture, sheenColorSampler, vec2<f32>(0.0));
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  let sheenRoughnessWitness = textureSample(sheenRoughnessTexture, sheenRoughnessSampler, vec2<f32>(0.0));
#endif
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
  let iridescenceWitness = textureSample(iridescenceTexture, iridescenceSampler, vec2<f32>(0.0));
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
  let iridescenceThicknessWitness = textureSample(iridescenceThicknessTexture, iridescenceThicknessSampler, vec2<f32>(0.0));
#endif
#ifdef SPECULAR_TEXTURE_AVAILABLE
  let specularWeightWitness = textureSample(specularTexture, specularTextureSampler, vec2<f32>(0.0));
#endif
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
  let specularColorWitness = textureSample(specularColorTexture, specularColorTextureSampler, vec2<f32>(0.0));
#endif
#ifdef DIFFUSE_TRANSMISSION_TEXTURE_AVAILABLE
  let diffuseTransmissionWitness = textureSample(diffuseTransmissionTexture, diffuseTransmissionSampler, vec2<f32>(0.0));
#endif
#ifdef DIFFUSE_TRANSMISSION_COLOR_TEXTURE_AVAILABLE
  let diffuseTransmissionColorWitness = textureSample(diffuseTransmissionColorTexture, diffuseTransmissionColorSampler, vec2<f32>(0.0));
#endif
#ifdef TRANSMISSION_AVAILABLE
#ifdef TRANSMISSION_TEXTURE_AVAILABLE
  let transmission = transmissionTexture;
#endif
#ifdef THICKNESS_TEXTURE_AVAILABLE
  let thickness = thicknessTexture;
#endif
#ifdef TRANSMISSION_TEXTURE_AVAILABLE
  let transmissionWitness = textureSample(transmission, transmissionSampler, vec2<f32>(0.0));
#endif
#ifdef THICKNESS_TEXTURE_AVAILABLE
  let thicknessWitness = textureSample(thickness, thicknessSampler, vec2<f32>(0.0));
#endif
#endif
}

// Skylight bindings merged into the PBR material BGL
// (feat-20260520-skylight-ibl-cubemap M3 / t48 round-4 amend per D-5
// round-4 REVISED). The round-2 stand-alone group 4 Skylight BGL collided
// with WebGPU's default maxBindGroups=4 in chrome-beta and blocked pbr-pl
// pipeline-layout creation; round-4 appends the 7 Skylight entries to the
// PBR material BindGroupLayout after the eight Standard texture pairs. The material BG factory
// (mergeSkylightIntoMaterialBgl in
// packages/runtime/src/ibl/skylight-bind-group.ts) extends the layout to
// merged entries; render-system-record assembles a single merged material
// BindGroup (no extra setBindGroup(4) call). Identity (default) resources
// produce ambient = 0; with a real Skylight, ibl_sampling helpers project
// the IBL irradiance + split-sum specular into `ambient` below.
@group(1) @binding(17) var irradianceMap        : texture_cube<f32>;
@group(1) @binding(18) var irradianceSampler    : sampler;
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(1) @binding(72) var directDfgLut: texture_2d<f32>;
#endif
@group(1) @binding(19) var prefilterMap         : texture_2d<f32>;
@group(1) @binding(20) var prefilterSampler     : sampler;
@group(1) @binding(21) var brdfLut              : texture_2d<f32>;
@group(1) @binding(22) var<uniform> skylight    : SkylightUniforms;
// Global specular remains resident when the per-draw prefilter slot holds a probe.
@group(1) @binding(47) var skylightPrefilterMap : texture_2d<f32>;

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

// feat-20260612-hdrp-ssao M7 (round 2) D-B + D-C, scope-amend-webgl2-ubo:
// SSAO sampling lives on the HDRP unified BGL @group(2) alongside the
// cluster bindings (binding 7 = ssao texture, binding 8 = sampler). The
// intensity scalar is folded into `cluster_uniform.near_far_log.w` (the
// previously-unused std140 pad lane on @binding(6)) — declaring a
// dedicated UBO at @binding(9) overflows WebGL2's
// `max_uniform_buffers_per_shader_stage = 11` budget on rhi-wgpu's
// fallback path. Disabled SSAO path binds 1x1 white at @binding(7) + the
// host writes intensity=0 into the cluster pad lane, so the synthesis
// collapses identically.
#ifdef CLUSTER_FORWARD_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(7) var ssaoBlurredTexture       : texture_2d<f32>;
@group(2) @binding(8) var ssaoBlurredSampler       : sampler;
#endif
#endif

#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
@group(1) @binding(56) var displacementTexture_sampler : sampler;
@group(1) @binding(57) var displacementTexture : texture_2d<f32>;
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
struct VsOut {
  @builtin(position) @invariant clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uvPair0 : vec4<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) worldTangent : vec4<f32>,
#endif
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  @location(7) viewZ : f32,
#else
  @location(7) positionOSAndViewZ : vec4<f32>,
#endif
  // Keep mesh and instance storage vertex-only: the flat object basis
  // (with ndc.w as its last element) serves transmission, triplanar object
  // projection and object-space normal maps.
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(4) @interpolate(flat) objectBasis0 : vec4<f32>,
#endif
  // Pair UV sets without changing their interpolation or material semantics.
  // Flat surface facts and the previous clip position share the freed slots
  // with physical variants that carry both transmission basis varyings.
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(5) uvPair1 : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(8) uvPair2 : vec4<f32>,
#endif
  // Preserve the integer surface row and the encoded temporal reactive lane
  // in one flat slot. Both are constant across each submitted triangle.
  @location(9) @interpolate(flat) surfaceData : vec3<u32>,
  @location(10) clipDelta : vec4<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(12) uvPair3 : vec4<f32>,
#endif
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
  @location(6) ndc : vec4<f32>,  // NDC for HDRP cluster lookup; .w = transmission basis tail
  // feat-20260609-hdrp-cluster-fragment-ggx M4.5-followup: view-space z is
  // needed by ndc_position_to_cluster (slice index uses log-z mapping that
  // takes negative view_z, NOT NDC z which is [0,1]). Earlier `in.ndc.z`
  // pass through view_z slot collapsed every fragment to slice 0, so cube
  // surfaces -- whose cluster cells were unrelated to the floor's slice 0
  // hot zone -- received zero light. Forward view_z explicitly. M5 / w19:
  // also feeds CSM cascade selection in evalDirectional.
  // Surface position and clustered/CSM view depth share one varying so the
  // composed Standard shader stays within WebGL2's 14 inter-stage locations.
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(13) @interpolate(flat) objectBasis1 : vec4<f32>,
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index variants carry the row selector in the storage-backed lane.
  // They never target the WebGL2 uniform-fallback limit, so location 15
  // stays outside its 14-location ABI.
  @location(15) @interpolate(flat) materialAddress : vec4<u32>,
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
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
  if (standardUsesDisplacementTexture()) {
    return displaceVertex(in.pos, in.normal, displacementTexture, displacementTexture_sampler,
      material.displacementScale, material.displacementBias,
      material.displacementTextureCoordinatesTransform, material.displacementTextureCoordinatesMetadata, material.displacementTextureCoordinatesRotation,
      array<vec2<f32>, 8>(in.uv, in.uv1, in.uv2, in.uv3, in.uv4, in.uv5, in.uv6, in.uv7));
  }
#endif
  return in.pos;
#endif
}

fn vs_main_impl(in : VsIn, localToWorld : mat4x4<f32>, previousLocalToWorld : mat4x4<f32>, materialAddress : vec4<u32>, temporal : vec3<f32>) -> VsOut {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
#ifndef STANDARD_VERTEX_MATERIAL_UNUSED
  material = selectedMaterial(materialAddress.x);
#endif
#endif
  let localPosition = standardVertexPosition(in);

  // Combine entity world with the per-instance local transform. Scene-index
  // draws pass the composed GPU Scene world and an identity local.
  let world = localToWorld * vec4<f32>(localPosition, 1.0);
  var out : VsOut;
  let previousWorld = previousLocalToWorld * vec4<f32>(localPosition, 1.0);
  let currentClip = view.temporalCurrentViewProj * world;
  let previousClip = view.temporalPreviousViewProj * previousWorld;
  // Equal poses produce exact zero before interpolation. Reprojecting two
  // separately rounded world/clip varyings would invent stationary motion.
  out.clipDelta = currentClip - previousClip;
  let reactive = max(temporal.x, select(0.0, 1.0, temporal.z != 0.0));
  let reactiveLane = packSceneTemporalV1WithValidity(currentClip,
    previousClip, view.temporalProjection, reactive, meshMotionValid(temporal.y)).w;
  out.surfaceData = vec3<u32>(0u, bitcast<u32>(reactiveLane), 0xffffffffu);
  out.clip = view.worldViewProj * world;
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  out.viewZ = sceneViewZ(out.clip, view.temporalProjection);
#else
  out.positionOSAndViewZ = vec4<f32>(localPosition, sceneViewZ(out.clip, view.temporalProjection));
#endif
  out.worldPos = world.xyz;
  #if TERRAIN_GEOMETRY_AVAILABLE == true
  let terrainN = terrainNormal(in.pos, terrainHeightTexture, material.terrainSection, material.terrainLod, material.terrainNeighbors);
  out.worldNormal = normalize(transformNormal(localToWorld, terrainN));
#else
  out.worldNormal = normalize(transformNormal(localToWorld, in.normal));
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
#if TERRAIN_GEOMETRY_AVAILABLE == true
  out.uvPair0 = vec4<f32>((localPosition.xz - material.terrainSection.xy) / material.terrainSection.z, in.uv1);
#else
  out.uvPair0 = vec4<f32>(in.uv, in.uv1);
#endif
  out.uvPair1 = vec4<f32>(in.uv2, in.uv3);
  out.uvPair2 = vec4<f32>(in.uv4, in.uv5);
  out.uvPair3 = vec4<f32>(in.uv6, in.uv7);
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
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialAddress = materialAddress;
#endif
  // feat-20260613-csm-cascaded-shadow-maps M5 / w19: the per-fragment
  // light-space position varying is gone; evalDirectional computes
  // per-cascade lightViewProj * worldPos in the fragment stage from
  // viewZ + worldPos.
  // NDC for HDRP cluster lookup (feat-20260609-hdrp-cluster-fragment-ggx M2 / w10).
  // Perspective divide on clip-space position; ndc.z retains depth-buffer value.
  let clipPos = out.clip;
  out.ndc = vec4(clipPos.xy / clipPos.w, clipPos.z / clipPos.w, localToWorld[2].z);
  // Keep the cluster depth exactly aligned with the CPU binner for both
  // perspective and off-axis orthographic projections.
  return out;
}

fn standardViewZ(in : VsOut) -> f32 {
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  return in.viewZ;
#else
  return in.positionOSAndViewZ.w;
#endif
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#ifdef VISIBLE_SURFACE_AVAILABLE
@group(3) @binding(7) var<storage, read> visibleSurfaceRows: array<u32>;
#endif
fn sceneIndexVertex(in : VsIn, idx : u32) -> VsOut {
  // Rigid visible = (scene instance row, material row, candidate row, signed LOD fade).
  let visible = visibleItems[idx];
  let draw = sceneIndexDraw(visible.x);
  var out = vs_main_impl(
    in,
    draw.world,
    draw.previousWorld,
    // Scene material rows never reach bit 31; it carries the receive opt-out.
    vec4<u32>(visible.y | select(STANDARD_NO_RECEIVE_BIT, 0u, draw.receivesShadows), draw.probe, visible.w),
    vec3<f32>(draw.temporal, bitcast<f32>(visible.w)),
  );
#ifdef VISIBLE_SURFACE_AVAILABLE
  out.surfaceData.x = visibleSurfaceRows[visible.z];
#endif
  out.surfaceData.z = draw.lightingChannels;
  return out;
}
#endif

// ShadowParticipation.receive: GPU-driven rows ride the flat material lane;
// per-entity draws read the dynamic-offset Mesh slot directly.
fn standardReceivesShadows(in : VsOut) -> bool {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  return (in.materialAddress.x & STANDARD_NO_RECEIVE_BIT) == 0u;
#else
#if STORAGE_BUFFER_AVAILABLE == true
  return meshReceivesShadows(meshes[0].temporal.y);
#else
  return true;
#endif
#endif
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  // This variant binds only the GPU Scene tables; every entry reads the
  // visible stream.
  return sceneIndexVertex(in, idx);
#else
  // The @group(2) dynamic-offset window is aimed at this entity's Mesh row;
  // @group(3) is the flat per-instance buffer indexed by instance_index.
  var localInstance = idx;
#ifdef VISIBLE_SURFACE_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  let address = meshes[0u].surface;
  localInstance = idx % max(address.y, 1u);
#endif
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
  );
  out.surfaceData.z = meshes[0u].surface.z;
#ifdef VISIBLE_SURFACE_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  out.surfaceData.x = select(0u, address.x + idx, address.x != 0u);
#endif
#endif
  return out;
#endif
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@vertex
fn vs_scene_index(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  return sceneIndexVertex(in, idx);
}
#endif

const STANDARD_NO_RECEIVE_BIT : u32 = 0x80000000u;

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn selectedMaterial(index : u32) -> MaterialParameters {
  return sceneMaterials[index & ~STANDARD_NO_RECEIVE_BIT];
}


#endif

#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
fn transformedMaterialUv(transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>, in : VsOut) -> vec2<f32> {
  var source = in.uvPair0.xy;
  if (metadata.x >= 1.0) { source = in.uvPair0.zw; }
  if (metadata.x >= 2.0) { source = in.uvPair1.xy; }
  if (metadata.x >= 3.0) { source = in.uvPair1.zw; }
  if (metadata.x >= 4.0) { source = in.uvPair2.xy; }
  if (metadata.x >= 5.0) { source = in.uvPair2.zw; }
  if (metadata.x >= 6.0) { source = in.uvPair3.xy; }
  if (metadata.x >= 7.0) { source = in.uvPair3.zw; }
  return materialUvLinear(source, transform, rotation) + transform.xy;
}
#endif

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
    vec3<f32>(in.objectBasis1.zw, in.ndc.w),
  );
#else
  return mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0));
#endif
}

// Pipeline-selected surface discard gates (bit 1: LOD crossfade coverage,
// bit 2: camera view clipping). A static discard defeats hidden-surface
// removal on tile GPUs even when it never fires, so GPU-driven raster clears a
// bit when its batch cannot fade or its view carries no clipping planes. The
// default keeps both discards for every other consumer of this template.
@id(64001) override standardSurfaceDiscards: u32 = 3u;

// Standard owns the lighting and pass policy; the selected Surface owns only
// the base facts exchanged through surface_v1.
fn evaluateStandardSurface(in : VsOut, frontFacing : bool, geometricNormal : vec3<f32>) -> SurfaceData {
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
  let triangleNormal = displacedNormal(in.worldPos, in.worldNormal);
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  if ((standardSurfaceDiscards & 1u) != 0u) {
    applyLodCoverage(in.clip.xy, bitcast<f32>(in.materialAddress.w));
  }
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index Surface helpers may close over the imported `material` symbol.
  // The compiler's scene variant maps that symbol to a private provider so
  // the whole helper call graph observes the selected row, not the direct
  // material uniform.
  material = selectedMaterial(in.materialAddress.x);
#endif

  if ((standardSurfaceDiscards & 2u) != 0u) {
    applyViewClipping(in.worldPos, false);
  }
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.worldPos, false, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif
#ifdef STANDARD_STOCK_SURFACE_AVAILABLE
  let viewDirectionWS = vec3<f32>(0.0);
#else
  let viewDirectionWS = viewDirectionToCamera(in.worldPos);
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  let surfaceTangent = in.worldTangent;
#else
  let surfaceTangent = vec4<f32>(0.0);
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  let surfaceUvs = array<vec2<f32>, 8>(in.uvPair0.xy, in.uvPair0.zw, in.uvPair1.xy, in.uvPair1.zw, in.uvPair2.xy, in.uvPair2.zw,
    in.uvPair3.xy, in.uvPair3.zw);
#else
  let surfaceUvs = array<vec2<f32>, 8>();
#endif
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  let positionOS = vec3<f32>(0.0);
#else
  let positionOS = in.positionOSAndViewZ.xyz;
#endif
  var vertexNormal = in.worldNormal;
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
  if (standardUsesDisplacementTexture() && (material.displacementScale != 0.0 || material.displacementBias != 0.0)) {
    vertexNormal = triangleNormal;
  }
#endif
  let input = SurfaceInput(
    positionOS, in.worldPos, geometricNormal, vertexNormal, surfaceTangent, viewDirectionWS,
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



fn finiteScalar(value : f32, fallback : f32) -> f32 {
  let bounded = clamp(value, -65504.0, 65504.0);
  return select(fallback, bounded, value == value);
}

fn finiteColor(value : vec3<f32>, fallback : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    finiteScalar(value.x, fallback.x),
    finiteScalar(value.y, fallback.y),
    finiteScalar(value.z, fallback.z),
  );
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

fn alphaTestSurface(surface : SurfaceData) {
  if (surface.alphaClipThreshold > 0.0 && surface.opacity <= surface.alphaClipThreshold) {
    discard;
  }
}

struct StandardPbrOutput {
  @location(0) color : vec4<f32>,
#ifdef REFLECTION_FALLBACK_AVAILABLE
  // Linear HDR environment contribution from this same Standard BRDF callsite.
  // The detached producer names this second target S_fallback.
  @location(1) reflectionFallback : vec4<f32>,
#endif
};

// Lit Standard surface before translucent fog. fs_main fogs it through the
// View slot it is bound to; fs_opaque serves draws bound to the unfogged slot
// (fogHeightOpacity.z == 0), where translucent fog is the identity unless the
// surface transmits, so the fog chain is compiled out of that entry.
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
#endif
  return output;
}

fn standardForwardFogged(in : VsOut, lit : StandardForwardLit) -> StandardPbrOutput {
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardOutput(lit, translucent_fog_transmission(view, in.worldPos, lit.color, lit.alpha, lit.transmittedContribution, lit.transmittedCoefficient));
#else
  return standardForwardOutput(lit, translucent_fog(view, in.worldPos, lit.color, lit.alpha));
#endif
}

fn standardSurfaceSpecular(in : VsOut, surface : SurfaceData, dielectricF0 : f32) -> vec4<f32> {
  let albedo = surface.baseColor;
  let metallic = clamp(finiteScalar(surface.metallic, 0.0), 0.0, 1.0);
  var specularColor = material.specularColor;
#ifdef SPECULAR_COLOR_TEXTURE_AVAILABLE
  if (standardUsesSpecularColorTexture()) {
  let specularUv = transformedMaterialUv(
    material.specularColorTextureCoordinatesTransform,
    material.specularColorTextureCoordinatesMetadata, material.specularColorTextureCoordinatesRotation,
    in,
  );
  specularColor = specularColor * sampleMaterialTexture(
    specularColorTexture,
    specularColorTextureSampler,
    specularUv,
    material.specularColorTextureCoordinatesMetadata.zw,
  ).rgb;
  }
#endif
  var specularWeight = clamp(finiteScalar(material.specular, 1.0), 0.0, 1.0);
#ifdef SPECULAR_TEXTURE_AVAILABLE
  if (standardUsesSpecularTexture()) {
  let specularWeightUv = transformedMaterialUv(
    material.specularTextureCoordinatesTransform,
    material.specularTextureCoordinatesMetadata, material.specularTextureCoordinatesRotation,
    in,
  );
  specularWeight = specularWeight * sampleMaterialTexture(
    specularTexture,
    specularTextureSampler,
    specularWeightUv,
    material.specularTextureCoordinatesMetadata.zw,
  ).a;
  }
#endif
  return vec4<f32>(min(vec3<f32>(dielectricF0) * specularColor, vec3<f32>(1.0)) * specularWeight, mix(specularWeight, 1.0, metallic));
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

// Forward shading shared by the sorted (fs_main, fs_opaque) and OIT (fs_oit*) entries.
fn standardForwardLit(in : VsOut, frontFacing : bool) -> StandardForwardLit {
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  var rawGeometry = surfaceGeometryNormal(dpdx(in.worldPos), dpdy(in.worldPos), vec3<f32>(0.0));
#if TERRAIN_GEOMETRY_AVAILABLE == true
  rawGeometry = terrainGeometryNormal(rawGeometry, frontFacing);
#endif
  let receiverNormal = select(in.worldNormal * select(-1.0, 1.0, frontFacing), rawGeometry,
    dot(rawGeometry, rawGeometry) > 0.0);
  let geometricNormal = receiverNormal * select(-1.0, 1.0, frontFacing);
  var normalSpread = geometricNormalSpread(in.worldNormal);
  let surface = evaluateStandardSurface(in, frontFacing, geometricNormal);
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

  let v = viewDirectionToCamera(in.worldPos);
  let safeIor = max(finiteScalar(material.ior, 1.5), 1.0);
  let dielectricF0 = standardDielectricF0(safeIor);
  let surfaceSpecular = standardSurfaceSpecular(in, surface, dielectricF0);
  var dielectricSpecular = surfaceSpecular;
  var metallicF0 = albedo;
  var f0 = mix(surfaceSpecular.rgb, albedo, metallic);
  var physicalNormal = n;
#ifdef ANISOTROPY_AVAILABLE
  var anisotropyStrength = finiteScalar(material.anisotropyStrength, 0.0);
  var anisotropyRotation = finiteScalar(material.anisotropyRotation, 0.0);
  var anisotropyDirection = vec2<f32>(1.0, 0.0);
#ifdef ANISOTROPY_TEXTURE_AVAILABLE
  if (standardUsesAnisotropyTexture()) {
  let anisotropyUv = transformedMaterialUv(
    material.anisotropyTextureCoordinatesTransform,
    material.anisotropyTextureCoordinatesMetadata, material.anisotropyTextureCoordinatesRotation,
    in,
  );
  let anisotropySample = sampleMaterialTexture(
    anisotropyTexture,
    anisotropySampler,
    anisotropyUv,
    material.anisotropyTextureCoordinatesMetadata.zw,
  );
  let encodedAnisotropyDirection = 2.0 * anisotropySample.rg - vec2<f32>(1.0, 1.0);
  if (dot(encodedAnisotropyDirection, encodedAnisotropyDirection) >= 1e-6) {
    anisotropyDirection = normalize(encodedAnisotropyDirection);
  }
  anisotropyStrength = anisotropyStrength * anisotropySample.b;
  }
#endif
  physicalNormal = evaluateAnisotropicNormal(
    n,
    in.worldTangent,
    anisotropyStrength,
    anisotropyRotation,
    anisotropyDirection,
  );
#endif
#ifdef IRIDESCENCE_AVAILABLE
  var iridescenceStrength = finiteScalar(material.iridescence, 0.0);
  var iridescenceThicknessFactor = 1.0;
#ifdef IRIDESCENCE_TEXTURE_AVAILABLE
  if (standardUsesIridescenceTexture()) {
  let iridescenceUv = transformedMaterialUv(
    material.iridescenceTextureCoordinatesTransform,
    material.iridescenceTextureCoordinatesMetadata, material.iridescenceTextureCoordinatesRotation,
    in,
  );
  let iridescenceSample = sampleMaterialTexture(
    iridescenceTexture,
    iridescenceSampler,
    iridescenceUv,
    material.iridescenceTextureCoordinatesMetadata.zw,
  );
  iridescenceStrength = iridescenceStrength * iridescenceSample.r;
  }
#endif
#ifdef IRIDESCENCE_THICKNESS_TEXTURE_AVAILABLE
  if (standardUsesIridescenceThicknessTexture()) {
  let iridescenceThicknessUv = transformedMaterialUv(
    material.iridescenceThicknessTextureCoordinatesTransform,
    material.iridescenceThicknessTextureCoordinatesMetadata, material.iridescenceThicknessTextureCoordinatesRotation,
    in,
  );
  let iridescenceThicknessSample = sampleMaterialTexture(
    iridescenceThicknessTexture,
    iridescenceThicknessSampler,
    iridescenceThicknessUv,
    material.iridescenceThicknessTextureCoordinatesMetadata.zw,
  );
  iridescenceThicknessFactor = clamp(iridescenceThicknessSample.g, 0.0, 1.0);
  }
#endif
  let filmThickness = mix(
    finiteScalar(material.iridescenceThicknessMinimum, 100.0),
    finiteScalar(material.iridescenceThicknessMaximum, 400.0),
    iridescenceThicknessFactor,
  );
  f0 = evaluateIridescenceFresnel(
    f0,
    iridescenceStrength,
    finiteScalar(material.iridescenceIor, 1.3),
    filmThickness,
  );
  dielectricSpecular = vec4<f32>(evaluateIridescenceFresnel(dielectricSpecular.rgb,
    iridescenceStrength, finiteScalar(material.iridescenceIor, 1.3), filmThickness), dielectricSpecular.a);
  metallicF0 = evaluateIridescenceFresnel(metallicF0,
    iridescenceStrength, finiteScalar(material.iridescenceIor, 1.3), filmThickness);
#endif
  var diffuseAlbedo = albedo;
#ifdef TRANSMISSION_AVAILABLE
  var transmissionSample = 1.0;
#ifdef TRANSMISSION_TEXTURE_AVAILABLE
  if (standardUsesTransmissionTexture()) {
  let transmissionUv = transformedMaterialUv(material.transmissionTextureCoordinatesTransform, material.transmissionTextureCoordinatesMetadata, material.transmissionTextureCoordinatesRotation, in);
  transmissionSample = sampleMaterialTexture(
    transmissionTexture,
    transmissionSampler,
    transmissionUv,
    material.transmissionTextureCoordinatesMetadata.zw,
  ).r;
  }
#endif
  var thicknessSample = 1.0;
#ifdef THICKNESS_TEXTURE_AVAILABLE
  if (standardUsesThicknessTexture()) {
  let thicknessUv = transformedMaterialUv(material.thicknessTextureCoordinatesTransform, material.thicknessTextureCoordinatesMetadata, material.thicknessTextureCoordinatesRotation, in);
  thicknessSample = sampleMaterialTexture(
    thicknessTexture,
    thicknessSampler,
    thicknessUv,
    material.thicknessTextureCoordinatesMetadata.zw,
  ).g;
  }
#endif
  let transmissionFactor = clamp(
    finiteScalar(material.transmission, 0.0) * finiteScalar(transmissionSample, 1.0),
    0.0,
    1.0,
  );
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
    transmissionFactor * (1.0 - metallic) * (1.0 - fresnel),
    refractedLengthSquared > 1e-6,
  );
  diffuseAlbedo = albedo * (1.0 - transmittedEnergy);
#endif
  // KHR_materials_diffuse_transmission: the dt fraction of the diffuse lobe
  // leaves through the opposite hemisphere. Specular transmission above
  // takes precedence, so only its remaining diffuse energy is split.
  var transmissionAlbedo = vec3<f32>(0.0);
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  var diffuseTransmissionSample = 1.0;
#ifdef DIFFUSE_TRANSMISSION_TEXTURE_AVAILABLE
  if (standardUsesDiffuseTransmissionTexture()) {
  let diffuseTransmissionUv = transformedMaterialUv(
    material.diffuseTransmissionTextureCoordinatesTransform,
    material.diffuseTransmissionTextureCoordinatesMetadata, material.diffuseTransmissionTextureCoordinatesRotation,
    in,
  );
  diffuseTransmissionSample = sampleMaterialTexture(
    diffuseTransmissionTexture,
    diffuseTransmissionSampler,
    diffuseTransmissionUv,
    material.diffuseTransmissionTextureCoordinatesMetadata.zw,
  ).a;
  }
#endif
  var diffuseTransmissionTint = finiteColor(material.diffuseTransmissionColor, vec3<f32>(1.0));
#ifdef DIFFUSE_TRANSMISSION_COLOR_TEXTURE_AVAILABLE
  if (standardUsesDiffuseTransmissionColorTexture()) {
  let diffuseTransmissionColorUv = transformedMaterialUv(
    material.diffuseTransmissionColorTextureCoordinatesTransform,
    material.diffuseTransmissionColorTextureCoordinatesMetadata, material.diffuseTransmissionColorTextureCoordinatesRotation,
    in,
  );
  diffuseTransmissionTint = diffuseTransmissionTint * sampleMaterialTexture(
    diffuseTransmissionColorTexture,
    diffuseTransmissionColorSampler,
    diffuseTransmissionColorUv,
    material.diffuseTransmissionColorTextureCoordinatesMetadata.zw,
  ).rgb;
  }
#endif
  let diffuseTransmissionFactor = clamp(
    finiteScalar(material.diffuseTransmission, 0.0) * finiteScalar(diffuseTransmissionSample, 1.0),
    0.0,
    1.0,
  );
  // The lobe evaluators do not apply (1 - metallic) to this albedo.
  transmissionAlbedo = diffuseTransmissionFactor * (1.0 - metallic) *
    clamp(diffuseTransmissionTint, vec3<f32>(0.0), vec3<f32>(1.0));
#ifdef TRANSMISSION_AVAILABLE
  transmissionAlbedo = transmissionAlbedo * (1.0 - transmittedEnergy);
#endif
  diffuseAlbedo = diffuseAlbedo * (1.0 - diffuseTransmissionFactor);
#endif
  // Shared base lighting is also consumed by the deferred resolve.
  var coatF = vec3<f32>(0.0);
#ifdef CLEARCOAT_AVAILABLE
  coatF = f_schlick(max(dot(physicalNormal, v), 0.0), vec3<f32>(0.04)) *
    clamp(finiteScalar(material.clearcoat, 0.0), 0.0, 1.0);
#endif
  var probeShPreblend : array<vec4<f32>, 9>;
  var probeLocalBlendFraction = 0.0;
#ifdef PROBE_BLEND_AVAILABLE
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
#endif
  let environment = evaluateStandardEnvironment(in.worldPos, physicalNormal, v,
    diffuseAlbedo, transmissionAlbedo, metallic, iblRoughness, f0, dielectricSpecular, metallicF0, skylight, irradianceMap, irradianceSampler,
    prefilterMap, prefilterSampler, brdfLut, skylightPrefilterMap,
    probeShPreblend, probeLocalBlendFraction);
  let ao = surface.occlusion;
  let specularEnvironmentScale = decodeSpecularEnvironmentScale(
    vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB), skylight.intensity);
  var ambient = (environment.diffuse + environment.specular) * (vec3<f32>(1.0) - coatF) * ao;
  var reflectionFallback = environment.specular * (vec3<f32>(1.0) - coatF) * ao;
#ifdef CLUSTER_FORWARD_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  let screenAo = sampleStandardAmbientOcclusion(in.worldPos, view.worldViewProj,
    ssaoBlurredTexture, ssaoBlurredSampler);
  ambient *= screenAo;
  reflectionFallback *= screenAo;
#endif
#endif
  var color = ambient;
#ifdef TRANSMISSION_AVAILABLE
  var transmittedContribution=vec3<f32>(0.0);
  var transmittedCoefficient=vec3<f32>(0.0);
  let screenUv = in.ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
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
    finiteScalar(material.thickness, 0.0) * length(worldRefractedDirection) *
      finiteScalar(thicknessSample, 1.0),
    0.0,
  );
  // Project the refracted ray's exit point instead of offsetting screen UVs by
  // world-space direction deltas: world +Y is screen -V, and only a projection
  // follows the camera orientation.
  let refractedExitClip = view.worldViewProj * vec4<f32>(
    in.worldPos + refracted * inverseSqrt(max(refractedLengthSquared, 1e-12)) * worldThickness,
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
    prefilterSampler,
    clamp(screenUv, vec2<f32>(0.0), vec2<f32>(1.0)),
    backdropLod,
  ).rgb;
  var transmittedBackdrop = unrefractedBackdrop;
  if (refractedLengthSquared > 1e-6 && insideGuardBand) {
    transmittedBackdrop = textureSampleLevel(
      transmissionBackdropTexture,
      prefilterSampler,
      clamp(refractedUv, vec2<f32>(0.0), vec2<f32>(1.0)),
      backdropLod,
    ).rgb;
  }
  let safeAttenuationColor = clamp(
    finiteColor(material.attenuationColor, vec3<f32>(1.0)),
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  let safeAttenuationDistance = max(finiteScalar(material.attenuationDistance, 0.0), 0.0);
  let attenuationExponent = worldThickness / max(safeAttenuationDistance, 1e-6);
  let beerAttenuation = select(
    vec3<f32>(1.0),
    pow(safeAttenuationColor, vec3<f32>(attenuationExponent)),
    safeAttenuationDistance > 1e-6 && worldThickness > 0.0,
  );
  transmittedCoefficient=transmittedEnergy*albedo*beerAttenuation;
  transmittedContribution=finiteColor(transmittedBackdrop,vec3<f32>(0.0))*transmittedCoefficient;
  color+=transmittedContribution;
#endif
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
  directionalLayerBase = terrainShadowLayerBase(rawGeometry, frontFacing, view.lightDir,
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
      in.worldPos,
      standardViewZ(in),
      directionalLayerBase,
      in.clip.xy,
    );
  }
  color += evaluateStandardDirect(in.worldPos, in.ndc.xyz, standardViewZ(in), in.clip.xy,
    physicalNormal, v, diffuseAlbedo, transmissionAlbedo, metallic, a, f0, directionalShadow,
    receiveShadows, in.surfaceData.z, false,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, irradianceSampler,
#endif
  ).radiance;
// CLUSTER_FORWARD_AVAILABLE
  // Emissive is part of the lower-energy stack and is attenuated by the
  // topcoat just like diffuse/specular radiance.
  color = color + surface.emissive;
#ifdef SHEEN_AVAILABLE
  var sheenColor = material.sheenColor;
  var sheenRoughnessFactor = 1.0;
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  if (standardUsesSheenColorTexture()) {
  let sheenColorUv = transformedMaterialUv(
    material.sheenColorTextureCoordinatesTransform,
    material.sheenColorTextureCoordinatesMetadata, material.sheenColorTextureCoordinatesRotation,
    in,
  );
  sheenColor = sheenColor * sampleMaterialTexture(
    sheenColorTexture,
    sheenColorSampler,
    sheenColorUv,
    material.sheenColorTextureCoordinatesMetadata.zw,
  ).rgb;
  }
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesSheenRoughnessTexture()) {
  let sheenRoughnessUv = transformedMaterialUv(
    material.sheenRoughnessTextureCoordinatesTransform,
    material.sheenRoughnessTextureCoordinatesMetadata, material.sheenRoughnessTextureCoordinatesRotation,
    in,
  );
  sheenRoughnessFactor = sampleMaterialTexture(
    sheenRoughnessTexture,
    sheenRoughnessSampler,
    sheenRoughnessUv,
    material.sheenRoughnessTextureCoordinatesMetadata.zw,
  ).a;
  }
#endif
  let sheenRoughness = clamp(
    finiteScalar(material.sheenRoughness, 0.0) * sheenRoughnessFactor,
    0.0,
    1.0,
  );
  color = evaluateSheenLayer(color, sheenColor, sheenRoughness, dot(n, v));
#endif
#ifdef CLEARCOAT_AVAILABLE
  var clearcoatFactor = clamp(material.clearcoat, 0.0, 1.0);
#ifdef CLEARCOAT_TEXTURE_AVAILABLE
  if (standardUsesClearcoatTexture()) {
  let clearcoatUv = transformedMaterialUv(material.clearcoatTextureCoordinatesTransform, material.clearcoatTextureCoordinatesMetadata, material.clearcoatTextureCoordinatesRotation, in);
  clearcoatFactor = clamp(
    material.clearcoat * sampleMaterialTexture(
      clearcoatTexture,
      clearcoatSampler,
      clearcoatUv,
      material.clearcoatTextureCoordinatesMetadata.zw,
    ).r,
    0.0,
    1.0,
  );
  }
#endif
  var clearcoatRoughnessValue = clamp(max(material.clearcoatRoughness, 0.04), 0.04, 1.0);
#ifdef CLEARCOAT_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesClearcoatRoughnessTexture()) {
  let clearcoatRoughnessUv = transformedMaterialUv(material.clearcoatRoughnessTextureCoordinatesTransform, material.clearcoatRoughnessTextureCoordinatesMetadata, material.clearcoatRoughnessTextureCoordinatesRotation, in);
  clearcoatRoughnessValue = clamp(
    max(material.clearcoatRoughness, 0.04) * sampleMaterialTexture(
      clearcoatRoughnessTexture,
      clearcoatRoughnessSampler,
      clearcoatRoughnessUv,
      material.clearcoatRoughnessTextureCoordinatesMetadata.zw,
    ).g,
    0.04,
    1.0,
  );
  }
#endif
  clearcoatRoughnessValue = specularAntiAliasedRoughness(clearcoatRoughnessValue, normalSpread);
  var clearcoatBaseNormal = in.worldNormal;
#ifdef FLAT_SHADING_AVAILABLE
  clearcoatBaseNormal = select(clearcoatBaseNormal, geometricNormal, material.flatShading != 0u);
#endif
  var clearcoatNormalValue = normalize(clearcoatBaseNormal);
#ifdef CLEARCOAT_NORMAL_TEXTURE_AVAILABLE
  if (standardUsesClearcoatNormalTexture()) {
  let clearcoatNormalUv = transformedMaterialUv(material.clearcoatNormalTextureCoordinatesTransform, material.clearcoatNormalTextureCoordinatesMetadata, material.clearcoatNormalTextureCoordinatesRotation, in);
  clearcoatNormalValue = applyTBN(
    clearcoatBaseNormal,
    in.worldTangent,
    scaleTangentSpaceNormal(
      decodeTangentSpaceNormalRg(sampleMaterialTexture(
        clearcoatNormalTexture,
        clearcoatNormalSampler,
        clearcoatNormalUv,
        material.clearcoatNormalTextureCoordinatesMetadata.zw,
      ).rg),
      vec2<f32>(material.clearcoatNormalScale),
    ),
  );
  }
#endif
  clearcoatNormalValue *= select(-1.0, 1.0, frontFacing);
  var clearcoatIbl = vec3<f32>(0.0);
  if (skylight.intensity < 0.0) {
    clearcoatIbl = sampleReflectionProbeSpecular(
      clearcoatNormalValue,
      v,
      clearcoatRoughnessValue,
      vec3<f32>(0.04),
      in.worldPos,
      vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB),
      skylight.rotation.xyz,
      vec4<f32>(0.0, 0.0, 0.0, 1.0),
      prefilterMap,
      prefilterSampler,
      brdfLut,
      irradianceSampler,
      skylightPrefilterMap, skylight.diffuseRotation, skylight.diffuseScale.xyz,
      max(-skylight.intensity - 1.0, 0.0), skylight.rotation.w > 0.5,
    );
  } else {
    clearcoatIbl = sampleIblSpecular(
      clearcoatNormalValue,
      v,
      clearcoatRoughnessValue,
      vec3<f32>(0.04),
      skylight.rotation,
      prefilterMap,
      prefilterSampler,
      brdfLut,
      irradianceSampler,
    );
  }
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
    directDfgLut, irradianceSampler,
#endif
  );
  let directionalClearcoat = select(vec3<f32>(0.0), view_apply_direct_solar(view, clearcoatDirect, in.worldPos),
    lightingChannelsMatch(view.lightingChannels, in.surfaceData.z));
  var clearcoatEnvironment = clearcoatIbl * specularEnvironmentScale * ao;
#ifdef CLUSTER_FORWARD_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  clearcoatEnvironment *= sampleStandardAmbientOcclusion(in.worldPos, view.worldViewProj,
    ssaoBlurredTexture, ssaoBlurredSampler);
#endif
#endif
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
#endif
  return lit;
}

fn standardForward(in : VsOut, frontFacing : bool) -> StandardPbrOutput {
  return standardForwardFogged(in, standardForwardLit(in, frontFacing));
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  return standardForward(in, frontFacing);
}

// Forward entry for draws bound to the unfogged View slot (opaque and other
// draws whose blend the translucent fog lanes do not compose). Identical
// output to fs_main there: translucent_fog_transmission returns its input
// when the slot is 0 and transmission is zero, which it always is without
// TRANSMISSION_AVAILABLE.
@fragment
fn fs_opaque(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  let lit = standardForwardLit(in, frontFacing);
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardFogged(in, lit);
#else
  return standardForwardOutput(lit, lit.color);
#endif
}

// Weighted blended OIT accumulation for straight-alpha blend states.
@fragment
fn fs_oit(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
  let color = standardForward(in, frontFacing).color;
  return oitAccumulate(color.rgb * color.a, color.a, distance(in.worldPos, view.cameraPos));
}

// Weighted blended OIT accumulation for premultiplied blend states.
@fragment
fn fs_oit_premultiplied(in : VsOut, @builtin(front_facing) frontFacing : bool) -> OitOutput {
  let color = standardForward(in, frontFacing).color;
  return oitAccumulate(color.rgb, color.a, distance(in.worldPos, view.cameraPos));
}

@fragment
fn fs_gbuffer(in : VsOut, @builtin(front_facing) frontFacing : bool
#ifdef VISIBLE_SURFACE_AVAILABLE
  , @builtin(primitive_index) primitiveIndex : u32
#endif
) -> GBufferOutput {
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  var rawGeometry = surfaceGeometryNormal(dpdx(in.worldPos), dpdy(in.worldPos), vec3<f32>(0.0));
#if TERRAIN_GEOMETRY_AVAILABLE == true
  rawGeometry = terrainGeometryNormal(rawGeometry, frontFacing);
#endif
  let receiverNormal = select(in.worldNormal * select(-1.0, 1.0, frontFacing), rawGeometry,
    dot(rawGeometry, rawGeometry) > 0.0);
  let geometricNormal = receiverNormal * select(-1.0, 1.0, frontFacing);
  var normalSpread = geometricNormalSpread(in.worldNormal);
  let surface = evaluateStandardSurface(in, frontFacing, geometricNormal);
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
  let specular = standardSurfaceSpecular(in, surface, standardDielectricF0(max(finiteScalar(material.ior, 1.5), 1.0)));
  var output = encodeStandardGBuffer(surface.normalWS, receiverNormal,
    specularAntiAliasedRoughness(clamp(surface.roughness, 0.04, 1.0), normalSpread),
    surface.baseColor, clamp(surface.metallic, 0.0, 1.0), mix(specular.rgb, surface.baseColor, clamp(surface.metallic, 0.0, 1.0)), specular,
    surface.occlusion, surface.emissive, materialOutputAlpha(surface.opacity, standardAlphaMode()), u32(skylight.diffuseScale.w), probeRow,
    standardReceivesShadows(in), in.surfaceData.z, subsurface,
    useDirectDfgLut,
  );
#if TERRAIN_GEOMETRY_AVAILABLE == true
  let directionalLayerBase = terrainShadowLayerBase(rawGeometry, frontFacing, view.lightDir,
    material.terrainShadowFamily, view.cascadeCount, view.directionalShadowFilter.x);
  output.receiver_geometry.x = (output.receiver_geometry.x & 0x00ffffffu) | (directionalLayerBase << 24u);
#endif
  let temporal = unpackSceneTemporalV1(vec4<f32>(0.0, 0.0, 0.0, bitcast<f32>(in.surfaceData.y)));
  // Alpha hashing already commits a binary Surface mask; its sampling alpha
  // must not become source reactivity. Share the standalone producer policy.
  var reactive = resolvePbrTemporalReactive(temporal.reactive, materialOutputAlpha(surface.opacity, standardAlphaMode()), 1.0);
#ifdef ALPHA_HASH_AVAILABLE
  if (material.alphaHash > 0.5) { reactive = temporal.reactive; }
#endif
  let currentClip = view.temporalCurrentViewProj * vec4<f32>(in.worldPos, 1.0);
  output.scene_temporal = packSceneTemporalV1WithValidity(
    currentClip, currentClip - in.clipDelta,
    view.temporalProjection, reactive, temporal.motionValid);
#ifdef VISIBLE_SURFACE_AVAILABLE
  let valid = in.surfaceData.x != 0u && dot(rawGeometry, rawGeometry) > 0.0;
  output.visible_surface = vec4<u32>(in.surfaceData.x, primitiveIndex,
    encodeStandardNormalRoughness(geometricNormal, 0.0), select(0u, select(1u, 3u, frontFacing), valid));
#endif
  return output;
}

struct TemporalVsOut {
#ifndef ALPHA_HASH_DISABLED
  @location(10) positionOS : vec3<f32>,
#endif
  @location(11) clippingPositionWS : vec3<f32>,
  @location(12) @interpolate(flat) temporal : vec3<f32>,
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
  @location(8) @interpolate(perspective) currentClip : vec4<f32>,
  @location(9) @interpolate(perspective) previousClip : vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(14) color : vec4<f32>,
#endif
};

@vertex
fn vs_temporal(in : VsIn, @builtin(instance_index) idx : u32) -> TemporalVsOut {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  let visible = visibleItems[idx];
  material = selectedMaterial(visible.y);
  let draw = sceneIndexDraw(visible.x);
  let localPosition = standardVertexPosition(in);
  let currentWorld = draw.world * SCENE_INDEX_LOCAL_IDENTITY * vec4<f32>(localPosition, 1.0);
  let previousWorld =
    draw.previousWorld * SCENE_INDEX_LOCAL_IDENTITY * vec4<f32>(localPosition, 1.0);
  var out : TemporalVsOut;
  out.temporal = vec3<f32>(draw.temporal, bitcast<f32>(visible.w));
#else
  let localPosition = standardVertexPosition(in);
  let currentWorld = meshes[0u].worldFromLocal *
    instances[idx].localFromInstance * vec4<f32>(localPosition, 1.0);
  var previousWorld = currentWorld;
#if STORAGE_BUFFER_AVAILABLE == true
  previousWorld = meshes[0u].previousWorldFromLocal *
    instances[idx].previousLocalFromInstance * vec4<f32>(localPosition, 1.0);
#endif
  var out : TemporalVsOut;
#if STORAGE_BUFFER_AVAILABLE == true
  out.temporal = meshes[0u].temporal.xyz;
#else
  out.temporal = vec3<f32>(0.0, 1.0, 0.0);
#endif
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialIndex = visibleItems[idx].y;
#endif
#ifndef ALPHA_HASH_DISABLED
  out.positionOS = localPosition;
#endif
  out.clippingPositionWS = currentWorld.xyz;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = view.worldViewProj * currentWorld;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
  #if TERRAIN_GEOMETRY_AVAILABLE == true
#ifndef STANDARD_UV_INPUT_UNUSED
  out.uv = (localPosition.xz - material.terrainSection.xy) / material.terrainSection.z;
#else
  out.uv = in.uv;
#endif
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
  return out;
}

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

@fragment
fn fs_temporal(in : TemporalVsOut) -> @location(0) vec4<f32> {
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  material = selectedMaterial(in.materialIndex);
#endif
  applyViewClipping(in.clippingPositionWS, false);
#ifdef MATERIAL_CLIPPING_AVAILABLE
  applyLocalClipping(in.clippingPositionWS, false, array<vec4<f32>, 6>(material.clippingPlaneA, material.clippingPlaneB, material.clippingPlaneC, material.clippingPlaneD, material.clippingPlaneE, material.clippingPlaneF), material.clippingControl);
#endif

  applyLodCoverage(in.clip.xy, in.temporal.z);
  // A changing LOD silhouette must reject stale temporal history.
  let reactive = max(in.temporal.x, select(0.0, 1.0, in.temporal.z != 0.0));
  let motionValid = meshMotionValid(in.temporal.y);

  let temporal = projectPbrSceneTemporal(
    material.baseColor.a * temporalVertexAlpha(in),
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
#ifdef BASE_COLOR_TEXTURE_AVAILABLE
    standardUsesBaseColorTexture(),
    baseColorTexture,
    baseColorTexture_sampler,
    material.baseColorTextureCoordinatesTransform,
    material.baseColorTextureCoordinatesMetadata, material.baseColorTextureCoordinatesRotation,
#endif
#ifdef ALPHA_TEXTURE_AVAILABLE
    standardUsesAlphaTexture(),
    alphaTexture,
    alphaTexture_sampler,
    material.alphaTextureCoordinatesTransform,
    material.alphaTextureCoordinatesMetadata, material.alphaTextureCoordinatesRotation,
    material.alphaChannel,
#endif
    in.currentClip,
    in.previousClip,
    view.temporalProjection,
    reactive,
    motionValid,
#ifndef STANDARD_UV_INPUT_UNUSED
    in.uv, in.uv1, in.uv2, in.uv3,
    in.uv4, in.uv5, in.uv6, in.uv7,
#else
    vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0), vec2<f32>(0.0),
#endif
  );
#ifdef COVERAGE_ONLY
  return vec4<f32>(1.0);
#else
  return temporal;
#endif
}
