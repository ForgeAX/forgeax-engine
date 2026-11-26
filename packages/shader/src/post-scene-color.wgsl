@group(1) @binding(0) var scene: texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(position.xy) * 2;
  let edge = vec2<i32>(textureDimensions(scene)) - 1;
  let a = textureLoad(scene, p, 0);
  let b = textureLoad(scene, min(p + vec2<i32>(1, 0), edge), 0);
  let c = textureLoad(scene, min(p + vec2<i32>(0, 1), edge), 0);
  let d = textureLoad(scene, min(p + 1, edge), 0);
  return (a + b + c + d) * 0.25;
}
