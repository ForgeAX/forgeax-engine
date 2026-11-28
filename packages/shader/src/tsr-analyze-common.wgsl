// Both lanes evaluate the same unjittered analysis and flicker history.
// Input-domain analysis, UE TSR DecimateHistory/ShadingAnalysis inputs: the unjittered input in
// GCS, the reprojected history guide in GCS (alpha: history accepted) and the reprojected moire
// history. Rejection itself is measured by the following stages.
struct TsrAnalysisResult {
  @location(0) input: vec4<f32>,
  @location(1) history: vec4<f32>,
  @location(2) moire: vec4<f32>,
  @location(3) decimate: vec4<f32>,
};
// UE Random.ush Rand3DPCG16 (RandomPCG.ush): three-lane integer hash, 16 random bits per lane.
fn tsrRand3dPcg16(p: vec3<i32>) -> vec3<u32> {
  var v = vec3<u32>(p) * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v >> vec3<u32>(16u);
}
fn tsrLoadDilated(p: vec2<i32>) -> vec4<f32> {
  return textureLoad(dilated, clamp(p, vec2<i32>(0), vec2<i32>(params.inputSize) - 1), 0);
}
// ComputeReprojectionEdge over the dilated pixel-velocity neighbourhood (TSRDepthVelocityAnalysis.ush:
// 560-607, CONFIG_VELOCITY_SAMPLES 9): four opposite pairs, each penalising a velocity step along
// its own offset direction.
fn tsrNeighbourhoodEdge(pixel: vec2<i32>, dilatedOrigin: vec2<i32>) -> f32 {
  let center = tsrAnalyzeDilatedMotion(pixel, dilatedOrigin) * params.inputSize;
  var edge = 1.0;
  for (var i = 0; i < 4; i++) {
    let offset = select(select(vec2<i32>(-1, 0), vec2<i32>(1, -1), i == 2),
      select(vec2<i32>(-1, -1), vec2<i32>(0, -1), i == 1), i < 2);
    let a = center - tsrAnalyzeDilatedMotion(pixel + offset, dilatedOrigin) * params.inputSize;
    let b = center - tsrAnalyzeDilatedMotion(pixel - offset, dilatedOrigin) * params.inputSize;
    let overlapA = 1.0 - dot(saturate(abs(a * vec2<f32>(offset))), vec2<f32>(1.0));
    let overlapB = 1.0 - dot(saturate(abs(b * vec2<f32>(-offset))), vec2<f32>(1.0));
    edge = min(edge, min(overlapA, overlapB));
  }
  return saturate(edge * 1.1);
}
// Reprojected history guide fetch: UE five-tap optimised Catmull-Rom (TSRKernels.ush:355-395, Stubbe)
// over bilinear taps, clamped to the previous viewport (TSRDecimateHistory.usf:171-199, 384-401).
fn tsrCatmullGuide(uv: vec2<f32>) -> vec4<f32> {
  let size = vec2<f32>(textureDimensions(previousGuide));
  let inverse = 1.0 / size;
  let coordinate = uv * size;
  let origin = floor(coordinate - 0.5) + 1.0;
  let f = coordinate - origin;
  let f2 = f * f;
  let t0 = (0.25 * f2 - 0.0625) * (1.125 - 0.5 * f2.yx);
  let w0 = t0 - 2.0 * f * t0;
  let w3 = t0 + 2.0 * f * t0;
  let centerUv = (origin - 0.5) * inverse;
  let tap = ((1.25 - f2) * f + 0.5) * inverse;
  let low = 0.5 * inverse;
  let high = (params.previousInputSize - 0.5) * inverse;
  let center = 1.0 - w0.x - w3.x - w0.y - w3.y;
  return
    textureSampleLevel(previousGuide, linearSampler, clamp(centerUv + vec2<f32>(-inverse.x, tap.y), low, high), 0.0) * w0.x +
    textureSampleLevel(previousGuide, linearSampler, clamp(centerUv + vec2<f32>(2.0 * inverse.x, tap.y), low, high), 0.0) * w3.x +
    textureSampleLevel(previousGuide, linearSampler, clamp(centerUv + tap, low, high), 0.0) * center +
    textureSampleLevel(previousGuide, linearSampler, clamp(centerUv + vec2<f32>(tap.x, -inverse.y), low, high), 0.0) * w0.y +
    textureSampleLevel(previousGuide, linearSampler, clamp(centerUv + vec2<f32>(tap.x, 2.0 * inverse.y), low, high), 0.0) * w3.y;
}
fn tsrAnalyze(pixel: vec2<i32>, tileOrigin: vec2<i32>, dilatedOrigin: vec2<i32>) -> TsrAnalysisResult {
  let uv = (vec2<f32>(pixel) + 0.5) / params.inputSize;
  let currentUv = uv + params.jitter;
  // The dilate stage already borrowed the closest tuple of the plus neighbourhood.
  let dilatedTuple = tsrLoadDilated(pixel);
  let dilatedEdge = textureLoad(dilatedEdgeTex, pixel, 0);
  let inputGeometry = TsrGeometry(dilatedTuple, dilatedEdge.b > 0.5);
  var geometry = inputGeometry;
  if (params.hasCoverage != 0u) {
    let ratio=vec2<f32>(textureDimensions(coverage))/params.inputSize;
    let scale=max(ratio.x,ratio.y);
    let radius=min(3,i32(ceil(scale)))+i32(ceil(max(scale-1.0,0.0)*0.5));
    let full=tsrClosestTemporal(coverage,currentUv,radius);
    if (full.packed.z >= 0.0) { geometry = full; }
    // A clear output sample cannot erase a real input-raster witness.
    // Positive-depth invalidity on either producer remains a hard veto.
    if (inputGeometry.packed.z >= 0.0 && inputGeometry.packed.w >= 1.0) { geometry = inputGeometry; }
  }
  let temporal = unpackSceneTemporalV1(geometry.packed);
  // The guide and moire histories follow the hole-filled reprojection of a disoccluded pixel
  // (UE DecimateHistory usf:435-472); only the disocclusion flag keeps the pixel's own match.
  let reprojection = tsrReproject(temporal, previousTemporal, uv, temporal.motionUv,
    params.depthModel, params.clipToPrevClip, params.projectionZ, geometry.depthEdge);
  let previousUv = uv - reprojection.motionUv;
  let previousGuideUv = previousUv * params.previousInputSize /
    vec2<f32>(textureDimensions(previousGuide));
  let valid = params.historyValid != 0u && params.analysisValid != 0u && reprojection.matches;
  var meanGcs = vec3<f32>(0.0);
  // A phase-correct three-texel box integrates encoded current samples onto
  // the unjittered input lattice. Its fractional boundary covers four texels;
  // Guide history and rejection are never stored on the jittered raster grid.
  let position = currentUv * params.inputSize;
  let base = vec2<i32>(floor(position-1.5));
  for (var y = 0; y < 4; y++) {
    for (var x = 0; x < 4; x++) {
      let rawPixel = base + vec2<i32>(x,y);
      let axis = clamp(vec2<f32>(2.0)-abs(vec2<f32>(rawPixel)+0.5-position),vec2<f32>(0.0),vec2<f32>(1.0));
      let weight = axis.x*axis.y;
      let p = clamp(rawPixel,vec2<i32>(0),vec2<i32>(params.inputSize)-1);
      meanGcs += tsrAnalyzeGcs(p, tileOrigin) * (weight/9.0);
    }
  }
  let reprojectedGuide = tsrCatmullGuide(previousGuideUv);
  let oldGuide = reprojectedGuide.rgb;
  // ReprojectPrevHistoryMoire (TSRDecimateHistory.usf:102-108): one point read of the previous moire
  // history at the motion-reprojected texel, jittered by a per-pixel PCG16 offset that varies with
  // the 8-frame state index so the nearest-neighbour fetch does not alias.
  let moireSize = vec2<f32>(textureDimensions(previousMoire));
  let random = vec2<f32>(tsrRand3dPcg16(vec3<i32>(pixel, i32(params.frameIndex % 8u))).xy) * (1.0 / 65536.0);
  let moireUv = previousUv * params.previousInputSize / moireSize + (random - 0.5) / moireSize;
  let reprojectedMoire = select(vec4<f32>(0.0),
    textureLoad(previousMoire, tsrPixel(moireUv, textureDimensions(previousMoire)), 0),
    params.analysisValid != 0u);
  // DecimateHistory velocity edge (usf:316-333): the refined neighbourhood edge unless the dilate
  // stage already found a strong one; a pixel that borrowed no neighbour is fully certain. The guide
  // alpha carries last frame's InputUncertainty as this frame's HistoryUncertainty. UE writes it for
  // disoccluded pixels too (usf:498-501): the reject stage zeroes their own clamp relief, and the
  // Min3x3 of their neighbours must not see a fabricated certain edge.
  let preliminary = dilatedEdge.r;
  var velocityEdge = tsrNeighbourhoodEdge(pixel, dilatedOrigin);
  velocityEdge = select(velocityEdge, preliminary, preliminary > 0.9);
  velocityEdge = select(1.0, velocityEdge, dilatedEdge.g > 0.5);
  let historyUncertainty = select(0.0, reprojectedGuide.a, params.historyValid != 0u && params.analysisValid != 0u);
  return TsrAnalysisResult(vec4<f32>(meanGcs, 1.0),
    vec4<f32>(oldGuide, select(0.0, 1.0, valid)),
    reprojectedMoire,
    vec4<f32>(velocityEdge, historyUncertainty, 0.0, 0.0));
}
