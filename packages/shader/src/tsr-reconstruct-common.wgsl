// Reconstruction math is shared; each lane owns only its neighborhood reads.
struct TsrReconstructionResult {
  @location(0) color: vec4<f32>,
  @location(1) temporal: vec4<f32>,
  @location(2) metadata: vec4<f32>,
};

const TSR_MAX_10_BIT_FLOAT: f32 = 64512.0;

// UE 5.8.1 5-tap optimized Catmull-Rom (Stubbe, TSRKernels.ush:355-395) with bilinear taps.
struct TsrCatmull5 {
  uv0: vec2<f32>,
  uv1: vec2<f32>,
  uv2: vec2<f32>,
  uv3: vec2<f32>,
  uv4: vec2<f32>,
  w0: f32,
  w1: f32,
  w3: f32,
  w4: f32,
};

fn tsrCatmull5Coords(uv: vec2<f32>, size: vec2<f32>) -> TsrCatmull5 {
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
  let high = vec2<f32>(1.0) - low;
  return TsrCatmull5(
    clamp(centerUv + vec2<f32>(-inverse.x, tap.y), low, high),
    clamp(centerUv + vec2<f32>(2.0 * inverse.x, tap.y), low, high),
    clamp(centerUv + tap, low, high),
    clamp(centerUv + vec2<f32>(tap.x, -inverse.y), low, high),
    clamp(centerUv + vec2<f32>(tap.x, 2.0 * inverse.y), low, high),
    w0.x, w3.x, w0.y, w3.y,
  );
}

// UE 5.8.1 TSRUpdateHistory.usf:988-1052: 5-tap Stubbe Catmull-Rom with center-tap anti-ringing
// fallback on negative overshoot, offset from center tap so uniform histories stay bit-exact.
fn tsrHistory(history: texture_2d<f32>, k: TsrCatmull5) -> vec3<f32> {
  let c0 = textureSampleLevel(history, linearSampler, k.uv0, 0.0).rgb;
  let c1 = textureSampleLevel(history, linearSampler, k.uv1, 0.0).rgb;
  let c2 = textureSampleLevel(history, linearSampler, k.uv2, 0.0).rgb;
  let c3 = textureSampleLevel(history, linearSampler, k.uv3, 0.0).rgb;
  let c4 = textureSampleLevel(history, linearSampler, k.uv4, 0.0).rgb;
  var result = c2 + (c0 - c2) * k.w0 + (c1 - c2) * k.w1 + (c3 - c2) * k.w3 + (c4 - c2) * k.w4;
  if (any(result < vec3<f32>(0.0))) {
    result = max(c2, vec3<f32>(0.0));
  }
  return result;
}

// UE 5.8.1 TSRUpdateHistory.usf:989, 1025, 1054: 5-tap Catmull-Rom filtered history validity.
fn tsrHistoryValidity(metadata: texture_2d<f32>, k: TsrCatmull5) -> f32 {
  let m0 = textureSampleLevel(metadata, linearSampler, k.uv0, 0.0).r;
  let m1 = textureSampleLevel(metadata, linearSampler, k.uv1, 0.0).r;
  let m2 = textureSampleLevel(metadata, linearSampler, k.uv2, 0.0).r;
  let m3 = textureSampleLevel(metadata, linearSampler, k.uv3, 0.0).r;
  let m4 = textureSampleLevel(metadata, linearSampler, k.uv4, 0.0).r;
  let v = m2 + (m0 - m2) * k.w0 + (m1 - m2) * k.w1 + (m3 - m2) * k.w3 + (m4 - m2) * k.w4;
  return saturate(v);
}

// UE 5.8.1 TSRKernels.ush:438-446 ComputeSampleWeigth: 1 - 1.9x^2 + 0.9x^4 over
// x^2 = saturate(u^2 |d|^2). Kernel taps use MinimalContribution 0.005
// (TSRUpdateHistory.usf:1187), the history weights use 0 (usf:1118-1164).
fn tsrSampleWeight(upscaleFactor: f32, delta: vec2<f32>, minContribution: f32) -> f32 {
  let x2 = saturate(upscaleFactor*upscaleFactor*dot(delta,delta));
  return saturate((0.9*x2 - 1.9)*x2 + 1.0 + minContribution);
}

// Vector in input pixels from the center K of an input pixel to the jittered output O (usf:1107).
fn tsrInputOffset(position: vec2<f32>, pixel: vec2<i32>) -> vec2<f32> {
  return clamp(position - (vec2<f32>(pixel) + 0.5), vec2<f32>(-0.5), vec2<f32>(0.5));
}

// TSRCommon.ush:497-500. A zero blend factor (fully accepted history) is an infinite
// multiplier in UE: any positive current weight saturates to the validity clamp. 1e20 is
// the largest finite stand-in that keeps weight*multiplier finite in f32.
fn tsrPrevWeightMultiplier(blendFactor: f32) -> f32 {
  return (1.0 - blendFactor)/max(blendFactor, 1e-20);
}

// Current-frame input of the history update: UE's five-tap PLUS_MOVE_FAR kernel
// (TSRUpdateHistory.usf:301-348, 1164-1260). The jittered output position O lies
// dKO from the center K of its input pixel; taps are K, the horizontal and vertical
// neighbors toward O, and two more that move to the closest corner when O is far
// from K. Each tap is weighted by its distance to O and by HdrWeight4 (usf:1216,
// TSRColorSpace.ush:191-219) of its exposed color.
struct TsrFilteredInput {
  color: vec3<f32>,
  low: vec3<f32>,
  high: vec3<f32>,
};
fn tsrFilteredInput(dKO: vec2<f32>, sourcePixel: vec2<i32>, sceneSize: vec2<u32>,
  inputOrigin: vec2<i32>, kernelFactor: f32, exposure: f32) -> TsrFilteredInput {
  let toward = select(vec2<f32>(1.0), vec2<f32>(-1.0), dKO < vec2<f32>(0.0));
  let square = select(vec2<f32>(-1.0), vec2<f32>(1.0), abs(dKO) >= vec2<f32>(0.25));
  var offsets = array<vec2<f32>,5>(
    vec2<f32>(0.0),
    vec2<f32>(toward.x, 0.0),
    vec2<f32>(0.0, toward.y),
    vec2<f32>(square.x*toward.x, saturate(square.x)*toward.y),
    vec2<f32>(saturate(square.y)*toward.x, square.y*toward.y));
  // Both moved samples land on the same corner when O is near the corner on both axes.
  let duplicated = square.x + square.y == 2.0;
  // Accumulate offsets from the center tap so a uniform neighborhood reproduces
  // its input bit-exactly instead of drifting by the weight-sum rounding.
  let center = tsrCachedScene(sourcePixel, inputOrigin).rgb;
  var delta = vec3<f32>(0.0);
  var total = 0.0;
  // History is clamped to the min/max of the same five taps (usf:1206-1232). The
  // duplicated tap repeats an included pixel, so it needs no exclusion.
  var low = center;
  var high = center;
  for (var i = 0; i < 5; i++) {
    let offset = offsets[i];
    let p = clamp(sourcePixel + vec2<i32>(offset), vec2<i32>(0), vec2<i32>(sceneSize) - 1);
    let sample = tsrCachedScene(p, inputOrigin).rgb;
    let weight = select(tsrSampleWeight(kernelFactor, offset - dKO, 0.005), 0.0, i == 4 && duplicated);
    low = min(low, sample);
    high = max(high, sample);
    let toneWeight = weight*tsrHdrWeight4(sample, exposure);
    delta += (sample - center)*toneWeight;
    total += toneWeight;
  }
  return TsrFilteredInput(center + delta/total, low, high);
}

struct TsrReconstructionInput {
  uv: vec2<f32>,
  currentUv: vec2<f32>,
  sourcePixel: vec2<i32>,
  coveragePixel: vec2<i32>,
  secondaryPixel: vec2<i32>,
  column: u32,
};
fn tsrReconstructionInput(pixel: vec2<u32>, size: vec2<u32>) -> TsrReconstructionInput {
  let uv=(vec2<f32>(pixel)+0.5)/vec2<f32>(size);
  let currentUv=uv+params.jitter;
  return TsrReconstructionInput(uv, currentUv, tsrPixel(currentUv,textureDimensions(scene)),
    tsrPixel(currentUv,textureDimensions(coverage)), tsrPixel(uv,textureDimensions(secondary)), pixel.x%8u);
}
fn tsrReconstruct(input: TsrReconstructionInput, size: vec2<u32>, inputOrigin: vec2<i32>,
  coverageOrigin: vec2<i32>, secondaryOrigin: vec2<i32>, useSecondaryCache: bool) -> TsrReconstructionResult {
  let uv=input.uv;
  let currentUv=input.currentUv;
  let sourcePixel=input.sourcePixel;
  let coveragePixel=input.coveragePixel;
  let inputPixel = tsrPixel(uv, vec2<u32>(params.inputSize));
  let exposure = tsrExposure(params.flicker.z);
  let ratio=vec2<f32>(textureDimensions(coverage))/params.inputSize;
  let coverageRadius=min(3,i32(ceil(max(ratio.x,ratio.y))));
  let nearest = tsrCachedScene(sourcePixel,inputOrigin);
  let analysis = textureLoad(decision, inputPixel, 0);
  // Single-authority dilated geometry from tsr-dilate (matches tsr-analyze and UE TSRUpdateHistory).
  let inputGeometry = TsrGeometry(
    textureLoad(dilated, inputPixel, 0),
    textureLoad(dilatedEdge, inputPixel, 0).b > 0.5,
  );
  var geometry = inputGeometry;
  if (params.hasCoverage != 0u) {
    let full = tsrCoverageGeometry(coveragePixel,coverageRadius,coverageOrigin,input.column);
    if (full.packed.z >= 0.0) { geometry = full; }
    if (inputGeometry.packed.z >= 0.0 && inputGeometry.packed.w >= 1.0) { geometry = inputGeometry; }
  }
  let packed = geometry.packed;
  let temporal = unpackSceneTemporalV1(packed);
  // A resurrected pixel reads the persistent snapshot where its surface was in the snapshot frame,
  // replacing the reprojection (UE OverwriteReprojectionFieldWithResurrection, TSRRejectShading.usf:
  // 334-377, and the resurrected history slice fetch, TSRUpdateHistory.usf:849, 982-983). Its speed
  // is that displacement (usf:837).
  let snapshot = tsrResurrectionScreen(uv, temporal.viewDepth, params.clipToResurrectionClip, params.projectionZ);
  let resurrected = params.analysisValid != 0u && params.resurrection.x != 0u && temporal.validDepth &&
    snapshot.z > 0.0 && tsrDecisionResurrected(analysis.a);
  // A parallax disocclusion reprojects with the velocity of the surface that covered it (UE hole
  // filling, TSRDecimateHistory.usf:435-472); it stays disoccluded for the spatial kernels below.
  let reprojection = tsrReproject(temporal, previousTemporal, uv, temporal.motionUv,
    params.depthModel, params.clipToPrevClip, params.projectionZ, geometry.depthEdge);
  let motionUv = select(reprojection.motionUv, uv - tsrScreenToUv(snapshot.xy), resurrected);
  let previousUv = uv - motionUv;
  let disoccluded = !resurrected && !reprojection.matches;
  var reactive = temporal.reactive;
  if (params.hasSecondary != 0u) {
    reactive = max(reactive, tsrSecondaryReactive(input.secondaryPixel, secondaryOrigin, useSecondaryCache));
  }
  let speed = length(motionUv*vec2<f32>(size));
  // The snapshot keeps no scene temporal, so a resurrection has no geometry to match; the reject
  // stage already judged it closer than the history.
  let valid = params.historyValid != 0u && tsrInside(previousUv) &&
    (resurrected || reprojection.usable) && reactive < 1.0;
  // History weights follow UE 5.8.1 TSRUpdateHistory.usf:1109-1168 and 1261-1300 with
  // r.TSR.History.SampleCount=16, ShadingRejection.SampleCount=2 and
  // Velocity.WeightClampingSampleCount=4/PixelSpeed=1 (TemporalSuperResolution.cpp:1933,
  // 3220-3224). Validity is stored in metadata.r in the 8-bit encoding of usf:1300.
  let h = 1.0/TSR_HISTORY_SAMPLE_COUNT;
  let inputToHistory = f32(size.x)/params.inputSize.x;
  let analysed = params.analysisValid != 0u;
  let lfr = select(1.0, analysis.r, analysed);
  let disableClamp = select(0.0, analysis.g, analysed);
  let decreaseValidity = select(0.0, analysis.b, analysed);
  let historyKernel = tsrCatmull5Coords(previousUv, vec2<f32>(size));
  var prevValidity = 0.0;
  if (valid && resurrected) { prevValidity = tsrHistoryValidity(resurrectedMetadata, historyKernel); }
  else if (valid) { prevValidity = tsrHistoryValidity(previousMetadata, historyKernel); }
  // Spatial anti-aliasing (usf:1093-1107): O moves toward the edge side by the input pixel offset,
  // fully where history is off-screen or disoccluded and otherwise as history is rejected.
  let aa = textureLoad(spatial, inputPixel, 0);
  let aaOffset = tsrAaDecode(aa.xy);
  let aaLerp = select(1.0, saturate(1.0 - lfr*4.0), valid && !disoccluded);
  let sceneExtent = vec2<i32>(textureDimensions(scene));
  let outputPosition = currentUv*vec2<f32>(sceneExtent) + aaOffset*aaLerp;
  let kernelPixel = clamp(vec2<i32>(floor(outputPosition)), vec2<i32>(0), sceneExtent - 1);
  let dKO = tsrInputOffset(outputPosition, kernelPixel);
  let blendFactor = select(1.0, 1.0 - lfr, valid);
  // MaxValidity = 1 - WeightClampingRejection * DecreaseValidityMultiplier (usf:1124-1134).
  // Engine reactivity (translucency, secondary and coverage producers) decreases validity too.
  let clampedPrev = min(prevValidity,
    1.0 - (1.0 - TSR_REJECTED_SAMPLE_COUNT*h)*max(decreaseValidity, reactive));
  let coarseCurrent = tsrSampleWeight(1.0, dKO, 0.0)*h;
  let idealCurrent = tsrSampleWeight(inputToHistory, dKO, 0.0)*h;
  let refiningHysteresis = select(1.0, idealCurrent/(clampedPrev + idealCurrent), clampedPrev + idealCurrent > 0.0);
  let coarseRejected = min(coarseCurrent*tsrPrevWeightMultiplier(blendFactor), 1.0);
  let coarseRefining = min(coarseCurrent*tsrPrevWeightMultiplier(refiningHysteresis), 1.0);
  let refining = min(select(1.0, 0.0, coarseRejected < coarseRefining), saturate(clampedPrev*TSR_HISTORY_SAMPLE_COUNT));
  // The kernel narrows to the history/input ratio only where history is accepted and
  // refining; rejected or off-screen pixels keep a one-input-pixel kernel (usf:1160-1164).
  let kernelLerp = select(0.0, saturate(lfr*16.0 - 13.0)*refining, valid && !disoccluded);
  // Input noise softens the kernel where history is not accepted (usf:1158-1161).
  let filtered = tsrFilteredInput(dKO, kernelPixel, textureDimensions(scene), inputOrigin,
    mix(1.0 - 0.5*aa.z, inputToHistory, kernelLerp), exposure);
  let current = filtered.color;
  let currentWeight = tsrSampleWeight(mix(1.0, inputToHistory, kernelLerp), dKO, 0.0)*h;
  var prevWeight = min(select(coarseCurrent, currentWeight, currentWeight > 0.0)*tsrPrevWeightMultiplier(blendFactor), clampedPrev);
  prevWeight = min(prevWeight, 1.0 - currentWeight);
  var result = current;
  // CONFIG_SELECTIVE_REPROJECTION: skip history color fetches when history contributes zero weight.
  if (valid && prevWeight > 0.0) {
    var reprojected: vec3<f32>;
    if (resurrected) { reprojected = tsrHistory(resurrectedColor, historyKernel); }
    else { reprojected = tsrHistory(previousColor, historyKernel); }
    let clampedHistory = clamp(reprojected, filtered.low, filtered.high);
    let blendClamped = (1.0 - disableClamp)*tsrHdrWeight4(clampedHistory, exposure);
    let blendRaw = disableClamp*tsrHdrWeight4(reprojected, exposure);
    let blendSum = blendClamped + blendRaw;
    let history = select(clampedHistory, clampedHistory + (reprojected - clampedHistory)*(blendRaw/blendSum), blendSum > 0.0);
    let amplitude = clamp(1.0 - TSR_VELOCITY_SAMPLE_COUNT*h, 0.0, 1.0);
    let historyLuma = history.r + 2.0*history.g + history.b;
    let currentLuma = current.r + 2.0*current.g + current.b;
    let stability = abs(currentLuma - historyLuma)/max(max(currentLuma, historyLuma), 1e-4);
    prevWeight = min(prevWeight, max(1.0 - amplitude*saturate(speed), stability));
    let blendHistory = prevWeight*tsrHdrWeightY(tsrLuma4(history), exposure);
    let blendCurrent = currentWeight*tsrHdrWeight4(current, exposure);
    let total = blendHistory + blendCurrent;
    if (total > 0.0) { result = history + (current - history)*(blendCurrent/total); }
  }
  let validity = ceil(255.0*(currentWeight + prevWeight))/255.0;
  return TsrReconstructionResult(
    vec4<f32>(clamp(result,vec3<f32>(0.0),vec3<f32>(TSR_MAX_10_BIT_FLOAT)),nearest.a), packed,
    vec4<f32>(validity,lfr,reactive,1.0));
}
