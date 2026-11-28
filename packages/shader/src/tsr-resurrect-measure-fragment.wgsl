@group(0) @binding(0) var tsrInput: texture_2d<f32>;
@group(0) @binding(1) var tsrClampedInput: texture_2d<f32>;
@group(0) @binding(2) var tsrClampedHistory: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> params: TsrParams;

@fragment
fn tsr_resurrect_measure_fragment(@builtin(position) position: vec4<f32>) -> TsrMeasureResult {
  let p = vec2<i32>(position.xy);
  return tsrMeasure(tsrInput, tsrClampedInput, tsrClampedHistory, 0.0, p);
}
