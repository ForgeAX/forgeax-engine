#define_import_path forgeax_depth_pyramid::reduce

// Depth pyramid reduction consumes the previous r32float mip.  It is deliberately a
// separate module from the depth seed: WebGPU depth sample types cannot bind
// an r32float view, while the seed must retain the depth-only binding.
#import forgeax_depth_pyramid::sample::{
  DEPTH_PYRAMID_EMPTY_DEPTH,
  depthPyramidDepthOrEmpty,
  depthPyramidFootprintEnd,
  depthPyramidFootprintStart,
}

@group(0) @binding(0) var sourcePyramid : texture_2d<f32>;
#if !PORTABLE_FRAGMENT
@group(0) @binding(1) var pyramidOutput : texture_storage_2d<r32float, write>;
#endif

fn reduceDepthPyramidFootprint(
  destinationCoordinate : vec2<u32>,
  sourceSize : vec2<u32>,
  destinationSize : vec2<u32>,
  furthest : bool,
) -> f32 {
  let sourceStart = depthPyramidFootprintStart(destinationCoordinate, sourceSize, destinationSize);
  let sourceEnd = depthPyramidFootprintEnd(destinationCoordinate, sourceSize, destinationSize);
  var reduced = select(DEPTH_PYRAMID_EMPTY_DEPTH, 0.0, furthest);
  for (var y = sourceStart.y; y < sourceEnd.y; y += 1u) {
    for (var x = sourceStart.x; x < sourceEnd.x; x += 1u) {
      let depth = depthPyramidDepthOrEmpty(textureLoad(sourcePyramid, vec2<i32>(vec2<u32>(x, y)), 0).r);
      reduced = select(min(reduced, depth), max(reduced, depth), furthest);
    }
  }
  return reduced;
}

#if !PORTABLE_FRAGMENT
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_reduce(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let sourceSize = textureDimensions(sourcePyramid, 0);
  let destinationSize = textureDimensions(pyramidOutput);
  if (globalId.x >= destinationSize.x || globalId.y >= destinationSize.y) {
    return;
  }
  let reduced = reduceDepthPyramidFootprint(globalId.xy, sourceSize, destinationSize, false);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(reduced, 0.0, 0.0, 1.0));
}

// The occlusion variant keeps the farthest covered depth so a coarse texel
// never claims to occlude more than every finer texel beneath it.
@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_reduce_furthest(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let sourceSize = textureDimensions(sourcePyramid, 0);
  let destinationSize = textureDimensions(pyramidOutput);
  if (globalId.x >= destinationSize.x || globalId.y >= destinationSize.y) {
    return;
  }
  let reduced = reduceDepthPyramidFootprint(globalId.xy, sourceSize, destinationSize, true);
  textureStore(pyramidOutput, vec2<i32>(globalId.xy), vec4<f32>(reduced, 0.0, 0.0, 1.0));
}

// A padded chain has 2×2 cells throughout. The first level of an 8×8 tile
// can feed two more levels without round-tripping those texels through memory.
@group(0) @binding(2) var pyramidOutput2 : texture_storage_2d<r32float, write>;
@group(0) @binding(3) var pyramidOutput3 : texture_storage_2d<r32float, write>;
var<workgroup> depthTile : array<f32, 64>;
var<workgroup> halfDepthTile : array<f32, 16>;

fn paddedFurthestDepth(pixel: vec2u, last: vec2u) -> f32 {
  let a = depthPyramidDepthOrEmpty(textureLoad(sourcePyramid, vec2i(min(pixel, last)), 0).r);
  let b = depthPyramidDepthOrEmpty(textureLoad(sourcePyramid, vec2i(min(pixel + vec2u(1u, 0u), last)), 0).r);
  let c = depthPyramidDepthOrEmpty(textureLoad(sourcePyramid, vec2i(min(pixel + vec2u(0u, 1u), last)), 0).r);
  let d = depthPyramidDepthOrEmpty(textureLoad(sourcePyramid, vec2i(min(pixel + 1u, last)), 0).r);
  return max(max(a, b), max(c, d));
}

@compute @workgroup_size(8, 8, 1)
fn depth_pyramid_reduce_furthest_batch(
  @builtin(global_invocation_id) id: vec3u,
  @builtin(local_invocation_id) local: vec3u,
  @builtin(local_invocation_index) lane: u32,
) {
  let size = textureDimensions(pyramidOutput);
  let depth = paddedFurthestDepth(min(id.xy, size - 1u) * 2u, textureDimensions(sourcePyramid, 0) - 1u);
  depthTile[lane] = depth;
  if (all(id.xy < size)) {
    textureStore(pyramidOutput, vec2i(id.xy), vec4f(depth, 0.0, 0.0, 1.0));
  }
  workgroupBarrier();

  let halfTilePixel = local.xy / 2u;
  let halfLane = halfTilePixel.y * 4u + halfTilePixel.x;
  if (all((local.xy & vec2u(1u)) == vec2u(0u))) {
    let reduced = max(max(depthTile[lane], depthTile[lane + 1u]),
      max(depthTile[lane + 8u], depthTile[lane + 9u]));
    halfDepthTile[halfLane] = reduced;
    let pixel = id.xy / 2u;
    if (all(pixel < textureDimensions(pyramidOutput2))) {
      textureStore(pyramidOutput2, vec2i(pixel), vec4f(reduced, 0.0, 0.0, 1.0));
    }
  }
  workgroupBarrier();

  if (all((local.xy & vec2u(3u)) == vec2u(0u))) {
    let pixel = id.xy / 4u;
    let reduced = max(max(halfDepthTile[halfLane], halfDepthTile[halfLane + 1u]),
      max(halfDepthTile[halfLane + 4u], halfDepthTile[halfLane + 5u]));
    if (all(pixel < textureDimensions(pyramidOutput3))) {
      textureStore(pyramidOutput3, vec2i(pixel), vec4f(reduced, 0.0, 0.0, 1.0));
    }
  }
}

#else
@vertex fn depth_pyramid_fullscreen(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn depth_pyramid_reduce_fragment(@builtin(position) position : vec4<f32>) -> @location(0) f32 {
  return reduceDepthPyramidFootprint(vec2<u32>(position.xy), textureDimensions(sourcePyramid, 0), max(textureDimensions(sourcePyramid, 0) / vec2<u32>(2u), vec2<u32>(1u)), false);
}
@fragment fn depth_pyramid_reduce_furthest_fragment(@builtin(position) position : vec4<f32>) -> @location(0) f32 {
  return reduceDepthPyramidFootprint(vec2<u32>(position.xy), textureDimensions(sourcePyramid, 0), max(textureDimensions(sourcePyramid, 0) / vec2<u32>(2u), vec2<u32>(1u)), true);
}
#endif
