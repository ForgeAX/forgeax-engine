// Shared sample classification with the compute meter; every output owns its complete count.
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var classified: texture_2d<u32>;
@group(0) @binding(2) var histogram: texture_2d<u32>;
@group(0) @binding(3) var<uniform> previous: vec4<f32>;
@group(0) @binding(4) var<uniform> parameters: AutoExposureParameters;

@vertex fn auto_exposure_fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(3., -1.), vec2<f32>(-1., 3.));
  return vec4<f32>(positions[index], 0., 1.);
}

@fragment fn auto_exposure_classify(@builtin(position) position: vec4<f32>) -> @location(0) vec4<u32> {
  let dimensions = textureDimensions(source, 0);
  let sampleGrid = (dimensions + vec2<u32>(3u)) / vec2<u32>(4u);
  let block = vec2<u32>(position.xy);
  return classifyExposureBlock(source, parameters, block, dimensions, exposureSampleScale(sampleGrid));
}

@fragment fn auto_exposure_tile_histogram(@builtin(position) position: vec4<f32>) -> @location(0) vec4<u32> {
  let grid = textureDimensions(classified, 0);
  let tileColumns = (grid.x + 15u) / 16u;
  let tileIndex = u32(position.y);
  let origin = vec2<u32>(tileIndex % tileColumns, tileIndex / tileColumns) * vec2<u32>(16u);
  let firstBin = u32(position.x) * 4u;
  let scale = exposureSampleScale(grid);
  var counts = vec4<u32>(0u);
  for (var y = 0u; y < 16u; y++) {
    for (var x = 0u; x < 16u; x++) {
      let samplePixel = origin + vec2<u32>(x, y);
      if (any(samplePixel >= grid)) { continue; }
      let records = textureLoad(classified, vec2<i32>(samplePixel), 0);
      for (var lane = 0u; lane < 4u; lane++) {
        let value = exposureBinWeights(records[lane], scale);
        if (value.x >= firstBin && value.x < firstBin + 4u) {
          counts[value.x - firstBin] += value.y;
        }
        let next = value.x + 1u;
        if (next >= firstBin && next < firstBin + 4u) {
          counts[next - firstBin] += value.z;
        }
      }
    }
  }
  return counts;
}

@fragment fn auto_exposure_reduce_histogram(@builtin(position) position: vec4<f32>) -> @location(0) vec4<u32> {
  let size = textureDimensions(histogram, 0);
  let first = u32(position.y) * 16u;
  var counts = vec4<u32>(0u);
  for (var row = first; row < min(first + 16u, size.y); row++) {
    counts += textureLoad(histogram, vec2<i32>(i32(position.x), i32(row)), 0);
  }
  return counts;
}

@fragment fn auto_exposure_adapt_fragment() -> @location(0) vec4<f32> {
  var counts: array<u32, 256>;
  var total = 0u;
  for (var quartet = 0u; quartet < 64u; quartet++) {
    let value = textureLoad(histogram, vec2<i32>(i32(quartet), 0), 0);
    for (var lane = 0u; lane < 4u; lane++) {
      counts[quartet * 4u + lane] = value[lane];
      total += value[lane];
    }
  }
  return adaptExposureHistogram(counts, total, previous, parameters);
}
