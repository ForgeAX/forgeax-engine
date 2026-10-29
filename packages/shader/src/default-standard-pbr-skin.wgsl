#pragma material_slot surface
#import forgeax_material::alpha_hash::{materialOutputAlpha, materialOutputColor}
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
#import forgeax_material::displacement::{displaceVertex, displacedNormal}
#endif
#import forgeax_clipping::planes::{applyViewClipping, applyLocalClipping}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardEnvironment, evaluateStandardDirect}
#import forgeax_pbr::gbuffer_output::{GBufferOutput, encodeStandardGBuffer}

#import forgeax_material::slot::surface::{evaluate_surface, evaluate_standard_surface}
#import forgeax_material::surface_v1::{SurfaceInput, SurfaceData, surfaceGeometryNormal}
#import forgeax_view::common::{viewDirectionToCamera, lightingChannelsMatch, View, Mesh, meshMotionValid, InstanceData, view, shadowMap, shadowSampler, sampleMaterialTexture}
#ifdef TRANSMISSION_AVAILABLE
#import forgeax_view::fog::{translucent_fog_transmission}
#else
#import forgeax_view::fog::{translucent_fog}
#endif
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, sceneIndexMorphPosition, sceneInstances}
#else
#import forgeax_view::common::{meshes, instances, meshReceivesShadows}
#endif
#import forgeax_scene_temporal::{sceneViewZ, packSceneTemporalV1WithValidity, unpackSceneTemporalV1}
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{spotModifierSampler, iesProfileTexture, cookieTexture, cookieMatrices}
#endif
#import forgeax_pbr::temporal::{projectPbrSceneTemporal, resolvePbrTemporalReactive}
#import forgeax_pbr::brdf::{standardOpaqueF0FromDielectric, standardDielectricF0, f_schlick, v_smith, d_ggx}
#import forgeax_pbr::specular_aa::{geometricNormalSpread, specularAntiAliasedRoughness}
#import forgeax_pbr::ibl_sampling::{decodeSpecularEnvironmentScale, sampleIblSpecular, sampleReflectionProbeSpecular}
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

#define_import_path forgeax_material::pbr-skin
#ifdef MATERIAL_TEXTURE_COORDINATES_AVAILABLE
#import forgeax_material::texture_coordinates::{materialUvLinear}
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

// The MaterialParameters struct and its binding-0 declaration are generated
// from the root ParamSchema during material composition. Keeping the ABI out
// of this template prevents a second handwritten interface from drifting from
// the runtime UBO writer.
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

// Preserve filtering reflection for resources passed to the shared sampler.
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
#ifdef TRANSMISSION_AVAILABLE
#ifdef TRANSMISSION_TEXTURE_AVAILABLE
  let transmission = transmissionTexture;
#endif
#ifdef THICKNESS_TEXTURE_AVAILABLE
  let thickness = thicknessTexture;
#endif
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
  let transmissionWitness = textureSample(transmission, transmissionSampler, vec2<f32>(0.0));
#endif
#ifdef THICKNESS_TEXTURE_AVAILABLE
  let thicknessWitness = textureSample(thickness, thicknessSampler, vec2<f32>(0.0));
#endif
#endif
}

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
@group(3) @binding(1) var<storage, read> probeBlendRecords : array<vec4<f32>>;
#endif

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@group(1) @binding(46) var<storage, read> sceneMaterials : array<MaterialParameters>;
@group(3) @binding(2) var<storage, read> visibleItems : array<vec4<u32>>;
#endif

#import forgeax_skin::task::{skinTaskDescriptor, skinTaskBlend, skinTaskDirectCandidate, skinTaskHistoryValid}

#ifdef CLUSTER_FORWARD_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
@group(2) @binding(7) var ssaoBlurredTexture : texture_2d<f32>;
@group(2) @binding(8) var ssaoBlurredSampler : sampler;
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
struct VsOut {
  @builtin(position) @invariant clip : vec4<f32>,
  // Keep mesh and instance storage vertex-only: the flat object basis
  // (with ndc.w as its last element) serves transmission, triplanar object
  // projection and object-space normal maps.
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(4) @interpolate(flat) objectBasis0 : vec4<f32>,
#endif
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(2) uv0And1 : vec4<f32>,
#endif
#ifndef STANDARD_TANGENT_INPUT_UNUSED
  @location(3) worldTangent : vec4<f32>,
#endif
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  @location(7) viewZ : f32,
#else
  @location(7) positionOSAndViewZ : vec4<f32>,
#endif
#ifndef STANDARD_UV_INPUT_UNUSED
  @location(5) uv2And3 : vec4<f32>,
#endif
  @location(9) @interpolate(flat) surfaceData : vec3<u32>,
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
  @location(6) ndc : vec4<f32>,
#ifndef STANDARD_OBJECT_BASIS_UNUSED
  @location(13) @interpolate(flat) objectBasis1 : vec4<f32>,
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index variants carry the row selector in the storage-backed lane.
  // They never target the WebGL2 uniform-fallback limit, so location 15
  // stays outside its 14-location ABI.
  @location(15) @interpolate(flat) materialAddress : vec3<u32>,
#endif
};

fn standardVertexPosition(in : VsIn) -> vec3<f32> {
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
  if (standardUsesDisplacementTexture()) {
    return displaceVertex(in.pos, in.normal, displacementTexture, displacementTexture_sampler,
      material.displacementScale, material.displacementBias,
      material.displacementTextureCoordinatesTransform, material.displacementTextureCoordinatesMetadata, material.displacementTextureCoordinatesRotation,
      array<vec2<f32>, 8>(in.uv, in.uv1, in.uv2, in.uv3, in.uv4, in.uv5, in.uv6, in.uv7));
  }
#endif
  return in.pos;
}

fn vs_main_impl(in : VsIn, paletteBase : u32, materialAddress : vec3<u32>, temporal : vec2<f32>) -> VsOut {
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

  // glTF 2.0 sec.Skins Implementation Note: when a mesh node has a skin
  // property, the joint matrices already encode the global transform of each
  // joint relative to the scene root. The transform of the mesh node itself
  // must be ignored when rendering the skinned mesh.
  //
  // The host pre-computes palette[i] = jointWorld_i * IBM_i (full world-space
  // transform, including the entire ancestor chain via propagateTransforms).
  // skinnedLocal IS the world position -- no additional left-multiply by
  // meshes[0].worldFromLocal or instanceLocal is needed.
  //
  // This removes the implicit contract "Skin entity Transform.world must be
  // identity" -- a skin entity can be parented under any Transform chain and
  // the skinned mesh will rigidly follow via joint propagation alone.
  let skinnedLocal = skinMatrix * vec4<f32>(localPosition, 1.0);

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
  let previousWorld = previousSkin * vec4<f32>(localPosition, 1.0);
  let currentClip = view.temporalCurrentViewProj * skinnedLocal;
  let previousClip = view.temporalPreviousViewProj * previousWorld;
  // Equal poses produce exact zero before interpolation. Reprojecting two
  // separately rounded world/clip varyings would invent stationary motion.
  out.clipDelta = currentClip - previousClip;
  let reactiveLane = packSceneTemporalV1WithValidity(
    currentClip, previousClip,
    view.temporalProjection, temporal.x, temporal.y >= 0.5 && skinTaskHistoryValid(descriptor)).w;
  out.surfaceData = vec3<u32>(0u, bitcast<u32>(reactiveLane), 0xffffffffu);
#ifdef STANDARD_OBJECT_POSITION_UNUSED
  out.viewZ = sceneViewZ(out.clip, view.temporalProjection);
#else
  out.positionOSAndViewZ = vec4<f32>(localPosition, sceneViewZ(out.clip, view.temporalProjection));
#endif
  out.worldPos = skinnedLocal.xyz;
  out.worldNormal = normalize(skinNormal3x3 * in.normal);
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
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.materialAddress = materialAddress;
#endif
  let clipPos = out.clip;
  out.ndc = vec4(clipPos.xy / clipPos.w, clipPos.z / clipPos.w, skinMatrix[2].z);
  // feat-20260613-csm-cascaded-shadow-maps M5 / w19: viewZ replaces the
  // prior light-space-position varying; evalDirectional picks the cascade
  // matrix per fragment from viewZ + worldPos.
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
fn sceneIndexVertex(source : VsIn, idx : u32, vertex : u32) -> VsOut {
  // visible = (scene instance row, material row, candidate row, LOD fade).
  // The palette already carries world space; the scene rows only name the
  // probe identity and keep the shared scene bindings referenced.
  let visible = visibleItems[idx];
  let draw = sceneIndexDraw(visible.x);
  // Morph precedes skinning, as in the per-entity morphed stream.
  var in = source;
  in.pos = sceneIndexMorphPosition(visible.x, vertex, in.pos);
  _ = draw.world;
  // Scene material rows never reach bit 31; it carries the receive opt-out.
  var out = vs_main_impl(
    in,
    visible.z,
    vec3<u32>(visible.y | select(STANDARD_NO_RECEIVE_BIT, 0u, draw.receivesShadows), draw.probe),
    draw.temporal,
  );
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
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
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
  var out = vs_main_impl(in, skinTaskDirectCandidate(), vec3<u32>(0xffffffffu, 0u, 0u), temporal);
  out.surfaceData.z = meshes[0u].surface.z;
  return out;
#endif
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@vertex
fn vs_scene_index(in : VsIn, @builtin(instance_index) idx : u32, @builtin(vertex_index) vertex : u32) -> VsOut {
  return sceneIndexVertex(in, idx, vertex);
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
  var source = in.uv0And1.xy;
  if (metadata.x >= 1.0) { source = in.uv0And1.zw; }
  if (metadata.x >= 2.0) { source = in.uv2And3.xy; }
  if (metadata.x >= 3.0) { source = in.uv2And3.zw; }
  if (metadata.x >= 4.0) { source = in.uv4And5.xy; }
  if (metadata.x >= 5.0) { source = in.uv4And5.zw; }
  if (metadata.x >= 6.0) { source = in.uv6And7.xy; }
  if (metadata.x >= 7.0) { source = in.uv6And7.zw; }
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
    vec3<f32>(in.objectBasis1.zw, in.ndc.w),
  );
#else
  return mat3x3<f32>(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 0.0, 1.0));
#endif
}


fn evaluateStandardSurface(in : VsOut, frontFacing : bool, geometricNormal : vec3<f32>) -> SurfaceData {
#ifdef DISPLACEMENT_TEXTURE_AVAILABLE
  let triangleNormal = displacedNormal(in.worldPos, in.worldNormal);
#endif
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index Surface helpers may close over the imported `material` symbol.
  // The compiler's scene variant maps that symbol to a private provider so
  // the whole helper call graph observes the selected row, not the direct
  // material uniform.
  material = selectedMaterial(in.materialAddress.x);
#endif

  applyViewClipping(in.worldPos, false);
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
  let surfaceUvs = array<vec2<f32>, 8>(in.uv0And1.xy, in.uv0And1.zw, in.uv2And3.xy, in.uv2And3.zw, in.uv4And5.xy, in.uv4And5.zw,
    in.uv6And7.xy, in.uv6And7.zw);
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

// Lit Standard surface before translucent fog. The skin fs_main fogs it through the
// View slot it is bound to; fs_opaque serves draws bound to the unfogged slot
// (fogHeightOpacity.z == 0), where translucent fog is the identity unless the
// surface transmits, so the fog chain is compiled out of that entry.
struct StandardForwardLit {
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
  output.color = vec4<f32>(color, lit.alpha);
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

// Forward shading shared by the fs_main and fs_opaque entries.
fn standardSkinForwardLit(in : VsOut, frontFacing : bool) -> StandardForwardLit {
  let _variantIdentity = standardSkinVariantIdentity();
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  let receiverNormal = surfaceGeometryNormal(dpdx(in.worldPos), dpdy(in.worldPos),
    in.worldNormal * select(-1.0, 1.0, frontFacing));
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
  let backdropMipCount = textureNumLevels(transmissionBackdropTexture);
  let backdropMaxLod = max(f32(backdropMipCount) - 1.0, 0.0);
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
      in.worldPos,
      standardViewZ(in),
      0u,
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
#ifdef SHEEN_AVAILABLE
  var sheenColor = material.sheenColor;
  var sheenRoughnessFactor = 1.0;
#ifdef SHEEN_COLOR_TEXTURE_AVAILABLE
  if (standardUsesSheenColorTexture()) {
  sheenColor = sheenColor * sampleMaterialTexture(
    sheenColorTexture,
    sheenColorSampler,
    transformedMaterialUv(material.sheenColorTextureCoordinatesTransform, material.sheenColorTextureCoordinatesMetadata, material.sheenColorTextureCoordinatesRotation, in),
    material.sheenColorTextureCoordinatesMetadata.zw,
  ).rgb;
  }
#endif
#ifdef SHEEN_ROUGHNESS_TEXTURE_AVAILABLE
  if (standardUsesSheenRoughnessTexture()) {
  sheenRoughnessFactor = sampleMaterialTexture(
    sheenRoughnessTexture,
    sheenRoughnessSampler,
    transformedMaterialUv(material.sheenRoughnessTextureCoordinatesTransform, material.sheenRoughnessTextureCoordinatesMetadata, material.sheenRoughnessTextureCoordinatesRotation, in),
    material.sheenRoughnessTextureCoordinatesMetadata.zw,
  ).a;
  }
#endif
  let sheenRoughness = clamp(
    material.sheenRoughness * sheenRoughnessFactor,
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
#endif
  return lit;
}

@fragment
fn fs_main(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  return standardForwardFogged(in, standardSkinForwardLit(in, frontFacing));
}

// See the rigid Standard fs_opaque: identical to fs_main on the unfogged slot.
@fragment
fn fs_opaque(in : VsOut, @builtin(front_facing) frontFacing : bool) -> StandardPbrOutput {
  let lit = standardSkinForwardLit(in, frontFacing);
#ifdef TRANSMISSION_AVAILABLE
  return standardForwardFogged(in, lit);
#else
  return standardForwardOutput(lit, lit.color);
#endif
}

// Keep the skinned Standard shader on the same multi-entry pass contract as
// the rigid Standard shader. Deferred draws select this entry point from the
// existing `forgeax::pbr-skin` artifact; lighting is performed by the deferred
// pass after these base surface facts are written to the shared G-buffer.
@fragment
fn fs_gbuffer(in : VsOut, @builtin(front_facing) frontFacing : bool) -> GBufferOutput {
  return skinGBuffer(in, frontFacing);
}

// Deformed draws publish no visible-surface rows (their posed triangles have no
// frame-stable raster address), so a visible-surface G-buffer pass writes row 0:
// skinned pixels read as uncovered instead of keeping an occluded surface's row.
struct SkinUncoveredGBufferOutput {
  @location(0) scene_color : vec4<f32>,
  @location(1) normal_roughness : u32,
  @location(2) f0_occlusion : vec2<u32>,
  @location(3) albedo_metallic : u32,
  @location(4) lighting_context : vec2<u32>,
  @location(5) receiver_geometry : vec2<u32>,
  @location(6) visible_surface : vec4<u32>,
  @location(7) scene_temporal : vec4<f32>,
};

@fragment
fn fs_gbuffer_uncovered(in : VsOut, @builtin(front_facing) frontFacing : bool) -> SkinUncoveredGBufferOutput {
  let g = skinGBuffer(in, frontFacing);
  return SkinUncoveredGBufferOutput(g.scene_color, g.normal_roughness, g.f0_occlusion,
    g.albedo_metallic, g.lighting_context, g.receiver_geometry, vec4<u32>(0u), g.scene_temporal);
}

fn skinGBuffer(in : VsOut, frontFacing : bool) -> GBufferOutput {
  // Freeze actual triangle geometry before clipping or alpha discard. The
  // receiver plane and offset cannot follow a BA gradient or normal map.
  let rawGeometry = surfaceGeometryNormal(dpdx(in.worldPos), dpdy(in.worldPos), vec3<f32>(0.0));
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
  // The vertex lane retains the canonical validity/reactivity encoding;
  // coverage and opacity come from the same evaluated surface as GBuffer.
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
  return output;
}

struct TemporalVsOut {
#ifndef ALPHA_HASH_DISABLED
  @location(10) positionOS : vec3<f32>,
#endif
  @location(11) clippingPositionWS : vec3<f32>,
  @location(12) @interpolate(flat) temporal : vec2<f32>,
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
  let localPosition = standardVertexPosition(in);
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  // Scene-index draws address the view's transient Skin task by the actual
  // candidate in visible.z, exactly as vs_scene_index does.
  let visible = visibleItems[idx];
  let paletteBase = visible.z;
  let materialIndex = visible.y;
  let temporalFlags = sceneIndexDraw(visible.x).temporal;
#else
  // Direct temporal draws select their task through per-draw dynamic offsets,
  // just like the direct forward entry point.
  let paletteBase = skinTaskDirectCandidate();
#endif
  let descriptor = skinTaskDescriptor(paletteBase);
  let currentSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, false);
  let previousSkin = skinTaskBlend(descriptor, in.skinIndex, in.skinWeight, true);
  let currentWorld = currentSkin * vec4<f32>(localPosition, 1.0);
  let previousWorld = previousSkin * vec4<f32>(localPosition, 1.0);
  var out : TemporalVsOut;
#if GPU_DRIVEN_SCENE_INDEX_AVAILABLE == true
  out.temporal = vec2<f32>(temporalFlags.x, select(0.0, temporalFlags.y, skinTaskHistoryValid(descriptor)));
  out.materialIndex = materialIndex;
#else
#if STORAGE_BUFFER_AVAILABLE == true
  out.temporal = vec2<f32>(meshes[0].temporal.x, select(0.0, 1.0, meshMotionValid(meshes[0].temporal.y) && skinTaskHistoryValid(descriptor)));
#else
  out.temporal = vec2<f32>(1.0, select(0.0, 1.0, skinTaskHistoryValid(descriptor)));
#endif
#endif
#ifndef ALPHA_HASH_DISABLED
  out.positionOS = localPosition;
#endif
  out.clippingPositionWS = currentWorld.xyz;
  out.currentClip = view.temporalCurrentViewProj * currentWorld;
  out.clip = view.worldViewProj * currentWorld;
  out.previousClip = view.temporalPreviousViewProj * previousWorld;
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

  let reactive = in.temporal.x;
  let motionValid = in.temporal.y >= 0.5;
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
