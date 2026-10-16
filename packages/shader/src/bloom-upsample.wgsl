#define_import_path forgeax_view::bloom_upsample

// @forgeax/engine-shader - bloom-upsample.wgsl
// One tent reconstruction module serves every coarse-to-fine pyramid edge.

#import forgeax_view::common::{FullscreenOutput, clampLinearHdr, fullscreen_triangle}

struct BloomUpsampleParams {
  scatter : f32,
  pad0    : f32,
  pad1    : f32,
  pad2    : f32,
};

@group(0) @binding(0) var current : texture_2d<f32>;
@group(0) @binding(1) var coarse  : texture_2d<f32>;
@group(0) @binding(2) var samp     : sampler;
@group(0) @binding(3) var<uniform> params : BloomUpsampleParams;

fn tent(uv : vec2<f32>) -> vec3<f32> {
  let coarseTexel = 1.0 / vec2<f32>(textureDimensions(coarse));
  let x0 = textureSampleLevel(coarse, samp, uv + vec2<f32>(-1.0, -1.0) * coarseTexel, 0.0).rgb;
  let x1 = textureSampleLevel(coarse, samp, uv + vec2<f32>( 0.0, -1.0) * coarseTexel, 0.0).rgb;
  let x2 = textureSampleLevel(coarse, samp, uv + vec2<f32>( 1.0, -1.0) * coarseTexel, 0.0).rgb;
  let x3 = textureSampleLevel(coarse, samp, uv + vec2<f32>(-1.0,  0.0) * coarseTexel, 0.0).rgb;
  let x4 = textureSampleLevel(coarse, samp, uv + vec2<f32>( 0.0,  0.0) * coarseTexel, 0.0).rgb;
  let x5 = textureSampleLevel(coarse, samp, uv + vec2<f32>( 1.0,  0.0) * coarseTexel, 0.0).rgb;
  let x6 = textureSampleLevel(coarse, samp, uv + vec2<f32>(-1.0,  1.0) * coarseTexel, 0.0).rgb;
  let x7 = textureSampleLevel(coarse, samp, uv + vec2<f32>( 0.0,  1.0) * coarseTexel, 0.0).rgb;
  let x8 = textureSampleLevel(coarse, samp, uv + vec2<f32>( 1.0,  1.0) * coarseTexel, 0.0).rgb;
  return (x0 + 2.0 * x1 + x2 + 2.0 * x3 + 4.0 * x4 + 2.0 * x5 + x6 + 2.0 * x7 + x8) / 16.0;
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let currentColor = textureSampleLevel(current, samp, in.uv, 0.0).rgb;
  let reconstructed = tent(in.uv);
  let scatter = clamp(params.scatter, 0.0, 0.95);
  return vec4<f32>(clampLinearHdr(mix(currentColor, reconstructed, scatter)), 1.0);
}
