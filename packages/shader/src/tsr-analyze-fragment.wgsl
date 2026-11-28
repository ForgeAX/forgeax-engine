@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var dilated: texture_2d<f32>;
@group(0) @binding(2) var previousGuide: texture_2d<f32>;
@group(0) @binding(3) var previousMoire: texture_2d<f32>;
@group(0) @binding(4) var previousTemporal: texture_2d<f32>;
@group(0) @binding(5) var coverage: texture_2d<f32>;
@group(0) @binding(6) var dilatedEdgeTex: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(8) var<uniform> params: TsrParams;

fn tsrAnalyzeGcs(p: vec2<i32>, origin: vec2<i32>) -> vec3<f32> {
  return tsrLinearToGcs(textureLoad(scene, p, 0).rgb * tsrExposure(params.flicker.z));
}
fn tsrAnalyzeDilatedMotion(p: vec2<i32>, origin: vec2<i32>) -> vec2<f32> {
  return textureLoad(dilated, clamp(p, vec2<i32>(0), vec2<i32>(params.inputSize) - 1), 0).xy;
}
@fragment
fn tsr_analyze_fragment(@builtin(position) position: vec4<f32>) -> TsrAnalysisResult {
  return tsrAnalyze(vec2<i32>(position.xy), vec2<i32>(0), vec2<i32>(0));
}
