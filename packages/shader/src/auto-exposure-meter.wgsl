// Auto exposure meter module. Runtime uses the cooked WGSL string directly.
// The three entry points execute as ordered dispatches in one meter pass.
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

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> state: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> candidate: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> parameters: AutoExposureParameters;

var<workgroup> localHistogram: array<atomic<u32>, 256>;
var<workgroup> totals: array<u32, 64>;
var<workgroup> sampleTotal: u32;

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

fn accumulateSample(
  block: vec2<u32>,
  sampleGrid: vec2<u32>,
  dimensions: vec2<u32>,
  center: vec2<f32>,
  extent: vec2<f32>,
) {
  if (block.x >= sampleGrid.x || block.y >= sampleGrid.y) { return; }
  let pixel = min(block * vec2<u32>(4u) + vec2<u32>(2u), dimensions - vec2<u32>(1u));
  let sample = textureLoad(source, vec2<i32>(pixel), 0);
  if (!finite(sample.r) || !finite(sample.g) || !finite(sample.b)) { return; }
  let luminance = dot(sample.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
  if (!finite(luminance) || luminance <= 0.0) { return; }
  let bin = min(u32(clamp(log2(luminance) + 12.0, 0.0, 23.999) * (256.0 / 24.0)), 255u);
  atomicAdd(&localHistogram[bin], centerWeight(block, center, extent));
}

@compute @workgroup_size(256, 1, 1)
fn auto_exposure_clear(@builtin(local_invocation_index) localIndex: u32) {
  atomicStore(&histogram[localIndex], 0u);
}

@compute @workgroup_size(256, 1, 1)
fn auto_exposure_histogram(
  @builtin(local_invocation_index) localIndex: u32,
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(num_workgroups) numWorkgroups: vec3<u32>,
) {
  let dimensions = textureDimensions(source);
  let sampleGrid = (dimensions.xy + vec2<u32>(3u)) / vec2<u32>(4u);
  let grid = vec2<f32>(sampleGrid);
  let center = (grid - vec2<f32>(1.0)) * 0.5;
  let extent = max(center, vec2<f32>(1.0));
  let inverseExtent = 1.0 / extent;
  let inverseExtentSquared = inverseExtent * inverseExtent;

  // Map the 256 lanes to a 16x16 logical tile. The fixed 4x8 dispatch grid
  // then uses a two-dimensional tile stride to cover every 4x4 sample block.
  atomicStore(&localHistogram[localIndex], 0u);
  workgroupBarrier();
  let localGrid = vec2<u32>(localIndex % 16u, localIndex / 16u);
  let tileSize = vec2<u32>(16u);
  let blockStart = workgroupId.xy * tileSize + localGrid;
  let blockStride = numWorkgroups.xy * tileSize;
  for (var blockY = blockStart.y; blockY < sampleGrid.y; blockY += blockStride.y) {
    for (var blockX = blockStart.x; blockX < sampleGrid.x; blockX += blockStride.x) {
      accumulateSample(
        vec2<u32>(blockX, blockY),
        sampleGrid,
        dimensions,
        center,
        inverseExtentSquared,
      );
    }
  }
  workgroupBarrier();

  // Every lane owns one bin. All local accumulation is complete before the
  // owners atomically publish their finite result to the one global 1KiB map.
  let localCount = atomicLoad(&localHistogram[localIndex]);
  if (localCount > 0u) {
    atomicAdd(&histogram[localIndex], localCount);
  }
}

@compute @workgroup_size(64, 1, 1)
fn auto_exposure_adapt(@builtin(local_invocation_index) localIndex: u32) {
  var total = 0u;
  for (var index = localIndex; index < 256u; index += 64u) {
    total += atomicLoad(&histogram[index]);
  }
  totals[localIndex] = total;
  workgroupBarrier();
  if (localIndex == 0u) {
    var reducedTotal = 0u;
    for (var lane = 0u; lane < 64u; lane += 1u) {
      reducedTotal += totals[lane];
    }
    sampleTotal = reducedTotal;
  }
  workgroupBarrier();
  if (localIndex == 0u) {
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
      let count = atomicLoad(&histogram[index]);
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
    let previous = state[0];
    let hasPrevious = validParameters && previous.y > 0.5 && previous.z == safeGeneration && previous.w == safeFallback && finite(previous.x) && previous.x > 0.0;
    let current = select(safeFallback, previous.x, hasPrevious);
    let rate = select(parameters.downRate, parameters.upRate, targetExposure > current);
    let safeRate = select(0.0, rate, finite(rate) && rate >= 0.0);
    let dt = select(0.0, parameters.deltaTime, finite(parameters.deltaTime) && parameters.deltaTime >= 0.0);
    let amount = 1.0 - exp(-safeRate * dt);
    let adapted = select(current, current + (targetExposure - current) * amount, validParameters && finite(targetExposure) && finite(current) && dt > 0.0 && safeRate > 0.0);
    let exposure = select(safeFallback, adapted, finite(adapted) && adapted > 0.0);
    candidate[0] = vec4<f32>(exposure, 1.0, safeGeneration, safeFallback);
    state[0] = candidate[0];
  }
}
