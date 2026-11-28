@group(0) @binding(0) var moireInputTex: texture_2d<f32>;
@group(0) @binding(1) var moireHistoryTex: texture_2d<f32>;
@group(0) @binding(2) var moireOpaqueTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> params: TsrParams;

@fragment
fn tsr_moire_clamp_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return tsrMoireClamp(moireInputTex, moireHistoryTex, moireOpaqueTex, vec2<i32>(position.xy));
}
