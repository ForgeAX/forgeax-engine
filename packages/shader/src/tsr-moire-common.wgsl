// UE 5.8.1 ComputeMoireError (TSRShadingAnalysis.ush:215-491), split into input-resolution stages
// that exchange only textures, like the shading rejection it re-runs on one channel:
//   clamp   -> InputC2/HistoryC2 and the luma modification (usf:235-286)
//   measure -> RawClampedEnergy, RawRejection, Delta (usf:288-370)
//   update  -> simulated TSRUpdateHistory and the gradient test (usf:372-420)
//   history -> dilated variation, new history and the moire error (usf:422-490)
// The flicker luma is GCS; the single-channel analysis runs in SMCS = GCS^2. UE flickering terms
// without an engine counterpart are not modeled: translucency alpha and thin geometry.
const TSR_MOIRE_ENCODING_ERROR: f32 = 1.0 / 127.0;
const TSR_MOIRE_MIN_BLEND: f32 = 0.05;
const TSR_MOIRE_MAX_COUNT: f32 = 20.0;
const TSR_MOIRE_LUMA_ENCODING_ERROR: f32 = 0.5 / 255.0;

fn tsrMoireGradient(encoded: f32) -> f32 { return encoded * (255.0 / 127.0) - 1.0; }

// ---------------------------------------------------------------- clamp stage
// (InputC2, HistoryC2, InputLumaModification, InputLuma). AnnihilateMutuallySingleChannel3x3 is
// Clamp3x3(A, Clamp3x3(B, A)) for each of the two fields; the modification is the luma the final
// scene color gained over the opaque scene color (usf:237-259, 0.5/255 encoding error).
fn tsrMoireSquared(tex: texture_2d<f32>, p: vec2<i32>) -> f32 {
  let g = tsrLoadIn(tex, p).x;
  return g * g;
}
fn tsrMoireClamp(inputLumaTex: texture_2d<f32>, historyTex: texture_2d<f32>,
  opaqueTex: texture_2d<f32>, pixel: vec2<i32>) -> vec4<f32> {
  var inputBound = vec2<f32>(1e30, -1e30);
  var historyBound = vec2<f32>(1e30, -1e30);
  for (var qy = -1; qy <= 1; qy++) {
    for (var qx = -1; qx <= 1; qx++) {
      let q = pixel + vec2<i32>(qx, qy);
      var inputBox = vec2<f32>(1e30, -1e30);
      var historyBox = vec2<f32>(1e30, -1e30);
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let a = tsrMoireSquared(inputLumaTex, q + vec2<i32>(x, y));
          let b = tsrMoireSquared(historyTex, q + vec2<i32>(x, y));
          inputBox = vec2<f32>(min(inputBox.x, a), max(inputBox.y, a));
          historyBox = vec2<f32>(min(historyBox.x, b), max(historyBox.y, b));
        }
      }
      let boundary = min(max(tsrMoireSquared(historyTex, q), inputBox.x), inputBox.y);
      inputBound = vec2<f32>(min(inputBound.x, boundary), max(inputBound.y, boundary));
      let guide = min(max(tsrMoireSquared(inputLumaTex, q), historyBox.x), historyBox.y);
      historyBound = vec2<f32>(min(historyBound.x, guide), max(historyBound.y, guide));
    }
  }
  let own = tsrMoireSquared(inputLumaTex, pixel);
  let inputC2 = min(max(own, inputBound.x), inputBound.y);
  let historyC2 = min(max(tsrMoireSquared(historyTex, pixel), historyBound.x), historyBound.y);
  let sceneGcs = tsrLinearToGcs(tsrLoadIn(opaqueTex, pixel).rgb * tsrExposure(params.flicker.z));
  let sceneLuma = dot(sceneGcs * sceneGcs, vec3<f32>(1.0 / 3.0));
  let modification = max(abs(own - sceneLuma) - TSR_MOIRE_LUMA_ENCODING_ERROR, 0.0);
  return vec4<f32>(inputC2, historyC2, modification, own);
}

// -------------------------------------------------------------- measure stage
// MeasureRejection on one channel (usf:288-370) with the engine's responsive clamp error:
// (RawClampedEnergy, RawRejection, Delta, FilteredInputLumaModification).
fn tsrMoireMeasure(fieldTex: texture_2d<f32>, pixel: vec2<i32>) -> vec4<f32> {
  var boxLow = 1e30;
  var boxHigh = -1e30;
  var c2Low = 1e30;
  var c2High = -1e30;
  var variation = 0.0;
  for (var qy = -1; qy <= 1; qy++) {
    for (var qx = -1; qx <= 1; qx++) {
      let q = pixel + vec2<i32>(qx, qy);
      var blur = 0.0;
      var sumC = 0.0;
      var sumD = 0.0;
      var centerC = 0.0;
      var centerD = 0.0;
      for (var y = -1; y <= 1; y++) {
        for (var x = -1; x <= 1; x++) {
          let field = tsrLoadIn(fieldTex, q + vec2<i32>(x, y));
          let d = abs(field.w - field.x);
          blur += field.x * tsrBlurWeight(x, y);
          sumC += field.x;
          sumD += d;
          if (x == 0 && y == 0) { centerC = field.x; centerD = d; }
        }
      }
      boxLow = min(boxLow, blur);
      boxHigh = max(boxHigh, blur);
      c2Low = min(c2Low, centerC);
      c2High = max(c2High, centerC);
      variation += min(abs(1.125 * centerD - 0.125 * sumD), abs(1.125 * centerC - 0.125 * sumC))
        * tsrBlurWeight(qx, qy);
    }
  }
  var filteredInput = 0.0;
  var filteredHistory = 0.0;
  var filteredModification = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let field = tsrLoadIn(fieldTex, pixel + vec2<i32>(x, y));
      let weight = tsrBlurWeight(x, y);
      filteredInput += field.x * weight;
      filteredHistory += field.y * weight;
      filteredModification += field.z * weight;
    }
  }
  let inputBoxSize = c2High - c2Low;
  var clampError = max(TSR_QUANTIZATION_ERROR, variation);
  clampError = max(clampError, inputBoxSize * (TSR_FILTERING_WEIGHT * 0.25));
  clampError = clampError + TSR_QUANTIZATION_ERROR;
  boxLow = boxLow - clampError;
  boxHigh = boxHigh + clampError;
  let boxSize = inputBoxSize * TSR_FILTERING_WEIGHT + TSR_QUANTIZATION_ERROR * (2.0 * TSR_FILTERING_WEIGHT);
  let clampedHistory = min(max(filteredHistory, boxLow), boxHigh);
  let delta = max(abs(filteredInput - filteredHistory), boxSize);
  let energy = abs(clampedHistory - filteredHistory);
  return vec4<f32>(energy, saturate(1.0 - max(energy, 0.0) / delta), delta, filteredModification);
}

// -------------------------------------------------------------- update stage
// Simulated TSRUpdateHistory (usf:372-398) and the flicker test on its gradient (usf:400-420):
// (GradientVariation, IsFlicker, CurrentGradient, FinalFlickeringHistory in GCS).
fn tsrMoireUpdate(rawTex: texture_2d<f32>, fieldTex: texture_2d<f32>, historyTex: texture_2d<f32>,
  pixel: vec2<i32>) -> vec4<f32> {
  // MaxRMinG3x3(Median3x3((RawClampedEnergy, RawRejection))).
  var energy = 0.0;
  var clampBlend = 1.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let median = tsrMedian9(rawTex, pixel + vec2<i32>(x, y));
      energy = max(energy, median.x);
      clampBlend = min(clampBlend, median.y);
    }
  }
  let own = tsrLoadIn(rawTex, pixel);
  let blendFinal = saturate(1.0 - max(energy, 0.0) / own.z);
  let input = tsrLoadIn(fieldTex, pixel).w;
  // ClampPlus3x3(PrevFlickeringHistory, InputLuma): the plus neighbourhood bounds the history.
  var low = input;
  var high = input;
  for (var i = 0; i < 4; i++) {
    let offset = select(select(vec2<i32>(-1, 0), vec2<i32>(1, 0), i == 1),
      select(vec2<i32>(0, -1), vec2<i32>(0, 1), i == 3), i >= 2);
    let neighbour = tsrLoadIn(fieldTex, pixel + offset).w;
    low = min(low, neighbour);
    high = max(high, neighbour);
  }
  let previous = tsrLoadIn(historyTex, pixel);
  let previousLuma = previous.x * previous.x;
  let finalPrevious = mix(min(max(previousLuma, low), high), previousLuma, clampBlend);
  let finalBlend = max(1.0 - blendFinal, TSR_MOIRE_MIN_BLEND);
  let finalHistory = input * finalBlend - finalPrevious * (finalBlend - 1.0);
  let ghosting = input * TSR_MOIRE_MIN_BLEND - previousLuma * (TSR_MOIRE_MIN_BLEND - 1.0);
  // Remove the luma that changed between the measurement and the final scene color (usf:400-405).
  let rawGradient = finalHistory - ghosting;
  let gradient = sign(rawGradient) * max(abs(rawGradient) - own.w, 0.0);
  let previousGradient = tsrMoireGradient(previous.y);
  let withinError = abs(gradient) < TSR_MOIRE_ENCODING_ERROR || abs(previousGradient) < TSR_MOIRE_ENCODING_ERROR;
  let isFlicker = select(1.0, 0.0,
    gradient * previousGradient > 0.0 || withinError || params.historyValid == 0u);
  return vec4<f32>(min(abs(previousGradient), abs(gradient)) * isFlicker, isFlicker, gradient,
    sqrt(max(finalHistory, 0.0)));
}

// ------------------------------------------------------------- history stage
struct TsrMoireHistoryResult {
  @location(0) history: vec4<f32>,
  @location(1) error: vec4<f32>,
};
// New moire history (GCS luma, gradient, total variation, count) and the moire error in .r
// (usf:422-490). Max3x3(Max3x3(.)) dilates the variation and its count over 5x5 texels so the
// nearest-neighbour history reprojection stays stable. bIsStatic is one until moving pixels are
// classified.
fn tsrMoireHistory(updateTex: texture_2d<f32>, fieldTex: texture_2d<f32>,
  previousTex: texture_2d<f32>, guideTex: texture_2d<f32>, edgeTex: texture_2d<f32>,
  pixel: vec2<i32>) -> TsrMoireHistoryResult {
  var variationContribution = 0.0;
  var countContribution = 0.0;
  for (var y = -2; y <= 2; y++) {
    for (var x = -2; x <= 2; x++) {
      let neighbour = tsrLoadIn(updateTex, pixel + vec2<i32>(x, y));
      variationContribution = max(variationContribution, neighbour.x);
      countContribution = max(countContribution, neighbour.y);
    }
  }
  let own = tsrLoadIn(updateTex, pixel);
  let previous = tsrLoadIn(previousTex, pixel);
  // bIsStatic = 1 - IsMovingMask (RejectShading.usf:239).
  let isStatic = 1.0 - tsrLoadIn(edgeTex, pixel).a;
  let previousGradient = tsrMoireGradient(previous.y);
  let previousVariation = previous.z * (1.0 - TSR_MOIRE_MIN_BLEND) * isStatic;
  let previousCount = previous.w * TSR_MOIRE_MAX_COUNT * (1.0 - TSR_MOIRE_MIN_BLEND) * isStatic;
  var gradient = previousGradient * (TSR_MOIRE_MIN_BLEND - 1.0) * (own.y - 1.0) + own.z;
  var variation = previousVariation + variationContribution;
  var count = previousCount + countContribution;
  // Parallax disocclusion discards the whole moire history (usf:455-458).
  if (tsrLoadIn(guideTex, pixel).a < 0.5) {
    gradient = 0.0;
    variation = 0.0;
    count = 0.0;
  }
  let quantized = floor(count * (255.0 / TSR_MOIRE_MAX_COUNT)) * (TSR_MOIRE_MAX_COUNT / 255.0);
  let inverseCount = select(0.0, 1.0 / count, count > 0.0);
  variation = variation * quantized * inverseCount;
  let fadeIn = saturate(count * params.flicker.x - 0.5);
  let error = (abs(variation * inverseCount) + count * TSR_MOIRE_ENCODING_ERROR) * fadeIn;
  let modification = tsrLoadIn(fieldTex, pixel).z;
  return TsrMoireHistoryResult(
    vec4<f32>(own.w, gradient * (127.0 / 255.0) + 127.0 / 255.0, variation, quantized / TSR_MOIRE_MAX_COUNT),
    vec4<f32>(saturate(error * isStatic - modification), 0.0, 0.0, 0.0));
}
