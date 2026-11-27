#define_import_path forgeax_view::bloom_vertical
#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle}
#import forgeax_view::bloom_filter::{bloomAttachmentColor, bloomGaussian}

struct BloomVerticalParams { level: f32, weight: f32, coarserWeight: f32, packed: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var coarser: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> params: BloomVerticalParams;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(in: FullscreenOutput) -> @location(0) vec4<f32> {
  let step = vec2<f32>(0.0, 1.0 / f32(textureDimensions(src).y));
  var color = bloomGaussian(src, samp, in.uv, step, u32(params.level)) * params.weight;
  if (params.coarserWeight > 0.0) {
    color += textureSampleLevel(coarser, samp, in.uv, 0.0).rgb * params.coarserWeight;
  }
  return vec4<f32>(bloomAttachmentColor(color, params.packed > 0.0), 1.0);
}
