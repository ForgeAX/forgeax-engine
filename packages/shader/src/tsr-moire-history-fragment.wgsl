@group(0) @binding(0) var moireUpdateTex: texture_2d<f32>;
@group(0) @binding(1) var moireFieldTex: texture_2d<f32>;
@group(0) @binding(2) var moirePreviousTex: texture_2d<f32>;
@group(0) @binding(3) var moireGuideTex: texture_2d<f32>;
@group(0) @binding(4) var moireEdgeTex: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var<uniform> params: TsrParams;

@fragment
fn tsr_moire_history_fragment(@builtin(position) position: vec4<f32>) -> TsrMoireHistoryResult {
  return tsrMoireHistory(moireUpdateTex, moireFieldTex, moirePreviousTex, moireGuideTex, moireEdgeTex,
    vec2<i32>(position.xy));
}
