#define_import_path forgeax_ssr::trace
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, decodeStandardNormalRoughness, loadStandardSceneSurfaceValid, loadCompactGBufferRoughness}
#import forgeax_scene_temporal::{unpackSceneTemporalV1}
#import forgeax_depth_pyramid::sample::{DEPTH_PYRAMID_EMPTY_DEPTH, linearizeViewDepth}
#import forgeax_ssr::ray::{SsrRayHit, traceSsrRay, ssrReflectionDirection, ssrVignette, ssrClipUv}
@group(0) @binding(0) var sceneDepth : texture_depth_2d;
@group(0) @binding(1) var sceneNormal : texture_2d<u32>;
@group(0) @binding(14) var defaultGBufferB : texture_2d<u32>;
@group(0) @binding(2) var sceneColor : texture_2d<f32>;
@group(0) @binding(3) var depthPyramid : texture_2d<f32>;
#if !PORTABLE_FRAGMENT
@group(0) @binding(4) var traceOutput : texture_storage_2d<rgba16float, write>;
#endif

// This is the existing Standard View UBO, not a second camera state source.
// The shader only consumes world/inverse projection and the validated SSR
// parameter tail published by the record stage.
#import forgeax_view::common::{View, screenSpaceReflectionRoughnessFade, sampleSsrSceneColor}
@group(0) @binding(5) var<uniform> view : View;
// RGB belongs to lighting; alpha is its exact Standard material coverage.
@group(0) @binding(6) var reflectionFallback : texture_2d<f32>;
@group(0) @binding(7) var sceneTemporal : texture_2d<f32>;
@group(0) @binding(13) var sceneColorHistory : texture_2d<f32>;
// Motion at a radiance source invalidates reflection history even when the
// receiver is stationary. This scalar is reactivity, not reflected velocity.
#if !PORTABLE_FRAGMENT
@group(0) @binding(8) var hitReactivityOutput : texture_storage_2d<r32float, write>;
#endif

#if !PORTABLE_FRAGMENT
// Water owns receiver facts. Its hit hierarchy comes from opaque depth.
@group(0) @binding(9) var waterOriginDepth : texture_depth_2d;
@group(0) @binding(10) var waterOriginNormal : texture_2d<u32>;
@group(0) @binding(11) var waterOriginCoverage : texture_2d<f32>;
struct WaterSsrParams {
  historyUvScaleBias: vec4<f32>,
  historyUvClamp: vec4<f32>,
  hitColorUvScaleBias: vec4<f32>,
  hitColorUvClamp: vec4<f32>,
  hitColorParams: vec4<f32>,
};
@group(0) @binding(12) var<uniform> waterParams: WaterSsrParams;
#endif

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn reconstructWorldPosition(uv : vec2<f32>, depth : f32) -> vec3<f32> {
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * clip;
  if (!isFinite(world.w) || world.w == 0.0) {
    return vec3<f32>(0.0);
  }
  return world.xyz / world.w;
}

fn ssrSourceReactivity(pixel : vec2<i32>) -> f32 {
  let temporal = textureLoad(sceneTemporal, pixel, 0);
  let speed = length(temporal.xy);
  if (!isFinite(speed) || !isFinite(temporal.z) || temporal.z < 0.0 || !isFinite(temporal.w)) {
    return 1.0;
  }
  return clamp(max(speed * 64.0, temporal.w), 0.0, 1.0);
}

// Reject motion from a different layer. In particular, SLW may have
// overwritten a temporal texel while the reflection hit remains opaque.
fn ssrPreviousHitUv(hit: SsrRayHit, pixel: vec2i) -> vec2f {
  let hitWorld = vec4f(reconstructWorldPosition(hit.uv, hit.depth), 1.0);
  let previous = view.temporalPreviousViewProj * hitWorld;
  if (!(previous.w > 1e-8)) { return vec2f(-1.0); }
  let motion = unpackSceneTemporalV1(textureLoad(sceneTemporal, pixel, 0));
  if (motion.validDepth && motion.motionValid && isFinite(motion.motionUv.x) && isFinite(motion.motionUv.y)) {
    let rawDepth = textureLoad(sceneDepth, pixel, 0);
    let distance = linearizeViewDepth(rawDepth, view.temporalProjection);
    let logDepth = log2(1.0 + distance);
    let exponent = (bitcast<u32>(logDepth) >> 23u) & 255u;
    let logSpacing = bitcast<f32>((max(exponent, 113u) - 10u) << 23u);
    let tolerance = (1.0 + distance) * (exp2(logSpacing) - 1.0) + distance * 1e-6;
    if (distance < DEPTH_PYRAMID_EMPTY_DEPTH && abs(motion.viewDepth - distance) <= tolerance) {
      // Velocity is authoritative on the full-resolution texel. Unjitter that
      // texel's surface before applying its motion to the interpolated hit UV.
      let current = view.temporalCurrentViewProj * hitWorld;
      if (current.w > 1e-8) { return ssrClipUv(current) - motion.motionUv; }
    }
  }
  return ssrClipUv(previous);
}

fn ssrHitPixel(uv: vec2f, size: vec2u) -> vec2i {
  return vec2i(clamp(uv * vec2f(size), vec2f(0.0), vec2f(size - 1u)));
}

fn ssrCameraDirection(origin: vec3f) -> vec3f {
  if (view.temporalProjection.z <= 0.5) { return view.cameraPos - origin; }
  let near = reconstructWorldPosition(vec2f(0.5), 1.0);
  let far = reconstructWorldPosition(vec2f(0.5), 0.5);
  return near - far;
}

fn ssrStepCount(roughness: f32) -> u32 {
  let steps = max(8u, u32(view.ssrQuality.y));
  let rays = max(1u, u32(view.ssrQuality.z));
  return select(steps, min(24u, steps * rays), rays > 1u && roughness < 0.1);
}

#if !PORTABLE_FRAGMENT
fn waterReflectionWeight(hitUv: vec2<f32>, colorUv: vec2<f32>, roughness: f32, maximumRoughness: f32) -> f32 {
  return screenSpaceReflectionRoughnessFade(roughness, maximumRoughness, view.ssrQuality.w > 0.0) * waterParams.hitColorParams.z *
    min(ssrVignette(hitUv), ssrVignette(colorUv));
}

struct WaterSsrReceiver {
  valid: bool,
  origin: vec3<f32>,
  normal: vec3<f32>,
  toCamera: vec3<f32>,
  roughness: f32,
};

fn waterSsrReceiver(pixel: vec2<i32>, size: vec2<u32>) -> WaterSsrReceiver {
  var result: WaterSsrReceiver;
  let depth = textureLoad(waterOriginDepth, pixel, 0);
  let normal = decodeStandardNormalRoughness(textureLoad(waterOriginNormal, pixel, 0).r);
  let normalLength = length(normal.xyz);
  if (textureLoad(waterOriginCoverage, pixel, 0).r <= 0.0 || !isFinite(depth) || depth <= 0.0 ||
      !isFinite(normalLength) || normalLength < 1e-6 || !isFinite(normal.a) ||
      !isFinite(view.ssrParams.w) || view.ssrParams.w <= 0.5 || view.ssrParams.z <= 0.0) { return result; }
  let uv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(size);
  let origin = reconstructWorldPosition(uv, depth);
  let toCamera = ssrCameraDirection(origin);
  let cameraDistance = length(toCamera);
  if (!isFinite(cameraDistance) || cameraDistance < 1e-6) { return result; }
  return WaterSsrReceiver(true, origin, normal.xyz / normalLength, toCamera / cameraDistance, normal.a);
}

fn traceWaterWorldRay(receiver: WaterSsrReceiver, pixel: vec2u, ray: u32) -> SsrRayHit {
  let direction = ssrReflectionDirection(receiver.normal, receiver.toCamera, receiver.roughness, pixel,
    u32(view.ssrQuality.w), ray);
  if (dot(receiver.normal, direction) <= 0.0) { return SsrRayHit(vec2f(0.0), 0.0, false); }
  return traceSsrRay(depthPyramid, view, textureDimensions(sceneDepth, 0), receiver.origin,
    direction, receiver.roughness, ssrStepCount(receiver.roughness));
}

fn waterHitHistoryColor(screenUv: vec2<f32>) -> vec3<f32> {
  let uv = clamp(screenUv * waterParams.hitColorUvScaleBias.xy + waterParams.hitColorUvScaleBias.zw,
    waterParams.hitColorUvClamp.xy, waterParams.hitColorUvClamp.zw);
  return sampleSsrSceneColor(sceneColorHistory, uv) * waterParams.hitColorParams.y;
}

fn waterCurrentReflection(hit: SsrRayHit, roughness: f32) -> vec4<f32> {
  if (!hit.found) { return vec4<f32>(0.0); }
  let weight = waterReflectionWeight(hit.uv, hit.uv, roughness, view.ssrParams.z);
  let color = sampleSsrSceneColor(sceneColor, hit.uv);
  if (!all(vec3<bool>(isFinite(color.r), isFinite(color.g), isFinite(color.b))) || !isFinite(weight)) {
    return vec4<f32>(0.0);
  }
  return vec4<f32>(color, 1.0) * weight;
}

fn waterHistoryReflection(hit: SsrRayHit, roughness: f32) -> vec4<f32> {
  if (waterParams.hitColorParams.x <= 0.5) { return waterCurrentReflection(hit, roughness); }
  if (!hit.found) { return vec4<f32>(0.0); }
  let previousScreen = ssrPreviousHitUv(hit, ssrHitPixel(hit.uv, textureDimensions(sceneTemporal, 0)));
  let weight = waterReflectionWeight(hit.uv, previousScreen, roughness, view.ssrParams.z);
  let color = waterHitHistoryColor(previousScreen);
  if (!all(vec3<bool>(isFinite(color.r), isFinite(color.g), isFinite(color.b))) || !isFinite(weight)) {
    return vec4<f32>(0.0);
  }
  return vec4<f32>(color, 1.0) * weight;
}

fn storeWaterReflection(globalId: vec3u, history: bool) {
  let size = textureDimensions(waterOriginDepth, 0);
  if (any(globalId.xy >= size)) { return; }
  let pixel = vec2i(globalId.xy);
  let receiver = waterSsrReceiver(pixel, size);
  var reflection = vec4f(0.0);
  if (receiver.valid && screenSpaceReflectionRoughnessFade(receiver.roughness, view.ssrParams.z, view.ssrQuality.w > 0.0) > 0.0) {
    let rays = select(1u, max(1u, u32(view.ssrQuality.z)), receiver.roughness >= 0.1);
    for (var ray = 0u; ray < rays; ray++) {
      let hit = traceWaterWorldRay(receiver, globalId.xy, ray);
      if (!hit.found) { continue; }
      if (history) {
        reflection += waterHistoryReflection(hit, receiver.roughness);
      } else {
        reflection += waterCurrentReflection(hit, receiver.roughness);
      }
    }
    reflection /= f32(rays);
  }
  textureStore(traceOutput, pixel, reflection);
}

#endif
struct SsrTraceOutput {
  @location(0) color : vec4<f32>,
  @location(1) reactivity : f32,
}
// Rec. 709 luminance, matching the TAA resolve's Karis weights.
fn ssrLuminance(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Unreal SSRTReflections.usf: SampleColor.rgb *= rcp(1 + Luminance(SampleColor.rgb)).
// The inverse lives in ssr-compose.wgsl (ssrLuminanceUnweight).
fn ssrLuminanceWeight(rgb : vec3<f32>) -> vec3<f32> {
  return rgb / (1.0 + max(0.0, ssrLuminance(rgb)));
}

fn evaluateSsrTrace(globalId : vec3<u32>, context : texture_2d<u32>, compact : bool) -> SsrTraceOutput {
  var output = SsrTraceOutput(vec4<f32>(0.0), 0.0);
  let fullSize = textureDimensions(sceneDepth, 0);
  let traceScale = select(1.0, view.ssrQuality.x, view.ssrQuality.x > 0.0);
  let traceSize = max(vec2<u32>(vec2<f32>(fullSize) * traceScale), vec2<u32>(1u));
  if (globalId.x >= traceSize.x || globalId.y >= traceSize.y) {
    return output;
  }
  output.reactivity = 0.0;
  let fullPixel = min(vec2<u32>((vec2<f32>(globalId.xy) + vec2<f32>(0.5)) * vec2<f32>(fullSize) / vec2<f32>(traceSize)), fullSize - vec2<u32>(1u));
  if (!loadStandardSceneSurfaceValid(sceneNormal, vec2<i32>(fullPixel))) { return output; }
  let pixel = vec2i(fullPixel);
  let depth = textureLoad(sceneDepth, pixel, 0);
  var surface = loadStandardNormalRoughness(sceneNormal, pixel);
  if (compact) { surface.w = loadCompactGBufferRoughness(context, pixel); }
  let normalLength = length(surface.xyz);
  let glossy = view.ssrQuality.w > 0.0;
  let fade = screenSpaceReflectionRoughnessFade(surface.w, view.ssrParams.z, glossy);
  if (!(depth > 0.0 && normalLength > 1e-5 && fade > 0.0 &&
      view.ssrParams.w > 0.5 && isFinite(view.ssrParams.w)) ||
      textureLoad(reflectionFallback, pixel, 0).a <= 0.5) {
    return output;
  }

  let uv = (vec2f(fullPixel) + 0.5) / vec2f(fullSize);
  let world = reconstructWorldPosition(uv, depth);
  let normal = surface.xyz / normalLength;
  let toCamera = normalize(ssrCameraDirection(world));
  let rays = select(1u, max(1u, u32(view.ssrQuality.z)), glossy && surface.w >= 0.1);
  let steps = ssrStepCount(surface.w);
  var accum = vec4f(0.0);
  for (var ray = 0u; ray < rays; ray++) {
    let direction = ssrReflectionDirection(normal, toCamera, surface.w, fullPixel, u32(view.ssrQuality.w), ray);
    if (dot(normal, direction) <= 0.0) { continue; }
    let hit = traceSsrRay(depthPyramid, view, fullSize, world, direction, surface.w, steps);
    if (!hit.found) { continue; }
    let sourcePixel = ssrHitPixel(hit.uv, fullSize);
    var weight = ssrVignette(hit.uv);
    var color = vec3f(0.0);
    if (glossy && view.temporalPreviousCameraPos.w > 0.5 && view.ssrParams.w > 3.5) {
      let previousUv = ssrPreviousHitUv(hit, sourcePixel);
      weight = min(weight, ssrVignette(previousUv));
      color = sampleSsrSceneColor(sceneColorHistory, previousUv);
    } else {
      color = sampleSsrSceneColor(sceneColor, hit.uv);
    }
    if (!(weight > 0.0) || !all(vec3<bool>(isFinite(color.r), isFinite(color.g), isFinite(color.b)))) {
      continue;
    }
    accum += vec4f(ssrLuminanceWeight(color) * weight, weight);
    output.reactivity = max(output.reactivity, ssrSourceReactivity(sourcePixel));
  }
  output.color = vec4f(accum.rgb / max(accum.a, 1e-6), fade * accum.a / f32(rays));
  return output;
}

#if PORTABLE_FRAGMENT
@vertex fn ssr_fullscreen(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn ssr_trace_fragment(@builtin(position) position : vec4<f32>) -> SsrTraceOutput {
  return evaluateSsrTrace(vec3<u32>(vec2<u32>(position.xy), 0u), sceneNormal, false);
}
@fragment fn ssr_trace_fragment_compact(@builtin(position) position : vec4<f32>) -> SsrTraceOutput {
  return evaluateSsrTrace(vec3<u32>(vec2<u32>(position.xy), 0u), defaultGBufferB, true);
}
#else
fn storeOpaqueSsrTrace(globalId : vec3<u32>, context : texture_2d<u32>, compact : bool) {
  if (any(globalId.xy >= textureDimensions(traceOutput))) { return; }
  let output = evaluateSsrTrace(globalId, context, compact);
  textureStore(traceOutput, vec2<i32>(globalId.xy), output.color);
  textureStore(hitReactivityOutput, vec2<i32>(globalId.xy), vec4<f32>(output.reactivity));
}
@compute @workgroup_size(8, 8, 1)
fn ssr_trace(@builtin(global_invocation_id) globalId : vec3<u32>) {
  storeOpaqueSsrTrace(globalId, sceneNormal, false);
}
@compute @workgroup_size(8, 8, 1)
fn ssr_trace_compact(@builtin(global_invocation_id) globalId : vec3<u32>) {
  storeOpaqueSsrTrace(globalId, defaultGBufferB, true);
}
#endif

#if !PORTABLE_FRAGMENT
@compute @workgroup_size(8, 8, 1)
fn ssr_water_trace(@builtin(global_invocation_id) globalId: vec3<u32>) {
  storeWaterReflection(globalId, false);
}

@compute @workgroup_size(8, 8, 1)
fn ssr_water_trace_history(@builtin(global_invocation_id) globalId: vec3<u32>) {
  storeWaterReflection(globalId, true);
}
#endif
