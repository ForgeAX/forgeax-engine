#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle}
struct ScreenParameters { size: vec4<u32>, enabled: vec4<u32> }
@group(0) @binding(0) var<uniform> params: ScreenParameters;
@group(0) @binding(1) var ambientOcclusion: texture_2d<f32>;
@group(0) @binding(2) var contactVisibility: texture_2d<f32>;
@group(0) @binding(3) var decalColor: texture_2d<f32>;
@group(0) @binding(4) var decalNormal: texture_2d<f32>;
@group(0) @binding(5) var decalRoughness: texture_2d<f32>;

fn bilinear(source: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
  let dimensions = vec2<i32>(textureDimensions(source));
  let coordinate = clamp(uv * vec2<f32>(dimensions) - 0.5, vec2<f32>(0.0), vec2<f32>(dimensions - 1));
  let low = vec2<i32>(floor(coordinate));
  let high = min(low + 1, dimensions - 1);
  let weight = fract(coordinate);
  return mix(mix(textureLoad(source, low, 0), textureLoad(source, vec2<i32>(high.x, low.y), 0), weight.x),
    mix(textureLoad(source, vec2<i32>(low.x, high.y), 0), textureLoad(source, high, 0), weight.x), weight.y);
}
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput { return fullscreen_triangle(index); }
@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let coordinate = vec2<u32>(input.position.xy);
  let tile = coordinate / params.size.xy;
  let pixel = coordinate % params.size.xy;
  let uv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(params.size.xy);
  let layer = tile.x + tile.y * 2u;
  if (layer == 0u) {
    var ao = 1.0;
    var contact = 1.0;
    if (params.enabled.x != 0u) { ao = bilinear(ambientOcclusion, uv).r; }
    if (params.enabled.y != 0u) { contact = textureLoad(contactVisibility, vec2<i32>(pixel), 0).r; }
    return vec4<f32>(ao, contact, 0.0, 0.0);
  }
  if (params.enabled.z == 0u) { return vec4<f32>(0.0); }
  if (layer == 1u) { return textureLoad(decalColor, vec2<i32>(pixel), 0); }
  if (layer == 2u) { return textureLoad(decalNormal, vec2<i32>(pixel), 0); }
  return textureLoad(decalRoughness, vec2<i32>(pixel), 0);
}
