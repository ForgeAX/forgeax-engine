#define_import_path forgeax_material::water_deformation_input
#import forgeax_material::water_deformation_v1::{WaterDeformationInput, WaterDeformationOutput}
#import forgeax_material::water_waves::{waterBodyData, waterBodyTileOffset, waterBodyPhaseAtWorldPosition, waterMeshTileWords, waterMaterialDrawData, waterMeshFarBoundaryWeight}
#if WATER_VERTEX_FLOW_AVAILABLE == true
#import forgeax_material::parameters::{material}
#endif

fn waterVertexFlowXZ(color: vec4<f32>, localToWorld: mat4x4<f32>) -> vec2<f32> {
  let angle = color.g * 6.28318530718;
  let worldFlow = (localToWorld * vec4<f32>(cos(angle), 0.0, sin(angle), 0.0)).xz;
  return worldFlow / max(length(worldFlow), 0.000001) * clamp(color.r, 0.0, 1.0);
}

fn waterVertexFlowMPerSec(flowXZ: vec2<f32>) -> vec2<f32> {
#if WATER_VERTEX_FLOW_AVAILABLE == true
  return flowXZ * material.maximumFlowVelocityMPerSec;
#else
  return vec2<f32>(0.0);
#endif
}

fn waterDeformationInput(bodyIndex: u32, waveBodyIndex: u32, current: vec3<f32>, previous: vec3<f32>, normal: vec3<f32>, viewOriginM: vec3<f32>, relativeXZ: vec2<f32>, displacementMode: u32, vertexFlowMPerSec: vec2<f32>) -> WaterDeformationInput {
  let body = waterBodyData[bodyIndex];
  let waveBody = waterBodyData[waveBodyIndex];
  var wavePhaseXZ = waterBodyTileOffset(waveBodyIndex, relativeXZ);
  if (waterMeshTileWords[15u] == 0u) {
    wavePhaseXZ = waterBodyPhaseAtWorldPosition(waveBodyIndex, current.xz);
  }
  let selectedViewOriginM = vec3<f32>(waterMaterialDrawData.viewOriginX, waterMaterialDrawData.viewOriginY, waterMaterialDrawData.viewOriginZ);
  return WaterDeformationInput(current, previous, normal, selectedViewOriginM,
    wavePhaseXZ, vertexFlowMPerSec, waveBody.timeAndMask.x, waveBody.timeAndMask.y,
    bodyIndex, waveBodyIndex, body.modeZoneSlice.z, body.modeZoneSlice.w, waveBody.waveRange.x, waveBody.waveRange.y, displacementMode);
}

fn waterMeshFarContinuity(input: WaterDeformationInput, deformation: WaterDeformationOutput, instanceIndex: u32) -> WaterDeformationOutput {
#if WATER_DEFAULT_DEFORMATION_AVAILABLE == true
  let currentWeight = waterMeshFarBoundaryWeight(instanceIndex, input.bodyRenderIndex, input.waveBodyRenderIndex, input.positionM.xz);
  let previousWeight = waterMeshFarBoundaryWeight(instanceIndex, input.bodyRenderIndex, input.waveBodyRenderIndex, input.previousPositionM.xz);
  if (currentWeight == 1.0 && previousWeight == 1.0) { return deformation; }
  let baseHeightM = waterBodyData[input.bodyRenderIndex].tileMeta.z;
  return WaterDeformationOutput(
    mix(vec3<f32>(input.positionM.x, baseHeightM, input.positionM.z), deformation.currentPositionM, currentWeight),
    mix(vec3<f32>(input.previousPositionM.x, baseHeightM, input.previousPositionM.z), deformation.previousPositionM, previousWeight),
    normalize(mix(input.normalYUp, deformation.currentNormalYUp, currentWeight)),
    normalize(mix(input.normalYUp, deformation.previousNormalYUp, previousWeight)), deformation.waterMask, deformation.bodyRenderIndex);
#else
  return deformation;
#endif
}
