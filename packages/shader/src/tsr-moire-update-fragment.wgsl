@group(0) @binding(0) var moireRawTex: texture_2d<f32>;
@group(0) @binding(1) var moireFieldTex: texture_2d<f32>;
@group(0) @binding(2) var moireHistoryTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> params: TsrParams;

@fragment
fn tsr_moire_update_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return tsrMoireUpdate(moireRawTex, moireFieldTex, moireHistoryTex, vec2<i32>(position.xy));
}
