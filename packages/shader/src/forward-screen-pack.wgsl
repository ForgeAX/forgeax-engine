#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle}
struct PackParameters { dimensions: vec4<u32> }
@group(0) @binding(0) var<uniform> params: PackParameters;
@group(0) @binding(1) var source: texture_2d<f32>;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput { return fullscreen_triangle(index); }
@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4<u32> {
  let destination = vec2<u32>(input.position.xy);
  let index = (destination.y - params.dimensions.x) * params.dimensions.y + destination.x;
  let size = textureDimensions(source);
  let packedWidth = size.x / 2u;
  if (index >= packedWidth * size.y) { discard; }
  let pixel = vec2<u32>((index % packedWidth) * 2u, index / packedWidth);
  let a = textureLoad(source, vec2<i32>(pixel), 0);
  let b = textureLoad(source, vec2<i32>(pixel + vec2<u32>(1u, 0u)), 0);
  return vec4<u32>(pack2x16float(a.xy), pack2x16float(a.zw), pack2x16float(b.xy), pack2x16float(b.zw));
}
