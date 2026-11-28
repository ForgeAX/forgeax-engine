@group(0) @binding(0) var tsrInput: texture_2d<f32>;
@group(0) @binding(1) var tsrHistory: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: TsrParams;

@fragment
fn tsr_clamp_fragment(@builtin(position) position: vec4<f32>) -> TsrClampResult {
  let p = vec2<i32>(position.xy);
  return tsrClamp(tsrInput, tsrHistory, p);
}
