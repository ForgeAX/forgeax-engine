#define_import_path forgeax_cloud::mode0_reconstruct
#import forgeax_view::common::{View, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
#import forgeax_cloud::depth_minmax::cloud_mode0_unjittered_uv
#import forgeax_cloud::reconstruct::{CloudReconstructionSample, cloud_reconstruct_sample, cloud_history_uv}

struct Mode0Params { previousViewProjection: mat4x4f, phaseSize: vec4f, historyExposure: vec4f }
@group(1) @binding(0) var traceFar: texture_2d<f32>;
@group(1) @binding(1) var colorSampler: sampler;
@group(1) @binding(2) var<uniform> params: Mode0Params;
@group(1) @binding(3) var sceneDepth: texture_depth_2d;
@group(1) @binding(4) var depthSampler: sampler;
@group(1) @binding(5) var traceNear: texture_2d<f32>;
@group(1) @binding(6) var traceDepth: texture_2d<f32>;
@group(1) @binding(7) var historyFar: texture_2d<f32>;
@group(1) @binding(8) var historyNear: texture_2d<f32>;
@group(1) @binding(9) var historyDepth: texture_2d<f32>;
struct Output { @location(0) far: vec4f, @location(1) near: vec4f, @location(2) depth: vec4f }
@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput { return fullscreen_triangle(id); }
@fragment fn fs_main(input: FullscreenOutput) -> Output {
  let pixel = vec2u(input.position.xy);
  let coord = min(vec2i(pixel / 2u), vec2i(textureDimensions(traceFar)) - 1);
  let depth = textureLoad(traceDepth, coord, 0);
  let uv = (vec2f(pixel) + 0.5) / vec2f((vec2u(params.phaseSize.zw) + 1u) / 2u);
  let ray = atmosphere_view_ray(view, uv);
  let previousUv = cloud_history_uv(ray.origin + ray.direction * depth.x, params.previousViewProjection);
  let historyCoord = clamp(vec2i(previousUv * vec2f(textureDimensions(historyDepth))), vec2i(0), vec2i(textureDimensions(historyDepth)) - 1);
  // The branch prevents even a speculative previous-texture read during cold initialization.
  var previous = CloudReconstructionSample(vec4f(0.0,0.0,0.0,1.0), vec4f(0.0,0.0,0.0,1.0), depth);
  if (params.historyExposure.x > 0.5) {
    previous = CloudReconstructionSample(textureSampleLevel(historyFar,colorSampler,previousUv,0.0),textureSampleLevel(historyNear,colorSampler,previousUv,0.0),textureLoad(historyDepth,historyCoord,0));
  }
  var current = CloudReconstructionSample(textureSampleLevel(traceFar,colorSampler,uv,0.0),textureSampleLevel(traceNear,colorSampler,uv,0.0),depth);
  if (all(pixel % vec2u(2u) == vec2u(params.phaseSize.xy))) {
    current = CloudReconstructionSample(textureLoad(traceFar,coord,0),textureLoad(traceNear,coord,0),depth);
  }
  let result = cloud_reconstruct_sample(current,previous,pixel,vec2u(params.phaseSize.xy),previousUv,params.historyExposure.x > 0.5,params.historyExposure.y,params.historyExposure.z,0.0,params.historyExposure.w);
  return Output(result.far,result.near,result.depthMeters);
}

fn cloud_ue_depth_fixup(depthKm: vec4f) -> vec4f {
  return select(depthKm, vec4f(65504.0), depthKm > vec4f(60000.0));
}

fn reconstruct_ue_mode0(pixel: vec2u, coord: vec2i, uv: vec2f, depthKm: vec4f) -> Output {
  let cold = Output(textureSampleLevel(traceFar, colorSampler, uv, 0.0),
    textureSampleLevel(traceNear, colorSampler, uv, 0.0),
    textureSampleLevel(traceDepth, colorSampler, uv, 0.0));
  if params.historyExposure.x <= 0.5 { return cold; }
  let current = Output(textureLoad(traceFar, coord, 0), textureLoad(traceNear, coord, 0),
    cloud_ue_depth_fixup(depthKm));
  if all(pixel % vec2u(2u) == vec2u(params.phaseSize.xy)) { return current; }

  let ndc = cloud_mode0_unjittered_uv(view, uv) * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  let depthMeters = max(depthKm.x * 1000.0, near);
  let inverseRange = 1.0 / max(far - near, 1e-6);
  let orthoZ = (far - depthMeters) * inverseRange;
  let perspectiveZ = select(near * (far / depthMeters - 1.0) * inverseRange,
    near / depthMeters, far > 1e30 || far <= near);
  let deviceZ = select(perspectiveZ, orthoZ, view.temporalProjection.z > 0.5);
  let world = view.inverseViewProj * vec4f(ndc, deviceZ, 1.0);
  let previousClip = params.previousViewProjection * world;
  let previousUv = (previousClip.xy / previousClip.w) * vec2f(0.5, -0.5) + 0.5;
  let valid = previousClip.w * world.w > 0.0 && all(previousUv > vec2f(0.0)) &&
    all(previousUv < vec2f(1.0));
  let historyUv = select(uv, previousUv, valid);
  let priorDepth = cloud_ue_depth_fixup(textureSampleLevel(historyDepth, colorSampler, historyUv, 0.0));
  let nowDepth = current.depth;
  let applyDisocclusion = any(nowDepth.yzw < vec3f(5.0)) || any(priorDepth.yzw < vec3f(5.0));
  let newAtEdge = abs(nowDepth.z - nowDepth.w) > 2.0 &&
    abs(nowDepth.z - nowDepth.y) < abs(nowDepth.w - nowDepth.y);
  if applyDisocclusion && (newAtEdge || abs(priorDepth.y - nowDepth.y) > 2.0) { return current; }
  if !valid { return cold; }
  if abs(nowDepth.z - priorDepth.z) > 1.0 { return current; }
  let exposure = vec4f(vec3f(params.historyExposure.y / params.historyExposure.z), 1.0);
  let historyFarValue = textureSampleLevel(historyFar, colorSampler, historyUv, 0.0) * exposure;
  let historyNearValue = textureSampleLevel(historyNear, colorSampler, historyUv, 0.0) * exposure;
  if !(all(abs(historyFarValue) <= vec4f(65504.0)) &&
    all(abs(historyNearValue) <= vec4f(65504.0)) && all(abs(priorDepth) <= vec4f(65504.0))) {
    let transparent = vec4f(0.0, 0.0, 0.0, 1.0);
    return Output(transparent, transparent, vec4f(1000.0));
  }
  return Output(historyFarValue, historyNearValue, priorDepth);
}

@fragment fn fs_ue_mode(input: FullscreenOutput) -> Output {
  let pixel = vec2u(input.position.xy);
  let coord = min(vec2i(pixel / 2u), vec2i(textureDimensions(traceFar)) - 1);
  let uv = input.position.xy / vec2f((vec2u(params.phaseSize.zw) + 1u) / 2u);
  return reconstruct_ue_mode0(pixel, coord, uv, textureLoad(traceDepth, coord, 0));
}
