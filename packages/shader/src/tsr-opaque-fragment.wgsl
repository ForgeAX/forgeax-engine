// UE 5.8.1 TSRMeasureFlickeringLuma: pre-fog/pre-translucency exposed GLuma in rgba8unorm.
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> opaqueParams: vec4<f32>;
@fragment
fn tsr_measure_opaque_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let exposure = tsrExposure(opaqueParams.x);
  let gluma = tsrFlickerLuma(textureLoad(scene, vec2<i32>(position.xy), 0).rgb * exposure);
  return vec4<f32>(gluma, 0.0, 0.0, 1.0);
}
