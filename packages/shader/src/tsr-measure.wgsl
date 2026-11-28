@group(0) @binding(0) var tsrInput: texture_2d<f32>;
@group(0) @binding(1) var tsrClampedInput: texture_2d<f32>;
@group(0) @binding(2) var tsrClampedHistory: texture_2d<f32>;
@group(0) @binding(3) var tsrMoireError: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var<uniform> params: TsrParams;
@group(0) @binding(6) var rawEnergy: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var rawDelta: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn tsr_measure(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let p = vec2<i32>(id.xy);
  let result = tsrMeasure(tsrInput, tsrClampedInput, tsrClampedHistory, tsrLoadIn(tsrMoireError, p).r, p);
  textureStore(rawEnergy, p, result.raw);
  textureStore(rawDelta, p, result.delta);
}
