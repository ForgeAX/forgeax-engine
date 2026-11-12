@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(2) var previousGuide: texture_2d<f32>;
@group(0) @binding(3) var previousMoire: texture_2d<f32>;
@group(0) @binding(4) var previousTemporal: texture_2d<f32>;
@group(0) @binding(5) var opaqueGuide: texture_2d<f32>;
@group(0) @binding(6) var coverage: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(8) var<uniform> params: TsrParams;

fn tsrAnalyzeGuide(p: vec2<i32>, origin: vec2<i32>) -> vec3<f32> {
  return tsrGuide(textureLoad(scene, p, 0).rgb);
}
fn tsrAnalyzeOpaque(p: vec2<i32>, origin: vec2<i32>) -> vec3<f32> {
  return textureLoad(opaqueGuide, p, 0).rgb;
}
@fragment
fn tsr_analyze_fragment(@builtin(position) position: vec4<f32>) -> TsrAnalysisResult {
  return tsrAnalyze(vec2<i32>(position.xy), vec2<i32>(0));
}
