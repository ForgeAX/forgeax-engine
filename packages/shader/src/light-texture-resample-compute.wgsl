#import forgeax_lighting::light_texture_resample_kernel::{ResampleParams, levelTexelOffset, levelWordOffset, meanFour, reconstructPixel}
@group(0) @binding(0) var<uniform> params : ResampleParams;
@group(0) @binding(1) var source : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> levels : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> packed : array<u32>;

fn store(level : u32, x : u32, y : u32, value : vec4<f32>) {
  let outputSize = params.outputSizeAndRowAlignWords.x;
  let rowAlignWords = params.outputSizeAndRowAlignWords.y;
  let size = outputSize >> level;
  levels[levelTexelOffset(level, outputSize) + y * size + x] = value;
  packed[levelWordOffset(level, outputSize, rowAlignWords) + y * max(size, rowAlignWords) + x] = pack4x8unorm(value);
}

@compute @workgroup_size(8, 8, 1)
fn light_texture_resample(@builtin(global_invocation_id) id : vec3<u32>) {
  let outputSize = params.outputSizeAndRowAlignWords.x;
  if (id.x >= outputSize || id.y >= outputSize) { return; }
  store(0u, id.x, id.y, reconstructPixel(source, params.sourceSize, params.grayscale, id.xy, outputSize));
}

@compute @workgroup_size(8, 8, 1)
fn light_texture_reduce(@builtin(global_invocation_id) id : vec3<u32>) {
  let level = params.level;
  let outputSize = params.outputSizeAndRowAlignWords.x;
  let size = outputSize >> level;
  if (id.x >= size || id.y >= size) { return; }
  store(level, id.x, id.y, reducePixelFromBuffer(level, id.xy, outputSize));
}

fn reducePixelFromBuffer(level : u32, pixel : vec2<u32>, outputSize : u32) -> vec4<f32> {
  let size = outputSize >> level;
  let above = levelTexelOffset(level - 1u, outputSize);
  let row = above + (pixel.y * 2u) * (size * 2u) + pixel.x * 2u;
  return meanFour(
    levels[row],
    levels[row + 1u],
    levels[row + size * 2u],
    levels[row + size * 2u + 1u]
  );
}
