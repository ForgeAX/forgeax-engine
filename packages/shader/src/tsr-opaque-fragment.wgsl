@group(0) @binding(0) var scene: texture_2d<f32>;
@fragment
fn tsr_measure_opaque_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(tsrGuide(textureLoad(scene, vec2<i32>(position.xy), 0).rgb), 1.0);
}
