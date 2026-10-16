#define_import_path regression::left
#import forgeax_material::parameters::{material}
struct Input { @location(0) position: vec3<f32> }
@vertex fn vs_main(input: Input) -> @builtin(position) vec4<f32> {
  return vec4<f32>(input.position.xy * 0.4 + vec2<f32>(-0.6, 0.0), 0.5, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> {
  return vec4<f32>(material.strength, 0.0, 0.0, 1.0);
}
