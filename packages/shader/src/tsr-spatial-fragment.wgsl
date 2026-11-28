@group(0) @binding(0) var tsrScene: texture_2d<f32>;
@group(0) @binding(1) var tsrDecision: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: TsrParams;

@fragment
fn tsr_spatial_fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  return tsrSpatial(vec2<i32>(position.xy));
}
