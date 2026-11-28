#define_import_path water_r3::caustics_receiver
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
// R3 owns this artistic mapping. domain.y carries the energy-weighted wave
// phase selected by this demo from its admitted WaveSet and the World clock.
fn textureCoordinates(positionM: vec2<f32>, scale: f32, phase: f32) -> vec2<f32> {
  let p = positionM / (10.0 * scale);
  let broad = vec2<f32>(dot(p, vec2<f32>(3.1, 5.3)), dot(p, vec2<f32>(-4.7, 2.9)));
  let detail = vec2<f32>(dot(p, vec2<f32>(11.3, -7.1)), dot(p, vec2<f32>(6.7, 13.1)));
  let flow = sin(broad + phase * vec2<f32>(1.0, -0.91)
    + 0.7 * sin(phase * vec2<f32>(0.31, 0.23) + broad.yx));
  let ripple = sin(detail + phase * vec2<f32>(-1.67, 1.43) + flow * 1.2);
  return fract(p + flow * 0.065 + ripple * 0.018);
}
fn texturePulse(positionM: vec2<f32>, scale: f32, phase: f32) -> f32 {
  let p = positionM / max(scale, 0.01);
  return 0.92 + 0.12 * sin(dot(p, vec2<f32>(0.61, -0.43)) + phase)
    + 0.08 * sin(dot(p, vec2<f32>(1.13, 0.79)) - phase * 1.53);
}
// R3's display approximation uses shaded color as a receiver-response proxy.
// It is not a separate BRDF evaluation. Keep the actual solar hue, improve
// concentrated folds locally, and bound amplification of existing highlights.
fn receiverCaustics(original: vec3<f32>, gain: f32) -> vec3<f32> {
  let sun = max(view.lightColor, vec3<f32>(0.0));
  let solarHue = sun / max(max(max(sun.r, sun.g), sun.b), 0.0001);
  let peak = max(max(original.r, original.g), original.b);
  let receiverProxy = original / (1.0 + max(peak - 0.6, 0.0));
  let focused = max(gain, 0.0) * smoothstep(0.10, 0.65, gain);
  let concentration = focused / (1.0 + focused / 8.0);
  return receiverProxy * solarHue * (concentration * 1.75);
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
  let patternUv = textureCoordinates(projected, scale, params.domain.y);
  let coordinates = select(dynamicUv, patternUv, textureMode);
  let raw = sampleField(coordinates, clamp(params.budget.x, 0.0, 1.0) * 5.0);
  let relative = select(raw / max(params.sun.w, 0.0001), raw, params.domain.w > 0.5);
  let dynamicEnergy = max(min(relative, params.budget.w) - 1.0, 0.0);
  let inside = all(dynamicUv > vec2<f32>(0.0)) && all(dynamicUv < vec2<f32>(1.0));
  let score = select(clamp(dynamicEnergy / 2.0, 0.0, 1.0), raw, textureMode);
  let threshold = mix(0.95, 0.08, clamp(params.style.w, 0.0, 1.0));
  let edge = max(fwidth(score), 0.015 + params.budget.x * 0.12);
  let support = smoothstep(threshold - edge, threshold + edge, score);
  var energy = select(dynamicEnergy * select(0.0, 1.0, inside), raw * 2.0, textureMode) * support;
  if (textureMode) {
    energy *= texturePulse(projected, scale, params.domain.y);
  }
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
    let priorUv = textureCoordinates(projected, scale, params.history.x);
    let priorRaw = sampleField(priorUv, clamp(params.budget.x, 0.0, 1.0) * 5.0);
    priorEnergy = priorRaw * 2.0 * smoothstep(threshold - edge, threshold + edge, priorRaw)
      * texturePulse(projected, scale, params.history.x);
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
  return ReceiverOutput(vec4<f32>(original.rgb + receiverCaustics(original.rgb, gain), original.a), vec4<f32>(0.0, 0.0, 0.0, reactive));
}
@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return receiveCaustics(p).color;
}
@fragment fn fs_temporal(@builtin(position) p: vec4<f32>) -> ReceiverOutput {
  return receiveCaustics(p);
}
