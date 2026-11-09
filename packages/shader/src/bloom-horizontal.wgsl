#define_import_path forgeax_view::bloom_horizontal
// Three r184 BloomNode Gaussian (horizontal, truncated radii 6/10/14/18/22) whose
// input stage follows Unreal's standalone Gaussian bloom:
//  - every downsample is Unreal PostProcessDownsample.usf DOWNSAMPLE_QUALITY_HIGH:
//    four bilinear taps at +-1 source texel (a 4x4 filter), so a sub-pixel
//    highlight is spread over the whole 2x2 destination footprint before anything
//    non-linear sees it;
//  - level 0 then applies the threshold to that filtered half-resolution colour,
//    like PostProcessBloom.usf BloomSetup running on the downsampled scene;
//  - a negative threshold disables the setup (Unreal BloomThreshold -1 default).
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
// UE SampleInput: clamp to the bilinear-safe viewport so edge taps stay in range.
fn sampleSource(uv : vec2<f32>, texel : vec2<f32>) -> vec3<f32> {
  let clamped = clamp(uv, 0.5 * texel, 1.0 - 0.5 * texel);
  return textureSampleLevel(src, samp, clamped, 0.0).rgb;
}
// UE DownsampleCommon (HIGH): average of four bilinear taps at (+-1, +-1) source texels.
fn downsample4x4(uv : vec2<f32>) -> vec3<f32> {
  let texel = 1.0 / vec2<f32>(textureDimensions(src));
  let sum = sampleSource(uv + texel * vec2<f32>(-1.0, -1.0), texel)
    + sampleSource(uv + texel * vec2<f32>(1.0, -1.0), texel)
    + sampleSource(uv + texel * vec2<f32>(-1.0, 1.0), texel)
    + sampleSource(uv + texel * vec2<f32>(1.0, 1.0), texel);
  return max(sum * 0.25, vec3<f32>(0.0));
}
fn bloomInput(uv : vec2<f32>) -> vec3<f32> {
  let color = downsample4x4(uv);
  if (params.level > 0.0 || params.threshold < 0.0) { return color; }
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
