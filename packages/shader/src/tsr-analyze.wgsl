@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(2) var previousGuide: texture_2d<f32>;
@group(0) @binding(3) var previousMoire: texture_2d<f32>;
@group(0) @binding(4) var previousTemporal: texture_2d<f32>;
@group(0) @binding(5) var opaqueGuide: texture_2d<f32>;
@group(0) @binding(6) var coverage: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(8) var<uniform> params: TsrParams;
@group(0) @binding(9) var guideOutput: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(10) var moireOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var decisionOutput: texture_storage_2d<rgba16float, write>;

// 4,608 bytes of workgroup memory; no extra texture or persistent history.
// Reuse encoded input texels while retaining the exact geometry gather.
var<workgroup> analyzeGuideTile:array<vec4<f32>,144>;
var<workgroup> analyzeOpaqueTile:array<vec4<f32>,144>;

fn tsrAnalyzeGuide(p: vec2<i32>, origin: vec2<i32>) -> vec3<f32> {
  let local = p-origin;
  return analyzeGuideTile[u32(local.y*12+local.x)].rgb;
}
fn tsrAnalyzeOpaque(p: vec2<i32>, origin: vec2<i32>) -> vec3<f32> {
  let local = p-origin;
  return analyzeOpaqueTile[u32(local.y*12+local.x)].rgb;
}

@compute @workgroup_size(8, 8)
fn tsr_analyze(@builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group:vec3<u32>, @builtin(local_invocation_index) lane:u32) {
  let groupUv=(vec2<f32>(group.xy*8u)+0.5)/params.inputSize+params.jitter;
  let tileOrigin=vec2<i32>(floor(groupUv*params.inputSize-1.5));
  for(var n=lane;n<144u;n+=64u) {
    let p=clamp(tileOrigin+vec2<i32>(i32(n%12u),i32(n/12u)),vec2<i32>(0),vec2<i32>(params.inputSize)-1);
    analyzeGuideTile[n]=vec4<f32>(tsrGuide(textureLoad(scene,p,0).rgb),1.0);
    analyzeOpaqueTile[n]=textureLoad(opaqueGuide,p,0);
  }
  workgroupBarrier();
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let pixel = vec2<i32>(id.xy);
  let result = tsrAnalyze(pixel, tileOrigin);
  textureStore(guideOutput, pixel, result.guide);
  textureStore(moireOutput, pixel, result.moire);
  textureStore(decisionOutput, pixel, result.decision);
}
