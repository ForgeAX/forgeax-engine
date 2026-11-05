struct AutoExposureParameters {
  compensationEv: f32,
  rangeMinEv: f32,
  rangeMaxEv: f32,
  upRate: f32,
  downRate: f32,
  deltaTime: f32,
  fallback: f32,
  generation: f32,
};

fn finite(value: f32) -> bool {
  // Equality rejects NaN; the magnitude bound rejects +/-infinity.
  return value == value && abs(value) <= 3.402823e+37;
}

fn centerWeight(
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
    let lowRank = min(sampleTotal, u32(f32(sampleTotal) * 0.05));
    let highRank = min(sampleTotal, max(lowRank + 1u, u32(ceil(f32(sampleTotal) * 0.95))));
    var cumulative = 0u;
    var clippedWeightedLog = 0.0;
    var clippedTotal = 0u;
    for (var index = 0u; index < 256u; index += 1u) {
      let count = counts[index];
      let begin = cumulative;
      cumulative += count;
      let keptBegin = max(begin, lowRank);
      let keptEnd = min(cumulative, highRank);
      if (keptEnd > keptBegin) {
        let kept = keptEnd - keptBegin;
        clippedTotal += kept;
        clippedWeightedLog += f32(kept) * (-12.0 + (f32(index) + 0.5) * (24.0 / 256.0));
      }
    }
    let averageLog = select(0.0, clippedWeightedLog / f32(clippedTotal), clippedTotal > 0u);
    let measuredExposure = exp2(-averageLog) * 0.18;
    let targetExposure = select(
      safeFallback,
      exp2(clamp(log2(max(measuredExposure, 1e-6)) + parameters.compensationEv, parameters.rangeMinEv, parameters.rangeMaxEv)),
      validParameters && clippedTotal > 0u && finite(measuredExposure),
    );
    let hasPrevious = validParameters && previous.y > 0.5 && previous.z == safeGeneration && previous.w == safeFallback && finite(previous.x) && previous.x > 0.0;
    let current = select(safeFallback, previous.x, hasPrevious);
    let rate = select(parameters.downRate, parameters.upRate, targetExposure > current);
    let safeRate = select(0.0, rate, finite(rate) && rate >= 0.0);
    let dt = select(0.0, parameters.deltaTime, finite(parameters.deltaTime) && parameters.deltaTime >= 0.0);
    let amount = 1.0 - exp(-safeRate * dt);
    let adapted = select(current, current + (targetExposure - current) * amount, validParameters && finite(targetExposure) && finite(current) && dt > 0.0 && safeRate > 0.0);
    let exposure = select(safeFallback, adapted, finite(adapted) && adapted > 0.0);
    return vec4<f32>(exposure, 1.0, safeGeneration, safeFallback);
}
