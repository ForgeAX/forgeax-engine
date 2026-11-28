@group(0) @binding(0) var moireUpdateTex: texture_2d<f32>;
@group(0) @binding(1) var moireFieldTex: texture_2d<f32>;
@group(0) @binding(2) var moirePreviousTex: texture_2d<f32>;
@group(0) @binding(3) var moireGuideTex: texture_2d<f32>;
@group(0) @binding(4) var moireEdgeTex: texture_2d<f32>;
@group(0) @binding(5) var linearSampler: sampler;
@group(0) @binding(6) var<uniform> params: TsrParams;
@group(0) @binding(7) var moireHistoryOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(8) var moireErrorOutput: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn tsr_moire_history(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let p = vec2<i32>(id.xy);
  let result = tsrMoireHistory(moireUpdateTex, moireFieldTex, moirePreviousTex, moireGuideTex, moireEdgeTex, p);
  textureStore(moireHistoryOutput, p, result.history);
  textureStore(moireErrorOutput, p, result.error);
}
