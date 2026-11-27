#define_import_path forgeax_depth_pyramid::seed

// Every depth pyramid uses one r32float view for each graph mip.
const DEPTH_PYRAMID_FORMAT : u32 = 1u;
#import forgeax_depth_pyramid::sample::{
  DEPTH_PYRAMID_EMPTY_DEPTH,
  linearizeViewDepth,
  depthPyramidFootprintEnd,
  depthPyramidFootprintStart,
}

@group(0) @binding(0) var sourceDepth : texture_depth_2d;
#if !PORTABLE_FRAGMENT
@group(0) @binding(1) var pyramidOutput : texture_storage_2d<r32float, write>;
#endif
#import forgeax_view::common::View
@group(0) @binding(2) var<uniform> view : View;

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn seedFootprintStart(coordinate: vec2u, sourceSize: vec2u, outputSize: vec2u) -> vec2u {
  let padded = any(outputSize > max(sourceSize / 2u, vec2u(1u)));
  if (padded) { return min(coordinate * 2u, sourceSize - 1u); }
  return depthPyramidFootprintStart(coordinate, sourceSize, outputSize);
}

fn seedFootprintEnd(coordinate: vec2u, sourceSize: vec2u, outputSize: vec2u) -> vec2u {
  let padded = any(outputSize > max(sourceSize / 2u, vec2u(1u)));
  if (padded) { return min((coordinate + 1u) * 2u, sourceSize); }
  return depthPyramidFootprintEnd(coordinate, sourceSize, outputSize);
}

fn evaluate_seed(coordinate : vec2<u32>, outputSize : vec2<u32>) -> f32 {
  let sourceSize = textureDimensions(sourceDepth, 0);
  let first = seedFootprintStart(coordinate, sourceSize, outputSize);
  let end = seedFootprintEnd(coordinate, sourceSize, outputSize);
  var nearestDepth = 0.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let sample = textureLoad(sourceDepth, vec2<i32>(vec2<u32>(x, y)), 0);
      if (isFinite(sample) && sample > 0.0 && sample <= 1.0) {
        nearestDepth = max(nearestDepth, sample);
      }
    }
  }
  // Both supported depth projections are monotonic, so linearize once after
  // selecting the nearest valid source sample.
  let depth = linearizeViewDepth(nearestDepth, view.temporalProjection);
  return depth;
}

// Occlusion culling needs a conservative farthest bound: an occluder texel
// hides a candidate only when every covered source sample is nearer. Any
// empty or invalid sample (sky, cleared depth) therefore leaves the texel
// EMPTY so nothing behind that hole is culled.
fn evaluate_seed_furthest(coordinate : vec2<u32>, outputSize : vec2<u32>) -> f32 {
  let sourceSize = textureDimensions(sourceDepth, 0);
  let first = seedFootprintStart(coordinate, sourceSize, outputSize);
  let end = seedFootprintEnd(coordinate, sourceSize, outputSize);
  var farthestDepth = 1.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let sample = textureLoad(sourceDepth, vec2<i32>(vec2<u32>(x, y)), 0);
      let valid = isFinite(sample) && sample > 0.0 && sample <= 1.0;
      farthestDepth = min(farthestDepth, select(0.0, sample, valid));
    }
  }
  let depth = linearizeViewDepth(farthestDepth, view.temporalProjection);
  return depth;
}

#if !PORTABLE_FRAGMENT
// Multisampled scene depth: a texel is occluding only when every sample of
// every covered pixel is, so the furthest bound spans the samples too.
@group(0) @binding(3) var sourceDepthMultisampled : texture_depth_multisampled_2d;

fn evaluate_seed_furthest_multisampled(coordinate : vec2<u32>, outputSize : vec2<u32>, resolve : bool) -> f32 {
  let sourceSize = textureDimensions(sourceDepthMultisampled);
  let first = seedFootprintStart(coordinate, sourceSize, outputSize);
  let end = seedFootprintEnd(coordinate, sourceSize, outputSize);
  let samples = textureNumSamples(sourceDepthMultisampled);
  var farthestDepth = 1.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      var nearestDepth = 0.0;
      for (var s = 0u; s < samples; s++) {
        let sample = textureLoad(sourceDepthMultisampled, vec2<i32>(vec2<u32>(x, y)), i32(s));
        let valid = isFinite(sample) && sample > 0.0 && sample <= 1.0;
        let depth = select(0.0, sample, valid);
        if (resolve) {
          nearestDepth = max(nearestDepth, depth);
        } else {
          farthestDepth = min(farthestDepth, depth);
        }
      }
      if (resolve) { farthestDepth = min(farthestDepth, nearestDepth); }
    }
  }
  let depth = linearizeViewDepth(farthestDepth, view.temporalProjection);
  return depth;
}

#endif

#if PORTABLE_FRAGMENT
@vertex fn depth_pyramid_fullscreen(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn depth_pyramid_seed_fragment(@builtin(position) position : vec4<f32>) -> @location(0) f32 {
  return evaluate_seed(vec2<u32>(position.xy), max(textureDimensions(sourceDepth, 0) / vec2<u32>(2u), vec2<u32>(1u)));
}
@fragment fn depth_pyramid_seed_furthest_fragment(@builtin(position) position : vec4<f32>) -> @location(0) f32 {
  return evaluate_seed_furthest(vec2<u32>(position.xy), max(textureDimensions(sourceDepth, 0) / vec2<u32>(2u), vec2<u32>(1u)));
}
fn paddedSeedSize() -> vec2u {
  let sourceSize = vec2f(textureDimensions(sourceDepth, 0));
  return vec2u(exp2(ceil(log2(max(sourceSize * 0.5, vec2f(1.0))))));
}

@fragment fn depth_pyramid_seed_padded_fragment(@builtin(position) position: vec4f) -> @location(0) f32 {
  return evaluate_seed(vec2u(position.xy), paddedSeedSize());
}

@fragment fn depth_pyramid_seed_furthest_padded_fragment(@builtin(position) position: vec4f) -> @location(0) f32 {
  return evaluate_seed_furthest(vec2u(position.xy), paddedSeedSize());
}
#else
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_seed(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let size = textureDimensions(pyramidOutput);
  if (any(globalId.xy >= size)) { return; }
  let depth = evaluate_seed(globalId.xy, size);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(depth, 0.0, 0.0, 1.0));
}
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_seed_furthest(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let size = textureDimensions(pyramidOutput);
  if (any(globalId.xy >= size)) { return; }
  let depth = evaluate_seed_furthest(globalId.xy, size);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(depth, 0.0, 0.0, 1.0));
}
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_seed_furthest_multisampled(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let size = textureDimensions(pyramidOutput);
  if (any(globalId.xy >= size)) { return; }
  let depth = evaluate_seed_furthest_multisampled(globalId.xy, size, false);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(depth, 0.0, 0.0, 1.0));
}
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_seed_furthest_resolve_msaa(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let size = textureDimensions(pyramidOutput);
  if (any(globalId.xy >= size)) { return; }
  let depth = evaluate_seed_furthest_multisampled(globalId.xy, size, true);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(depth, 0.0, 0.0, 1.0));
}
#endif
