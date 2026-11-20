#import forgeax_shadow::capsule::{capsuleVisibility}
#import forgeax_pbr::contact_shadow::{directionalContactShadow}
#define_import_path forgeax_standard::deferred_lighting
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE
#pragma variant_axis DIRECT_DFG_LUT_AVAILABLE

#import forgeax_view::common::{viewDirectionToCamera, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_scene_temporal::{sceneFragmentViewZ}
#import forgeax_pbr::gbuffer::{decodeStandardGBufferNormal, standardGBufferValid, decodeStandardReceiverNormal, decodeStandardReflectance, decodeStandardGBufferReflectance, standardSubsurfaceActive, compactGBufferLit, compactGBufferSubsurface, decodeCompactBaseColor, STANDARD_GBUFFER_NO_RECEIVE_BIT, STANDARD_GBUFFER_PROBE_ROW_MASK, STANDARD_GBUFFER_V2_DIRECT_DFG_BIT}
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel}
#ifdef DIRECTIONAL_PCSS_AVAILABLE
#import forgeax_pbr::lighting_directional::{canUseProjectedDirectionalPcf, evalProjectedDirectionalShadow}
#endif
#import forgeax_pbr::standard_lighting::{SkylightUniforms, StandardEnvironment, evaluateStandardEnvironmentFromRadiance, sampleSkylightRadiance, evaluateStandardDirectSplit}
#import forgeax_pbr::pmrem::{samplePmremArrayLayer}
#import forgeax_pbr::ibl_sampling::{box_project, environmentDfg, environmentSingleScatteringFromDfg, environmentReflectionDirection, reflectionProbeBoundaryWeight, sampleIblRadiance}
#import forgeax_pbr::ibl_shared::{standardSpecularOcclusion}

@group(1) @binding(0) var normalRoughness : texture_2d<u32>;
@group(1) @binding(1) var albedoMetallic : texture_2d<u32>;
@group(1) @binding(2) var dielectricSpecularSource : texture_2d<u32>;
@group(1) @binding(3) var lightingContext : texture_2d<u32>;
@group(1) @binding(4) var sceneDepth : texture_depth_2d;
@group(1) @binding(5) var screenOcclusion : texture_2d<f32>;
@group(1) @binding(6) var linearSampler : sampler;
#ifdef DIRECTIONAL_PCSS_AVAILABLE
@id(64005) override standardDeferredProjectedPcf : bool = false;
#endif
@id(64004) override standardDeferredSubsurface : bool = false;
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

struct DeferredReflectionProbe {
  centerAndIntensity : vec4<f32>,
  extentsAndAddress : vec4<f32>,
};

// The reflection owner admits at most 16 rows per frame.
const DEFERRED_REFLECTION_PROBE_COUNT : u32 = 16u;

struct DeferredReflectionTable {
  diffuseScale : vec4<f32>,
  diffuseRotation : vec4<f32>,
  ambientIrradiance : vec4<f32>,
  ground : vec4<f32>,
  probes : array<DeferredReflectionProbe, DEFERRED_REFLECTION_PROBE_COUNT>,
};
@group(3) @binding(1) var reflectionClass0 : texture_2d_array<f32>;
@group(3) @binding(2) var reflectionClass1 : texture_2d_array<f32>;
@group(3) @binding(3) var<uniform> reflectionTable : DeferredReflectionTable;

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

struct DeferredSurface {
  position : vec3<f32>,
  ndc : vec3<f32>,
  viewZ : f32,
  packedNormal : vec2<u32>,
  context : vec2<u32>,
  normal : vec3<f32>,
  roughness : f32,
  albedo : vec4<f32>,
  response : vec4<f32>,
  dielectricSpecular : vec4<f32>,
  direction : vec3<f32>,
};

struct DeferredCoverage {
  packedNormal : vec2<u32>,
  context : vec2<u32>,
  compactMaterial : u32,
};

fn loadDeferredCoverage(pixel : vec2<i32>, expectedEnvironment : u32, compact : bool, compactContext : u32) -> DeferredCoverage {
  let packedNormal = textureLoad(normalRoughness, pixel, 0).rg;
  if (compact) {
    let b = textureLoad(dielectricSpecularSource, pixel, 0).r;
    if (!compactGBufferLit(b)) { discard; }
    if (expectedEnvironment <= 255u && compactContext >> 24u != expectedEnvironment) { discard; }
    var customData = 0u;
    if (standardDeferredSubsurface && compactGBufferSubsurface(b)) {
      customData = textureLoad(lightingContext, pixel, 0).r;
    }
    return DeferredCoverage(packedNormal, vec2<u32>(compactContext, customData), b);
  }
  if (!standardGBufferValid(packedNormal)) { discard; }
  let context = textureLoad(lightingContext, pixel, 0).rg;
  // A precise filter keeps standalone probes from fetching unrelated scene depth.
  if (expectedEnvironment <= 255u && context.x >> 24u != expectedEnvironment) { discard; }
  return DeferredCoverage(packedNormal, context, 0u);
}

fn loadDeferredSurface(in : FullscreenOutput, coverage : DeferredCoverage, compact : bool) -> DeferredSurface {
  let pixel = vec2<i32>(in.position.xy);
  let packedNormal = coverage.packedNormal;
  let context = coverage.context;
  let depth = textureLoad(sceneDepth, pixel, 0);
  if (depth <= 0.0) { discard; }
  let uv = in.position.xy / vec2<f32>(textureDimensions(sceneDepth));
  let ndc = vec3<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth);
  let homogeneous = view.inverseViewProj * vec4<f32>(ndc, 1.0);
  let position = homogeneous.xyz / homogeneous.w;
  let normalSample = decodeStandardGBufferNormal(packedNormal);
  let normal = normalSample.xyz;
  var roughness = normalSample.w;
  var albedo : vec4<f32>;
  var response : vec4<f32>;
  var dielectricSpecular : vec4<f32>;
  let color = textureLoad(albedoMetallic, pixel, 0).r;
  if (compact) {
    let b = unpack4x8unorm(coverage.compactMaterial);
    let c = unpack4x8unorm(color);
    albedo = vec4<f32>(decodeCompactBaseColor(c.rgb), b.r);
    roughness = b.b;
    let dielectricF0 = vec3<f32>(b.g * 0.08);
    let f0 = mix(dielectricF0, albedo.rgb, b.r);
    dielectricSpecular = vec4<f32>(dielectricF0, clamp(f0.g * 50.0, 0.0, 1.0));
    response = vec4<f32>(f0, c.a);
  } else {
    albedo = decodeStandardReflectance(color);
    let specular = textureLoad(dielectricSpecularSource, pixel, 0).r;
    let reflectance = decodeStandardGBufferReflectance(albedo, specular, packedNormal);
    response = reflectance.response;
    dielectricSpecular = reflectance.dielectricSpecular;
  }
  let direction = viewDirectionToCamera(position);
  // The fullscreen triangle has a different clip.w from the scene surface.
  let viewZ = sceneFragmentViewZ(vec4<f32>(in.position.xy, depth, homogeneous.w), view.temporalProjection);
  return DeferredSurface(position, ndc, viewZ, packedNormal, context, normal, roughness, albedo,
    response, dielectricSpecular, direction);
}

fn deferredEnvironment(surface : DeferredSurface, sky : SkylightUniforms, radiance : vec3<f32>) -> StandardEnvironment {
  var sh : array<vec4<f32>, 9>;
  var localBlend = 0.0;
  let probeRow = surface.context.x & STANDARD_GBUFFER_PROBE_ROW_MASK;
  let base = probeRow * 16u;
  if (probeRow > 0u && base + 9u < arrayLength(&probeBlendRecords)) {
    let header = probeBlendRecords[base];
    if (u32(header.x) + 1u == probeRow) {
      localBlend = header.z;
      for (var band = 0u; band < 9u; band += 1u) { sh[band] = probeBlendRecords[base + 1u + band]; }
    }
  }
  return evaluateStandardEnvironmentFromRadiance(surface.normal, surface.direction,
    surface.albedo.rgb, vec3<f32>(0.0), surface.albedo.a, surface.roughness, surface.response.rgb,
    surface.dielectricSpecular, surface.albedo.rgb, sky, irradianceMap, linearSampler, brdfLut,
    sh, localBlend, radiance);
}

fn deferredScreenOcclusion(position : vec2<f32>) -> f32 {
  // The AO producer already applied the intensity exponent before filtering.
  if (params.lanes.x <= 0.0) { return 1.0; }
  let uv = position / vec2<f32>(textureDimensions(sceneDepth));
  return clamp(textureSampleLevel(screenOcclusion, linearSampler, uv, 0.0).r, 0.0, 1.0);
}

fn shadeDeferredSurface(in : FullscreenOutput, surface : DeferredSurface, environment : StandardEnvironment,
  receiver : vec2<u32>, compact : bool) -> DeferredOutput {
  let pixel = vec2<i32>(in.position.xy);
  let normal = surface.normal;
  let roughness = surface.roughness;
  let direction = surface.direction;
  let position = surface.position;
  let albedo = surface.albedo;
  let response = surface.response;
  let ndc = surface.ndc;
  let viewZ = surface.viewZ;
  let context = surface.context;
  let packedNormal = surface.packedNormal;
  let receiveShadows = (context.x & STANDARD_GBUFFER_NO_RECEIVE_BIT) == 0u;
  let screenAo = deferredScreenOcclusion(in.position.xy);
  let ao = response.a * screenAo;
  let nDotV = max(dot(normal, direction), 0.0);
  let specularAo = standardSpecularOcclusion(nDotV, ao, roughness);
  var shadow = 1.0;
  // Deferred surfaces have no diffuse transmission. A back-facing BRDF has
  // zero directional radiance, so its CSM/contact/capsule factor is unused.
  let nDotL = dot(normal, normalize(-view.lightDir));
  if (receiveShadows && nDotL > 0.0) {
    let directionalLayerBase = receiver.x >> 24u;
#ifdef DIRECTIONAL_PCSS_AVAILABLE
    if (standardDeferredProjectedPcf && canUseProjectedDirectionalPcf()) {
      shadow = evalProjectedDirectionalShadow(position, viewZ, directionalLayerBase, in.position.xy, nDotL);
    } else
#endif
    {
      let receiverNormal = decodeStandardReceiverNormal(receiver.x);
      shadow = evalDirectionalShadowFactorAtPixel(select(receiverNormal, normal, view.splitPlanes[0].w > 0.5 || (compact && receiver.x == 0u)),
        position, viewZ, directionalLayerBase, in.position.xy);
    }
    if (view.directionalShadowFilter.w > 0.0 && shadow > 0.0) {
      shadow *= directionalContactShadow(view, sceneDepth, position, normal, pixel, params.lanes.y, normalRoughness, compact);
    }
    if (params.lanes.z > 0.0 && shadow > 0.0 && dot(normal, -view.lightDir) > 0.0) {
      shadow *= directionalCapsuleShadow(position, pixel);
    }
  }
  let receiverChannels = receiver.y;
  let diffuseToSubsurface = standardDeferredSubsurface && standardSubsurfaceActive(context.y);
  let direct = evaluateStandardDirectSplit(position, ndc, viewZ, in.position.xy, normal, direction, albedo.rgb, vec3<f32>(0.0),
    albedo.a, roughness * roughness, response.rgb, shadow, receiveShadows, receiverChannels,
    diffuseToSubsurface,
#ifdef DIRECTIONAL_PCSS_AVAILABLE
    select(0u, u32(view.fogSky.w), !compact && standardDeferredProjectedPcf),
#else
    0u,
#endif
    false,
    !compact && (packedNormal.x & STANDARD_GBUFFER_V2_DIRECT_DFG_BIT) != 0u,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, linearSampler,
#endif
  );
  // Add radiance to geometry-owned SceneColor; attachment blending preserves
  // its emissive and opacity without sampling the active color attachment.
  let directAo = mix(1.0, screenAo, clamp(params.occlusion.x, 0.0, 1.0));
  let diffuse = environment.diffuse * ao;
  let sceneDiffuse = select(diffuse, vec3<f32>(0.0), diffuseToSubsurface);
  let subsurface = select(vec3<f32>(0.0), diffuse + direct.diffuse * directAo, diffuseToSubsurface);
  return DeferredOutput(vec4<f32>(sceneDiffuse + environment.specular * specularAo + direct.radiance * directAo, 0.0),
    vec4<f32>(environment.specular * specularAo, 1.0),
    vec4<f32>(environment.response.rgb * standardSpecularOcclusion(nDotV, response.a, roughness), environment.response.a),
    vec4<f32>(subsurface, 0.0));
}

fn resolveStandardDeferredSurface(in : FullscreenOutput, surface : DeferredSurface,
  receiver : vec2<u32>, compact : bool) -> DeferredOutput {
  let reflection = environmentReflectionDirection(surface.normal, surface.direction, surface.roughness);
  let radiance = sampleSkylightRadiance(skylight, surface.position, reflection, surface.roughness,
    prefilterMap, linearSampler, skylightPrefilterMap);
  return shadeDeferredSurface(in, surface, deferredEnvironment(surface, skylight, radiance), receiver, compact);
}

fn resolveStandardDeferred(in : FullscreenOutput) -> DeferredOutput {
  let pixel = vec2<i32>(in.position.xy);
  let coverage = loadDeferredCoverage(pixel, u32(skylight.diffuseScale.w), false, 0u);
  let surface = loadDeferredSurface(in, coverage, false);
  return resolveStandardDeferredSurface(in, surface, textureLoad(receiverGeometry, pixel, 0).rg, false);
}

fn reflectionProbeClass(row : DeferredReflectionProbe) -> u32 {
  // Address lanes: box projection (1 bit), size/format class (4 bits), layer.
  return (u32(row.extentsAndAddress.w) >> 1u) & 15u;
}

fn reflectionProbeWeight(surface : DeferredSurface, row : DeferredReflectionProbe) -> f32 {
  return reflectionProbeBoundaryWeight(surface.position, row.centerAndIntensity.xyz, row.extentsAndAddress.xyz);
}

fn reflectionProbeSkyRadiance(direction : vec3<f32>, roughness : f32) -> vec3<f32> {
  return sampleIblRadiance(direction, roughness, reflectionTable.diffuseRotation,
    skylightPrefilterMap, linearSampler) * reflectionTable.diffuseScale.xyz;
}

fn reflectionProbeArrayRadiance(surface : DeferredSurface, reflection : vec3<f32>,
  row : DeferredReflectionProbe, weight : f32, map : texture_2d_array<f32>) -> vec3<f32> {
  var radiance = vec3<f32>(0.0);
  if (weight < 1.0) {
    radiance = reflectionProbeSkyRadiance(reflection, surface.roughness);
  }
  if (weight <= 0.0) { return radiance; }
  let address = u32(row.extentsAndAddress.w);
  var direction = reflection;
  if ((address & 1u) != 0u) {
    direction = box_project(surface.position, reflection, row.centerAndIntensity.xyz, row.extentsAndAddress.xyz);
  }
  // Local capture faces are already in world space.
  let local = samplePmremArrayLayer(map, linearSampler, address >> 5u, direction, surface.roughness);
  return mix(radiance, local * max(-row.centerAndIntensity.w - 1.0, 0.0), weight);
}

fn resolveStandardDeferredArraySurface(in : FullscreenOutput, surface : DeferredSurface,
  receiver : vec2<u32>, compact : bool, first : texture_2d_array<f32>,
  second : texture_2d_array<f32>, baseClassCount : u32) -> DeferredOutput {
  let env = surface.context.x >> 24u;
  var sky = skylight;
  var radiance = vec3<f32>(0.0);
  if (env == 0u || env > DEFERRED_REFLECTION_PROBE_COUNT) {
    let reflection = environmentReflectionDirection(surface.normal, surface.direction, surface.roughness);
    radiance = sampleSkylightRadiance(sky, surface.position, reflection, surface.roughness,
      skylightPrefilterMap, linearSampler, skylightPrefilterMap);
  } else {
    let row = reflectionTable.probes[env - 1u];
    let sizeClass = reflectionProbeClass(row);
    let weight = reflectionProbeWeight(surface, row);
    // Local captures replace only the directional PMREM. Diffuse, including
    // the broad multiple-scattering lobe, is independent of array admission.
    sky.intensity = row.centerAndIntensity.w;
    sky.diffuseScale = reflectionTable.diffuseScale;
    sky.diffuseRotation = reflectionTable.diffuseRotation;
    sky.ambientIrradiance = reflectionTable.ambientIrradiance;
    sky.ground = reflectionTable.ground;
    if (weight <= 0.0) {
      let reflection = environmentReflectionDirection(surface.normal, surface.direction, surface.roughness);
      radiance = reflectionProbeSkyRadiance(reflection, surface.roughness);
    } else if (sizeClass < baseClassCount) {
      let reflection = environmentReflectionDirection(surface.normal, surface.direction, surface.roughness);
      if (sizeClass == 0u) {
        radiance = reflectionProbeArrayRadiance(surface, reflection, row, weight, first);
      } else {
        radiance = reflectionProbeArrayRadiance(surface, reflection, row, weight, second);
      }
    }
    // Positive-weight pixels of a class outside the base window are shaded
    // by that class's bounded specular draw. Outside the box the base owns sky.
  }
  return shadeDeferredSurface(in, surface, deferredEnvironment(surface, sky, radiance), receiver, compact);
}

fn resolveStandardDeferredArrays(in : FullscreenOutput, first : texture_2d_array<f32>,
  second : texture_2d_array<f32>, baseClassCount : u32) -> DeferredOutput {
  let pixel = vec2<i32>(in.position.xy);
  let coverage = loadDeferredCoverage(pixel, 256u, false, 0u);
  let surface = loadDeferredSurface(in, coverage, false);
  return resolveStandardDeferredArraySurface(in, surface, textureLoad(receiverGeometry, pixel, 0).rg,
    false, first, second, baseClassCount);
}

struct ReflectionOverflowVertex {
  @builtin(position) position : vec4<f32>,
  @location(0) @interpolate(flat) sizeClass : u32,
};

fn overflowRectangle(vertex : u32, low : vec2<f32>, high : vec2<f32>) -> vec4<f32> {
  let corner = array<vec2<f32>, 6>(vec2<f32>(0, 0), vec2<f32>(1, 0), vec2<f32>(1, 1),
    vec2<f32>(0, 0), vec2<f32>(1, 1), vec2<f32>(0, 1))[vertex];
  return vec4<f32>(mix(low, high, corner), 0.0, 1.0);
}

@vertex
fn vs_standard_deferred_reflection_overflow(@builtin(vertex_index) vertex : u32,
  @builtin(instance_index) sizeClass : u32) -> ReflectionOverflowVertex {
  var low = vec2<f32>(1e8);
  var high = vec2<f32>(-1e8);
  for (var i = 0u; i < DEFERRED_REFLECTION_PROBE_COUNT; i += 1u) {
    let row = reflectionTable.probes[i];
    if (row.centerAndIntensity.w >= 0.0 || reflectionProbeClass(row) != sizeClass) { continue; }
    let center = row.centerAndIntensity.xyz;
    let extents = max(row.extentsAndAddress.xyz, vec3<f32>(0.0001));
    for (var j = 0u; j < 8u; j += 1u) {
      let signs = select(vec3<f32>(-1.0), vec3<f32>(1.0),
        (vec3<u32>(j) & vec3<u32>(1u, 2u, 4u)) != vec3<u32>(0u));
      let clip = view.worldViewProj * vec4<f32>(center + signs * extents, 1.0);
      // A box crossing the eye plane has no conservative corner bound.
      if (!(clip.w > 0.00001)) {
        return ReflectionOverflowVertex(overflowRectangle(vertex, vec2<f32>(-1), vec2<f32>(1)), sizeClass);
      }
      let p = clip.xy / clip.w;
      if (!all(abs(p) <= vec2<f32>(1e8))) {
        return ReflectionOverflowVertex(overflowRectangle(vertex, vec2<f32>(-1), vec2<f32>(1)), sizeClass);
      }
      low = min(low, p);
      high = max(high, p);
    }
  }
  if (any(low > high)) { return ReflectionOverflowVertex(vec4<f32>(2, 2, 0, 1), sizeClass); }
  // Pad by two internal pixels for rounding at the reconstructed box boundary.
  let margin = 4.0 / max(vec2<f32>(view.viewportWidth, view.viewportHeight), vec2<f32>(1.0));
  return ReflectionOverflowVertex(overflowRectangle(vertex, clamp(low - margin, vec2<f32>(-1), vec2<f32>(1)),
    clamp(high + margin, vec2<f32>(-1), vec2<f32>(1))), sizeClass);
}

fn resolveReflectionOverflow(in : ReflectionOverflowVertex, compact : bool, context : u32) -> vec3<f32> {
  let coverage = loadDeferredCoverage(vec2<i32>(in.position.xy), 256u, compact, context);
  let env = coverage.context.x >> 24u;
  if (env == 0u || env > DEFERRED_REFLECTION_PROBE_COUNT) { discard; }
  let row = reflectionTable.probes[env - 1u];
  if (reflectionProbeClass(row) != in.sizeClass) { discard; }
  let surface = loadDeferredSurface(FullscreenOutput(in.position, vec2<f32>(0.0)), coverage, compact);
  let weight = reflectionProbeWeight(surface, row);
  if (weight <= 0.0) { discard; }
  let reflection = environmentReflectionDirection(surface.normal, surface.direction, surface.roughness);
  let radiance = reflectionProbeArrayRadiance(surface, reflection, row, weight, reflectionClass0);
  let nDotV = max(dot(surface.normal, surface.direction), 0.0);
  let ab = environmentDfg(max(nDotV, 0.001), surface.roughness, brdfLut, linearSampler);
  let specular = surface.dielectricSpecular;
  let dielectric = environmentSingleScatteringFromDfg(ab, specular.rgb, specular.a);
  let metal = environmentSingleScatteringFromDfg(ab, surface.albedo.rgb, specular.a);
  let ao = surface.response.a * deferredScreenOcclusion(in.position.xy);
  return radiance * mix(dielectric, metal, surface.albedo.a)
    * standardSpecularOcclusion(nDotV, ao, surface.roughness);
}

@fragment
fn fs_standard_deferred_reflection_overflow(in : ReflectionOverflowVertex) -> @location(0) vec4<f32> {
  return vec4<f32>(resolveReflectionOverflow(in, false, 0u), 0.0);
}

struct ReflectionOverflowOutput {
  @location(0) color : vec4<f32>,
  @location(1) fallback : vec4<f32>,
};

@fragment
fn fs_standard_deferred_reflections_overflow(in : ReflectionOverflowVertex) -> ReflectionOverflowOutput {
  let specular = resolveReflectionOverflow(in, false, 0u);
  return ReflectionOverflowOutput(vec4<f32>(specular, 0.0), vec4<f32>(specular, 1.0));
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

@fragment fn fs_standard_deferred_array_single(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveStandardDeferredArrays(in, reflectionClass0, reflectionClass0, 1u).color;
}

@fragment fn fs_standard_deferred_reflections_array_single(in : FullscreenOutput) -> DeferredOutput {
  return resolveStandardDeferredArrays(in, reflectionClass0, reflectionClass0, 1u);
}

@fragment fn fs_standard_deferred_subsurface_array_single(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveStandardDeferredArrays(in, reflectionClass0, reflectionClass0, 1u);
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}

@fragment fn fs_standard_deferred_array_dual(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveStandardDeferredArrays(in, reflectionClass0, reflectionClass1, 2u).color;
}

@fragment fn fs_standard_deferred_reflections_array_dual(in : FullscreenOutput) -> DeferredOutput {
  return resolveStandardDeferredArrays(in, reflectionClass0, reflectionClass1, 2u);
}

@fragment fn fs_standard_deferred_subsurface_array_dual(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveStandardDeferredArrays(in, reflectionClass0, reflectionClass1, 2u);
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}

#ifdef DIRECTIONAL_PCSS_AVAILABLE
fn resolveCompactDeferred(in : FullscreenOutput, receiver : vec4<u32>) -> DeferredOutput {
  let coverage = loadDeferredCoverage(vec2<i32>(in.position.xy), u32(skylight.diffuseScale.w), true, receiver.y);
  let surface = loadDeferredSurface(in, coverage, true);
  return resolveStandardDeferredSurface(in, surface, vec2<u32>(receiver.z, receiver.x), true);
}

fn resolveCompactDeferredArrays(in : FullscreenOutput, first : texture_2d_array<f32>,
  second : texture_2d_array<f32>, baseClassCount : u32) -> DeferredOutput {
  let pixel = vec2<i32>(in.position.xy);
  let receiver = textureLoad(receiverGeometry, pixel, 0);
  let coverage = loadDeferredCoverage(pixel, 256u, true, receiver.y);
  let surface = loadDeferredSurface(in, coverage, true);
  return resolveStandardDeferredArraySurface(in, surface, vec2<u32>(receiver.z, receiver.x), true, first, second, baseClassCount);
}

@fragment fn fs_standard_deferred_compact(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveCompactDeferred(in, vec4<u32>(0xffffffffu, 0u, 0u, 0u)).color;
}

@fragment fn fs_standard_deferred_compact_channels(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveCompactDeferred(in, textureLoad(receiverGeometry, vec2<i32>(in.position.xy), 0)).color;
}

@fragment fn fs_standard_deferred_compact_channels_array_single(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveCompactDeferredArrays(in, reflectionClass0, reflectionClass0, 1u).color;
}

@fragment fn fs_standard_deferred_compact_channels_array_dual(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return resolveCompactDeferredArrays(in, reflectionClass0, reflectionClass1, 2u).color;
}

@fragment fn fs_standard_deferred_compact_overflow(in : ReflectionOverflowVertex) -> @location(0) vec4<f32> {
  return vec4<f32>(resolveReflectionOverflow(in, true,
    textureLoad(receiverGeometry, vec2<i32>(in.position.xy), 0).g), 0.0);
}

@fragment fn fs_standard_deferred_compact_subsurface(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveCompactDeferred(in, vec4<u32>(0xffffffffu, 0u, 0u, 0u));
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}

@fragment fn fs_standard_deferred_compact_subsurface_channels(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveCompactDeferred(in, textureLoad(receiverGeometry, vec2<i32>(in.position.xy), 0));
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}

@fragment fn fs_standard_deferred_compact_subsurface_channels_array_single(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveCompactDeferredArrays(in, reflectionClass0, reflectionClass0, 1u);
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}

@fragment fn fs_standard_deferred_compact_subsurface_channels_array_dual(in : FullscreenOutput) -> SubsurfaceLightingOutput {
  let output = resolveCompactDeferredArrays(in, reflectionClass0, reflectionClass1, 2u);
  return SubsurfaceLightingOutput(output.color, output.diffuse);
}

@fragment fn fs_standard_deferred_compact_reflections(in : FullscreenOutput) -> DeferredOutput {
  return resolveCompactDeferred(in, vec4<u32>(0xffffffffu, 0u, 0u, 0u));
}

@fragment fn fs_standard_deferred_compact_reflections_channels(in : FullscreenOutput) -> DeferredOutput {
  return resolveCompactDeferred(in, textureLoad(receiverGeometry, vec2<i32>(in.position.xy), 0));
}

@fragment fn fs_standard_deferred_compact_reflections_channels_array_single(in : FullscreenOutput) -> DeferredOutput {
  return resolveCompactDeferredArrays(in, reflectionClass0, reflectionClass0, 1u);
}

@fragment fn fs_standard_deferred_compact_reflections_channels_array_dual(in : FullscreenOutput) -> DeferredOutput {
  return resolveCompactDeferredArrays(in, reflectionClass0, reflectionClass1, 2u);
}

@fragment fn fs_standard_deferred_compact_reflections_overflow(in : ReflectionOverflowVertex) -> ReflectionOverflowOutput {
  let specular = resolveReflectionOverflow(in, true,
    textureLoad(receiverGeometry, vec2<i32>(in.position.xy), 0).g);
  return ReflectionOverflowOutput(vec4<f32>(specular, 0.0), vec4<f32>(specular, 1.0));
}
#endif
