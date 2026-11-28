// UE 5.8.1 TSRMeasureFlickeringLuma: pre-fog/pre-translucency exposed GLuma in rgba8unorm.
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var opaqueGuide: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> opaqueParams: vec4<f32>;

@compute @workgroup_size(8, 8)
fn tsr_measure_opaque(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(opaqueGuide);
  if (any(id.xy >= size)) { return; }
  let pixel = vec2<i32>(id.xy);
  let exposure = tsrExposure(opaqueParams.x);
  let gluma = tsrFlickerLuma(textureLoad(scene, pixel, 0).rgb * exposure);
  textureStore(opaqueGuide, pixel, vec4<f32>(gluma, 0.0, 0.0, 1.0));
}
