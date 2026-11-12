// Reconstruction math is shared; each lane owns only its neighborhood reads.
struct TsrReconstructionResult {
  @location(0) color: vec4<f32>,
  @location(1) temporal: vec4<f32>,
  @location(2) metadata: vec4<f32>,
};
fn tsrHistory(uv: vec2<f32>) -> vec3<f32> {
  let size = vec2<f32>(textureDimensions(previousColor));
  let position = uv * size;
  let base = floor(position - 0.5) + 0.5;
  let f = position - base;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = -0.5*f + f2 - 0.5*f3;
  let w1 = vec2<f32>(1.0) - 2.5*f2 + 1.5*f3;
  let w2 = 0.5*f + 2.0*f2 - 1.5*f3;
  let w3 = -0.5*f2 + 0.5*f3;
  let w12 = w1 + w2;
  let positions = array<vec2<f32>,3>((base-1.0)/size, (base+w2/w12)/size, (base+2.0)/size);
  let weights = array<vec2<f32>,3>(w0,w12,w3);
  var result = vec3<f32>(0.0);
  for (var y = 0; y < 3; y++) {
    for (var x = 0; x < 3; x++) {
      result += textureSampleLevel(previousColor, linearSampler,
        vec2<f32>(positions[x].x,positions[y].y), 0.0).rgb * weights[x].x * weights[y].y;
    }
  }
  return max(result, vec3<f32>(0.0));
}

struct TsrReconstructionInput {
  uv: vec2<f32>,
  currentUv: vec2<f32>,
  sourcePixel: vec2<i32>,
  coveragePixel: vec2<i32>,
  column: u32,
};
fn tsrReconstructionInput(pixel: vec2<u32>, size: vec2<u32>) -> TsrReconstructionInput {
  let uv=(vec2<f32>(pixel)+0.5)/vec2<f32>(size);
  let currentUv=uv+params.jitter;
  return TsrReconstructionInput(uv, currentUv, tsrPixel(currentUv,textureDimensions(scene)),
    tsrPixel(currentUv,textureDimensions(coverage)), pixel.x%8u);
}
fn tsrReconstruct(input: TsrReconstructionInput, size: vec2<u32>, inputOrigin: vec2<i32>,
  coverageOrigin: vec2<i32>) -> TsrReconstructionResult {
  let uv=input.uv;
  let currentUv=input.currentUv;
  let sourcePixel=input.sourcePixel;
  let coveragePixel=input.coveragePixel;
  let ratio=vec2<f32>(textureDimensions(coverage))/params.inputSize;
  let coverageRadius=min(3,i32(ceil(max(ratio.x,ratio.y))));
  let nearest = tsrCachedScene(sourcePixel,inputOrigin);
  let analysis = textureLoad(decision, tsrPixel(uv,textureDimensions(scene)), 0);
  // Rejected regions have no temporal supersamples yet. Reconstruct their
  // spatial footprint instead of enlarging a nearest input texel into blocks.
  // Accepted regions retain the jittered sample for temporal detail recovery.
  let spatial = textureSampleLevel(scene, linearSampler, currentUv, 0.0);
  let current = mix(spatial, nearest, analysis.r);
  let inputGeometry = tsrInputGeometry(sourcePixel,inputOrigin);
  var geometry = inputGeometry;
  if (params.hasCoverage != 0u) {
    let full = tsrCoverageGeometry(coveragePixel,coverageRadius,coverageOrigin,input.column);
    if (full.packed.z >= 0.0) { geometry = full; }
    if (inputGeometry.packed.z >= 0.0 && inputGeometry.packed.w >= 1.0) { geometry = inputGeometry; }
  }
  let packed = geometry.packed;
  let temporal = unpackSceneTemporalV1(packed);
  let previousUv = uv - temporal.motionUv;
  let oldTemporal = unpackSceneTemporalV1(textureLoad(previousTemporal,
    tsrPixel(previousUv,textureDimensions(previousTemporal)),0));
  var reactive = temporal.reactive;
  if (params.hasSecondary != 0u) {
    let center = tsrPixel(uv,textureDimensions(secondary));
    for (var y = -3; y <= 3; y++) {
      for (var x = -3; x <= 3; x++) {
        let p = clamp(center+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(textureDimensions(secondary))-1);
        reactive = max(reactive,textureLoad(secondary,p,0).r);
      }
    }
  }
  let speed = length(temporal.motionUv*vec2<f32>(size));
  let valid = params.historyValid != 0u && tsrInside(previousUv) &&
    tsrGeometryMatches(temporal,oldTemporal,geometry.depthEdge,speed) && reactive < 1.0;
  var count = 0.0;
  var result = current.rgb;
  if (valid) {
    var low = nearest.rgb;
    var high = nearest.rgb;
    let priorCount = textureLoad(previousMetadata, tsrPixel(previousUv,size),0).r * TSR_SUPPORT_LIMIT;
    let radius = select(1,2,priorCount>=8.0 && length(temporal.motionUv*vec2<f32>(size))<0.25);
    for (var y = -radius; y <= radius; y++) {
      for (var x = -radius; x <= radius; x++) {
        let p = clamp(sourcePixel+vec2<i32>(x,y),vec2<i32>(0),vec2<i32>(textureDimensions(scene))-1);
        let sample = tsrCachedScene(p,inputOrigin).rgb;
        low = min(low,sample);
        high = max(high,sample);
      }
    }
    let relaxation = exp2(analysis.g*16.0)-1.0;
    let margin = max(high,vec3<f32>(1.0))*relaxation;
    let history = clamp(tsrHistory(previousUv),max(low-margin,vec3<f32>(0.0)),high+margin);
    let oldCount = priorCount;
    let motionLimit = mix(TSR_SUPPORT_LIMIT-1.0,3.0,clamp(speed,0.0,1.0));
    // A changed input extent invalidates Guide/Moire only. Keep a bounded
    // color contribution when the output geometry still matches.
    let accepted = select(min(oldCount, 1.0), oldCount * analysis.r, params.analysisValid != 0u);
    count = min(accepted * (1.0-reactive), motionLimit);
    let currentWeight = 1.0 / (count + 1.0);
    // Shading analysis and local bounds reject outliers. Linear radiance
    // accumulation preserves subpixel line energy instead of counting
    // dark and bright coverage samples with different luminance weights.
    result = mix(history,current.rgb,currentWeight);
  }
  return TsrReconstructionResult(
    vec4<f32>(clamp(result,vec3<f32>(0.0),vec3<f32>(65504.0)),nearest.a), packed,
    vec4<f32>((count+1.0)/TSR_SUPPORT_LIMIT,analysis.r,reactive,1.0));
}
