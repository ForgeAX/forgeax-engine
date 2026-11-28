#define_import_path forgeax_material::water_caustics_copy
@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(1) var sceneSampler: sampler;
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return textureLoad(scene, vec2<i32>(p.xy), 0);
}
