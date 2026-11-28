@group(0) @binding(0) var tsrInput: texture_2d<f32>;
@group(0) @binding(1) var tsrHistory: texture_2d<f32>;
@group(0) @binding(2) var tsrRaw: texture_2d<f32>;
@group(0) @binding(3) var tsrDelta: texture_2d<f32>;
@group(0) @binding(4) var tsrDecimate: texture_2d<f32>;
@group(0) @binding(5) var tsrResurrected: texture_2d<f32>;
@group(0) @binding(6) var tsrResurrectedRaw: texture_2d<f32>;
@group(0) @binding(7) var tsrResurrectedDelta: texture_2d<f32>;
@group(0) @binding(8) var linearSampler: sampler;
@group(0) @binding(9) var<uniform> params: TsrParams;

@fragment
fn tsr_reject_fragment(@builtin(position) position: vec4<f32>) -> TsrRejectResult {
  let p = vec2<i32>(position.xy);
  return tsrReject(tsrInput, tsrHistory, tsrRaw, tsrDelta, tsrDecimate, tsrResurrected,
    tsrResurrectedRaw, tsrResurrectedDelta, p);
}
