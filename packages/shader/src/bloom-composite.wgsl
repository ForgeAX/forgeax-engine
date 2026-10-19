#define_import_path forgeax_view::bloom_composite
// Three r184 five-level weighting. Preserve scene alpha and encode only at output.
// Content marker: bloomComposite
#import forgeax_view::common::{FullscreenOutput, clampLinearHdr, fullscreen_triangle}
struct BloomCompositeParams { intensity : f32, radius : f32, pad1 : f32, pad2 : f32 };
@group(0) @binding(0) var hdrColor : texture_2d<f32>;
@group(0) @binding(1) var bloom0 : texture_2d<f32>;
@group(0) @binding(2) var bloom1 : texture_2d<f32>;
@group(0) @binding(3) var bloom2 : texture_2d<f32>;
@group(0) @binding(4) var bloom3 : texture_2d<f32>;
@group(0) @binding(5) var bloom4 : texture_2d<f32>;
@group(0) @binding(6) var samp : sampler;
@group(0) @binding(7) var<uniform> params : BloomCompositeParams;
fn bloomWeight(factor : f32) -> f32 { return mix(factor, 1.2 - factor, params.radius); }
@vertex fn vs_main(@builtin(vertex_index) index : u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let scene = textureSampleLevel(hdrColor, samp, in.uv, 0.0);
  let bloom = textureSampleLevel(bloom0, samp, in.uv, 0.0).rgb * bloomWeight(1.0)
    + textureSampleLevel(bloom1, samp, in.uv, 0.0).rgb * bloomWeight(0.8)
    + textureSampleLevel(bloom2, samp, in.uv, 0.0).rgb * bloomWeight(0.6)
    + textureSampleLevel(bloom3, samp, in.uv, 0.0).rgb * bloomWeight(0.4)
    + textureSampleLevel(bloom4, samp, in.uv, 0.0).rgb * bloomWeight(0.2);
  return vec4<f32>(clampLinearHdr(scene.rgb + params.intensity * bloom), scene.a);
}
