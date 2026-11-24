struct AutoExposureParameters {
  compensationEv: f32,
  rangeMinEv: f32,
  rangeMaxEv: f32,
  upRate: f32,
  downRate: f32,
  deltaTime: f32,
  fallback: f32,
  generation: f32,
  // The mode is the first lane of the final 16-byte uniform slot.
  adaptation: vec4<f32>,
};

fn finite(value: f32) -> bool {
  // Equality rejects NaN; the magnitude bound rejects +/-infinity.
  return value == value && abs(value) <= 3.402823e+37;
}

fn legacyExposureSampleWeight(
  block: vec2<u32>,
  center: vec2<f32>,
  inverseExtentSquared: vec2<f32>,
) -> u32 {
  let delta = vec2<f32>(block) - center;
  let distanceSquared =
    delta.x * delta.x * inverseExtentSquared.x +
    delta.y * delta.y * inverseExtentSquared.y;
  if (distanceSquared <= 0.25) { return 3u; }
  if (distanceSquared <= 0.75) { return 2u; }
  return 1u;
}

// Integer classification is shared by atomic and raster histogram plans.
fn classifyExposureSample(sample: vec3<f32>) -> vec2<u32> {
  if (!finite(sample.r) || !finite(sample.g) || !finite(sample.b)) { return vec2<u32>(0u); }
  let luminance = dot(sample, vec3<f32>(0.2126, 0.7152, 0.0722));
  if (!finite(luminance) || luminance <= 0.0) { return vec2<u32>(0u); }
  let bin = min(u32(clamp(log2(luminance) + 12.0, 0.0, 23.999) * (256.0 / 24.0)), 255u);
  return vec2<u32>(bin, 1u);
}
const UE_HISTOGRAM_SIZE = 64u;
const UE_HISTOGRAM_MIN_LOG = -10.0;
const UE_HISTOGRAM_MAX_LOG = 20.0;
const UE_SAMPLE_BIT = 0x80000000u;

fn exposureSampleScale(grid: vec2<u32>) -> u32 {
  // UE uses 19-bit fixed-point weights before reducing local histograms.
  // This portable histogram reduces into u32 globally. Limit the scale by the
  // maximum four half-resolution samples per block so no bin or total can wrap.
  return min(524288u, 0xffffffffu / 4u / max(grid.x, 1u) / max(grid.y, 1u));
}

fn classifyUeExposureQuad(source: texture_2d<f32>, origin: vec2<u32>, scale: u32) -> u32 {
  let pixel = vec2<i32>(origin);
  let filtered = (
    textureLoad(source, pixel, 0).rgb +
    textureLoad(source, pixel + vec2<i32>(1, 0), 0).rgb +
    textureLoad(source, pixel + vec2<i32>(0, 1), 0).rgb +
    textureLoad(source, pixel + vec2<i32>(1, 1), 0).rgb
  ) * 0.25;
  let luminance = dot(filtered, vec3<f32>(1.0 / 3.0));
  if (!finite(luminance) || luminance <= exp2(UE_HISTOGRAM_MIN_LOG)) { return 0u; }
  let range = UE_HISTOGRAM_MAX_LOG - UE_HISTOGRAM_MIN_LOG;
  let position = clamp((log2(luminance) - UE_HISTOGRAM_MIN_LOG) / range, 0.0, 1.0) * f32(UE_HISTOGRAM_SIZE - 1u);
  let low = u32(position);
  let highWeight = u32(fract(position) * f32(scale));
  return UE_SAMPLE_BIT | (highWeight << 8u) | low;
}

fn classifyExposureBlock(
  source: texture_2d<f32>,
  parameters: AutoExposureParameters,
  block: vec2<u32>,
  dimensions: vec2<u32>,
  scale: u32,
) -> vec4<u32> {
  if (parameters.adaptation.x == 1.0) {
    // UE's histogram reads complete 2x2 groups of the half-resolution scene color.
    if (any(block >= dimensions / vec2<u32>(4u))) { return vec4<u32>(0u); }
    let origin = block * 4u;
    return vec4<u32>(
      classifyUeExposureQuad(source, origin, scale),
      classifyUeExposureQuad(source, origin + vec2<u32>(2u, 0u), scale),
      classifyUeExposureQuad(source, origin + vec2<u32>(0u, 2u), scale),
      classifyUeExposureQuad(source, origin + vec2<u32>(2u, 2u), scale),
    );
  }
  let pixel = min(block * 4u + vec2<u32>(2u), dimensions - vec2<u32>(1u));
  let value = classifyExposureSample(textureLoad(source, vec2<i32>(pixel), 0).rgb);
  let grid = (dimensions + vec2<u32>(3u)) / vec2<u32>(4u);
  let center = (vec2<f32>(grid) - vec2<f32>(1.0)) * 0.5;
  let extent = 1.0 / max(center, vec2<f32>(1.0));
  let weight = value.y * legacyExposureSampleWeight(block, center, extent * extent);
  return vec4<u32>((weight << 8u) | value.x, 0u, 0u, 0u);
}

// A record stores a low bin index and either the legacy count or the split
// high-bin weight. UE's default black bucket influence is zero.
fn exposureBinWeights(record: u32, scale: u32) -> vec3<u32> {
  let bin = record & 255u;
  let weight = (record & ~UE_SAMPLE_BIT) >> 8u;
  if ((record & UE_SAMPLE_BIT) == 0u) { return vec3<u32>(bin, weight, 0u); }
  return vec3<u32>(bin, select(scale - weight, 0u, bin == 0u), weight);
}

// UE eye adaptation operates on scene luminance EV, the inverse of camera gain.
fn ueAdaptExposure(current: f32, targetGain: f32, parameters: AutoExposureParameters) -> f32 {
  let currentEv = -log2(current);
  let targetEv = -log2(targetGain);
  let difference = targetEv - currentEv;
  let distance = abs(difference);
  let rate = select(parameters.downRate, parameters.upRate, difference > 0.0);
  let dt = parameters.deltaTime;
  if (rate <= 0.0 || dt <= 0.0 || distance == 0.0) { return current; }
  let transition = 1.5;
  if (distance > transition) {
    let step = min(distance, dt * rate);
    return exp2(-(currentEv + sign(difference) * step));
  }
  // Match the linear derivative at the 60 Hz calibration step.
  let referenceStep = 1.0 / 60.0;
  let referenceFraction = 1.0 - exp2(-referenceStep * rate);
  let frameFraction = 1.0 - exp2(-dt * rate);
  let fractionRatio = select(dt / referenceStep, frameFraction / referenceFraction, referenceFraction > 0.0);
  let blend = min(1.0, fractionRatio * (referenceStep * rate / transition));
  return exp2(-mix(currentEv, targetEv, blend));
}

fn adaptExposureHistogram(counts: array<u32, 256>, sampleTotal: u32, previous: vec4<f32>, parameters: AutoExposureParameters) -> vec4<f32> {
    let validParameters =
      finite(parameters.compensationEv) &&
      finite(parameters.rangeMinEv) &&
      finite(parameters.rangeMaxEv) &&
      parameters.rangeMinEv <= parameters.rangeMaxEv &&
      finite(parameters.upRate) &&
      finite(parameters.downRate) &&
      finite(parameters.deltaTime) &&
      parameters.deltaTime >= 0.0 &&
      finite(parameters.fallback) &&
      parameters.fallback > 0.0 &&
      finite(parameters.generation);
    let safeFallback = select(
      1.0,
      parameters.fallback,
      finite(parameters.fallback) && parameters.fallback > 0.0,
    );
    let safeGeneration = select(0.0, parameters.generation, finite(parameters.generation));
    let ue = parameters.adaptation.x == 1.0;
    let total = f32(sampleTotal);
    let legacyLowRank = min(sampleTotal, u32(total * 0.05));
    let legacyHighRank = min(sampleTotal, max(legacyLowRank + 1u, u32(ceil(total * 0.95))));
    let lowRank = select(f32(legacyLowRank), total * 0.10, ue);
    let highRank = select(f32(legacyHighRank), total * 0.90, ue);
    var cumulative = 0u;
    var clippedWeightedLog = 0.0;
    var clippedTotal = 0.0;
    let bins = select(256u, UE_HISTOGRAM_SIZE, ue);
    for (var index = 0u; index < bins; index += 1u) {
      let count = counts[index];
      let begin = cumulative;
      cumulative += count;
      let keptBegin = max(f32(begin), lowRank);
      let keptEnd = min(f32(cumulative), highRank);
      if (keptEnd > keptBegin) {
        let kept = keptEnd - keptBegin;
        clippedTotal += kept;
        let legacyLog = -12.0 + (f32(index) + 0.5) * (24.0 / 256.0);
        let ueLog = mix(UE_HISTOGRAM_MIN_LOG, UE_HISTOGRAM_MAX_LOG, f32(index) / f32(UE_HISTOGRAM_SIZE - 1u));
        clippedWeightedLog += kept * select(legacyLog, ueLog, ue);
      }
    }
    let averageLog = select(0.0, clippedWeightedLog / clippedTotal, clippedTotal > 0.0);
    let measuredExposure = exp2(-averageLog) * 0.18;
    let gainEv = log2(max(measuredExposure, 1e-6));
    let legacyTarget = exp2(clamp(gainEv + parameters.compensationEv, parameters.rangeMinEv, parameters.rangeMaxEv));
    let ueGainEv = clamp(log2(0.18) - averageLog, parameters.rangeMinEv, parameters.rangeMaxEv);
    let ueTarget = min(10000.0, exp2(ueGainEv)) * exp2(parameters.compensationEv);
    let targetExposure = select(
      safeFallback,
      select(legacyTarget, ueTarget, ue),
      validParameters && clippedTotal > 0.0 && finite(measuredExposure),
    );
    let hasPrevious = validParameters && previous.y > 0.5 && previous.z == safeGeneration && previous.w == safeFallback && finite(previous.x) && previous.x > 0.0;
    let current = select(safeFallback, previous.x, hasPrevious);
    if (ue) {
      let hasTarget = validParameters && clippedTotal > 0.0 && finite(targetExposure) && targetExposure > 0.0;
      if (!hasTarget) {
        return vec4<f32>(current, select(0.0, 1.0, hasPrevious), safeGeneration, safeFallback);
      }
      if (!hasPrevious) {
        return vec4<f32>(targetExposure, 1.0, safeGeneration, safeFallback);
      }
      let adapted = ueAdaptExposure(current, targetExposure, parameters);
      let exposure = select(current, adapted, finite(adapted) && adapted > 0.0);
      return vec4<f32>(exposure, 1.0, safeGeneration, safeFallback);
    }
    let rate = select(parameters.downRate, parameters.upRate, targetExposure > current);
    let safeRate = select(0.0, rate, finite(rate) && rate >= 0.0);
    let dt = select(0.0, parameters.deltaTime, finite(parameters.deltaTime) && parameters.deltaTime >= 0.0);
    let amount = 1.0 - exp(-safeRate * dt);
    let adapted = select(current, current + (targetExposure - current) * amount, validParameters && finite(targetExposure) && finite(current) && dt > 0.0 && safeRate > 0.0);
    let exposure = select(safeFallback, adapted, finite(adapted) && adapted > 0.0);
    return vec4<f32>(exposure, 1.0, safeGeneration, safeFallback);
}
