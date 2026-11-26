#define_import_path forgeax_view::bloom_composite
// Content marker: bloomComposite
// linearHdrColorDomain: blend before display encoding.
#import forgeax_view::common::{FullscreenOutput, clampLinearHdr, fullscreen_triangle}

struct BloomCompositeParams { intensity: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: BloomCompositeParams;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(in: FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = textureSampleLevel(source, samp, in.uv, 0.0);
  let glow = textureSampleLevel(bloom, samp, in.uv, 0.0).rgb;
  return vec4<f32>(clampLinearHdr(scene.rgb + params.intensity * glow), scene.a);
}
