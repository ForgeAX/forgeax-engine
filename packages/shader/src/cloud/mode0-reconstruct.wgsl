#define_import_path forgeax_cloud::mode0_reconstruct
#import forgeax_view::common::{View, view, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray}
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
