#define_import_path forgeax_material::standard_surface
#import forgeax_material::texture_coordinates::{materialUvLinear}
#import forgeax_view::common::{view, sampleMaterialTexture}
#import forgeax_view::fog::{translucent_fog_transmission}
#import forgeax_pbr::brdf::{f_schlick}
#import forgeax_pbr::specular_aa::{geometricNormalSpread, specularAntiAliasedRoughness}
#import forgeax_pbr::ibl_sampling::{decodeSpecularEnvironmentScale, sampleIblDiffuse, sampleIblSpecular, sampleReflectionProbeSpecular}
#import forgeax_pbr::lighting_probe::{evaluateProbeDiffuse}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg, scaleTangentSpaceNormal, applyTBN}
#import forgeax_pbr::lighting_directional::{evalDirectionalNoShadow, evalDirectionalShadowFactorAtPixel}
#import forgeax_view::atmosphere::{view_apply_direct_solar}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{evaluateStandardClusterLights, sampleStandardAmbientOcclusion}
#endif

// Shared Standard material ABI and surface evaluation. Geometry adapters supply
// world-space inputs; Render owns View, material/environment, Cluster, and shadow
// resources. This module imports no scene mesh or instance transform table.

struct Material {
  baseColor          : vec4<f32>,
  metallic           : f32,
  roughness          : f32,
  // Channel selectors (D-8): 4 independent f32 entries split out of the
  // legacy `channelMap : vec4<u32>`. Each value is a small integer encoded
  // as f32 in {0.0, 1.0, 2.0, 3.0} indexing into {r,g,b,a}. Default glTF 2.0
  // packing = (metallicChannel=2, roughnessChannel=1, aoChannel=0,
  // extraChannel=0). The fragment casts to u32 at the pick site -- f32 is
  // chosen so the schema entry type aligns with the 14-tuple
  // MaterialParamType numeric-run packing rule (4-byte stride, 16 B span).
  metallicChannel    : f32,
  roughnessChannel   : f32,
  aoChannel          : f32,
  extraChannel       : f32,
  // vec3 align=16 inserts 8 implicit padding bytes after extraChannel
  // (offsets 40..48) so emissive lands at offset 48.
  emissive           : vec3<f32>,
  emissiveIntensity  : f32,
  occlusionStrength  : f32,
  alphaCutoff        : f32,
  clearcoat          : f32,
  clearcoatRoughness : f32,
  specularTint       : vec3<f32>,
  normalScale                   : vec2<f32>,
  transmission                  : f32,
  ior                           : f32,
  thickness                     : f32,
  attenuationColor              : vec3<f32>,
  attenuationDistance           : f32,
  baseColorTextureCoordinatesTransform : vec4<f32>,
  baseColorTextureCoordinatesMetadata : vec4<f32>,
  baseColorTextureCoordinatesRotation : vec4<f32>,
  metallicRoughnessTextureCoordinatesTransform : vec4<f32>,
  metallicRoughnessTextureCoordinatesMetadata : vec4<f32>,
  metallicRoughnessTextureCoordinatesRotation : vec4<f32>,
  normalTextureCoordinatesTransform : vec4<f32>,
  normalTextureCoordinatesMetadata : vec4<f32>,
  normalTextureCoordinatesRotation : vec4<f32>,
  specularTintTextureCoordinatesTransform : vec4<f32>,
  specularTintTextureCoordinatesMetadata : vec4<f32>,
  specularTintTextureCoordinatesRotation : vec4<f32>,
  emissiveTextureCoordinatesTransform : vec4<f32>,
  emissiveTextureCoordinatesMetadata : vec4<f32>,
  emissiveTextureCoordinatesRotation : vec4<f32>,
  occlusionTextureCoordinatesTransform : vec4<f32>,
  occlusionTextureCoordinatesMetadata : vec4<f32>,
  occlusionTextureCoordinatesRotation : vec4<f32>,
  transmissionTextureCoordinatesTransform : vec4<f32>,
  transmissionTextureCoordinatesMetadata : vec4<f32>,
  transmissionTextureCoordinatesRotation : vec4<f32>,
  thicknessTextureCoordinatesTransform : vec4<f32>,
  thicknessTextureCoordinatesMetadata : vec4<f32>,
  thicknessTextureCoordinatesRotation : vec4<f32>,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directMultiscatteringLut: u32,
#endif
};

@group(1) @binding(0) var<uniform> material : Material;
@group(1) @binding(1) var baseColorTexture_sampler : sampler;
@group(1) @binding(2) var baseColorTexture : texture_2d<f32>;
@group(1) @binding(3) var metallicRoughnessTexture_sampler : sampler;
@group(1) @binding(4) var metallicRoughnessTexture : texture_2d<f32>;
@group(1) @binding(5) var normalTexture_sampler : sampler;
@group(1) @binding(6) var normalTexture : texture_2d<f32>;
@group(1) @binding(7) var specularTintSampler : sampler;
@group(1) @binding(8) var specularTintTexture : texture_2d<f32>;
@group(1) @binding(9) var emissiveTexture_sampler : sampler;
@group(1) @binding(10) var emissiveTexture : texture_2d<f32>;
@group(1) @binding(11) var occlusionTexture_sampler : sampler;
@group(1) @binding(12) var occlusionTexture : texture_2d<f32>;
@group(1) @binding(13) var transmissionSampler : sampler;
@group(1) @binding(14) var transmissionTexture : texture_2d<f32>;
@group(1) @binding(15) var thicknessSampler : sampler;
@group(1) @binding(16) var thicknessTexture : texture_2d<f32>;
#ifdef TRANSMISSION_AVAILABLE
@group(1) @binding(23) var transmissionBackdropSampler : sampler;
@group(1) @binding(24) var transmissionBackdropTexture : texture_2d<f32>;
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
  let base = baseColorTexture;
  let metallicRoughness = metallicRoughnessTexture;
  let normal = normalTexture;
  let specularTint = specularTintTexture;
  let emissive = emissiveTexture;
  let occlusion = occlusionTexture;
  let baseWitness = textureSample(base, baseColorTexture_sampler, vec2<f32>(0.0));
  let metallicRoughnessWitness = textureSample(metallicRoughness, metallicRoughnessTexture_sampler, vec2<f32>(0.0));
  let normalWitness = textureSample(normal, normalTexture_sampler, vec2<f32>(0.0));
  let specularTintWitness = textureSample(specularTint, specularTintSampler, vec2<f32>(0.0));
  let emissiveWitness = textureSample(emissive, emissiveTexture_sampler, vec2<f32>(0.0));
  let occlusionWitness = textureSample(occlusion, occlusionTexture_sampler, vec2<f32>(0.0));
  let transmission = transmissionTexture;
  let thickness = thicknessTexture;
  let transmissionWitness = textureSample(transmission, transmissionSampler, vec2<f32>(0.0));
  let thicknessWitness = textureSample(thickness, thicknessSampler, vec2<f32>(0.0));
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
struct SkylightUniforms {
  intensity : f32,
  // The former pad0/1/2 lanes now carry the linear-space ambient `color` tint
  // (downstream integration #4). Kept as three scalars (NOT vec3<f32>) so the
  // struct stays exactly 16 B: a vec3 has 16-byte alignment in std140 and
  // would push `color` to offset 16. The rotation vec4 follows at offset 16,
  // so the host writes one 32 B payload.
  colorR : f32,
  colorG : f32,
  colorB : f32,
  rotation : vec4<f32>,
  // Probe mode retains the global diffuse environment independently.
  diffuseScale : vec4<f32>,
  diffuseRotation : vec4<f32>,
};
@group(1) @binding(17) var irradianceMap        : texture_cube<f32>;
@group(1) @binding(18) var irradianceSampler    : sampler;
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(1) @binding(72) var directDfgLut: texture_2d<f32>;
#endif
@group(1) @binding(19) var prefilterMap         : texture_cube<f32>;
@group(1) @binding(20) var prefilterSampler     : sampler;
@group(1) @binding(21) var brdfLut              : texture_2d<f32>;
@group(1) @binding(22) var<uniform> skylight    : SkylightUniforms;
// Global specular remains resident when the per-draw prefilter slot holds a probe.
@group(1) @binding(47) var skylightPrefilterMap : texture_cube<f32>;

#ifdef PROBE_BLEND_AVAILABLE
// Optional consumer lane. The host must provide the retained 160B record
// buffer and matching BGL before enabling this capability.
@group(3) @binding(1) var<storage, read> probeBlendRecords : array<vec4<f32>>;
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


struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos : vec3<f32>,
  @location(1) worldNormal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) worldTangent : vec4<f32>,
#ifdef TRANSMISSION_AVAILABLE
  // Keep mesh and instance storage vertex-only; transmission receives the
  // transform basis from the vertex stage below.
  @location(4) @interpolate(flat) transmissionBasisFirst : vec4<f32>,
#endif
  // feat-city-glb multi-UV tiling: second UV set inter-stage varying. Uses the
  // previously-vacant @location(5) so @location(6)/(7) stay byte-stable with
  // the prior layout (CSM M5/w19).
  @location(5) uvOne : vec2<f32>,
  @location(8) uvTwo : vec2<f32>,
  @location(9) uvThree : vec2<f32>,
  @location(10) uvFour : vec2<f32>,
  @location(11) uvFive : vec2<f32>,
  @location(12) uvSix : vec2<f32>,
  @location(13) uvSeven : vec2<f32>,
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
  @location(7) viewZ : f32,
#ifdef TRANSMISSION_AVAILABLE
  @location(15) @interpolate(flat) transmissionBasisSecond : vec4<f32>,
#endif
};

fn pick_channel(rgba : vec4<f32>, channelIndex : u32) -> f32 {
  // Branch-free channel pick. WGSL has no array<f32, 4>(rgba) addressable
  // helper; manual switch keeps the path uniform.
  switch (channelIndex) {
    case 0u: { return rgba.r; }
    case 1u: { return rgba.g; }
    case 2u: { return rgba.b; }
    default: { return rgba.a; }
  }
}

// Directional light evaluation lives in forgeax_pbr::lighting_directional.
// Local lights are evaluated by forgeax_standard::cluster when the clustered
// variant is selected; keeping that ownership in one module avoids a second
// View-group light-array ABI.



fn transformedMaterialUv(transform : vec4<f32>, metadata : vec4<f32>, rotation : vec4<f32>, in : VsOut) -> vec2<f32> {
  var source = in.uv;
  if (metadata.x >= 1.0) { source = in.uvOne; }
  if (metadata.x >= 2.0) { source = in.uvTwo; }
  if (metadata.x >= 3.0) { source = in.uvThree; }
  if (metadata.x >= 4.0) { source = in.uvFour; }
  if (metadata.x >= 5.0) { source = in.uvFive; }
  if (metadata.x >= 6.0) { source = in.uvSix; }
  if (metadata.x >= 7.0) { source = in.uvSeven; }
  return materialUvLinear(source, transform, rotation) + transform.xy;
}

fn materialAlpha(baseSample : vec4<f32>) -> f32 {
  return material.baseColor.a * baseSample.a;
}

fn materialVertexColor(in : VsOut) -> vec4<f32> {
#ifdef VERTEX_COLOR_AVAILABLE
  return in.color;
#else
  return vec4<f32>(1.0);
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

fn alphaTest(alpha : f32) {
  if (material.alphaCutoff > 0.0 && alpha <= material.alphaCutoff) {
    discard;
  }
}

// The renderer supplies the retained ProbeBlendRecord at the per-object
// consumer boundary. This helper deliberately accepts only diffuse inputs;
// Skylight/ReflectionProbe continue to own specular.
fn composeProbeDiffuse(
  shPreblend : array<vec4<f32>, 9>,
  localBlendFraction : f32,
  normal : vec3<f32>,
  skyIrradiance : vec3<f32>,
  kD : vec3<f32>,
  albedo : vec3<f32>,
  metallic : f32,
) -> vec3<f32> {
  return evaluateProbeDiffuse(shPreblend, localBlendFraction, normal, skyIrradiance, kD, albedo, metallic);
}

struct StandardPbrOutput {
  @location(0) color : vec4<f32>,
#ifdef REFLECTION_FALLBACK_AVAILABLE
  // Linear HDR environment contribution from this same Standard BRDF callsite.
  // The detached producer names this second target S_fallback.
  @location(1) reflectionFallback : vec4<f32>,
#endif
};

// Shared surface evaluator: vertex producers supply geometry and factor values;
// material textures, direct lights, IBL, and shadow sampling retain one owner.
struct StandardSurfaceFactors {
  baseColor : vec4<f32>,
  metallic : f32,
  roughness : f32,
  emissive : vec3<f32>,
  emissiveIntensity : f32,
  clearcoat : f32,
  clearcoatRoughness : f32,
  lighting : bool,
  receiveShadows : bool,
};



// Particle lighting is an authored renderer fact. A dedicated entry keeps all
// implicit-derivative samples uniform while removing discarded lit evaluation.
fn evaluateUnlitStandardSurface(in : VsOut, baseColor : vec4<f32>, emissive : vec3<f32>, emissiveIntensity : f32) -> StandardPbrOutput {
  let baseUv = transformedMaterialUv(material.baseColorTextureCoordinatesTransform, material.baseColorTextureCoordinatesMetadata, material.baseColorTextureCoordinatesRotation, in);
  let baseSample = sampleMaterialTexture(baseColorTexture, baseColorTexture_sampler, baseUv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = materialVertexColor(in);
  alphaTest(baseColor.a * baseSample.a * vertexColor.a);
  let alpha = baseColor.a * baseSample.a * vertexColor.a;
  let albedo = baseColor.rgb * baseSample.rgb * vertexColor.rgb;
  let emissiveUv = transformedMaterialUv(material.emissiveTextureCoordinatesTransform, material.emissiveTextureCoordinatesMetadata, material.emissiveTextureCoordinatesRotation, in);
  let emissiveSample = sampleMaterialTexture(emissiveTexture, emissiveTexture_sampler, emissiveUv, material.emissiveTextureCoordinatesMetadata.zw).rgb;
  let color = albedo + emissive * emissiveIntensity * emissiveSample;
  var output : StandardPbrOutput;
  output.color = vec4<f32>(translucent_fog_transmission(view, in.worldPos, color, alpha, vec3<f32>(0.0), vec3<f32>(0.0)), alpha);
#ifdef REFLECTION_FALLBACK_AVAILABLE
  output.reflectionFallback = vec4<f32>(vec3<f32>(0.0), 1.0);
#endif
  return output;
}

fn evaluateStandardSurface(in : VsOut, factors : StandardSurfaceFactors) -> StandardPbrOutput {
  var useDirectDfgLut = false;
#ifdef DIRECT_DFG_LUT_AVAILABLE
  useDirectDfgLut = material.directMultiscatteringLut != 0u;
#endif
  let normalSpread = geometricNormalSpread(in.worldNormal);
  let baseUv = transformedMaterialUv(material.baseColorTextureCoordinatesTransform, material.baseColorTextureCoordinatesMetadata, material.baseColorTextureCoordinatesRotation, in);
  let baseSample = sampleMaterialTexture(baseColorTexture, baseColorTexture_sampler, baseUv, material.baseColorTextureCoordinatesMetadata.zw);
  let vertexColor = materialVertexColor(in);
  alphaTest(factors.baseColor.a * baseSample.a * vertexColor.a);
  let alpha = factors.baseColor.a * baseSample.a * vertexColor.a;
  let albedo = factors.baseColor.rgb * baseSample.rgb * vertexColor.rgb;

  // Metallic-roughness texture sampling with per-field channel selectors
  // (D-8): glTF 2.0 default layout B=metallic, G=roughness, R=occlusion is
  // encoded by the host as 4 independent f32 selectors in the merged UBO
  // (metallicChannel/roughnessChannel/aoChannel/extraChannel). Cast to u32
  // at the pick_channel call site; values stay in {0,1,2,3}.
  let mrUv = transformedMaterialUv(material.metallicRoughnessTextureCoordinatesTransform, material.metallicRoughnessTextureCoordinatesMetadata, material.metallicRoughnessTextureCoordinatesRotation, in);
  let mrSample = sampleMaterialTexture(metallicRoughnessTexture, metallicRoughnessTexture_sampler, mrUv, material.metallicRoughnessTextureCoordinatesMetadata.zw);
  let metallic = clamp(
    finiteScalar(factors.metallic, 0.0) *
      finiteScalar(pick_channel(mrSample, u32(material.metallicChannel)), 1.0),
    0.0,
    1.0,
  );
  let roughnessTex = clamp(
    finiteScalar(pick_channel(mrSample, u32(material.roughnessChannel)), 1.0),
    0.0,
    1.0,
  );

  // Layer-2 fail-fast: shader internal clamp keeps D_GGX finite for
  // roughness=0 even if the asset somehow bypasses layer-1 register
  // fail-fast (plan-strategy section 5.3 + AC-02 (b)+(c)). Direct D_GGX and
  // the split-sum IBL lookup share this one anti-aliased roughness.
  let iblRoughness = specularAntiAliasedRoughness(
    clamp(max(finiteScalar(factors.roughness, 0.5), 0.04) * roughnessTex, 0.04, 1.0), normalSpread);
  let a = iblRoughness * iblRoughness;

  // TBN basis composed via forgeax_pbr::tbn helpers; default fallback
  // (defaultNormalTextureView) RG=(128,128) -> tangent (0,0,1) -> world n
  // unchanged.
  let normalUv = transformedMaterialUv(material.normalTextureCoordinatesTransform, material.normalTextureCoordinatesMetadata, material.normalTextureCoordinatesRotation, in);
  let normSampleRg = sampleMaterialTexture(normalTexture, normalTexture_sampler, normalUv, material.normalTextureCoordinatesMetadata.zw).rg;
  let normTangent = scaleTangentSpaceNormal(
    decodeTangentSpaceNormalRg(normSampleRg), material.normalScale,
  );
  let n = applyTBN(in.worldNormal, in.worldTangent, normTangent);

  let v = normalize(view.cameraPos - in.worldPos);
  let specularUv = transformedMaterialUv(material.specularTintTextureCoordinatesTransform, material.specularTintTextureCoordinatesMetadata, material.specularTintTextureCoordinatesRotation, in);
  let specularTint = material.specularTint * sampleMaterialTexture(
    specularTintTexture, specularTintSampler, specularUv, material.specularTintTextureCoordinatesMetadata.zw,
  ).rgb;
  let safeIor = max(finiteScalar(material.ior, 1.5), 1.0);
  let dielectricF0 = pow((safeIor - 1.0) / (safeIor + 1.0), 2.0);
  let f0 = mix(vec3<f32>(dielectricF0) * specularTint, albedo, metallic);
  var diffuseAlbedo = albedo;
#ifdef TRANSMISSION_AVAILABLE
  let transmissionUv = transformedMaterialUv(
    material.transmissionTextureCoordinatesTransform,
    material.transmissionTextureCoordinatesMetadata, material.transmissionTextureCoordinatesRotation,
    in,
  );
  let thicknessUv = transformedMaterialUv(
    material.thicknessTextureCoordinatesTransform,
    material.thicknessTextureCoordinatesMetadata, material.thicknessTextureCoordinatesRotation,
    in,
  );
  let transmissionSample = sampleMaterialTexture(
    transmissionTexture,
    transmissionSampler,
    transmissionUv,
    material.transmissionTextureCoordinatesMetadata.zw,
  ).r;
  let thicknessSample = sampleMaterialTexture(
    thicknessTexture,
    thicknessSampler,
    thicknessUv,
    material.thicknessTextureCoordinatesMetadata.zw,
  ).g;
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
  let coatRoughness = specularAntiAliasedRoughness(max(factors.clearcoatRoughness, 0.04), normalSpread);
  let coatAlpha = coatRoughness * coatRoughness;
  let coatF = f_schlick(max(dot(n, v), 0.0), vec3<f32>(0.04)) * factors.clearcoat;

  // Ambient (IBL) + 1 + N + N accumulation
  // (feat-20260520-skylight-ibl-cubemap M3 / t48 +
  //  feat-20260520-directional-light-shadow-mapping +
  //  feat-20260518-pbr-direct-lighting-mvp Finding 4):
  //
  //   color = ambient(IBL) + directional(shadowed) + sum(point) + sum(spot)
  //
  // When the host Skylight bind group provides default-zero resources the IBL
  // helpers sample to vec3(0) and ambient = 0, so the shader falls through to
  // direct lighting naturally (zero contribution, no branch, no #if guard).
  //
  // sampleIblDiffuse / sampleIblSpecular are imported from
  // forgeax_pbr::ibl_sampling (ibl-sampling.wgsl) and take the
  // @group(1) @binding(7..13) Skylight resources as function arguments
  // -- the runtime helper module is zero-binding so the host owns the
  // binding layout (round-4 amend: Skylight merged into material BGL).
  // `a` above is the alpha form used by direct-light D_GGX; the split-sum
  // mip lookup consumes the unsquared `iblRoughness`.
  //
  // Direct lights (1 + N + N): one directional + N point + N spot, summed
  // sequentially. LIGHT_ARRAY_MAX_SLOTS = 4 host-side bounds the loop trip
  // counts. The directional path additionally projects worldPos through the
  // per-cascade light-space matrix in the fragment stage for shadow-map PCF
  // lookup (CSM, feat-20260613). Cluster owns punctual BRDF evaluation in the
  // clustered variant above.
  let kD = (vec3<f32>(1.0) - f_schlick(max(dot(n, v), 0.0), f0)) * (1.0 - metallic);
  var irradiance = vec3<f32>(0.0);
  var specularIbl = vec3<f32>(0.0);
  if (skylight.intensity < 0.0) {
    irradiance = sampleIblDiffuse(n, skylight.diffuseRotation, irradianceMap, irradianceSampler);
    // A negative intensity is the renderer-owned probe sentinel. The producer
    // stores -(probeIntensity + 1), so intensity=0 remains distinguishable
    // from the ordinary Skylight zero payload. The four color/rotation lanes
    // carry probe center and half extents in this mode; Skylight resources
    // remain unchanged and therefore preserve the ABI.
    specularIbl = sampleReflectionProbeSpecular(
      n, v, iblRoughness, f0, in.worldPos,
      vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB),
      skylight.rotation.xyz, vec4<f32>(0.0, 0.0, 0.0, 1.0),
      prefilterMap, prefilterSampler, brdfLut, irradianceSampler,
      skylightPrefilterMap, skylight.diffuseRotation, skylight.diffuseScale.xyz,
      max(-skylight.intensity - 1.0, 0.0), skylight.rotation.w > 0.5,
    );
  } else {
    irradiance = sampleIblDiffuse(n, skylight.rotation, irradianceMap, irradianceSampler);
    specularIbl = sampleIblSpecular(
      n, v, iblRoughness, f0,
      skylight.rotation,
      prefilterMap, prefilterSampler, brdfLut, irradianceSampler,
    );
  }
  let occlusionUv = transformedMaterialUv(material.occlusionTextureCoordinatesTransform, material.occlusionTextureCoordinatesMetadata, material.occlusionTextureCoordinatesRotation, in);
  let aoSample = sampleMaterialTexture(occlusionTexture, occlusionTexture_sampler, occlusionUv, material.occlusionTextureCoordinatesMetadata.zw);
  let ao = mix(1.0, aoSample.r, material.occlusionStrength);
  // feat-20260612-hdrp-ssao M7 round-2: `var` (mutable) so the
  // CLUSTER_FORWARD_AVAILABLE branch below can `ambient *=` the SSAO
  // factor. The non-HDRP path leaves ambient untouched.
  let skyColor = vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB);
  let skyFactor = select(skyColor * skylight.intensity, skylight.diffuseScale.xyz, skylight.intensity < 0.0);
  let specularEnvironmentScale = decodeSpecularEnvironmentScale(skyColor, skylight.intensity);
  var reflectionFallback = specularIbl * specularEnvironmentScale * (vec3<f32>(1.0) - coatF);
  var ambient = (kD * irradiance * diffuseAlbedo * skyFactor + specularIbl * specularEnvironmentScale) * (vec3<f32>(1.0) - coatF);
#ifdef PROBE_BLEND_AVAILABLE
  // group(3) is the per-object bind group; record zero is the object selected
  // by this draw, independent of instance count.
  let probeShPreblend = array<vec4<f32>, 9>(
    probeBlendRecords[1], probeBlendRecords[2], probeBlendRecords[3],
    probeBlendRecords[4], probeBlendRecords[5], probeBlendRecords[6],
    probeBlendRecords[7], probeBlendRecords[8], probeBlendRecords[9],
  );
  let probeLocalBlendFraction = probeBlendRecords[0].z;
  let probeDiffuseK = kD / max(vec3<f32>(1.0 - metallic), vec3<f32>(0.0001));
  let probeDiffuse = composeProbeDiffuse(probeShPreblend, probeLocalBlendFraction, n, irradiance * skyFactor, probeDiffuseK, albedo, metallic);
  ambient = (probeDiffuse + specularIbl * specularEnvironmentScale) * (vec3<f32>(1.0) - coatF);
#endif
  if (factors.clearcoat != 0.0) {
    // Keep the clearcoat lobe on the same selected environment as the base
    // specular lobe. Probe mode reuses the packed center/extents lanes in the
    // per-probe uniform; routing it through global Skylight IBL would make the
    // fallback a mixed-source projection and break c=1 source equivalence.
    var clearcoatIbl = vec3<f32>(0.0);
    if (skylight.intensity < 0.0) {
      clearcoatIbl = sampleReflectionProbeSpecular(
        n, v, coatRoughness, vec3<f32>(0.04), in.worldPos,
        vec3<f32>(skylight.colorR, skylight.colorG, skylight.colorB),
        skylight.rotation.xyz, vec4<f32>(0.0, 0.0, 0.0, 1.0),
        prefilterMap, prefilterSampler, brdfLut, irradianceSampler,
      skylightPrefilterMap, skylight.diffuseRotation, skylight.diffuseScale.xyz,
      max(-skylight.intensity - 1.0, 0.0), skylight.rotation.w > 0.5,
      );
    } else {
      clearcoatIbl = sampleIblSpecular(
        n, v, coatRoughness, vec3<f32>(0.04),
        skylight.rotation,
        prefilterMap, prefilterSampler, brdfLut, irradianceSampler,
      );
    }
    let clearcoatContribution = clearcoatIbl * factors.clearcoat * specularEnvironmentScale;
    ambient = ambient + clearcoatContribution;
    reflectionFallback = reflectionFallback + clearcoatContribution;
  }
  ambient = ambient * ao;
  reflectionFallback = reflectionFallback * ao;
#ifdef CLUSTER_FORWARD_AVAILABLE
#if STORAGE_BUFFER_AVAILABLE == true
  let screenAo = sampleStandardAmbientOcclusion(in.worldPos, view.worldViewProj,
    ssaoBlurredTexture, ssaoBlurredSampler);
  ambient *= screenAo;
  reflectionFallback *= screenAo;
#endif
#endif
  var color = ambient;
  var transmittedContribution=vec3<f32>(0.0);
  var transmittedCoefficient=vec3<f32>(0.0);
#ifdef TRANSMISSION_AVAILABLE
  let screenUv = in.ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  // Read the same renderer-owned transform tables that the vertex stage uses
  // instead of adding six more interstage varyings. WebGPU guarantees only 16
  // user-defined vertex output locations; keeping the affine conversion in
  // the fragment stage preserves that contract and keeps thickness in the
  // glTF unit-scale mesh space before measuring the refracted segment in world
  // metres.
  let localToWorld0 = in.transmissionBasisFirst.xyz;
  let localToWorld1 = vec3<f32>(
    in.transmissionBasisFirst.w,
    in.transmissionBasisSecond.x,
    in.transmissionBasisSecond.y,
  );
  let localToWorld2 = vec3<f32>(
    in.transmissionBasisSecond.z,
    in.transmissionBasisSecond.w,
    in.ndc.w,
  );
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
    transmissionBackdropSampler,
    clamp(screenUv, vec2<f32>(0.0), vec2<f32>(1.0)),
    backdropLod,
  ).rgb;
  var transmittedBackdrop = unrefractedBackdrop;
  if (refractedLengthSquared > 1e-6 && insideGuardBand) {
    transmittedBackdrop = textureSampleLevel(
      transmissionBackdropTexture,
      transmissionBackdropSampler,
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
  transmittedCoefficient=transmittedEnergy*beerAttenuation;
  transmittedContribution=finiteColor(transmittedBackdrop,vec3<f32>(0.0))*transmittedCoefficient;
  color+=transmittedContribution;
#endif
  var directionalShadow = 1.0;
  // Keep the receiver path unless the final shading normal proves zero direct response.
  var needsDirectionalShadow = factors.clearcoat != 0.0 || !(dot(n, normalize(-view.lightDir)) <= 0.0);
#ifdef CLEARCOAT_AVAILABLE
  needsDirectionalShadow = true;
#endif
#ifdef DIFFUSE_TRANSMISSION_AVAILABLE
  needsDirectionalShadow = true;
#endif
#ifdef TRANSMISSION_AVAILABLE
  needsDirectionalShadow = true;
#endif
  if (factors.receiveShadows && needsDirectionalShadow) {
    directionalShadow = evalDirectionalShadowFactorAtPixel(n, in.worldPos, in.viewZ, 0u, in.clip.xy);
  }
  let directionalBase = evalDirectionalNoShadow(n, v, diffuseAlbedo, metallic, a, f0, vec3<f32>(0.0),
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, irradianceSampler,
#endif
  );
  color = color + view_apply_direct_solar(view, directionalShadow * directionalBase, in.worldPos);
  if (factors.clearcoat != 0.0) {
    let directionalClearcoat = evalDirectionalNoShadow(
      n, v, vec3<f32>(0.0), 1.0, coatAlpha, vec3<f32>(0.04), vec3<f32>(0.0),
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, irradianceSampler,
#endif
    );
    color = color + view_apply_direct_solar(view, directionalShadow * factors.clearcoat * directionalClearcoat, in.worldPos);
  }
#ifdef CLUSTER_FORWARD_AVAILABLE
  // NDC from vertex shader (perspective-divided clip-space, interpolated).
  // view_z: NDC depth for cluster Z-slice lookup.
  color = color + evaluateStandardClusterLights(
    in.ndc.xyz, in.viewZ, in.worldPos, n, v, diffuseAlbedo, metallic, a, f0, vec3<f32>(0.0), false, factors.receiveShadows, 0xffffffffu,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, irradianceSampler,
#endif
  );
  if (factors.clearcoat != 0.0) {
      color = color + factors.clearcoat * evaluateStandardClusterLights(
        in.ndc.xyz, in.viewZ, in.worldPos, n, v, vec3<f32>(0.0), 1.0, coatAlpha, vec3<f32>(0.04), vec3<f32>(0.0), false, factors.receiveShadows, 0xffffffffu,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, irradianceSampler,
#endif
      );
    }
#else
  // Local lights are cluster-owned in the current render topology. The
  // no-cluster variant intentionally remains directional + IBL only; this
  // keeps its group(0) contract aligned with the latest Standard pipeline,
  // where point/spot data no longer lives in the View bind group.
#endif // CLUSTER_FORWARD_AVAILABLE
  let emissiveUv = transformedMaterialUv(material.emissiveTextureCoordinatesTransform, material.emissiveTextureCoordinatesMetadata, material.emissiveTextureCoordinatesRotation, in);
  let emissiveSample = sampleMaterialTexture(emissiveTexture, emissiveTexture_sampler, emissiveUv, material.emissiveTextureCoordinatesMetadata.zw).rgb;
  // Evaluate texture derivatives uniformly; the per-instance lighting switch
  // selects the result, never a divergent implicit-derivative sampling path.
  color = select(albedo, color, factors.lighting) + factors.emissive * factors.emissiveIntensity * emissiveSample;
  transmittedContribution=select(vec3<f32>(0.0),transmittedContribution,factors.lighting);
  transmittedCoefficient=select(vec3<f32>(0.0),transmittedCoefficient,factors.lighting);
  var output : StandardPbrOutput;
  output.color = vec4<f32>(translucent_fog_transmission(view, in.worldPos, color, alpha, transmittedContribution, transmittedCoefficient), alpha);
#ifdef REFLECTION_FALLBACK_AVAILABLE
  output.reflectionFallback = vec4<f32>(select(vec3<f32>(0.0), reflectionFallback, factors.lighting), 1.0);
#endif
  return output;
}

// ── G-buffer output struct (feat-20260612-hdrp-deferred-shading M2 / w12) ──
//
