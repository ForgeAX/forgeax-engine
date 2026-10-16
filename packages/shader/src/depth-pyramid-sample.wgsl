#define_import_path forgeax_depth_pyramid::sample

// Shared addressing for every depth pyramid, whichever reduction produced it
// and whichever pass consumes it. Texels hold positive linear view distance;
// an uncovered texel holds the empty sentinel.
const DEPTH_PYRAMID_EMPTY_DEPTH : f32 = 3.402823e+38;

fn depthPyramidDepthOrEmpty(value : f32) -> f32 {
  let valid = value == value && value > 0.0 && value < DEPTH_PYRAMID_EMPTY_DEPTH;
  return select(DEPTH_PYRAMID_EMPTY_DEPTH, value, valid);
}

// Level extent derived from level 0. A per-lane level passed to
// textureDimensions is valid WGSL, but lavapipe answers every lane with the
// first lane's level; WebGPU mips are floor-halved, so the shift is exact.
fn depthPyramidLevelSize(pyramid : texture_2d<f32>, level : u32) -> vec2<u32> {
  return max(textureDimensions(pyramid, 0) >> vec2<u32>(level), vec2<u32>(1u));
}

// The texel of a level that owns a normalized coordinate, clamped to the level.
fn depthPyramidCell(uv : vec2<f32>, levelSize : vec2<u32>) -> vec2<u32> {
  let last = levelSize - vec2<u32>(1u);
  return min(vec2<u32>(clamp(uv * vec2<f32>(levelSize), vec2<f32>(0.0), vec2<f32>(last))), last);
}

// The finer-level footprint [start, end) of a coarser cell. Boundaries are
// integer-normalized and the end is ceiled, so footprints overlap at odd
// boundaries: a 3-wide source reduced to one texel covers all three texels.
fn depthPyramidFootprintStart(
  cell : vec2<u32>,
  fineSize : vec2<u32>,
  coarseSize : vec2<u32>,
) -> vec2<u32> {
  return cell * fineSize / coarseSize;
}

fn depthPyramidFootprintEnd(
  cell : vec2<u32>,
  fineSize : vec2<u32>,
  coarseSize : vec2<u32>,
) -> vec2<u32> {
  return min((cell * fineSize + fineSize + coarseSize - vec2<u32>(1u)) / coarseSize, fineSize);
}

// WebGPU depth attachments expose perspective depth, not a linear distance.
// The pyramid stores the positive view distance consumed by screen-space
// tracers and GPU occlusion culling. The shared View UBO carries the active
// projection range, so this conversion does not create a second camera or
// projection owner.
fn linearizeViewDepth(value : f32, projection : vec4<f32>) -> f32 {
  let near = projection.x;
  let far = projection.y;
  if (!(value > 0.0 && value <= 1.0 && near > 0.0 && far > near && far < DEPTH_PYRAMID_EMPTY_DEPTH)) {
    return DEPTH_PYRAMID_EMPTY_DEPTH;
  }
  let distance = select(
    near / (value + (1.0 - value) * (near / far)),
    far - value * (far - near),
    projection.z > 0.5,
  );
  return depthPyramidDepthOrEmpty(distance);
}
