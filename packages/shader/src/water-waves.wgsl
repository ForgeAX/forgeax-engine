#define_import_path forgeax_material::water_waves

struct WaterBodyData {
  waveRange: vec4<u32>,
  timeAndMask: vec4<f32>,
  tileHighXZ: vec4<f32>,
  tileLowXZ: vec4<f32>,
  tileMeta: vec4<f32>,
  fixedHeightDepthVelocity: vec4<f32>,
  modeZoneSlice: vec4<u32>,
  dynamicBoundsCenterExtentXZ: vec4<f32>,
};

struct WaterGerstnerWave {
  directionAmplitude: vec4<f32>,
  steepnessKOmegaGpuQ: vec4<f32>,
  cpuQMaxHeightReserved: vec4<f32>,
};

struct WaterWaveResult {
  displacement: vec3<f32>,
  normal: vec3<f32>,
  velocity: vec3<f32>,
  compression: f32,
};

struct WaterMeshTileVertex {
  position: vec3<f32>,
  waveRelativeXZ: vec2<f32>,
  coverageXZ: vec2<f32>,
  gridXZ: vec2<f32>,
  bodyIndex: u32,
  waveBodyIndex: u32,
  far: bool,
};

struct WaterInfoDescriptor {
  sliceAndSize: vec4<u32>,
  heightRange: vec4<f32>,
  centerAndExtent: vec4<f32>,
};

struct WaterMaterialDrawData {
  bodyIndex: u32,
  viewOriginX: f32,
  viewOriginY: f32,
  viewOriginZ: f32,
};

struct WaterBakedDescriptor {
  originSpacing: vec4<f32>,
  heightOrigin: vec4<f32>,
  dimensionsOffsetValid: vec4<u32>,
};

struct WaterBakedSample {
  heightDepthVelocity: vec4<f32>,
  valid: bool,
};

struct WaterWaveVertexState {
  currentPosition: vec3<f32>,
  previousPosition: vec3<f32>,
  currentDisplacementXZ: vec2<f32>,
  normal: vec3<f32>,
  velocity: vec3<f32>,
  valid: bool,
};

struct WaterHeightMappingResult {
  worldPositionM: vec3<f32>,
  deltaWpoM: vec3<f32>,
};

// Group 2 is the mesh group. High slots preserve its existing mesh/HDRP ABI.
@group(2) @binding(16) var<storage, read> waterBodyData: array<WaterBodyData>;
@group(2) @binding(17) var<storage, read> waterGerstnerWaves: array<WaterGerstnerWave>;
@group(2) @binding(18) var waterInfoTexture: texture_2d_array<f32>;
@group(2) @binding(19) var waterInfoSampler: sampler;
@group(2) @binding(20) var<uniform> waterInfoDescriptor: WaterInfoDescriptor;
@group(2) @binding(21) var<uniform> waterMaterialDrawData: WaterMaterialDrawData;
@group(2) @binding(22) var<storage, read> waterMeshTileWords: array<u32>;
@group(2) @binding(23) var<storage, read> waterBakedDescriptors: array<WaterBakedDescriptor>;
@group(2) @binding(24) var<storage, read> waterBakedSamples: array<vec4<f32>>;

const WATER_WAVE_GRAVITY_M_PER_SEC2: f32 = 9.8;
const WATER_WAVE_EDGE_BLEND_WIDTH_M: f32 = 4.0;

fn waterMeshTileWordOffset(instanceIndex: u32) -> u32 {
  return select(0u, waterMeshTileWords[0u], waterMeshTileWords[23u] == 0x57474d31u) + instanceIndex * 24u;
}

fn waterMeshInstanceTransformIndex(instanceIndex: u32) -> u32 {
  return select(instanceIndex, 0u, waterMeshTileWords[23u] == 0x57474d31u);
}

fn waterMeshSourceBodyIndex(instanceIndex: u32) -> u32 {
  if (waterMeshTileWords[23u] == 0x57474d31u) { return waterMeshTileWords[waterMeshTileWordOffset(instanceIndex) + 7u] - 1u; }
  return waterMaterialDrawData.bodyIndex;
}

fn waterMeshWaveBodyIndex(instanceIndex: u32) -> u32 {
  if (waterMeshTileWords[15u] == 0u) { return waterMaterialDrawData.bodyIndex; }
  let transitionWaveIndexPlusOne = waterMeshTileWords[waterMeshTileWordOffset(instanceIndex) + 8u];
  return select(waterMeshSourceBodyIndex(instanceIndex), transitionWaveIndexPlusOne - 1u, transitionWaveIndexPlusOne > 0u);
}

fn waterMeshTileIsFar(instanceIndex: u32) -> bool {
  return waterMeshTileWords[15u] != 0u && ((waterMeshTileWords[waterMeshTileWordOffset(instanceIndex) + 14u] >> 16u) & 1u) != 0u;
}

fn waterMeshFarBoundaryWeight(instanceIndex: u32, bodyIndex: u32, waveBodyIndex: u32, worldXZ: vec2<f32>) -> f32 {
  if (waterMeshTileWords[15u] == 0u || waterMeshTileIsFar(instanceIndex)) { return 1.0; }
  let mask = waterMeshTileWords[waterMeshTileWordOffset(instanceIndex) + 23u] & 15u;
  if (mask == 0u) { return 1.0; }
  let bounds = waterBodyData[bodyIndex].dynamicBoundsCenterExtentXZ;
  if (any(bounds.zw <= vec2<f32>(0.0))) { return 1.0; }
  let minimum = bounds.xy - bounds.zw * 0.5;
  let maximum = bounds.xy + bounds.zw * 0.5;
  let distances = vec4<f32>(worldXZ.x - minimum.x, maximum.x - worldXZ.x, worldXZ.y - minimum.y, maximum.y - worldXZ.y);
  var distanceM = 1e20;
  for (var side = 0u; side < 4u; side += 1u) {
    if ((mask & (1u << side)) != 0u) { distanceM = min(distanceM, distances[side]); }
  }
  // Keep the entire horizontal/vertical wave envelope inside the flat join.
  let widthM = max(WATER_WAVE_EDGE_BLEND_WIDTH_M, waterBodyData[waveBodyIndex].timeAndMask.w * 2.0);
  return smoothstep(0.0, widthM, distanceM);
}

fn waterMeshWavePhaseAt(instanceIndex: u32, coverageXZ: vec2<f32>, worldXZ: vec2<f32>) -> vec2<f32> {
  let waveBodyIndex = waterMeshWaveBodyIndex(instanceIndex);
  if (waterMeshTileWords[15u] == 0u) { return waterBodyPhaseAtWorldPosition(waveBodyIndex, worldXZ); }
  let offset = waterMeshTileWordOffset(instanceIndex);
  let relativeOriginXZ = vec2<f32>(bitcast<f32>(waterMeshTileWords[offset + 16u]), bitcast<f32>(waterMeshTileWords[offset + 17u]));
  return waterBodyTileOffset(waveBodyIndex, relativeOriginXZ + coverageXZ);
}

fn waterMeshTileVertex(localPosition: vec3<f32>, instanceIndex: u32) -> WaterMeshTileVertex {
  if (waterMeshTileWords[15u] == 0u) {
    return WaterMeshTileVertex(localPosition, localPosition.xz, localPosition.xz, vec2<f32>(0.0), waterMaterialDrawData.bodyIndex, waterMaterialDrawData.bodyIndex, false);
  }
  let offset = waterMeshTileWordOffset(instanceIndex);
  let originX = bitcast<f32>(waterMeshTileWords[offset]);
  let originZ = bitcast<f32>(waterMeshTileWords[offset + 1u]);
  let extentX = bitcast<f32>(waterMeshTileWords[offset + 2u]);
  let extentZ = bitcast<f32>(waterMeshTileWords[offset + 3u]);
  let waterY = bitcast<f32>(waterMeshTileWords[offset + 4u]);
  let lodScaleM = bitcast<f32>(waterMeshTileWords[offset + 11u]);
  let packedFlags = waterMeshTileWords[offset + 14u] >> 16u;
  let shouldMorph = (packedFlags & 2u) != 0u;
  let heightMorph = f32((packedFlags >> 3u) & 8191u) / 8191.0;
  let lod0 = waterMeshTileWords[offset + 9u];
  let maxMorphLod = waterMeshTileWords[offset + 22u];
  let quadsPerEdge = max(waterMeshTileWords[offset + 15u], 1u);
  let tileOriginXZ = vec2<f32>(originX, originZ);
  let tileExtentXZ = vec2<f32>(extentX, extentZ);
  var tileLocalXZ = localPosition.xz * tileExtentXZ;
  let quadSize = tileExtentXZ / f32(quadsPerEdge);
  let cameraRelativeXZ = vec2<f32>(
    bitcast<f32>(waterMeshTileWords[offset + 20u]),
    bitcast<f32>(waterMeshTileWords[offset + 21u]),
  );
  if (shouldMorph) {
    var morphLod = lod0;
    var morphQuadSize = quadSize;
    loop {
      if (morphLod >= maxMorphLod) { break; }
      let distanceToCamera = length(tileLocalXZ - cameraRelativeXZ);
      var lodFactor = clamp(distanceToCamera / (lodScaleM * exp2(f32(morphLod))) - 1.0, 0.0, 1.0);
      if (morphLod == lod0) { lodFactor = clamp(heightMorph + lodFactor, 0.0, 1.0); }
      tileLocalXZ = waterMeshMorphPosition(tileLocalXZ, morphQuadSize, lodFactor);
      if (lodFactor < 1.0) { break; }
      morphLod += 1u;
      morphQuadSize *= 2.0;
    }
  }
  let worldXZ = tileOriginXZ + tileLocalXZ;
  let waveOriginOffsetX = bitcast<f32>(waterMeshTileWords[offset + 16u]);
  let waveOriginOffsetZ = bitcast<f32>(waterMeshTileWords[offset + 17u]);
  return WaterMeshTileVertex(
    vec3<f32>(worldXZ.x, waterY, worldXZ.y),
    vec2<f32>(waveOriginOffsetX, waveOriginOffsetZ) + tileLocalXZ,
    tileLocalXZ,
    localPosition.xz,
    waterMeshSourceBodyIndex(instanceIndex),
    waterMeshWaveBodyIndex(instanceIndex),
    waterMeshTileIsFar(instanceIndex),
  );
}

fn waterMeshMorphPosition(positionXZ: vec2<f32>, quadSize: vec2<f32>, factor: f32) -> vec2<f32> {
  let grid4 = quadSize * 4.0;
  let offset = fract(positionXZ / grid4) - vec2<f32>(0.5);
  var result = positionXZ;
  if (abs(offset.x) < 0.26) { result.x += offset.x * factor * grid4.x; }
  if (abs(offset.y) < 0.26) { result.y += offset.y * factor * grid4.y; }
  return result;
}

fn waterMeshPointInCoverageRing(pointXZ: vec2<f32>, firstWord: u32, pointCount: u32, epsilon: f32) -> bool {
  var inside = false;
  var previous = pointCount - 1u;
  for (var current = 0u; current < pointCount; current += 1u) {
    let a = vec2<f32>(bitcast<f32>(waterMeshTileWords[firstWord + current * 2u]), bitcast<f32>(waterMeshTileWords[firstWord + current * 2u + 1u]));
    let b = vec2<f32>(bitcast<f32>(waterMeshTileWords[firstWord + previous * 2u]), bitcast<f32>(waterMeshTileWords[firstWord + previous * 2u + 1u]));
    let edge = b - a;
    let relative = pointXZ - a;
    let crossValue = edge.x * relative.y - edge.y * relative.x;
    if (abs(crossValue) <= epsilon * max(length(edge), epsilon) && all(pointXZ >= min(a, b) - vec2<f32>(epsilon)) && all(pointXZ <= max(a, b) + vec2<f32>(epsilon))) { return true; }
    if ((a.y > pointXZ.y) != (b.y > pointXZ.y) && pointXZ.x < edge.x * (pointXZ.y - a.y) / (edge.y + select(0.0000001, 0.0, abs(edge.y) > 0.0000001)) + a.x) { inside = !inside; }
    previous = current;
  }
  return inside;
}

fn waterMeshCoverageContains(instanceIndex: u32, pointXZ: vec2<f32>) -> bool {
  if (waterMeshTileWords[15u] == 0u) { return true; }
  let instanceOffset = waterMeshTileWordOffset(instanceIndex);
  let ringWordOffset = waterMeshTileWords[instanceOffset + 18u];
  let ringCount = waterMeshTileWords[instanceOffset + 19u];
  if (ringWordOffset == 0u || ringCount == 0u) { return true; }
  let epsilon = 0.001;
  let pointWordOffset = ringWordOffset + 1u + ringCount;
  var pointCursor = pointWordOffset;
  var inside = false;
  for (var ringIndex = 0u; ringIndex < ringCount; ringIndex += 1u) {
    let pointCount = waterMeshTileWords[ringWordOffset + 1u + ringIndex];
    if (pointCount >= 3u && waterMeshPointInCoverageRing(pointXZ, pointCursor, pointCount, epsilon)) { inside = !inside; }
    pointCursor += pointCount * 2u;
  }
  return inside;
}

fn waterDynamicBoundsContains(bodyIndex: u32, worldPositionM: vec3<f32>) -> bool {
#if WATER_DYNAMIC_BOUNDS_CLIP == true
  let bounds = waterBodyData[bodyIndex].dynamicBoundsCenterExtentXZ;
  if (any(bounds.zw <= vec2<f32>(0.0))) { return true; }
  let minimum = bounds.xy - bounds.zw * 0.5;
  let maximum = bounds.xy + bounds.zw * 0.5;
#if WATER_USE_INFO == true
  return all(worldPositionM.xz >= minimum) && all(worldPositionM.xz <= maximum);
#else
  return !(all(worldPositionM.xz > minimum) && all(worldPositionM.xz < maximum));
#endif
#else
  return true;
#endif
}

fn waterMeshWireColor(instanceIndex: u32, gridXZ: vec2<f32>) -> vec4<f32> {
  let pixelWidth = max(fwidth(gridXZ), vec2<f32>(0.000001));
  let offset = waterMeshTileWordOffset(instanceIndex);
  let quadsPerEdge = f32(max(waterMeshTileWords[offset + 15u], 1u));
  let grid = gridXZ * quadsPerEdge;
  let cell = fract(grid);
  let gridPixelWidth = max(fwidth(grid), vec2<f32>(0.000001));
  let axisPixels = min(cell, vec2<f32>(1.0) - cell) / gridPixelWidth;
  let diagonalPixels = abs(cell.x + cell.y - 1.0) / max(fwidth(grid.x + grid.y), 0.000001);
  let wirePixels = min(min(axisPixels.x, axisPixels.y), diagonalPixels);
  let quadSizePixels = min(1.0 / gridPixelWidth.x, 1.0 / gridPixelWidth.y);
  let wireFade = max(0.12, smoothstep(1.0, 3.0, quadSizePixels));
  let wireAlpha = (1.0 - smoothstep(0.35, 1.3, wirePixels)) * wireFade * 0.7;
  let tilePixels = min(gridXZ / pixelWidth, (vec2<f32>(1.0) - gridXZ) / pixelWidth);
  let tileAlpha = 1.0 - smoothstep(0.4, 1.7, min(tilePixels.x, tilePixels.y));
  let enabled = (waterBodyData[waterMaterialDrawData.bodyIndex].waveRange.w & 4u) != 0u;
  let alpha = max(wireAlpha, tileAlpha) * select(0.0, 1.0, enabled);
  let far = ((waterMeshTileWords[offset + 14u] >> 16u) & 1u) != 0u;
  let lod = waterMeshTileWords[offset + 9u];
  var color = vec3<f32>(0.15, 0.88, 0.78);
  if (lod == 1u) { color = vec3<f32>(1.0, 0.68, 0.25); }
  if (lod >= 2u) { color = vec3<f32>(0.95, 0.37, 0.29); }
  if (far) { color = vec3<f32>(0.88, 0.94, 0.98); }
  return vec4<f32>(color, alpha);
}

fn waterWaveDepthAttenuation(depthM: f32, depthMaskM: f32) -> f32 {
  if (depthMaskM <= 0.0) { return 1.0; }
  return 1.0 - exp(-max(depthM, 0.0) / (depthMaskM * 0.5));
}

fn waterWaveSinCos(tileOffsetXZ: vec2<f32>, tileLengthM: f32, edgeBlendWidthM: f32, wave: WaterGerstnerWave, timeSeconds: f32) -> vec2<f32> {
  let direction = wave.directionAmplitude.xy;
  let k = wave.steepnessKOmegaGpuQ.y;
  let omega = wave.steepnessKOmegaGpuQ.z;
  let phase = dot(tileOffsetXZ, direction) * k - omega * timeSeconds;
  var result = vec2<f32>(sin(phase), cos(phase));
  let tileBorderDist = vec2<f32>(tileLengthM * 0.5) - abs(tileOffsetXZ);
  if (any(tileBorderDist < vec2<f32>(edgeBlendWidthM))) {
    let blendAlpha = clamp(tileBorderDist.x / edgeBlendWidthM, 0.0, 1.0) * clamp(tileBorderDist.y / edgeBlendWidthM, 0.0, 1.0);
    let blendPhase = dot(tileBorderDist, direction) * k - omega * timeSeconds;
    let blended = vec2<f32>(sin(blendPhase), cos(blendPhase));
    result = mix(blended, result, blendAlpha);
  }
  return result;
}

fn waterInfoFilteredSampleAt(worldXZ: vec2<f32>, vertexHeightMapping: bool) -> vec4<f32> {
  let dimensions = max(waterInfoDescriptor.sliceAndSize.yz, vec2<u32>(1u));
  let center = waterInfoDescriptor.centerAndExtent.xy;
  let extent = max(waterInfoDescriptor.centerAndExtent.zw, vec2<f32>(0.000001));
  let uv = clamp((worldXZ - center) / extent + vec2<f32>(0.5), vec2<f32>(0.0), vec2<f32>(1.0));
  let texelPosition = uv * vec2<f32>(dimensions) - vec2<f32>(0.5);
  let low = vec2<i32>(floor(texelPosition));
  let high = low + vec2<i32>(1);
  let fraction = fract(texelPosition);
  let maximum = vec2<i32>(dimensions) - vec2<i32>(1);
  let slice = i32(waterInfoDescriptor.sliceAndSize.x);
  let p00 = textureLoad(waterInfoTexture, clamp(low, vec2<i32>(0), maximum), slice, 0);
  let p10 = textureLoad(waterInfoTexture, clamp(vec2<i32>(high.x, low.y), vec2<i32>(0), maximum), slice, 0);
  let p01 = textureLoad(waterInfoTexture, clamp(vec2<i32>(low.x, high.y), vec2<i32>(0), maximum), slice, 0);
  let p11 = textureLoad(waterInfoTexture, clamp(high, vec2<i32>(0), maximum), slice, 0);
  let bilinear = mix(mix(p00, p10, fraction.x), mix(p01, p11, fraction.x), fraction.y);
  if (!vertexHeightMapping) { return bilinear; }
  // The vertex mapping extension excludes empty B texels to retain shore height.
  let weights = vec4<f32>((1.0 - fraction.x) * (1.0 - fraction.y), fraction.x * (1.0 - fraction.y), (1.0 - fraction.x) * fraction.y, fraction.x * fraction.y);
  let validWeights = weights * vec4<f32>(select(0.0, 1.0, p00.z > 0.0), select(0.0, 1.0, p10.z > 0.0), select(0.0, 1.0, p01.z > 0.0), select(0.0, 1.0, p11.z > 0.0));
  let weightSum = dot(validWeights, vec4<f32>(1.0));
  var encodedHeight = 0.0;
  if (weightSum > 0.0) { encodedHeight = dot(validWeights, vec4<f32>(p00.z, p10.z, p01.z, p11.z)) / weightSum; }
  return vec4<f32>(bilinear.xy, encodedHeight, bilinear.w);
}

fn waterInfoSampleAt(worldXZ: vec2<f32>) -> vec4<f32> {
  return waterInfoFilteredSampleAt(worldXZ, false);
}

fn waterInfoHeightDepth(worldXZ: vec2<f32>) -> vec3<f32> {
  let info = waterInfoSampleAt(worldXZ);
  let groundYM = mix(waterInfoDescriptor.heightRange.z, waterInfoDescriptor.heightRange.y, clamp(info.w, 0.0, 1.0));
  let waterYM = select(groundYM - 2.56, mix(waterInfoDescriptor.heightRange.x, waterInfoDescriptor.heightRange.y, clamp(info.z, 0.0, 1.0)), info.z > 0.0);
  return vec3<f32>(waterYM, max(waterYM - groundYM, 0.0), select(0.0, 1.0, info.z > 0.0));
}

fn waterBakedSample(bodyIndex: u32, worldXZ: vec2<f32>) -> WaterBakedSample {
  let descriptor = waterBakedDescriptors[bodyIndex];
  let dimensions = descriptor.dimensionsOffsetValid.xy;
  if (descriptor.dimensionsOffsetValid.w == 0u || any(dimensions < vec2<u32>(3u)) || any(descriptor.originSpacing.zw <= vec2<f32>(0.0))) {
    return WaterBakedSample(vec4<f32>(0.0), false);
  }
  let coordinate = (worldXZ - descriptor.originSpacing.xy) / descriptor.originSpacing.zw;
  let maximum = vec2<f32>(dimensions - vec2<u32>(1u));
  if (any(coordinate <= vec2<f32>(0.0)) || any(coordinate >= maximum)) {
    return WaterBakedSample(vec4<f32>(descriptor.heightOrigin.x, 0.0, 0.0, 0.0), true);
  }
  let low = vec2<u32>(floor(coordinate));
  let high = min(low + vec2<u32>(1u), dimensions - vec2<u32>(1u));
  let fraction = coordinate - vec2<f32>(low);
  let offset = descriptor.dimensionsOffsetValid.z;
  let width = dimensions.x;
  let a = waterBakedSamples[offset + low.y * width + low.x];
  let b = waterBakedSamples[offset + low.y * width + high.x];
  let c = waterBakedSamples[offset + high.y * width + low.x];
  let d = waterBakedSamples[offset + high.y * width + high.x];
  let row0 = mix(a, b, fraction.x);
  let row1 = mix(c, d, fraction.x);
  let sample = mix(row0, row1, fraction.y);
  return WaterBakedSample(vec4<f32>(descriptor.heightOrigin.x + sample.x, sample.yzw), true);
}

fn waterBakedHeightDepth(bodyIndex: u32, worldXZ: vec2<f32>) -> vec3<f32> {
  let sample = waterBakedSample(bodyIndex, worldXZ);
  return vec3<f32>(sample.heightDepthVelocity.xy, select(0.0, 1.0, sample.valid));
}

fn waterBodyVelocity(bodyIndex: u32, worldXZ: vec2<f32>, vertexFlowMPerSec: vec2<f32>) -> vec2<f32> {
  let body = waterBodyData[bodyIndex];
#if WATER_USE_FIXED_VELOCITY == true
  return body.fixedHeightDepthVelocity.zw;
#else
#if WATER_USE_BAKED_SIMULATION == true
  return waterBakedSample(bodyIndex, worldXZ).heightDepthVelocity.zw;
#else
#if WATER_USE_INFO == true
  if (((body.modeZoneSlice.x >> 1u) & 3u) == 1u) {
    return waterInfoSampleAt(worldXZ).xy * 20.48 - vec2<f32>(10.24);
  }
#endif
  return vertexFlowMPerSec;
#endif
#endif
}

fn waterBodyHeightDepth(bodyIndex: u32, worldXZ: vec2<f32>, bakedHeightDepthAndValidityM: vec3<f32>) -> vec3<f32> {
  let body = waterBodyData[bodyIndex];
  let sourceMode = (body.modeZoneSlice.x >> 1u) & 3u;
  var sample = vec3<f32>(body.fixedHeightDepthVelocity.xy, 1.0);
#if WATER_USE_BAKED_SIMULATION == true
#if WATER_BAKED_HEIGHT_DEPTH_AVAILABLE == true
  sample = waterBakedHeightDepth(bodyIndex, worldXZ);
#endif
#else
#if WATER_USE_INFO == true
  if (sourceMode == 1u) { sample = waterInfoHeightDepth(worldXZ); }
#endif
#endif
#if WATER_USE_FIXED_HEIGHT == true
  sample.x = body.fixedHeightDepthVelocity.x;
  sample.z = 1.0;
#endif
#if WATER_USE_FIXED_DEPTH == true
  sample.y = body.fixedHeightDepthVelocity.y;
#endif
  return sample;
}

fn waterHeightMappingVS(bodyIndex: u32, worldPositionM: vec3<f32>, bakedHeightDepthAndValidityM: vec3<f32>) -> WaterHeightMappingResult {
  let body = waterBodyData[bodyIndex];
  var sample = waterBodyHeightDepth(bodyIndex, worldPositionM.xz, bakedHeightDepthAndValidityM);
#if WATER_USE_INFO == true
#if WATER_USE_BAKED_SIMULATION == false
#if WATER_USE_FIXED_HEIGHT == false
  if (((body.modeZoneSlice.x >> 1u) & 3u) == 1u) {
    let encodedHeight = waterInfoFilteredSampleAt(worldPositionM.xz, true).z;
    sample.x = mix(waterInfoDescriptor.heightRange.x, waterInfoDescriptor.heightRange.y, clamp(encodedHeight, 0.0, 1.0));
    sample.z = select(0.0, 1.0, encodedHeight > 0.0);
  }
#endif
#endif
#endif
  let delta = select(0.0, sample.x - worldPositionM.y, sample.z > 0.5 && (body.waveRange.w & 2u) == 0u);
  let deltaWpoM = vec3<f32>(0.0, delta, 0.0);
  return WaterHeightMappingResult(worldPositionM + deltaWpoM, deltaWpoM);
}

fn waterWaveDepthAt(bodyIndex: u32, worldXZ: vec2<f32>, bakedHeightDepthAndValidityM: vec3<f32>) -> vec2<f32> {
  let sample = waterBodyHeightDepth(bodyIndex, worldXZ, bakedHeightDepthAndValidityM);
  return vec2<f32>(sample.y, sample.z);
}

fn waterWrappedPhase(bodyIndex: u32, phaseXZ: vec2<f32>) -> vec2<f32> {
  let body = waterBodyData[bodyIndex];
  let tileLength = max(body.tileMeta.x, 0.000001);
  return phaseXZ - floor((phaseXZ + vec2<f32>(tileLength * 0.5)) / tileLength) * tileLength;
}

fn waterBodyTileOffset(bodyIndex: u32, bodyRelativeXZ: vec2<f32>) -> vec2<f32> {
  return waterWrappedPhase(bodyIndex, bodyRelativeXZ + waterBodyData[bodyIndex].tileLowXZ.xy);
}

fn waterBodyPhaseAtWorldPosition(bodyIndex: u32, worldXZ: vec2<f32>) -> vec2<f32> {
  let body = waterBodyData[bodyIndex];
  let bodyRelativeXZ = (worldXZ - body.tileHighXZ.xy) - body.tileLowXZ.xy;
  return waterBodyTileOffset(bodyIndex, bodyRelativeXZ);
}

fn evaluateWaterWavesForward(bodyIndex: u32, tileOffsetXZ: vec2<f32>, depthM: f32, timeSeconds: f32) -> WaterWaveResult {
  let body = waterBodyData[bodyIndex];
  let attenuation = waterWaveDepthAttenuation(depthM, body.timeAndMask.z);
  return evaluateWaterWavesAtAttenuation(bodyIndex, tileOffsetXZ, attenuation, timeSeconds);
}

fn evaluateWaterWavesAtAttenuation(bodyIndex: u32, tileOffsetXZ: vec2<f32>, attenuation: f32, timeSeconds: f32) -> WaterWaveResult {
  let body = waterBodyData[bodyIndex];
  var displacement = vec3<f32>(0.0);
  var velocity = vec3<f32>(0.0);
  var waveNormal = vec3<f32>(0.0);
  var horizontalGradient = vec3<f32>(0.0);
  for (var waveIndex = body.waveRange.x; waveIndex < body.waveRange.x + body.waveRange.y; waveIndex += 1u) {
    let wave = waterGerstnerWaves[waveIndex];
    let direction = wave.directionAmplitude.xy;
    let amplitude = wave.directionAmplitude.z * attenuation;
    let trig = waterWaveSinCos(tileOffsetXZ, body.tileMeta.x, body.tileMeta.y, wave, timeSeconds);
    let sine = trig.x;
    let cosine = trig.y;
    let gpuQ = wave.steepnessKOmegaGpuQ.w;
    let k = wave.steepnessKOmegaGpuQ.y;
    let omega = wave.steepnessKOmegaGpuQ.z;
    let horizontal = -gpuQ * amplitude * sine;
    displacement += vec3<f32>(direction.x * horizontal, amplitude * cosine, direction.y * horizontal);
    velocity += vec3<f32>(direction.x * gpuQ * amplitude * omega * cosine, amplitude * omega * sine, direction.y * gpuQ * amplitude * omega * cosine);
    let wka = amplitude * k;
    horizontalGradient += gpuQ * wka * cosine * vec3<f32>(direction.x * direction.x, direction.x * direction.y, direction.y * direction.y);
    let solveNormalZ = cosine * wave.steepnessKOmegaGpuQ.x * clamp((wave.directionAmplitude.z * 50.0) / max(wave.directionAmplitude.w, 0.000001), 0.0, 1.0);
    waveNormal += vec3<f32>(sine * wka * direction.x, solveNormalZ, sine * wka * direction.y);
  }
  let normal = normalize(vec3<f32>(waveNormal.x, 1.0 - waveNormal.y, waveNormal.z));
  // 1 - the minimum eigenvalue of the horizontal Gerstner Jacobian.
  let compression = max(0.0, 0.5 * (horizontalGradient.x + horizontalGradient.z
    + length(vec2<f32>(horizontalGradient.x - horizontalGradient.z, 2.0 * horizontalGradient.y))));
  return WaterWaveResult(displacement, normal, velocity, compression);
}

fn evaluateWaterWaveTemporalVelocity(bodyIndex: u32, tileOffsetXZ: vec2<f32>, depthM: f32) -> vec3<f32> {
  let body = waterBodyData[bodyIndex];
  let now = evaluateWaterWavesForward(bodyIndex, tileOffsetXZ, depthM, body.timeAndMask.x);
  let previous = evaluateWaterWavesForward(bodyIndex, tileOffsetXZ, depthM, body.timeAndMask.y);
  let delta = body.timeAndMask.x - body.timeAndMask.y;
  if (abs(delta) <= 0.000001) { return now.velocity; }
  return (now.displacement - previous.displacement) / delta;
}

fn applyWaterWavesToVertexWithHeightSample(bodyIndex: u32, currentWorld: vec3<f32>, previousWorld: vec3<f32>, tileOffsetXZ: vec2<f32>, bakedHeightDepthAndValidityM: vec3<f32>) -> WaterWaveVertexState {
  let body = waterBodyData[bodyIndex];
  let currentMapped = waterHeightMappingVS(bodyIndex, currentWorld, bakedHeightDepthAndValidityM);
  let previousMapped = waterHeightMappingVS(bodyIndex, previousWorld, bakedHeightDepthAndValidityM);
  let currentDepth = waterWaveDepthAt(bodyIndex, currentWorld.xz, bakedHeightDepthAndValidityM);
  let depth = select(0.0, currentDepth.x, currentDepth.y > 0.5);
  let current = evaluateWaterWavesForward(bodyIndex, tileOffsetXZ, depth, body.timeAndMask.x);
  let previous = evaluateWaterWavesForward(bodyIndex, tileOffsetXZ, depth, body.timeAndMask.y);
  let delta = body.timeAndMask.x - body.timeAndMask.y;
  var velocity = current.velocity;
  if (abs(delta) > 0.000001) { velocity = ((currentMapped.worldPositionM + current.displacement) - (previousMapped.worldPositionM + previous.displacement)) / delta; }
  return WaterWaveVertexState(currentMapped.worldPositionM + current.displacement, previousMapped.worldPositionM + previous.displacement, current.displacement.xz, current.normal, velocity, currentDepth.y > 0.5);
}

fn applyWaterWavesToVertex(bodyIndex: u32, currentWorld: vec3<f32>, previousWorld: vec3<f32>, tileOffsetXZ: vec2<f32>) -> WaterWaveVertexState {
  return applyWaterWavesToVertexWithHeightSample(bodyIndex, currentWorld, previousWorld, tileOffsetXZ, vec3<f32>(0.0));
}
