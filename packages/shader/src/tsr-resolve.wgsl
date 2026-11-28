@group(0) @binding(0) var tsrHistory: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> params: TsrParams;
@group(0) @binding(3) var resolveOutput: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn tsr_resolve(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= vec2<u32>(params.outputSize))) { return; }
  let p = vec2<i32>(id.xy);
  textureStore(resolveOutput, p, tsrResolveHistory(p));
}
