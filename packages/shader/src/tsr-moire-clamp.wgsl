@group(0) @binding(0) var moireInputTex: texture_2d<f32>;
@group(0) @binding(1) var moireHistoryTex: texture_2d<f32>;
@group(0) @binding(2) var moireOpaqueTex: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
@group(0) @binding(4) var<uniform> params: TsrParams;
@group(0) @binding(5) var moireFieldOutput: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn tsr_moire_clamp(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let p = vec2<i32>(id.xy);
  textureStore(moireFieldOutput, p, tsrMoireClamp(moireInputTex, moireHistoryTex, moireOpaqueTex, p));
}
