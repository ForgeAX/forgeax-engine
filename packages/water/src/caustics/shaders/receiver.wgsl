#define_import_path forgeax_material::water_caustics_receiver
#import forgeax_view::common::{view}
#import forgeax_scene_temporal::{sceneViewZ}
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel}
#import forgeax_pbr::gbuffer::{decodeStandardGBufferNormal, standardGBufferValid}
#import forgeax_optics::interface::{refractInterface}
struct Params { style: vec4<f32>, budget: vec4<f32>, sun: vec4<f32>, domain: vec4<f32>, history: vec4<f32> };
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var fieldSampler: sampler;
@group(1) @binding(2) var<uniform> params: Params;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(5) var sceneNormal: texture_2d<u32>;
@group(1) @binding(6) var field: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}
fn sampleField(uv: vec2<f32>, radius: f32) -> f32 {
  let d = vec2<f32>(radius) / vec2<f32>(textureDimensions(field));
  return textureSample(field, fieldSampler, uv).r * 0.5 + 0.125 * (
    textureSample(field, fieldSampler, uv + vec2<f32>(d.x, 0.0)).r +
    textureSample(field, fieldSampler, uv - vec2<f32>(d.x, 0.0)).r +
    textureSample(field, fieldSampler, uv + vec2<f32>(0.0, d.y)).r +
    textureSample(field, fieldSampler, uv - vec2<f32>(0.0, d.y)).r);
}
struct ReceiverOutput {
  @location(0) color: vec4<f32>,
  @location(1) temporal: vec4<f32>,
};
// Retain history for the receiver's static geometry. Response follows only
// the changing light's relative contribution, including a vacated texture tap.
fn causticsReactivity(gain: f32, previousGain: f32, changing: bool) -> f32 {
  let contribution = max(gain, previousGain);
  return select(0.0, min(0.45, contribution / (1.0 + contribution)), changing);
}
fn receiveCaustics(p: vec4<f32>) -> ReceiverOutput {
  let pixel = vec2<i32>(p.xy);
  let original = textureLoad(scene, pixel, 0);
  let rawDepth = textureLoad(sceneDepth, pixel, 0);
  let bits = textureLoad(sceneNormal, pixel, 0).rg;
  let uv = p.xy / vec2<f32>(textureDimensions(scene));
  let h = view.inverseViewProj * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), max(rawDepth, 0.00001), 1.0);
  let position = h.xyz / h.w;
  let normal = decodeStandardGBufferNormal(bits).xyz;
  let incident = normalize(params.sun.xyz);
  let ray = refractInterface(incident, vec3<f32>(0.0, 1.0, 0.0), 1.0, 1.333);
  let projected = position.xz + ray.direction.xz * ((params.domain.x - position.y) / min(ray.direction.y, -0.0001));
  let scale = max(params.style.z, 0.01);
  let dynamicUv = projected / (32.0 * scale) + 0.5;
  let textureMode = params.style.x < 1.5;
  let drift = params.domain.y * 0.035;
  let patternUv = fract(projected / (10.0 * scale) + vec2<f32>(drift, drift * 0.7));
  let coordinates = select(dynamicUv, patternUv, textureMode);
  let raw = sampleField(coordinates, clamp(params.budget.x, 0.0, 1.0) * 5.0);
  let relative = select(raw / max(params.sun.w, 0.0001), raw, params.domain.w > 0.5);
  let dynamicEnergy = max(min(relative, params.budget.w) - 1.0, 0.0);
  let inside = all(dynamicUv > vec2<f32>(0.0)) && all(dynamicUv < vec2<f32>(1.0));
  let score = select(clamp(dynamicEnergy / 2.0, 0.0, 1.0), raw, textureMode);
  let threshold = mix(0.95, 0.08, clamp(params.style.w, 0.0, 1.0));
  let edge = max(fwidth(score), 0.015 + params.budget.x * 0.12);
  let support = smoothstep(threshold - edge, threshold + edge, score);
  let energy = select(dynamicEnergy * select(0.0, 1.0, inside), raw * 2.0, textureMode) * support;
  let depth = -position.y;
  let depthMax = max(params.budget.z, 0.1);
  let depthBand = smoothstep(0.0, 0.12, depth) * (1.0 - smoothstep(depthMax * 0.8, depthMax, depth));
  let distanceM = distance(view.cameraPos, position);
  let visibleDistance = max(params.budget.y, 0.1);
  let fade = 1.0 - smoothstep(visibleDistance * 0.65, visibleDistance, distanceM);
  let clip = view.worldViewProj * vec4<f32>(position, 1.0);
  let shadow = evalDirectionalShadowFactorAtPixel(normal, position, sceneViewZ(clip, view.temporalProjection), 0u, p.xy);
  let enabled = standardGBufferValid(bits) && rawDepth > 0.0 && incident.y < -0.01 && params.sun.w > 0.0;
  let gain = select(0.0, energy * params.style.y * params.sun.w * max(dot(normal, -ray.direction), 0.0) * shadow * depthBand * fade, enabled);
  var priorEnergy = energy;
  if (textureMode) {
    let priorDrift = params.history.x * 0.035;
    let priorUv = fract(projected / (10.0 * scale) + vec2<f32>(priorDrift, priorDrift * 0.7));
    let priorRaw = sampleField(priorUv, clamp(params.budget.x, 0.0, 1.0) * 5.0);
    priorEnergy = priorRaw * 2.0 * smoothstep(threshold - edge, threshold + edge, priorRaw);
  }
  let domain = textureMode || inside;
  let responsive = enabled && domain && params.style.y > 0.0 && dot(normal, -ray.direction) > 0.0;
  let priorGain = priorEnergy * params.style.y * params.sun.w * max(dot(normal, -ray.direction), 0.0) * shadow * depthBand * fade;
  let changing = params.history.y > 0.5 || params.history.z > 0.5;
  let response = causticsReactivity(gain, select(priorGain, 1.0, params.history.z > 0.5), changing);
  let reactive = select(0.0, response, responsive);
  if (params.domain.z > 0.5) {
    return ReceiverOutput(vec4<f32>(vec3<f32>(select(1.0, shadow, standardGBufferValid(bits))), original.a), vec4<f32>(0.0, 0.0, 0.0, reactive));
  }
  // Local concentration modulates the original lit receiver, retaining its
  // original color. A neutral field yields exactly zero gain.
  return ReceiverOutput(vec4<f32>(original.rgb + original.rgb * vec3<f32>(1.0, 0.96, 0.88) * gain, original.a), vec4<f32>(0.0, 0.0, 0.0, reactive));
}
@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return receiveCaustics(p).color;
}
@fragment fn fs_temporal(@builtin(position) p: vec4<f32>) -> ReceiverOutput {
  return receiveCaustics(p);
}
