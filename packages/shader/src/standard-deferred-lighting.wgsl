#import forgeax_shadow::capsule::{capsuleVisibility}
#import forgeax_pbr::contact_shadow::{directionalContactShadow}
#define_import_path forgeax_standard::deferred_lighting
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE
#pragma variant_axis DIRECT_DFG_LUT_AVAILABLE

#import forgeax_view::common::{viewDirectionToCamera, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_scene_temporal::{sceneViewZ}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, decodeStandardReceiverNormal, decodeStandardReflectance, STANDARD_GBUFFER_NO_RECEIVE_BIT, STANDARD_GBUFFER_PROBE_ROW_MASK, STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT}
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardEnvironment, evaluateStandardDirectSplit}
#import forgeax_pbr::ibl_shared::{standardSpecularOcclusion}

@group(1) @binding(0) var normalRoughness : texture_2d<u32>;
@group(1) @binding(1) var albedoMetallic : texture_2d<u32>;
@group(1) @binding(2) var f0Occlusion : texture_2d<u32>;
@group(1) @binding(3) var lightingContext : texture_2d<u32>;
@group(1) @binding(4) var sceneDepth : texture_depth_2d;
@group(1) @binding(5) var screenOcclusion : texture_2d<f32>;
@group(1) @binding(6) var linearSampler : sampler;
struct DeferredLightingParams {
  lanes : vec4<f32>,
  occlusion : vec4<f32>,
};
@group(1) @binding(7) var<uniform> params : DeferredLightingParams;
@group(1) @binding(8) var irradianceMap : texture_cube<f32>;
@group(1) @binding(9) var prefilterMap : texture_2d<f32>;
@group(1) @binding(10) var brdfLut : texture_2d<f32>;
@group(1) @binding(11) var skylightPrefilterMap : texture_2d<f32>;
@group(1) @binding(12) var<uniform> skylight : SkylightUniforms;
@group(1) @binding(13) var<storage, read> capsules : array<vec4<f32>>;
@group(1) @binding(14) var<storage, read> capsuleTiles : array<u32>;
@group(1) @binding(15) var receiverGeometry : texture_2d<u32>;
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(1) @binding(16) var directDfgLut: texture_2d<f32>;
// Preserve the filtering contract through the shared BRDF texture parameters.
fn directDfgTextureFilteringWitness() {
  let sample = textureSample(directDfgLut, linearSampler, vec2<f32>(0.0));
  let occlusion = textureSample(screenOcclusion, linearSampler, vec2<f32>(0.0));
  let irradiance = textureSample(irradianceMap, linearSampler, vec3<f32>(0.0, 0.0, 1.0));
  let prefilter = textureSample(prefilterMap, linearSampler, vec2<f32>(0.5));
  let brdf = textureSample(brdfLut, linearSampler, vec2<f32>(0.0));
  let skylightPrefilter = textureSample(skylightPrefilterMap, linearSampler, vec2<f32>(0.5));
}
#endif
@group(3) @binding(0) var<storage, read> probeBlendRecords : array<vec4<f32>>;

struct DeferredOutput {
  @location(0) color : vec4<f32>,
  @location(1) reflectionFallback : vec4<f32>,
  @location(2) specularResponse : vec4<f32>,
  @location(3) diffuse : vec4<f32>,
};

const CAPSULE_TILE_SIZE : u32 = 16u;
const CAPSULE_TILE_COUNT_BITS : u32 = 6u;

fn directionalCapsuleShadow(position : vec3<f32>, pixel : vec2<i32>) -> f32 {
  let toLight = normalize(-view.lightDir);
  let tilesX = (textureDimensions(sceneDepth).x + CAPSULE_TILE_SIZE - 1u) / CAPSULE_TILE_SIZE;
  let tile = vec2<u32>(pixel) / CAPSULE_TILE_SIZE;
  let headerIndex = tile.y * tilesX + tile.x;
  if (headerIndex >= arrayLength(&capsuleTiles)) { return 1.0; }
  let header = capsuleTiles[headerIndex];
  let count = header & ((1u << CAPSULE_TILE_COUNT_BITS) - 1u);
  let offset = header >> CAPSULE_TILE_COUNT_BITS;
  var visibility = 1.0;
  for (var i = 0u; i < count; i++) {
    let index = capsuleTiles[offset + i] * 2u;
    let start = capsules[index];
    let end = capsules[index + 1u];
    visibility *= capsuleVisibility(position, toLight, start.xyz, start.w, end.xyz, end.w, params.lanes.w);
    if (visibility <= 0.001) { break; }
  }
  return visibility;
}

@vertex
fn vs_standard_deferred(@builtin(vertex_index) index : u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}

fn resolveStandardDeferred(in : FullscreenOutput) -> DeferredOutput {
  let pixel = vec2<i32>(in.position.xy);
  let depth = textureLoad(sceneDepth, pixel, 0);
  if (depth <= 0.0) { discard; }
  let context = textureLoad(lightingContext, pixel, 0).r;
  // One masked full-screen triangle per resident reflection environment. No
  // material, mesh or instance geometry is submitted by this lighting pass.
  if (context >> 24u != u32(skylight.diffuseScale.w)) { discard; }
  let uv = in.position.xy / vec2<f32>(textureDimensions(sceneDepth));
  let ndc = vec3<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth);
  let homogeneous = view.inverseViewProj * vec4<f32>(ndc, 1.0);
  let position = homogeneous.xyz / homogeneous.w;
  let normalSample = loadStandardNormalRoughness(normalRoughness, pixel);
  let normal = normalSample.xyz;
  let roughness = normalSample.w;
  let albedo = decodeStandardReflectance(textureLoad(albedoMetallic, pixel, 0).r);
  let specular = textureLoad(f0Occlusion, pixel, 0).rg;
  let response = decodeStandardReflectance(specular.r);
  let dielectricSpecular = decodeStandardReflectance(specular.g);
  let direction = viewDirectionToCamera(position);
  var sh : array<vec4<f32>, 9>;
  var localBlend = 0.0;
  let probeRow = context & STANDARD_GBUFFER_PROBE_ROW_MASK;
  let receiveShadows = (context & STANDARD_GBUFFER_NO_RECEIVE_BIT) == 0u;
  let receiver = textureLoad(receiverGeometry, pixel, 0).rg;
  let base = probeRow * 16u;
  if (probeRow > 0u && base + 9u < arrayLength(&probeBlendRecords)) {
    let header = probeBlendRecords[base];
    if (u32(header.x) + 1u == probeRow) {
      localBlend = header.z;
      for (var band = 0u; band < 9u; band += 1u) { sh[band] = probeBlendRecords[base + 1u + band]; }
    }
  }
  let environment = evaluateStandardEnvironment(position, normal, direction, albedo.rgb, vec3<f32>(0.0),
    albedo.a, roughness, response.rgb, dielectricSpecular, albedo.rgb, skylight, irradianceMap, linearSampler,
    prefilterMap, linearSampler, brdfLut, skylightPrefilterMap, sh, localBlend);
  var screenAo = 1.0;
  // The AO producer already applied the intensity exponent before filtering.
  if (params.lanes.x > 0.0) {
    screenAo = clamp(textureSampleLevel(screenOcclusion, linearSampler, uv, 0.0).r, 0.0, 1.0);
  }
  let ao = response.a * screenAo;
  let nDotV = max(dot(normal, direction), 0.0);
  let specularAo = standardSpecularOcclusion(nDotV, ao, roughness);
  let viewZ = sceneViewZ(view.worldViewProj * vec4<f32>(position, 1.0), view.temporalProjection);
  var shadow = 1.0;
  // Deferred surfaces have no diffuse transmission. A back-facing BRDF has
  // zero directional radiance, so its CSM/contact/capsule factor is unused.
  if (receiveShadows && dot(normal, normalize(-view.lightDir)) > 0.0) {
    // Geometry owns this exact raster plane; BRDF and decals retain their
    // independent shading normal. No depth-neighborhood inference is needed.
    let receiverNormal = decodeStandardReceiverNormal(receiver.x);
    let directionalLayerBase = receiver.x >> 24u;
    shadow = evalDirectionalShadowFactorAtPixel(select(receiverNormal, normal, view.splitPlanes[0].w > 0.5), position, viewZ, directionalLayerBase, in.position.xy);
    if (view.directionalShadowFilter.w > 0.0 && shadow > 0.0) {
      shadow *= directionalContactShadow(view, sceneDepth, position, normal, pixel, params.lanes.y);
    }
    if (params.lanes.z > 0.0 && shadow > 0.0 && dot(normal, -view.lightDir) > 0.0) {
      shadow *= directionalCapsuleShadow(position, pixel);
    }
  }
  let receiverChannels = receiver.y;
  let direct = evaluateStandardDirectSplit(position, ndc, viewZ, in.position.xy, normal, direction, albedo.rgb, vec3<f32>(0.0),
    albedo.a, roughness * roughness, response.rgb, shadow, receiveShadows, receiverChannels,
    textureLoad(lightingContext, pixel, 0).g >> 24u > 0u,
    (receiver.x & STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT) != 0u,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, linearSampler,
#endif
  );
  // Add radiance to geometry-owned SceneColor; attachment blending preserves
  // its emissive and opacity without sampling the active color attachment.
  let directAo = mix(1.0, screenAo, clamp(params.occlusion.x, 0.0, 1.0));
  let diffuse = environment.diffuse * ao + direct.diffuse * directAo;
  return DeferredOutput(vec4<f32>(environment.diffuse * ao + environment.specular * specularAo + direct.radiance * directAo, 0.0),
    vec4<f32>(environment.specular * specularAo, 1.0),
    vec4<f32>(environment.response.rgb * standardSpecularOcclusion(nDotV, response.a, roughness), environment.response.a),
    vec4<f32>(diffuse, 0.0));
}

@fragment
fn fs_standard_deferred(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveStandardDeferred(in).color;
}

@fragment
fn fs_standard_deferred_reflections(in : FullscreenOutput) -> DeferredOutput {
  return resolveStandardDeferred(in);
}

struct SubsurfaceLightingOutput {
  @location(0) color : vec4<f32>,
  @location(1) diffuse : vec4<f32>,
};
@fragment fn fs_standard_deferred_subsurface(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveStandardDeferred(in);
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}
