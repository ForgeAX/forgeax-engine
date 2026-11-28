@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var dilated: texture_2d<f32>;
@group(0) @binding(2) var previousColor: texture_2d<f32>;
@group(0) @binding(3) var previousTemporal: texture_2d<f32>;
@group(0) @binding(4) var previousMetadata: texture_2d<f32>;
@group(0) @binding(5) var decision: texture_2d<f32>;
@group(0) @binding(6) var secondary: texture_2d<f32>;
@group(0) @binding(7) var coverage: texture_2d<f32>;
@group(0) @binding(8) var spatial: texture_2d<f32>;
@group(0) @binding(9) var resurrectedColor: texture_2d<f32>;
@group(0) @binding(10) var resurrectedMetadata: texture_2d<f32>;
@group(0) @binding(11) var dilatedEdge: texture_2d<f32>;
@group(0) @binding(12) var linearSampler: sampler;
@group(0) @binding(13) var<uniform> params: TsrParams;

fn tsrCachedScene(p: vec2<i32>, origin: vec2<i32>) -> vec4<f32> {
  return textureLoad(scene, p, 0);
}
fn tsrCoverageGeometry(center: vec2<i32>, radius: i32, origin: vec2<i32>, column: u32) -> TsrGeometry {
  return tsrClosestTemporalAt(coverage, center, radius);
}
fn tsrSecondaryReactive(center: vec2<i32>, origin: vec2<i32>, cached: bool) -> f32 {
  let extent = vec2<i32>(textureDimensions(secondary));
  var reactive = 0.0;
  for (var y = -3; y <= 3; y++) {
    for (var x = -3; x <= 3; x++) {
      let p = clamp(center + vec2<i32>(x, y), vec2<i32>(0), extent - 1);
      reactive = max(reactive, textureLoad(secondary, p, 0).r);
    }
  }
  return reactive;
}
@fragment
fn tsr_reconstruct_fragment(@builtin(position) position: vec4<f32>) -> TsrReconstructionResult {
  return tsrReconstruct(tsrReconstructionInput(vec2<u32>(position.xy), textureDimensions(previousColor)),
    textureDimensions(previousColor), vec2<i32>(0), vec2<i32>(0), vec2<i32>(0), false);
}
