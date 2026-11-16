#define_import_path forgeax_material::water_deformation_default
#import forgeax_material::water_deformation_v1::{WaterDeformationInput, WaterDeformationOutput}
#import forgeax_material::water_waves::{waterBodyData, waterHeightMappingVS, waterWaveDepthAt, waterBodyVelocity, evaluateWaterWavesForward, waterWrappedPhase}
#if WATER_SHALLOW_SIMULATION == true
#import forgeax_material::water_advanced_sampling::{shallowUv, shallowPreviousUv, shallowInside, shallowGrid, shallowPreviousGrid, shallowSurfaceNormal, shallowPreviousSurfaceNormal, shallowCompositionWeight, shallowComposeNormal, shallowResidualHeight}
#endif
#if WATER_OCEAN_PATCH == true
#import forgeax_material::water_advanced_sampling::{oceanPatchSample, oceanPatchPreviousSample}
#endif
#if WATER_TRANSITION_AVAILABLE == true
#import forgeax_material::parameters::{material}
#endif

fn waterWaveDeformation(input: WaterDeformationInput, current: vec3<f32>, previous: vec3<f32>, currentNormal: vec3<f32>, previousNormal: vec3<f32>, waveWeight: vec2<f32>) -> WaterDeformationOutput {
  let depth = waterWaveDepthAt(input.bodyRenderIndex, input.positionM.xz, vec3<f32>(0.0));
  let currentWave = evaluateWaterWavesForward(input.waveBodyRenderIndex, input.waveRelativeXZ, select(0.0, depth.x, depth.y > 0.5), input.timeSeconds);
  let previousDepth = waterWaveDepthAt(input.bodyRenderIndex, input.previousPositionM.xz, vec3<f32>(0.0));
  let previousPhase = waterWrappedPhase(input.waveBodyRenderIndex, input.waveRelativeXZ + input.previousPositionM.xz - input.positionM.xz);
  let previousWave = evaluateWaterWavesForward(input.waveBodyRenderIndex, previousPhase, select(0.0, previousDepth.x, previousDepth.y > 0.5), input.prevTimeSeconds);
  let up = vec3<f32>(0.0, 1.0, 0.0);
  var currentCombinedNormal=normalize(currentNormal+(currentWave.normal-up)*waveWeight.x);
  var previousCombinedNormal=normalize(previousNormal+(previousWave.normal-up)*waveWeight.y);
#if WATER_SHALLOW_SIMULATION == true
#if WATER_SHALLOW_ADDITIVE == true
  let currentSlope=currentNormal.xz/max(currentNormal.y,0.0001)+currentWave.normal.xz/max(currentWave.normal.y,0.0001)*waveWeight.x;
  let previousSlope=previousNormal.xz/max(previousNormal.y,0.0001)+previousWave.normal.xz/max(previousWave.normal.y,0.0001)*waveWeight.y;
  currentCombinedNormal=normalize(vec3<f32>(currentSlope.x,1.0,currentSlope.y));
  previousCombinedNormal=normalize(vec3<f32>(previousSlope.x,1.0,previousSlope.y));
#endif
#endif
  return WaterDeformationOutput(current + currentWave.displacement * waveWeight.x,
    previous + previousWave.displacement * waveWeight.y,
    currentCombinedNormal,previousCombinedNormal,1.0,input.bodyRenderIndex);
}

#if WATER_TRANSITION_AVAILABLE == true
fn waterTransitionDeformation(input: WaterDeformationInput, current: vec3<f32>, previous: vec3<f32>, currentNormal: vec3<f32>, previousNormal: vec3<f32>, waveWeight: vec2<f32>) -> WaterDeformationOutput {
  let velocity = waterBodyVelocity(input.bodyRenderIndex, input.positionM.xz, input.vertexFlowMPerSec);
  let previousVelocity = waterBodyVelocity(input.bodyRenderIndex, input.previousPositionM.xz, input.vertexFlowMPerSec);
  let velocityMask = clamp(vec2<f32>(length(velocity), length(previousVelocity)) / material.waveVelocityMaskThresholdMPerSec, vec2<f32>(0.0), vec2<f32>(1.0));
  return waterWaveDeformation(input, current, previous, currentNormal, previousNormal, waveWeight * (vec2<f32>(1.0) - velocityMask));
}
#endif

fn deform_water_vertex(input: WaterDeformationInput) -> WaterDeformationOutput {
  if (input.displacementMode != 0u) {
    return WaterDeformationOutput(input.positionM, input.previousPositionM, input.normalYUp, input.normalYUp, 1.0, input.bodyRenderIndex);
  }
  var current = input.positionM;
  var previous = input.previousPositionM;
  var currentNormal = input.normalYUp;
  var previousNormal = input.normalYUp;
  var waveWeight = vec2<f32>(1.0);
#if WATER_HEIGHT_MAPPING_AVAILABLE == true
  current = waterHeightMappingVS(input.bodyRenderIndex, current, vec3<f32>(0.0)).worldPositionM;
  previous = waterHeightMappingVS(input.bodyRenderIndex, previous, vec3<f32>(0.0)).worldPositionM;
#endif
  #if WATER_SHALLOW_SIMULATION == true
  #if WATER_SHALLOW_ADDITIVE == false
  let shallowCurrentUv=shallowUv(current.xz);
  if(shallowInside(shallowCurrentUv)){
    current.y=shallowGrid(shallowCurrentUv).x;
    currentNormal=shallowSurfaceNormal(shallowCurrentUv);
    waveWeight.x=0.0;
  }
  let previousUv=shallowPreviousUv(previous.xz);
  if(shallowInside(previousUv)){
    previous.y=shallowPreviousGrid(previousUv).x;
    previousNormal=shallowPreviousSurfaceNormal(previousUv);
    waveWeight.y=0.0;
  }
  #endif
  #endif
  #if WATER_OCEAN_PATCH == true
  #if WATER_OCEAN_DISPLACEMENT == true
  let oceanCurrent=oceanPatchSample(current.xz);
  let oceanPrevious=oceanPatchPreviousSample(previous.xz);
  current.y+=oceanCurrent.a*waveWeight.x;
  previous.y+=oceanPrevious.a*waveWeight.y;
  currentNormal=normalize(mix(currentNormal,oceanCurrent.xzy,waveWeight.x));
  previousNormal=normalize(mix(previousNormal,oceanPrevious.xzy,waveWeight.y));
  #endif
  #endif
  var deformation=WaterDeformationOutput(current,previous,currentNormal,previousNormal,1.0,input.bodyRenderIndex);
#if WATER_ENABLE_WAVES == true
  deformation=waterWaveDeformation(input, current, previous, currentNormal, previousNormal, waveWeight);
#else
#if WATER_TRANSITION_AVAILABLE == true
  deformation=waterTransitionDeformation(input, current, previous, currentNormal, previousNormal, waveWeight);
#endif
#endif
#if WATER_SHALLOW_SIMULATION == true
#if WATER_SHALLOW_ADDITIVE == true
  // Local fields use the same post-horizontal-displacement world position as the Surface.
  let currentUv=shallowUv(deformation.currentPositionM.xz);
  if(shallowInside(currentUv)){
    let residual=shallowResidualHeight(shallowGrid(currentUv).x,0,waterBodyData[input.bodyRenderIndex].tileMeta.z);
    deformation.currentPositionM.y+=residual*shallowCompositionWeight(currentUv);
    deformation.currentNormalYUp=shallowComposeNormal(currentUv,0,residual,deformation.currentNormalYUp);
  }
  let previousUv=shallowPreviousUv(deformation.previousPositionM.xz);
  if(shallowInside(previousUv)){
    let residual=shallowResidualHeight(shallowPreviousGrid(previousUv).x,1,waterBodyData[input.bodyRenderIndex].tileMeta.z);
    deformation.previousPositionM.y+=residual*shallowCompositionWeight(previousUv);
    deformation.previousNormalYUp=shallowComposeNormal(previousUv,1,residual,deformation.previousNormalYUp);
  }
#endif
#endif
  return deformation;
}
