// Auto exposure meter module. Runtime uses the cooked WGSL string directly.
// The three entry points execute as ordered dispatches in one meter pass.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histogram: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> state: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> candidate: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> parameters: AutoExposureParameters;

var<workgroup> localHistogram: array<atomic<u32>, 256>;
var<workgroup> totals: array<u32, 64>;
var<workgroup> sampleTotal: u32;

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
  let classified = classifyExposureSample(sample.rgb);
  if (classified.y == 0u) { return; }
  let bin = classified.x;
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
    var counts: array<u32, 256>;
    for (var index = 0u; index < 256u; index++) { counts[index] = atomicLoad(&histogram[index]); }
    candidate[0] = adaptExposureHistogram(counts, sampleTotal, state[0], parameters);
  }
}
