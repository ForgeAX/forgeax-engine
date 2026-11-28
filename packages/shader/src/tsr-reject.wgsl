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
@group(0) @binding(10) var guideOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var decisionOutput: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn tsr_reject(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let p = vec2<i32>(id.xy);
  let result = tsrReject(tsrInput, tsrHistory, tsrRaw, tsrDelta, tsrDecimate, tsrResurrected,
    tsrResurrectedRaw, tsrResurrectedDelta, p);
  textureStore(guideOutput, p, result.guide);
  textureStore(decisionOutput, p, result.decision);
}
