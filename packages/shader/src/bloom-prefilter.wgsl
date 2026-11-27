@group(1) @binding(0) var scene: texture_2d<f32>;
@group(1) @binding(2) var<uniform> params: vec4<f32>;
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
}
@fragment fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let color = max(textureLoad(scene, vec2<i32>(position.xy), 0).rgb, vec3<f32>(0.0));
  // The FP16 input ceiling is also the maximum Rec.709 luminance. Preserve
  // an exact hard cutoff there when the dot rounds slightly above the input.
  let luminance = min(dot(color, vec3<f32>(0.2126, 0.7152, 0.0722)), 65504.0);
  var weight = select(0.0, 1.0, luminance > params.x);
  if (params.y > 0.0) {
    weight = smoothstep(params.x, params.x + params.y, luminance);
  }
  return vec4<f32>(color * weight, 1.0);
}
