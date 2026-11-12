@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var opaqueGuide: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn tsr_measure_opaque(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(opaqueGuide);
  if (any(id.xy >= size)) { return; }
  let pixel = vec2<i32>(id.xy);
  textureStore(opaqueGuide, pixel, vec4<f32>(tsrGuide(textureLoad(scene, pixel, 0).rgb), 1.0));
}
