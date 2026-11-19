#define_import_path forgeax_material::water_transition_continuity
#import forgeax_material::water_waves::{waterMeshTileWords, waterMeshTileWordOffset, waterMeshTileIsFar, waterMeshWaveBodyIndex, waterBodyData, waterWaveDepthAt, evaluateWaterWavesForward, waterWrappedPhase}
#import forgeax_material::water_deformation_v1::{WaterDeformationInput, WaterDeformationOutput}

fn waterMeshContinuityVertexWeight(instanceIndex: u32, gridXZ: vec2<f32>) -> f32 {
  if (waterMeshTileWords[15u] == 0u || waterMeshTileIsFar(instanceIndex)) { return 0.0; }
  let tile = waterMeshTileWordOffset(instanceIndex);
  let support = waterMeshTileWords[tile + 23u] >> 4u;
  if (support == 0u || waterMeshTileWords[support] != 0x57434e31u) { return 0.0; }
  let n = waterMeshTileWords[tile + 15u];
  let side = n + 1u;
  let point = min(vec2<u32>(round(clamp(gridXZ, vec2<f32>(0.0), vec2<f32>(1.0)) * f32(n))), vec2<u32>(n));
  return bitcast<f32>(waterMeshTileWords[support + 2u + point.y * side + point.x]);
}

fn waterMeshContinuityWeight(instanceIndex: u32, gridXZ: vec2<f32>) -> f32 {
  if (waterMeshTileWords[15u] == 0u || waterMeshTileIsFar(instanceIndex)) { return 0.0; }
  let tile = waterMeshTileWordOffset(instanceIndex);
  let support = waterMeshTileWords[tile + 23u] >> 4u;
  if (support == 0u || waterMeshTileWords[support] != 0x57434e31u) { return 0.0; }
  let n = waterMeshTileWords[tile + 15u];
  let p = clamp(gridXZ * f32(n), vec2<f32>(0.0), vec2<f32>(f32(n)));
  let low = min(vec2<u32>(floor(p)), vec2<u32>(n - 1u));
  let f = p - vec2<f32>(low);
  let a = low.y * (n + 1u) + low.x;
  let b = a + 1u; let c = a + n + 1u; let d = c + 1u;
  let wa = bitcast<f32>(waterMeshTileWords[support + 2u + a]);
  let wb = bitcast<f32>(waterMeshTileWords[support + 2u + b]);
  let wc = bitcast<f32>(waterMeshTileWords[support + 2u + c]);
  let wd = bitcast<f32>(waterMeshTileWords[support + 2u + d]);
  if (f.x + f.y <= 1.0) { return wa * (1.0 - f.x - f.y) + wb * f.x + wc * f.y; }
  return wb * (1.0 - f.y) + wc * (1.0 - f.x) + wd * (f.x + f.y - 1.0);
}

fn waterMeshTransitionContinuity(input: WaterDeformationInput, source: WaterDeformationOutput, instanceIndex: u32, gridXZ: vec2<f32>) -> WaterDeformationOutput {
#if WATER_DEFAULT_DEFORMATION_AVAILABLE == true
#if WATER_HEIGHT_MAPPING_AVAILABLE == true || WATER_ENABLE_WAVES == true || WATER_TRANSITION_AVAILABLE == true
  if (input.displacementMode != 0u) { return source; }
  let weight = waterMeshContinuityVertexWeight(instanceIndex, gridXZ);
  if (weight == 0.0) { return source; }
  let waveBodyIndex = waterMeshWaveBodyIndex(instanceIndex);
  let base = waterBodyData[waveBodyIndex].tileMeta.z;
  let depth = waterWaveDepthAt(input.bodyRenderIndex, input.positionM.xz, vec3<f32>(0.0));
  let now = evaluateWaterWavesForward(waveBodyIndex, input.waveRelativeXZ, select(0.0, depth.x, depth.y > 0.5), input.timeSeconds);
  let oldDepth = waterWaveDepthAt(input.bodyRenderIndex, input.previousPositionM.xz, vec3<f32>(0.0));
  let oldPhase = waterWrappedPhase(waveBodyIndex, input.waveRelativeXZ + input.previousPositionM.xz - input.positionM.xz);
  let old = evaluateWaterWavesForward(waveBodyIndex, oldPhase, select(0.0, oldDepth.x, oldDepth.y > 0.5), input.prevTimeSeconds);
  let currentReference = vec3<f32>(input.positionM.x, base, input.positionM.z) + now.displacement;
  let previousReference = vec3<f32>(input.previousPositionM.x, base, input.previousPositionM.z) + old.displacement;
  return WaterDeformationOutput(mix(source.currentPositionM, currentReference, weight), mix(source.previousPositionM, previousReference, weight),
    normalize(mix(source.currentNormalYUp, now.normal, weight)), normalize(mix(source.previousNormalYUp, old.normal, weight)), source.waterMask, source.bodyRenderIndex);
#else
  return source;
#endif
#else
  return source;
#endif
}
