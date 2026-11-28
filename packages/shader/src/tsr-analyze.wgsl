@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var dilated: texture_2d<f32>;
@group(0) @binding(2) var previousGuide: texture_2d<f32>;
@group(0) @binding(3) var previousMoire: texture_2d<f32>;
@group(0) @binding(4) var previousTemporal: texture_2d<f32>;
@group(0) @binding(5) var coverage: texture_2d<f32>;
@group(0) @binding(6) var dilatedEdgeTex: texture_2d<f32>;
@group(0) @binding(7) var linearSampler: sampler;
@group(0) @binding(8) var<uniform> params: TsrParams;
@group(0) @binding(9) var inputOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var historyOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(11) var moireOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(12) var decimateOutput: texture_storage_2d<rgba8unorm, write>;

// 3,104 bytes of workgroup memory: GCS-encoded scene tile (2,304 B) + dilated motion tile (800 B).
// Storing GCS directly removes 16x exp2/log2 round-trips per pixel.
var<workgroup> analyzeGcsTile: array<vec4<f32>, 144>;
var<workgroup> analyzeDilatedMotionTile: array<vec2<f32>, 100>;

fn tsrAnalyzeGcs(p: vec2<i32>, origin: vec2<i32>) -> vec3<f32> {
  let local = p - origin;
  return analyzeGcsTile[u32(local.y * 12 + local.x)].rgb;
}

fn tsrAnalyzeDilatedMotion(p: vec2<i32>, origin: vec2<i32>) -> vec2<f32> {
  let local = p - origin;
  return analyzeDilatedMotionTile[u32(local.y * 10 + local.x)];
}

@compute @workgroup_size(8, 8)
fn tsr_analyze(@builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let inputExtent = vec2<i32>(params.inputSize);
  let exposure = tsrExposure(params.flicker.z);
  let groupUv = (vec2<f32>(group.xy * 8u) + 0.5) / params.inputSize + params.jitter;
  let tileOrigin = vec2<i32>(floor(groupUv * params.inputSize - 1.5));
  for (var n = lane; n < 144u; n += 64u) {
    let p = clamp(tileOrigin + vec2<i32>(i32(n % 12u), i32(n / 12u)), vec2<i32>(0), inputExtent - 1);
    analyzeGcsTile[n] = vec4<f32>(tsrLinearToGcs(textureLoad(scene, p, 0).rgb * exposure), 1.0);
  }
  let dilatedOrigin = vec2<i32>(group.xy * 8u) - vec2<i32>(1);
  for (var n = lane; n < 100u; n += 64u) {
    let p = clamp(dilatedOrigin + vec2<i32>(i32(n % 10u), i32(n / 10u)), vec2<i32>(0), inputExtent - 1);
    analyzeDilatedMotionTile[n] = textureLoad(dilated, p, 0).xy;
  }
  workgroupBarrier();
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let pixel = vec2<i32>(id.xy);
  let result = tsrAnalyze(pixel, tileOrigin, dilatedOrigin);
  textureStore(inputOutput, pixel, result.input);
  textureStore(historyOutput, pixel, result.history);
  textureStore(moireOutput, pixel, result.moire);
  textureStore(decimateOutput, pixel, result.decimate);
}
