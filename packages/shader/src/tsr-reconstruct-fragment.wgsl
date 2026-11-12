@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(2) var previousColor: texture_2d<f32>;
@group(0) @binding(3) var previousTemporal: texture_2d<f32>;
@group(0) @binding(4) var previousMetadata: texture_2d<f32>;
@group(0) @binding(5) var decision: texture_2d<f32>;
@group(0) @binding(6) var secondary: texture_2d<f32>;
@group(0) @binding(7) var coverage: texture_2d<f32>;
@group(0) @binding(8) var linearSampler: sampler;
@group(0) @binding(9) var<uniform> params: TsrParams;

fn tsrCachedScene(p: vec2<i32>, origin: vec2<i32>) -> vec4<f32> {
  return textureLoad(scene, p, 0);
}
fn tsrInputGeometry(center: vec2<i32>, origin: vec2<i32>) -> TsrGeometry {
  return tsrClosestTemporalAt(sceneTemporal, center, 1);
}
fn tsrCoverageGeometry(center: vec2<i32>, radius: i32, origin: vec2<i32>, column: u32) -> TsrGeometry {
  return tsrClosestTemporalAt(coverage, center, radius);
}
@fragment
fn tsr_reconstruct_fragment(@builtin(position) position: vec4<f32>) -> TsrReconstructionResult {
  return tsrReconstruct(tsrReconstructionInput(vec2<u32>(position.xy),textureDimensions(previousColor)), textureDimensions(previousColor),
    vec2<i32>(0), vec2<i32>(0));
}
