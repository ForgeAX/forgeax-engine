#define_import_path forgeax_view::bloom_horizontal
#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle}
#import forgeax_view::bloom_filter::{bloomAttachmentColor, bloomGaussian}

struct BloomHorizontalParams { level: f32, pad0: f32, pad1: f32, packed: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: BloomHorizontalParams;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(in: FullscreenOutput) -> @location(0) vec4<f32> {
  let step = vec2<f32>(1.0 / f32(textureDimensions(src).x), 0.0);
  return vec4<f32>(bloomAttachmentColor(bloomGaussian(src, samp, in.uv, step, u32(params.level)), params.packed > 0.0), 1.0);
}
