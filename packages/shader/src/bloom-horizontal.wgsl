#define_import_path forgeax_view::bloom_horizontal
// Three r184 BloomNode: horizontal truncated Gaussian, radii 6/10/14/18/22.
// Level zero fuses the half-resolution high pass at the exact source texel centres.
// linearHdrColorDomain: threshold and convolution stay in linear HDR.
#import forgeax_view::common::{FullscreenOutput, clampLinearHdr, fullscreen_triangle}
struct BloomHorizontalParams {
  threshold : f32,
  smoothWidth : f32,
  destinationW : f32,
  destinationH : f32,
  level : f32,
  pad0 : f32,
  pad1 : f32,
  pad2 : f32,
};
@group(0) @binding(0) var src : texture_2d<f32>;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var<uniform> params : BloomHorizontalParams;
fn bloomInput(uv : vec2<f32>) -> vec3<f32> {
  if (params.level > 0.0) { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
  let halfTexel = 0.5 / vec2<f32>(params.destinationW, params.destinationH);
  let color = textureSampleLevel(src, samp, clamp(uv, halfTexel, 1.0 - halfTexel), 0.0).rgb;
  let luma = min(dot(color, vec3<f32>(0.2126, 0.7152, 0.0722)), 65504.0);
  if (params.smoothWidth == 0.0) { return color * select(0.0, 1.0, luma > params.threshold); }
  return color * smoothstep(params.threshold, params.threshold + params.smoothWidth, luma);
}
@vertex fn vs_main(@builtin(vertex_index) index : u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let radius = 6u + 4u * u32(params.level);
  let sigma = f32(radius) / 3.0;
  let centreWeight = 0.39894 / sigma;
  var color = bloomInput(in.uv) * centreWeight;
  for (var i = 1u; i < radius; i += 1u) {
    let weight = centreWeight * exp(-0.5 * f32(i * i) / (sigma * sigma));
    let offset = vec2<f32>(f32(i) / params.destinationW, 0.0);
    color += (bloomInput(in.uv + offset) + bloomInput(in.uv - offset)) * weight;
  }
  return vec4<f32>(clampLinearHdr(color), 1.0);
}
