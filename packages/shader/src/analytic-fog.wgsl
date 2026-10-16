#define_import_path forgeax_view::analytic_fog
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle}
#import forgeax_view::fog::{height_fog}

// Blends premultiplied fog (one, one-minus-src-alpha) onto the opaque scene
// before transmission and translucency, which fog themselves at their own depth.
@group(0) @binding(0) var<uniform> fog_view: View;
@group(0) @binding(1) var scene_depth: texture_depth_2d;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let size = textureDimensions(scene_depth);
  let pixel = clamp(vec2<i32>(input.position.xy), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
  let depth = textureLoad(scene_depth, pixel, 0);
  // The authored sky remains its own background; only finite scene surfaces receive fog.
  if depth <= 0.0 { discard; }
  let ndc = vec4<f32>(input.uv.x * 2.0 - 1.0, 1.0 - input.uv.y * 2.0, depth, 1.0);
  let projected = fog_view.inverseViewProj * ndc;
  let fog = height_fog(fog_view, projected.xyz / projected.w);
  return vec4<f32>(fog.inscatter, 1.0 - fog.transmittance);
}
