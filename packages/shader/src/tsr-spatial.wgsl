@group(0) @binding(0) var tsrScene: texture_2d<f32>;
@group(0) @binding(1) var tsrDecision: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: TsrParams;
@group(0) @binding(4) var spatialOutput: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn tsr_spatial(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let p = vec2<i32>(id.xy);
  textureStore(spatialOutput, p, tsrSpatial(p));
}
