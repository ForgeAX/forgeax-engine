#import forgeax_view::common::{view, FullscreenOutput, fullscreen_triangle}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}
#import forgeax_pbr::contact_shadow::{directionalContactShadow}
#import forgeax_shadow::capsule::{capsuleVisibility}

@group(1) @binding(0) var sceneDepth : texture_depth_2d;
@group(1) @binding(1) var sceneNormal : texture_2d<u32>;
@group(1) @binding(2) var<uniform> frame : vec4<f32>;
@group(1) @binding(3) var capsules : texture_2d<f32>;
@group(1) @binding(4) var capsuleTiles : texture_2d<u32>;

fn capsuleTexel(index : u32) -> vec4<f32> {
  let width = textureDimensions(capsules).x;
  return textureLoad(capsules, vec2<i32>(i32(index % width), i32(index / width)), 0);
}
fn capsuleTileWord(index : u32) -> u32 {
  let width = textureDimensions(capsuleTiles).x;
  let texel = index / 4u;
  return textureLoad(capsuleTiles, vec2<i32>(i32(texel % width), i32(texel / width)), 0)[index % 4u];
}
fn capsuleShadow(position : vec3<f32>, pixel : vec2<i32>) -> f32 {
  if (frame.z <= 0.0) { return 1.0; }
  let tile = vec2<u32>(pixel) / 16u;
  let header = capsuleTileWord(tile.y * u32(frame.w) + tile.x);
  let count = min(header & 63u, 32u);
  let offset = header >> 6u;
  let toLight = normalize(-view.lightDir);
  var visibility = 1.0;
  for (var i = 0u; i < count; i++) {
    let index = capsuleTileWord(offset + i) * 2u;
    let start = capsuleTexel(index);
    let end = capsuleTexel(index + 1u);
    visibility *= capsuleVisibility(position, toLight, start.xyz, start.w, end.xyz, end.w, frame.z);
    if (visibility <= 0.001) { break; }
  }
  return visibility;
}

@vertex fn vs_main(@builtin(vertex_index) index : u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}
@fragment fn fs_main(input : FullscreenOutput) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(input.position.xy);
  let depth = textureLoad(sceneDepth, pixel, 0);
  if (depth <= 0.0) { return vec4<f32>(1.0); }
  let uv = input.position.xy / vec2<f32>(textureDimensions(sceneDepth));
  let homogeneous = view.inverseViewProj * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
  let position = homogeneous.xyz / homogeneous.w;
  let normal = loadStandardNormalRoughness(sceneNormal, pixel).xyz;
  var visibility = capsuleShadow(position, pixel);
  if (frame.y > 0.0) {
    visibility *= directionalContactShadow(view, sceneDepth, position, normal, pixel, frame.x);
  }
  return vec4<f32>(visibility);
}
