@group(0) @binding(0) var sceneTemporal: texture_2d<f32>;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> params: TsrParams;
@group(0) @binding(3) var dilatedOutput: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var edgeOutput: texture_storage_2d<rgba8unorm, write>;

// 10x10 workgroup tile cache (1,600 bytes): reduces sceneTemporalFromVelocity from 14/px to 1.56/px.
var<workgroup> dilateTile: array<vec4<f32>, 100>;

fn tsrDilateSample(p: vec2<i32>, origin: vec2<i32>) -> vec4<f32> {
  let local = p - origin;
  return dilateTile[u32(local.y * 10 + local.x)];
}

@compute @workgroup_size(8, 8)
fn tsr_dilate(@builtin(global_invocation_id) id: vec3<u32>,
  @builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let extent = vec2<i32>(textureDimensions(sceneTemporal));
  let origin = vec2<i32>(group.xy * 8u) - vec2<i32>(1);
  for (var n = lane; n < 100u; n += 64u) {
    let p = clamp(origin + vec2<i32>(i32(n % 10u), i32(n / 10u)), vec2<i32>(0), extent - 1);
    dilateTile[n] = loadSceneTemporal(p);
  }
  workgroupBarrier();
  if (any(id.xy >= vec2<u32>(params.inputSize))) { return; }
  let p = vec2<i32>(id.xy);
  let result = tsrDilate(p, origin);
  textureStore(dilatedOutput, p, result.dilated);
  textureStore(edgeOutput, p, result.edge);
}
