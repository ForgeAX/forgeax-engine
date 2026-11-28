@group(0) @binding(0) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> params: TsrParams;

fn tsrDilateSample(p: vec2<i32>, origin: vec2<i32>) -> vec4<f32> {
  return loadSceneTemporal(clamp(p, vec2<i32>(0), vec2<i32>(textureDimensions(sceneTemporal)) - 1));
}

@fragment
fn tsr_dilate_fragment(@builtin(position) position: vec4<f32>) -> TsrDilateResult {
  return tsrDilate(vec2<i32>(position.xy), vec2<i32>(0));
}
