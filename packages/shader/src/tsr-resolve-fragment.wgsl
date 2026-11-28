@group(0) @binding(0) var tsrHistory: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> params: TsrParams;

@fragment
fn tsr_resolve_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return tsrResolveHistory(vec2<i32>(position.xy));
}
