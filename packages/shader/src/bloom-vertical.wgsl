#define_import_path forgeax_view::bloom_vertical
// Three r184 separable Gaussian, vertical half of each progressive level.
#import forgeax_view::common::{FullscreenOutput, clampLinearHdr, fullscreen_triangle}
struct BloomVerticalParams { level : f32, pad0 : f32, pad1 : f32, pad2 : f32 };
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var<uniform> params : BloomVerticalParams;
@vertex fn vs_main(@builtin(vertex_index) index : u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let radius = 6u + 4u * u32(params.level);
  let sigma = f32(radius) / 3.0;
  let centreWeight = 0.39894 / sigma;
  var color = textureSampleLevel(src, samp, in.uv, 0.0).rgb * centreWeight;
  for (var i = 1u; i < radius; i += 1u) {
    let weight = centreWeight * exp(-0.5 * f32(i * i) / (sigma * sigma));
    let offset = vec2<f32>(0.0, f32(i) / f32(textureDimensions(src).y));
    color += (textureSampleLevel(src, samp, in.uv + offset, 0.0).rgb
      + textureSampleLevel(src, samp, in.uv - offset, 0.0).rgb) * weight;
  }
  return vec4<f32>(clampLinearHdr(color), 1.0);
}
