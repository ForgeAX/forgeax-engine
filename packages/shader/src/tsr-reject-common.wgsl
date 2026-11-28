// UE 5.8.1 shading rejection (TSRRejectShading.usf:670-912, TSRShadingAnalysis.ush:496-644),
// split into input-resolution stages that exchange only textures: clamp, measure and reject.
// Every stage loads its neighborhood with texel reads clamped to the input extent.
const TSR_FILTERING_WEIGHT: f32 = 0.25; // rcp(1 + 4*0.5 + 4*0.25), ShadingAnalysis.ush:25
const TSR_QUANTIZATION_ERROR: f32 = 0.00048828125; // MeasureBackbufferLDRQuantizationError, 0.5/1024
const TSR_MOIRE_LUMA_TO_CHANNEL: f32 = 3.0;

fn tsrLoadIn(t: texture_2d<f32>, p: vec2<i32>) -> vec4<f32> {
  return textureLoad(t, clamp(p, vec2<i32>(0), vec2<i32>(params.inputSize) - 1), 0);
}
fn tsrMin3(v: vec3<f32>) -> f32 { return min(v.x, min(v.y, v.z)); }
// GCSToSMCS (TSRColorSpace.ush): the shading LDR space is the square of the guide space.
fn tsrSmcs(g: vec3<f32>) -> vec3<f32> { return g * g; }
fn tsrBlurWeight(x: i32, y: i32) -> f32 {
  return select(0.5, 0.25, x != 0) * select(0.5, 0.25, y != 0);
}

// ---------------------------------------------------------------- clamp stage
// Mutual annihilation of input and history (usf:746-756): ClampedInput = Clamp3x3(EI,
// fastClamp(EH, MinMax3x3(EI))) and ClampedHistory = AnnihilateToGuide3x3(EH, EI)
// = Clamp3x3(EH, Clamp3x3(EI, EH)); Clamp3x3(A, B) = fastClamp(A, MinMax3x3(B)).
struct TsrClampResult {
  @location(0) input: vec4<f32>,
  @location(1) history: vec4<f32>,
};
fn tsrEncoded(tex: texture_2d<f32>, p: vec2<i32>) -> vec3<f32> {
  return tsrSmcs(tsrLoadIn(tex, p).rgb);
}
// The 5x5 neighborhood is read straight from the textures: a private array indexed by the unrolled
// loop counters spills to scratch memory on some compilers, which costs more than the cached reloads.
fn tsrClamp(inputTex: texture_2d<f32>, historyTex: texture_2d<f32>, pixel: vec2<i32>) -> TsrClampResult {
  var inputBoundLow = vec3<f32>(1e30);
  var inputBoundHigh = vec3<f32>(-1e30);
  var historyBoundLow = vec3<f32>(1e30);
  var historyBoundHigh = vec3<f32>(-1e30);
  for (var qy = -1; qy <= 1; qy++) {
    for (var qx = -1; qx <= 1; qx++) {
      let q = pixel + vec2<i32>(qx, qy);
      var inputLow = vec3<f32>(1e30);
      var inputHigh = vec3<f32>(-1e30);
      var historyLow = vec3<f32>(1e30);
      var historyHigh = vec3<f32>(-1e30);
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let a = tsrEncoded(inputTex, q + vec2<i32>(x, y));
          let b = tsrEncoded(historyTex, q + vec2<i32>(x, y));
          inputLow = min(inputLow, a);
          inputHigh = max(inputHigh, a);
          historyLow = min(historyLow, b);
          historyHigh = max(historyHigh, b);
        }
      }
      let boundary = tsrFastClamp(tsrEncoded(historyTex, q), inputLow, inputHigh);
      inputBoundLow = min(inputBoundLow, boundary);
      inputBoundHigh = max(inputBoundHigh, boundary);
      let guide = tsrFastClamp(tsrEncoded(inputTex, q), historyLow, historyHigh);
      historyBoundLow = min(historyBoundLow, guide);
      historyBoundHigh = max(historyBoundHigh, guide);
    }
  }
  return TsrClampResult(
    vec4<f32>(tsrFastClamp(tsrEncoded(inputTex, pixel), inputBoundLow, inputBoundHigh), 1.0),
    vec4<f32>(tsrFastClamp(tsrEncoded(historyTex, pixel), historyBoundLow, historyBoundHigh), 1.0));
}

// -------------------------------------------------------------- measure stage
struct TsrMeasureResult {
  @location(0) raw: vec4<f32>,
  @location(1) delta: vec4<f32>,
};
// MeasureRejection up to RawClampedEnergy/RawRejection/Delta (ShadingAnalysis.ush:509-625),
// with the moire error enabled and without thin-geometry control or scene alpha. The 5x5 fields
// (clamped input, |input - clamped input|, clamped history) are read from the textures on demand:
// TotalVariation3x3 = 1.125 C - 0.125 sum(3x3 C) and the (0.25, 0.5, 0.25) blur share one 3x3 loop.
fn tsrMeasure(inputTex: texture_2d<f32>, clampedInputTex: texture_2d<f32>,
  clampedHistoryTex: texture_2d<f32>, moireError: f32, pixel: vec2<i32>) -> TsrMeasureResult {
  let error = vec3<f32>(TSR_QUANTIZATION_ERROR);
  var filteredHistory = vec3<f32>(0.0);
  var filteredInput = vec3<f32>(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let p = pixel + vec2<i32>(x, y);
      filteredHistory += tsrLoadIn(clampedHistoryTex, p).rgb * tsrBlurWeight(x, y);
      filteredInput += tsrLoadIn(clampedInputTex, p).rgb * tsrBlurWeight(x, y);
    }
  }
  var variation = vec3<f32>(0.0);
  var boxLow = vec3<f32>(1e30);
  var boxHigh = vec3<f32>(-1e30);
  var inputLow = vec3<f32>(1e30);
  var inputHigh = vec3<f32>(-1e30);
  for (var qy = -1; qy <= 1; qy++) {
    for (var qx = -1; qx <= 1; qx++) {
      let q = pixel + vec2<i32>(qx, qy);
      var blur = vec3<f32>(0.0);
      var sumC = vec3<f32>(0.0);
      var sumD = vec3<f32>(0.0);
      var centerC = vec3<f32>(0.0);
      var centerD = vec3<f32>(0.0);
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let p = q + vec2<i32>(x, y);
          let c = tsrLoadIn(clampedInputTex, p).rgb;
          let d = abs(tsrSmcs(tsrLoadIn(inputTex, p).rgb) - c);
          blur += c * tsrBlurWeight(x, y);
          sumC += c;
          sumD += d;
          if (x == 0 && y == 0) { centerC = c; centerD = d; }
        }
      }
      let variationD = 1.125 * centerD - 0.125 * sumD;
      let variationC = 1.125 * centerC - 0.125 * sumC;
      variation += min(abs(variationD), abs(variationC)) * tsrBlurWeight(qx, qy);
      boxLow = min(boxLow, blur);
      boxHigh = max(boxHigh, blur);
      inputLow = min(inputLow, centerC);
      inputHigh = max(inputHigh, centerC);
    }
  }
  let inputBoxSize = inputHigh - inputLow;
  var clampError = max(error, variation);
  clampError = max(clampError, inputBoxSize * (TSR_FILTERING_WEIGHT * 0.25));
  clampError = clampError + error;
  boxLow = boxLow - clampError;
  boxHigh = boxHigh + clampError;
  // The flicker error widens the box so a stable oscillation is not clamped (usf:570-594); the
  // resurrected measure passes zero (usf:775).
  let moireSize = vec3<f32>(TSR_MOIRE_LUMA_TO_CHANNEL * moireError);
  let clampedFiltered = tsrFastClamp(filteredHistory,
    min(boxLow, boxHigh - moireSize), max(boxHigh, boxLow + moireSize));
  let clampedEnergy = abs(clampedFiltered - filteredHistory);
  let energySum = clampedEnergy.x + clampedEnergy.y + clampedEnergy.z;
  let energyAmount = select(vec3<f32>(0.0), clampedEnergy / energySum, energySum > 0.0);
  var boxSize = inputBoxSize * TSR_FILTERING_WEIGHT + error * (2.0 * TSR_FILTERING_WEIGHT);
  boxSize = max(boxSize, energyAmount * (TSR_FILTERING_WEIGHT * 3.0 * moireError));
  let delta = max(abs(filteredInput - filteredHistory), boxSize);
  let factor = saturate(vec3<f32>(1.0) - clampedEnergy / delta);
  return TsrMeasureResult(vec4<f32>(clampedEnergy, tsrMin3(factor)), vec4<f32>(delta, 1.0));
}

// --------------------------------------------------------------- reject stage
// Per-component median of nine values: median(max of column lows, median of column mids,
// min of column highs), the exact 3x3 median of TSRConvolutionNetwork.ush Median3x3.
fn tsrMedian3(a: vec4<f32>, b: vec4<f32>, c: vec4<f32>) -> vec4<f32> {
  return max(min(a, b), min(max(a, b), c));
}
fn tsrMedian9(tex: texture_2d<f32>, center: vec2<i32>) -> vec4<f32> {
  var lows = vec4<f32>(-1e30);
  var highs = vec4<f32>(1e30);
  var mids: array<vec4<f32>, 3>;
  for (var x = -1; x <= 1; x++) {
    let a = tsrLoadIn(tex, center + vec2<i32>(x, -1));
    let b = tsrLoadIn(tex, center + vec2<i32>(x, 0));
    let c = tsrLoadIn(tex, center + vec2<i32>(x, 1));
    lows = max(lows, min(a, min(b, c)));
    highs = min(highs, max(a, max(b, c)));
    mids[x + 1] = tsrMedian3(a, b, c);
  }
  return tsrMedian3(lows, tsrMedian3(mids[0], mids[1], mids[2]), highs);
}
struct TsrRejectResult {
  @location(0) guide: vec4<f32>,
  @location(1) decision: vec4<f32>,
};
// RejectionBlendFinal and RejectionClampBlend of one measured pair (ShadingAnalysis.ush:630-643):
// the worst case of the 3x3 median raw clamp energy and factor.
struct TsrBlend {
  rejection: f32,
  clampBlend: f32,
};
fn tsrRejectionBlend(rawTex: texture_2d<f32>, deltaTex: texture_2d<f32>, pixel: vec2<i32>) -> TsrBlend {
  var energy = vec3<f32>(0.0);
  var clampBlend = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let median = tsrMedian9(rawTex, pixel + vec2<i32>(x, y));
      energy = max(energy, median.rgb);
      clampBlend = min(clampBlend, median.a);
    }
  }
  let delta = tsrLoadIn(deltaTex, pixel).rgb;
  return TsrBlend(tsrMin3(saturate(vec3<f32>(1.0) - energy / delta)), clampBlend);
}
// IsResurrectedFrameCloserThanPreviousFrame (usf:263-281): the resurrected guide matches the input
// better than the reprojected history by more than 0.05 per channel over a 3x3 window, in more than
// four of the nine windows around the pixel, and the pixel lies on the snapshot screen.
fn tsrResurrectionCloser(inputTex: texture_2d<f32>, historyTex: texture_2d<f32>,
  resurrectedTex: texture_2d<f32>, pixel: vec2<i32>) -> bool {
  if (tsrLoadIn(resurrectedTex, pixel).a < 0.0) { return false; }
  var closerCount = 0.0;
  for (var qy = -1; qy <= 1; qy++) {
    for (var qx = -1; qx <= 1; qx++) {
      var totalMatchDiff = 0.0;
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let p = pixel + vec2<i32>(qx + x, qy + y);
          let exposedInput = tsrSmcs(tsrLoadIn(inputTex, p).rgb);
          let previous = abs(exposedInput - tsrSmcs(tsrLoadIn(historyTex, p).rgb));
          let resurrection = abs(exposedInput - tsrSmcs(tsrLoadIn(resurrectedTex, p).rgb));
          let matchDiff = previous - resurrection;
          totalMatchDiff += matchDiff.x + matchDiff.y + matchDiff.z;
        }
      }
      closerCount += select(0.0, 1.0, totalMatchDiff > 0.05 * 3.0 * 9.0);
    }
  }
  return closerCount > 4.0;
}
// UpdateGuide (TSRRejectShading.usf:380-399, 846-856, 860-865) after the resurrection decision.
// InputUncertainty is this frame's velocity edge and HistoryUncertainty the reprojected previous
// one (decimate.rg, from the analyze stage). The decision keeps its values in fp16 instead of
// UE's 8-bit offsets: (rejection, DisableHistoryClamp, DecreaseValidityMultiplier, bit mask).
//
// Resurrection (usf:762-790): UE measures the resurrected guide for a tile when any lane is closer
// with RejectionBlendFinal < 0.5, then resurrects each closer pixel whose rejection blend improves
// by more than 0.1. The tile gate is an any-lane ballot; here it is the per-pixel condition alone,
// so the decision does not depend on tile placement. Min3x3 of the history uncertainty (usf:899)
// takes the resurrected value only at the pixel itself: a neighbour's decision is not available.
fn tsrReject(inputTex: texture_2d<f32>, historyTex: texture_2d<f32>, rawTex: texture_2d<f32>,
  deltaTex: texture_2d<f32>, decimateTex: texture_2d<f32>, resurrectedTex: texture_2d<f32>,
  resurrectedRawTex: texture_2d<f32>, resurrectedDeltaTex: texture_2d<f32>,
  pixel: vec2<i32>) -> TsrRejectResult {
  var blend = tsrRejectionBlend(rawTex, deltaTex, pixel);
  let input = tsrLoadIn(inputTex, pixel).rgb;
  var history = tsrLoadIn(historyTex, pixel);
  let disoccluded = history.a < 0.5;
  let resurrection = tsrLoadIn(resurrectedTex, pixel);
  var resurrect = false;
  if (params.resurrection.x != 0u && blend.rejection < 0.5 &&
    tsrResurrectionCloser(inputTex, historyTex, resurrectedTex, pixel)) {
    let candidate = tsrRejectionBlend(resurrectedRawTex, resurrectedDeltaTex, pixel);
    if (candidate.rejection - blend.rejection > 0.1) {
      resurrect = true;
      blend = candidate;
      history = vec4<f32>(resurrection.rgb, history.a);
    }
  }
  let rejection = blend.rejection;
  // IsAliasingVisible (ShadingAnalysis.ush:190-202): luma of the exposed 3x3 input box.
  var boxLow = vec3<f32>(1e30);
  var boxHigh = vec3<f32>(-1e30);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = tsrSmcs(tsrLoadIn(inputTex, pixel + vec2<i32>(x, y)).rgb);
      boxLow = min(boxLow, c);
      boxHigh = max(boxHigh, c);
    }
  }
  let aliasingVisible = dot(boxHigh - boxLow, vec3<f32>(0.299, 0.587, 0.114)) > 0.05;
  // ShouldSpatialAntiAlias (ShadingAnalysis.ush:206-211).
  let freshHistory = disoccluded && !resurrect;
  let spatialAntiAlias = aliasingVisible && (rejection < 0.25 || freshHistory);
  // TheoricBlendFactor (cpp:3005); MaxHistorySampleCount = clamp(HistorySampleCount, 8, 32) = 16.
  let ratio = params.inputSize.x / params.outputSize.x;
  let theoric = 1.0 / (1.0 + TSR_HISTORY_SAMPLE_COUNT / (ratio * ratio));
  let total = select(saturate(1.0 - rejection * 4.0), 1.0, disoccluded);
  let blendFinal = max(max(theoric, 1.0 - rejection), total);
  let exposedInput = tsrAddPerceptionAdd(tsrGcsToLinear(input));
  let exposedHistory = tsrAddPerceptionAdd(tsrGcsToLinear(history.rgb));
  let guide = tsrLinearToGcs(tsrRemovePerceptionAdd(
    exposedInput * blendFinal - exposedHistory * (blendFinal - 1.0)));
  // usf:863-864, 899-901: a pixel with a fresh disocclusion keeps neither clamp relief nor validity
  // growth; otherwise DisableHistoryClamp is limited by the velocity edges (a pixel on a motion edge
  // keeps its clamp) while IncreaseValidityMultiplier is RejectionClampBlend. The history stores the
  // complement of the latter, as UE does.
  let inputUncertainty = tsrLoadIn(decimateTex, pixel).r;
  var historyUncertainty = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let uncertainty = tsrLoadIn(decimateTex, pixel + vec2<i32>(x, y)).g;
      historyUncertainty = min(historyUncertainty,
        select(uncertainty, resurrection.a, resurrect && x == 0 && y == 0));
    }
  }
  let disableClamp = select(min(blend.clampBlend, min(inputUncertainty, historyUncertainty)), 0.0, freshHistory);
  let increaseValidity = select(blend.clampBlend, 0.0, freshHistory);
  let mask = (select(0.0, 1.0, spatialAntiAlias) + select(0.0, 2.0, resurrect)) * (1.0 / 255.0);
  return TsrRejectResult(vec4<f32>(guide, inputUncertainty),
    vec4<f32>(rejection, disableClamp, 1.0 - increaseValidity, mask));
}
