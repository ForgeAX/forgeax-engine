#define_import_path regression::external_unlit
#import forgeax_material::parameters::{material, videoTexture, videoTexture_sampler}
struct Input { @location(0) position: vec3<f32>, @location(2) uv: vec2<f32> }
struct Varyings { @builtin(position) clip: vec4<f32>, @location(0) uv: vec2<f32> }
@vertex fn vs_main(input: Input) -> Varyings {
  var out: Varyings;
  out.clip = vec4<f32>(input.position.xy * 2.0, 0.5, 1.0);
  out.uv = input.uv;
  return out;
}
@fragment fn fs_main(input: Varyings) -> @location(0) vec4<f32> {
  return textureSampleBaseClampToEdge(videoTexture, videoTexture_sampler, input.uv);
}
