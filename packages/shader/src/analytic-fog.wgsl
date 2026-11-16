#define_import_path forgeax_view::analytic_fog
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle}
#import forgeax_view::fog::{height_fog}

// Blends premultiplied fog (one, one-minus-src-alpha) onto the opaque scene
// before transmission and translucency, which fog themselves at their own depth.
@group(0) @binding(0) var<uniform> fog_view: View;
@group(0) @binding(1) var scene_depth: texture_depth_2d;
@group(0) @binding(2) var scene_depth_msaa: texture_depth_multisampled_2d;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
fn fog_at_depth(position: vec2<f32>, size: vec2<u32>, depth: f32) -> vec4<f32> {
  // This pass runs only without an Atmosphere: the authored background is not
  // fogged, only finite scene surfaces are. With an Atmosphere, the compose pass
  // owns fog, including distant fog over the sky.
  // Zero premultiplied contribution preserves an empty sample without a
  // discard in a shared callee, including sample-frequency MSAA shading.
  if depth <= 0.0 { return vec4<f32>(0.0); }
  let uv = position / vec2<f32>(size);
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let projected = fog_view.inverseViewProj * ndc;
  let fog = height_fog(fog_view, projected.xyz / projected.w);
  return vec4<f32>(fog.inscatter, 1.0 - fog.transmittance);
}

@fragment fn fs_main(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let size = textureDimensions(scene_depth);
  let pixel = clamp(vec2<i32>(input.position.xy), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
  return fog_at_depth(input.position.xy, size, textureLoad(scene_depth, pixel, 0));
}

// sample_index requests sample-frequency shading: sky and finite geometry in
// the same pixel retain their independent transmittance before color resolve.
@fragment fn fs_msaa(input: FullscreenOutput, @builtin(sample_index) sample: u32) -> @location(0) vec4<f32> {
  let size = textureDimensions(scene_depth_msaa);
  let pixel = clamp(vec2<i32>(input.position.xy), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
  return fog_at_depth(input.position.xy, size, textureLoad(scene_depth_msaa, pixel, i32(sample)));
}

// The local volume integrates one ray per pixel, like its single-sample path.
// Reverse-Z selects the nearest covered sample; an entirely empty pixel stays 0.
@fragment fn fs_resolve_depth(input: FullscreenOutput) -> @builtin(frag_depth) f32 {
  let pixel = vec2<i32>(input.position.xy);
  var depth = 0.0;
  for (var sample = 0u; sample < textureNumSamples(scene_depth_msaa); sample++) {
    depth = max(depth, textureLoad(scene_depth_msaa, pixel, i32(sample)));
  }
  return depth;
}
