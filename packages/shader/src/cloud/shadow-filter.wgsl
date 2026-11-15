#define_import_path forgeax_cloud::shadow_filter
#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle}
#import forgeax_cloud::shadow::{cloud_shadow_filter}

@group(1) @binding(0) var rawShadow: texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) id: u32) -> FullscreenOutput {
  return fullscreen_triangle(id);
}

@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4f {
  let base = vec2i(input.position.xy) * 2;
  let last = vec2i(textureDimensions(rawShadow)) - vec2i(1);
  let a = textureLoad(rawShadow, min(base, last), 0).xyz;
  let b = textureLoad(rawShadow, min(base + vec2i(1, 0), last), 0).xyz;
  let c = textureLoad(rawShadow, min(base + vec2i(0, 1), last), 0).xyz;
  let d = textureLoad(rawShadow, min(base + vec2i(1, 1), last), 0).xyz;
  return vec4f(cloud_shadow_filter(a, b, c, d), 1.0);
}
