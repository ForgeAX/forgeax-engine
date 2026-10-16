#define_import_path forgeax_standard::deferred_lighting
#pragma variant_axis CLUSTER_FORWARD_AVAILABLE
#pragma variant_axis ATMOSPHERE_AVAILABLE
#pragma variant_axis EXTENDED_LIGHTING_AVAILABLE
#pragma variant_axis PROJECTOR_AVAILABLE
#pragma variant_axis DIRECTIONAL_PCSS_AVAILABLE
#pragma variant_axis DIRECT_DFG_LUT_AVAILABLE

#import forgeax_view::common::{view, FullscreenOutput, fullscreen_triangle}
#import forgeax_scene_temporal::{sceneViewZ}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, decodeStandardReceiverNormal, decodeStandardReflectance, STANDARD_GBUFFER_NO_RECEIVE_BIT, STANDARD_GBUFFER_PROBE_ROW_MASK, STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT}
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, evaluateStandardEnvironment, evaluateStandardDirect}

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
@group(1) @binding(9) var prefilterMap : texture_cube<f32>;
@group(1) @binding(10) var brdfLut : texture_2d<f32>;
@group(1) @binding(11) var skylightPrefilterMap : texture_cube<f32>;
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
  let prefilter = textureSample(prefilterMap, linearSampler, vec3<f32>(0.0, 0.0, 1.0));
  let brdf = textureSample(brdfLut, linearSampler, vec2<f32>(0.0));
  let skylightPrefilter = textureSample(skylightPrefilterMap, linearSampler, vec3<f32>(0.0, 0.0, 1.0));
}
#endif
@group(3) @binding(0) var<storage, read> probeBlendRecords : array<vec4<f32>>;

struct DeferredOutput {
  @location(0) color : vec4<f32>,
  @location(1) reflectionFallback : vec4<f32>,
  @location(2) specularResponse : vec4<f32>,
  @location(3) diffuse : vec4<f32>,
};

const CONTACT_SHADOW_MAX_STEPS : f32 = 8.0;
const CAPSULE_TILE_SIZE : u32 = 16u;
const CAPSULE_TILE_COUNT_BITS : u32 = 6u;
const CAPSULE_PI : f32 = 3.14159265;

fn capsuleCapArea(angle : f32) -> f32 {
  return 2.0 * CAPSULE_PI * (1.0 - cos(angle));
}

// Fraction of the light cone (half-angle params.lanes.w) left unblocked by one
// capsule: the closest point on its segment to the light ray is treated as a
// sphere whose solid angle overlaps the cone, faded out past the capsule reach.
fn capsuleVisibility(position : vec3<f32>, toLight : vec3<f32>, a : vec3<f32>, radius : f32,
    b : vec3<f32>, reach : f32, cone : f32) -> f32 {
  let d = b - a;
  let w0 = a - position;
  let lengthSq = dot(d, d);
  let along = dot(d, toLight);
  let denominator = lengthSq - along * along;
  var s = 0.0;
  if (denominator > 1e-6) {
    s = clamp((along * dot(toLight, w0) - dot(d, w0)) / denominator, 0.0, 1.0);
  } else if (lengthSq > 1e-6) {
    s = clamp(-dot(d, w0) / lengthSq, 0.0, 1.0);
  }
  let toCapsule = a + s * d - position;
  let t = dot(toCapsule, toLight);
  if (t <= 0.0) { return 1.0; }
  let fade = clamp(3.0 - 3.0 * t / reach, 0.0, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let distance = max(length(toCapsule), 1e-4);
  // Receivers inside the capsule shrink it so the occluder never covers the whole sky.
  let apparent = min(radius, 0.9 * distance);
  let omega = atan(apparent / distance);
  let beta = acos(clamp(t / distance, -1.0, 1.0));
  let low = abs(cone - omega);
  let overlap = 1.0 - clamp((beta - low) / max(cone + omega - low, 1e-5), 0.0, 1.0);
  let occlusion = capsuleCapArea(min(cone, omega)) * smoothstep(0.0, 1.0, overlap) /
    capsuleCapArea(cone);
  return 1.0 - min(occlusion, 1.0) * fade;
}

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

fn contactShadowLinearDepth(value : f32, near : f32, far : f32, orthographic : bool) -> f32 {
  return select(near / max(value + (1.0 - value) * (near / far), 1e-7), far - value * (far - near), orthographic);
}

// Screen-space contact shadow: a short depth-buffer march toward the
// directional light resolving occlusion finer than the shadow-map texel.
// The march interpolates clip coordinates, so each sample's w is the exact
// view distance of the ray point; only the scene sample needs linearizing.
fn directionalContactShadow(position : vec3<f32>, normal : vec3<f32>, originPixel : vec2<i32>) -> f32 {
  let rayLength = view.directionalShadowFilter.w;
  let toLight = normalize(-view.lightDir);
  if (dot(normal, toLight) <= 0.0) { return 1.0; }
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  let orthographic = view.temporalProjection.z > 0.5;
  // A distance-scaled normal offset keeps depth quantization of the
  // receiver's own plane from registering as a hit at grazing angles.
  let origin = position + normal * (0.001 * abs((view.worldViewProj * vec4<f32>(position, 1.0)).w));
  let clipStart = view.worldViewProj * vec4<f32>(origin, 1.0);
  var clipEnd = view.worldViewProj * vec4<f32>(origin + toLight * rayLength, 1.0);
  // Keep the ray in front of the camera; a toward-camera light would
  // otherwise cross w = 0 and fold the projected segment.
  let minW = near * 0.5;
  if (!orthographic && clipEnd.w < minW) {
    clipEnd = mix(clipStart, clipEnd, (clipStart.w - minW) / max(clipStart.w - clipEnd.w, 1e-6));
  }
  let dims = vec2<f32>(textureDimensions(sceneDepth));
  let screenStart = clipStart.xy / clipStart.w;
  let screenEnd = clipEnd.xy / clipEnd.w;
  let pixelSpan = length((screenEnd - screenStart) * dims * 0.5);
  if (pixelSpan < 1.5) { return 1.0; }
  let steps = clamp(ceil(pixelSpan / 4.0), 3.0, CONTACT_SHADOW_MAX_STEPS);
  let noiseCoord = vec2<f32>(originPixel) + 5.588238 * params.lanes.y;
  let jitter = fract(52.9829189 * fract(dot(noiseCoord, vec2<f32>(0.06711056, 0.00583715))));
  let startDistance = select(clipStart.w, contactShadowLinearDepth(clipStart.z / clipStart.w, near, far, true), orthographic);
  let endDistance = select(clipEnd.w, contactShadowLinearDepth(clipEnd.z / clipEnd.w, near, far, true), orthographic);
  // Occluders are assumed to be about one step deep plus a quarter of the
  // ray; thicker tolerance casts halos behind foreground silhouettes.
  let thickness = max(abs(endDistance - startDistance) / steps * 2.0, rayLength * 0.25) + startDistance * 0.002;
  for (var i = 0.0; i < steps; i += 1.0) {
    let t = (i + jitter) / steps;
    let clip = mix(clipStart, clipEnd, t);
    let ndc = clip.xyz / clip.w;
    let uv = ndc.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    if (any(uv < vec2<f32>(0.0)) || any(uv >= vec2<f32>(1.0))) { break; }
    let pixel = vec2<i32>(uv * dims);
    if (all(pixel == originPixel)) { continue; }
    let sceneDepthValue = textureLoad(sceneDepth, pixel, 0);
    if (sceneDepthValue <= 0.0) { continue; }
    let sceneDistance = contactShadowLinearDepth(sceneDepthValue, near, far, orthographic);
    let rayDistance = select(clip.w, contactShadowLinearDepth(ndc.z, near, far, true), orthographic);
    let delta = rayDistance - sceneDistance;
    if (delta > 0.0 && delta < thickness) {
      // Near hits darken fully; hits toward the ray end fade so the shadow
      // edge follows the configured length instead of cutting off.
      return t * t;
    }
  }
  return 1.0;
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
  let response = decodeStandardReflectance(textureLoad(f0Occlusion, pixel, 0).r);
  let direction = normalize(view.cameraPos - position);
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
    albedo.a, roughness, response.rgb, skylight, irradianceMap, linearSampler,
    prefilterMap, linearSampler, brdfLut, skylightPrefilterMap, sh, localBlend);
  var screenAo = 1.0;
  if (params.lanes.x > 0.0) {
    screenAo = pow(clamp(textureSampleLevel(screenOcclusion, linearSampler, uv, 0.0).r, 0.0, 1.0), params.lanes.x);
  }
  let ao = response.a * screenAo;
  let viewZ = sceneViewZ(view.worldViewProj * vec4<f32>(position, 1.0), view.temporalProjection);
  var shadow = 1.0;
  if (receiveShadows) {
    // Geometry owns this exact raster plane; BRDF and decals retain their
    // independent shading normal. No depth-neighborhood inference is needed.
    let receiverNormal = decodeStandardReceiverNormal(receiver.x);
    let directionalLayerBase = receiver.x >> 24u;
    shadow = evalDirectionalShadowFactorAtPixel(receiverNormal, position, viewZ, directionalLayerBase, in.position.xy);
    if (view.directionalShadowFilter.w > 0.0 && shadow > 0.0) {
      shadow *= directionalContactShadow(position, normal, pixel);
    }
    if (params.lanes.z > 0.0 && shadow > 0.0 && dot(normal, -view.lightDir) > 0.0) {
      shadow *= directionalCapsuleShadow(position, pixel);
    }
  }
  let receiverChannels = receiver.y;
  let direct = evaluateStandardDirect(position, ndc, viewZ, normal, direction, albedo.rgb, vec3<f32>(0.0),
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
  return DeferredOutput(vec4<f32>((environment.diffuse + environment.specular) * ao + direct.radiance * directAo, 0.0),
    vec4<f32>(environment.specular * ao, 1.0), vec4<f32>(environment.response * response.a, response.a), vec4<f32>(diffuse, 0.0));
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
