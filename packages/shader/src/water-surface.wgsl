#define_import_path forgeax_material::water_surface
#import forgeax_material::single_layer_water_surface_v1::{SingleLayerWaterSurfaceInput, SingleLayerWaterSurfaceData}
#import forgeax_material::water_waves::{waterBodyHeightDepth, waterBodyVelocity, waterMaterialDrawData, waterBodyData, waterMeshWaveBodyIndex, waterMeshTileIsFar, waterWaveDepthAt, evaluateWaterWavesForward, waterMeshFarBoundaryWeight}
#import forgeax_pbr::tbn::{decodeTangentSpaceNormalRg}
#import forgeax_material::water_fluid::{waterFluidSample, waterFluidSampleUvWithSampler, waterFluidFoamUv, waterFluidFoamActive, waterFluidSharedFoamActive}
#if WATER_SHALLOW_SIMULATION == true
#import forgeax_material::parameters::{waterShallowMappingTexture}
#import forgeax_material::water_advanced_sampling::{shallowUv, shallowInside, shallowGrid, shallowSurfaceNormal, shallowFoam, shallowRotate, shallowCompositionWeight, shallowComposeNormal, shallowDepthFlowAvailable, shallowResidualHeight}
#endif
#if WATER_OCEAN_PATCH == true
#import forgeax_material::water_advanced_sampling::{oceanPatchSample, oceanPatchAdvectedSample}
#endif
#if WATER_VISUAL_NORMAL_DETAIL == true
#if WATER_SHADOW_PASS == false
#import forgeax_material::parameters::{material, NormalDetailTex}
#endif
#endif
#if WATER_SHADOW_PASS == false
#if WATER_OCEAN_FOAM == true
#if WATER_USE_FOAM == true
#import forgeax_view::common::{view}
#import forgeax_view::atmosphere::{view_distant_sky_light}
#endif
#endif
#endif

fn waterFresnel(normal: vec3<f32>, toCamera: vec3<f32>, exponent: f32) -> f32 {
  return 0.04 + 0.96 * pow(1.0 - clamp(dot(normal, toCamera), 0.0, 1.0), exponent);
}

struct WaterSurfaceWaveSample { normal: vec3<f32>, compression: f32, weight: f32 };

#if WATER_VISUAL_NORMAL_DETAIL == true
#if WATER_SHADOW_PASS == false
fn waterVisualNormalDetailSample(
  positionXZ: vec2<f32>,
  velocityMPerSec: vec2<f32>,
  surfaceNormalWS: vec3<f32>,
  timeSeconds: f32,
) -> vec4<f32> {
  let size = vec2<i32>(textureDimensions(NormalDetailTex));
  let domainM = max(material.BakedWaterSimSize, 0.000001);
  let velocityWS = vec3<f32>(velocityMPerSec.x, 0.0, velocityMPerSec.y);
  let projectedVelocity = velocityWS - dot(velocityWS, surfaceNormalWS) * surfaceNormalWS;
  let uv = fract((positionXZ - projectedVelocity.xz * material.WPOWaveScale * timeSeconds) / domainM);
  let pixel = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let low = vec2<i32>(floor(pixel));
  let fraction = fract(pixel);
  let a = (low % size + size) % size;
  let b = (a + vec2<i32>(1)) % size;
  let top = mix(
    textureLoad(NormalDetailTex, a, 0),
    textureLoad(NormalDetailTex, vec2<i32>(b.x, a.y), 0),
    fraction.x,
  );
  let bottom = mix(
    textureLoad(NormalDetailTex, vec2<i32>(a.x, b.y), 0),
    textureLoad(NormalDetailTex, b, 0),
    fraction.x,
  );
  return mix(top, bottom, fraction.y);
}
#endif
#endif

#if WATER_DEFAULT_DEFORMATION_AVAILABLE == true
fn waterSurfaceWaveSample(input: SingleLayerWaterSurfaceInput, waveWeight: f32) -> WaterSurfaceWaveSample {
  if (waterMeshTileIsFar(input.instanceIndex)) { return WaterSurfaceWaveSample(input.geometricNormalWS, 0.0, 0.0); }
  let bodyIndex = waterMaterialDrawData.bodyIndex;
  let waveBodyIndex = waterMeshWaveBodyIndex(input.instanceIndex);
  // Gerstner Normal and its depth override exclude WPO; the velocity mask does not.
  let depth = waterWaveDepthAt(bodyIndex, input.originalPositionWS.xz, vec3<f32>(0.0));
  let wave = evaluateWaterWavesForward(waveBodyIndex, input.wavePhaseXZ, select(0.0, depth.x, depth.y > 0.5), waterBodyData[waveBodyIndex].timeAndMask.x);
  let boundaryWeight = waterMeshFarBoundaryWeight(input.instanceIndex, bodyIndex, waveBodyIndex, input.originalPositionWS.xz);
  let weight = waveWeight * boundaryWeight;
  return WaterSurfaceWaveSample(mix(vec3<f32>(0.0, 1.0, 0.0), wave.normal, weight), wave.compression, weight);
}
#endif

#if WATER_SHADOW_PASS == false
#if WATER_OCEAN_FOAM == true
#if WATER_USE_FOAM == true
fn waterHeightLerpNoContrast(height: f32, phase: f32) -> f32 {
  return clamp(height - 1.0 + 2.0 * phase, 0.0, 1.0);
}

fn waterPositiveClampedPow(base: f32, exponent: f32) -> f32 {
  if (base <= 2.980233e-8) { return 0.0; }
  return pow(base, exponent);
}

fn waterFoamResponse(simulationFoam: f32, position: vec3<f32>, eraseMask: f32) -> vec2<f32> {
  let uv = position.xz / material.foamTilingM;
  let blend = clamp((simulationFoam - material.foamTextureBlendMinimum) / material.foamTextureBlendWidth, 0.0, 1.0);
  let foamPhase = waterPositiveClampedPow(simulationFoam, material.foamPower) * material.foamBoost * eraseMask;
  let frontNoise = textureSample(waterVolumeNoiseTexture, waterVolumeNoiseTexture_sampler, position.xzy / material.foamFrontScaleM).r;
  let frontHeight = frontNoise * frontNoise + material.foamFrontHeightBias;
  let staticFoam = textureSample(waterFoamTexture, waterFoamTexture_sampler, uv).r;
  let height = mix(staticFoam + material.foamHeightBias, frontHeight, blend);
  let alpha = waterHeightLerpNoContrast(height, foamPhase);
  let opacity = clamp(alpha * (1.0 + 2.0 * material.foamContrast) - material.foamContrast, 0.0, 1.0);
  let scatteringFoam = textureSampleLevel(waterFoamTexture, waterFoamTexture_sampler, uv, material.foamScatteringMip).r;
  let scatteringHeight = mix(scatteringFoam + material.foamHeightBias + material.foamScatterBias, frontHeight, blend);
  return vec2<f32>(opacity, waterHeightLerpNoContrast(scatteringHeight, foamPhase));
}

fn waterFoamCoverageResponse(coverage: f32, position: vec3<f32>, eraseMask: f32) -> vec2<f32> {
  let uv = position.xz / material.foamTilingM;
  let amount = clamp(coverage * eraseMask, 0.0, 1.0);
  let opacity = textureSample(waterFoamTexture, waterFoamTexture_sampler, uv).r;
  let scattering = textureSampleLevel(waterFoamTexture, waterFoamTexture_sampler, uv, material.foamScatteringMip).r;
  return amount * clamp(vec2<f32>(opacity, scattering), vec2<f32>(0.0), vec2<f32>(1.0));
}

fn waterFoamHeightSample(bodyIndex: u32, uv: vec2<f32>) -> f32 {
  var value = textureSample(surfaceFoamSimulationTexture, surfaceFoamSimulationSampler, uv).r;
#if WATER_FLUID_SIMULATION == true
  if (waterFluidSharedFoamActive(bodyIndex)) { value = 0.0; }
  if (waterFluidFoamActive(bodyIndex)) { value = waterFluidSampleUvWithSampler(bodyIndex, uv, 3u, false, true).r; }
#endif
  return value;
}

fn waterFoamHeightNormal(bodyIndex: u32, uv: vec2<f32>) -> vec3<f32> {
  let offset = material.foamNormalUvOffset;
  var base = textureSample(surfaceFoamSimulationTexture, surfaceFoamHeightSampler, uv).r;
  var x = textureSample(surfaceFoamSimulationTexture, surfaceFoamHeightSampler, uv + vec2<f32>(offset, 0.0)).r;
  var y = textureSample(surfaceFoamSimulationTexture, surfaceFoamHeightSampler, uv + vec2<f32>(0.0, offset)).r;
#if WATER_FLUID_SIMULATION == true
  if (waterFluidSharedFoamActive(bodyIndex)) { base = 0.0; x = 0.0; y = 0.0; }
  if (waterFluidFoamActive(bodyIndex)) {
    base = waterFluidSampleUvWithSampler(bodyIndex, uv, 3u, true, true).r;
    x = waterFluidSampleUvWithSampler(bodyIndex, uv + vec2<f32>(offset, 0.0), 3u, true, true).r;
    y = waterFluidSampleUvWithSampler(bodyIndex, uv + vec2<f32>(0.0, offset), 3u, true, true).r;
  }
#endif
  // NormalFromHeightmap returns this cross product without normalization.
  return vec3<f32>((base - x) * material.foamNormalIntensity, (base - y) * material.foamNormalIntensity, 1.0);
}
#endif
#endif
#endif

fn evaluate_surface(input: SingleLayerWaterSurfaceInput) -> SingleLayerWaterSurfaceData {
  let bodyIndex = waterMaterialDrawData.bodyIndex;
  let heightDepth = waterBodyHeightDepth(bodyIndex, input.positionWS.xz, vec3<f32>(0.0));
  var depthM = heightDepth.y;
  var flowMPerSec = waterBodyVelocity(bodyIndex, input.positionWS.xz,
    input.vertexFlowXZ * material.maximumFlowVelocityMPerSec);
#if WATER_FLUID_SIMULATION == true
  let localFluid = waterFluidSample(bodyIndex, input.positionWS.xz, 0u);
  depthM = max(depthM + localFluid.b, 0.0);
#endif
#if WATER_SHALLOW_SIMULATION == true
  let advancedUv = shallowUv(input.positionWS.xz);
  if (shallowInside(advancedUv) && shallowDepthFlowAvailable()) {
    let grid=shallowGrid(advancedUv); let weight=shallowCompositionWeight(advancedUv);
    depthM=mix(depthM,grid.y,weight);
    flowMPerSec=mix(flowMPerSec,shallowRotate(grid.zw,textureLoad(waterShallowMappingTexture,vec2<i32>(1,0),0).x),weight);
  }
#endif
  let toCamera = normalize(input.viewDirectionWS);
  let originalNormal = normalize(input.originalNormalWS);
  let tangent = normalize(input.tangentWS.xyz - originalNormal * dot(originalNormal, input.tangentWS.xyz));
  let bitangent = cross(originalNormal, tangent) * input.tangentWS.w;
  let tangentToWorld = mat3x3<f32>(tangent, bitangent, originalNormal);
  var physicalWave = WaterSurfaceWaveSample(input.geometricNormalWS, 0.0, 0.0);
#if WATER_DEFAULT_DEFORMATION_AVAILABLE == true
#if WATER_ENABLE_WAVES == true
  physicalWave = waterSurfaceWaveSample(input, 1.0);
#else
#if WATER_TRANSITION_AVAILABLE == true
  let waveWeight = 1.0 - clamp(length(flowMPerSec) / material.waveVelocityMaskThresholdMPerSec, 0.0, 1.0);
  physicalWave = waterSurfaceWaveSample(input, waveWeight);
#endif
#endif
#endif
  var geometricNormal = physicalWave.normal;
 #if WATER_SHALLOW_SIMULATION == true
  if(shallowInside(advancedUv)){
    #if WATER_SHALLOW_ADDITIVE == true
    geometricNormal=shallowComposeNormal(advancedUv,0,shallowResidualHeight(shallowGrid(advancedUv).x,0,waterBodyData[bodyIndex].tileMeta.z),geometricNormal);
    #else
    geometricNormal=shallowSurfaceNormal(advancedUv);
    #endif
  }
 #endif
  var tangentNormal = transpose(tangentToWorld) * geometricNormal;
#if WATER_OCEAN_PATCH == true
#if WATER_RIVER == true
  let oceanNormal=oceanPatchAdvectedSample(input.positionWS.xz,flowMPerSec,geometricNormal,input.frameTime).xyz;
  let detailWorldNormal=vec3<f32>(oceanNormal.x*material.oceanPatchNormalStrength,oceanNormal.z,oceanNormal.y*material.oceanPatchNormalStrength);
  let detailTangentNormal=transpose(tangentToWorld)*detailWorldNormal;
  tangentNormal=normalize(vec3<f32>(tangentNormal.xy+detailTangentNormal.xy,tangentNormal.z*detailTangentNormal.z));
#else
  let oceanNormal=oceanPatchSample(input.positionWS.xz).xyz;
  let oceanWorldNormal=normalize(vec3<f32>(oceanNormal.x*material.oceanPatchNormalStrength,oceanNormal.z,oceanNormal.y*material.oceanPatchNormalStrength));
  tangentNormal=transpose(tangentToWorld)*oceanWorldNormal;
#endif
#endif
#if WATER_USE_NORMAL_TEXTURE == true
  // The graph's scale step and its continuous normal blend are independent.
  let farWeight = clamp((input.pixelDepthM - material.normalFarStartM) / material.normalFarRangeM, 0.0, 1.0);
  let scaleM = mix(material.normalTilingM, material.distantNormalTilingM, ceil(farWeight));
  let uv = input.positionWS.xz / scaleM;
  let time = input.frameTime * material.normalSpeed;
  let first = textureSample(waterNormalTexture, waterNormalTexture_sampler, uv + vec2<f32>(0.1) * time).rgb;
  let second = textureSample(waterNormalTexture, waterNormalTexture_sampler,
    (uv + vec2<f32>(0.4181, 0.3548)) / 1.618 + vec2<f32>(-0.1) * time).rgb;
  let third = textureSample(waterNormalTexture, waterNormalTexture_sampler,
    (uv + vec2<f32>(0.864861, 0.148384)) / 1.236094 + vec2<f32>(-0.1, 0.1) * time).rgb;
  let sample = (first + second + third) / 3.0;
  let nearStrength = material.normalStrength * (1.0 - clamp(input.pixelDepthM / material.normalFarStartM, 0.0, 1.0));
  let farStrength = mix(material.normalStrength, material.distantNormalStrength,
    waterFresnel(vec3<f32>(0.0, 1.0, 0.0), toCamera, 9.0));
  let nearNormal = tangentNormal + vec3<f32>((sample.rg - vec2<f32>(0.5)) * nearStrength, 0.0);
  let farNormal = normalize(vec3<f32>(sample.rg - vec2<f32>(0.5), 1.0 / farStrength));
  tangentNormal = mix(nearNormal, farNormal, farWeight);
#endif
#if WATER_RIVER == true
#if WATER_USE_FLOWMAP == true
  let depthResponse = vec2<f32>(1.0) - exp(-material.flowmapDepthDensityPerM *
    vec2<f32>(depthM + material.flowmapDepthBiasM, depthM));
  let flow = flowMPerSec * 100.0 * depthResponse.x * material.flowmapSpeed * material.flowmapFlip.xy * vec2<f32>(-1.0, 1.0);
  let flowWeight = clamp(length(flowMPerSec * depthResponse.y) / material.flowmapDetectionVelocityMPerSec, 0.0, 1.0);
  let riverUv = input.positionWS.xz / material.riverNormalTilingM;
  let riverTime = input.frameTime * 0.5;
  let noiseUv = input.positionWS.xz / material.flowmapTimeModulationSizeM + vec2<f32>(0.02 * riverTime);
  let phaseTime = riverTime + textureSampleLevel(waterNoiseTexture, waterNoiseTexture_sampler, noiseUv, -1.0).r * 0.25;
  let phase = fract(phaseTime);
  let phaseWeight = 1.0 - abs(2.0 * phase - 1.0);
  let firstUv = riverUv + flow * phase;
  let secondUv = fract(riverUv + flow * fract(phaseTime - 0.5)) + vec2<f32>(0.5);
  let dx = dpdx(riverUv) * 1024.0;
  let dy = dpdy(riverUv) * 1024.0;
  let mip = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-16));
  // UE takes the effective sampler type from the upstream Normal texture object.
  let firstNormal = decodeTangentSpaceNormalRg(textureSampleLevel(waterFlowNormalTexture, waterFlowNormalTexture_sampler, firstUv, mip).rg);
  let secondNormal = decodeTangentSpaceNormalRg(textureSampleLevel(waterFlowNormalTexture, waterFlowNormalTexture_sampler, secondUv, mip).rg);
  let riverNormal = mix(secondNormal, firstNormal, phaseWeight);
  let flattened = mix(riverNormal, vec3<f32>(0.0, 0.0, 1.0), material.normalFlatness);
  tangentNormal = mix(tangentNormal, flattened, flowWeight);
#endif
#endif
#if WATER_FLUID_SIMULATION == true
  tangentNormal += vec3<f32>(localFluid.rg * material.fluidNormalStrength, 0.0);
#endif
#if WATER_VISUAL_NORMAL_DETAIL == true
#if WATER_SHADOW_PASS == false
  let visualSample = waterVisualNormalDetailSample(input.positionWS.xz, flowMPerSec, geometricNormal, input.frameTime);
  let baseWorldNormal = normalize(tangentToWorld * tangentNormal);
  let visualWorldNormal = normalize(visualSample.xyz);
  let composedWorldNormal = normalize(baseWorldNormal + visualWorldNormal - vec3<f32>(0.0, 1.0, 0.0));
  tangentNormal = transpose(tangentToWorld) * composedWorldNormal;
#endif
#endif
  let normal = normalize(tangentToWorld * tangentNormal);
  let facedNormal = select(-normal, normal, input.frontFacing);
  var roughness = mix(material.roughness, material.fresnelRoughness, waterFresnel(facedNormal, toCamera, 5.0));
  let facing = select(0.0, 1.0, input.frontFacing);
  let normalDotCamera = dot(facedNormal, toCamera);
  let critical = clamp((material.criticalAngleDot - normalDotCamera) / material.criticalAngleWidth, 0.0, 1.0);
  let undersideOpacity = mix(critical, 0.0, facing);
  let undersideSpecular = mix(material.specular, 1.0, undersideOpacity);
  let refractionBase = mix(material.refractionPixelNormalStrength, material.distantRefractionPixelNormalStrength,
    clamp(input.pixelDepthM / material.refractionDistanceM, 0.0, 1.0));
  let bottomRefraction = mix(1.0, refractionBase, material.refractionBottomAmount);
  let bend = clamp((material.criticalAngleDot - normalDotCamera) / material.criticalAngleBendWidth, 0.0, 1.0);
  let refractionCritical = mix(bottomRefraction, material.lipRefraction, 1.0 - bend);
  let undersideRefraction = mix(refractionCritical, refractionBase, facing);
  // Saturation in WaterOpacityMaskFromDepth is in centimeters, before m^-1 coefficients.
  let depthMask = clamp(2.0 * max(clamp((depthM + material.opacityMaskDepthOffsetM) * 100.0, 0.0, 1.0),
    clamp(material.simulationWaterDepthM * 100.0, 0.0, 1.0)) - 1.0, 0.0, 1.0);
  let mask = depthMask * clamp(material.coefficientMask, 0.0, 1.0);
  let specular = undersideSpecular * mask;
  let specularF0 = min(0.08 * max(specular, 0.0), 0.99);
  let physicalIor = 2.0 / (1.0 - sqrt(specularF0)) - 1.0;
  let refractionPixelNormalStrength = mix(1.0, undersideRefraction, mask);
  var foamOpacity = 0.0;
  var foamScattering = 0.0;
  var foamEmissive = vec3<f32>(0.0);
#if WATER_SHADOW_PASS == false
#if WATER_OCEAN_FOAM == true
#if WATER_USE_FOAM == true
  let attachedPosition = mix(input.positionWS, input.originalPositionWS, material.foamAttachment);
  let legacyFoamUv = attachedPosition.xz / material.foamTilingM;
  var simulationUv = (attachedPosition.xz - material.simulationLocationM.xz) / material.waveCaptureSizeM + vec2<f32>(0.5);
#if WATER_FLUID_SIMULATION == true
  if (waterFluidFoamActive(bodyIndex)) { simulationUv = waterFluidFoamUv(bodyIndex, attachedPosition.xz); }
#endif
  let simulationFoam = waterFoamHeightSample(bodyIndex, simulationUv);
  let fluidPosition = input.originalPositionWS.xz / (material.fluidSimulationSizeM * material.foamFluidEraseScale) + vec2<f32>(0.5);
  let fluidBounds = 1.0 - 2.0 * material.foamEraseNearFluidSize;
  let fluidDistance = max(abs(fluidPosition - vec2<f32>(0.5)) - vec2<f32>(0.5 * fluidBounds), vec2<f32>(0.0));
  let fluidBoxMask = 1.0 - clamp(length(fluidDistance) / material.foamEraseNearFluidSize, 0.0, 1.0);
  let eraseMask = mix(1.0, 1.0 - fluidBoxMask, material.foamMaskNearFluid);
  let legacyResponse = waterFoamResponse(simulationFoam, attachedPosition, eraseMask);
  // This source follows the submitted original-grid waves through their actual WPO.
  let crestCompression = clamp((physicalWave.compression - material.surfaceCrestFoamCompressionMinimum)
    / max(material.surfaceCrestFoamCompressionRange, 0.000001), 0.0, 1.0);
  let crestFoam = crestCompression * physicalWave.weight * material.surfaceCrestFoamAmount;
  // A sky miss is encoded as far by the depth producer. Foreground and back faces cannot emit.
  let depthHit = input.frontFacing && input.sceneDepthWithoutWaterM > input.pixelDepthM && input.sceneDepthWithoutWaterM < view.temporalProjection.y;
  let clearanceM = input.sceneDepthWithoutWaterM - input.pixelDepthM;
  let depthFoam = select(0.0, (1.0 - smoothstep(0.0, max(material.sceneDepthFoamWidthM, 0.000001), clearanceM)) * material.sceneDepthFoamAmount, depthHit);
  let sharedFoamActive = waterFluidSharedFoamActive(bodyIndex);
  let sharedFoamUv = (input.positionWS.xz - material.simulationLocationM.xz) / material.waveCaptureSizeM + vec2<f32>(0.5);
  let sharedFoamInside = sharedFoamActive && all(sharedFoamUv >= vec2<f32>(0.0)) && all(sharedFoamUv <= vec2<f32>(1.0));
  let sharedFoam = select(0.0, textureSample(surfaceFoamSimulationTexture, surfaceFoamSimulationSampler, sharedFoamUv).r * material.contactFoamAmount, sharedFoamInside);
  var worldSource = max(crestFoam, depthFoam);
  var worldActive = sharedFoamActive || material.surfaceCrestFoamAmount > 0.0 || material.sceneDepthFoamAmount > 0.0;
  var residualFoamCoverage = clamp(sharedFoam, 0.0, 1.0);
#if WATER_SHALLOW_SIMULATION == true
#if WATER_SHALLOW_ADDITIVE == true
  let shallowFoamSource=select(0.0,shallowFoam(advancedUv)*shallowCompositionWeight(advancedUv),shallowInside(advancedUv));
  // Residual producers publish bounded coverage, not the legacy height-response input.
  if(shallowDepthFlowAvailable()){worldSource=max(worldSource,shallowFoamSource);}
  else{residualFoamCoverage=max(residualFoamCoverage,clamp(shallowFoamSource,0.0,1.0));}
  worldActive=worldActive||shallowFoamSource>0.0;
#endif
#endif
  let worldHeightResponse = waterFoamResponse(worldSource, input.positionWS, eraseMask);
  let worldCoverageResponse = waterFoamCoverageResponse(residualFoamCoverage, input.positionWS, eraseMask);
  let worldResponse = max(worldHeightResponse,worldCoverageResponse);
  let response = max(legacyResponse, select(vec2<f32>(0.0), worldResponse, worldActive && input.frontFacing));
  let worldResponseSelected = worldActive && input.frontFacing && worldResponse.x >= legacyResponse.x;
  let depthFade = clamp((input.sceneDepthWithoutWaterM - input.pixelDepthM) / material.foamDepthMinimumM, 0.0, 1.0);
  let foamMask = clamp(response.x * depthFade, 0.0, 1.0);
  foamOpacity = 1.0 - (1.0 - foamOpacity) * (1.0 - clamp(foamMask * material.foamAmount, 0.0, 1.0));
  roughness += material.foamRoughness * foamMask;
  var simulationNormal = waterFoamHeightNormal(bodyIndex, simulationUv);
  if (worldResponseSelected) { simulationNormal = vec3<f32>(0.0, 0.0, 1.0); }
  if (worldResponseSelected && sharedFoamInside && sharedFoam >= residualFoamCoverage && worldCoverageResponse.x >= worldHeightResponse.x) {
    let base = textureSampleLevel(surfaceFoamSimulationTexture, surfaceFoamHeightSampler, sharedFoamUv, 0.0).r;
    let x = textureSampleLevel(surfaceFoamSimulationTexture, surfaceFoamHeightSampler, sharedFoamUv + vec2<f32>(material.foamNormalUvOffset, 0.0), 0.0).r;
    let y = textureSampleLevel(surfaceFoamSimulationTexture, surfaceFoamHeightSampler, sharedFoamUv + vec2<f32>(0.0, material.foamNormalUvOffset), 0.0).r;
    simulationNormal = vec3<f32>((base - x) * material.foamNormalIntensity, (base - y) * material.foamNormalIntensity, 1.0);
  }
  let foamUv = select(legacyFoamUv, input.positionWS.xz / material.foamTilingM, worldResponseSelected);
  let staticNormal = decodeTangentSpaceNormalRg(textureSample(waterFoamNormalTexture, waterFoamNormalTexture_sampler, foamUv).rg)
    * material.foamNormalMultiplier;
  let baseNormal = normalize(vec3<f32>(tangentNormal.xy, material.foamNormalZ) * select(-1.0, 1.0, input.frontFacing));
  tangentNormal = mix(tangentNormal, baseNormal + vec3<f32>(simulationNormal.xy + staticNormal.xy, 0.0), foamOpacity);
  foamEmissive = material.foamEmissiveColor * foamOpacity * view_distant_sky_light(view);
  foamScattering = max(foamScattering, response.y);
#endif
#endif
#endif
 #if WATER_SHALLOW_SIMULATION == true
 #if WATER_SHALLOW_ADDITIVE == false
  if(shallowInside(advancedUv)){
    foamOpacity=clamp(shallowFoam(advancedUv),0.0,1.0);
    foamScattering=foamOpacity;
    roughness=mix(roughness,material.foamRoughness,foamOpacity);
  }
 #endif
 #endif
  let absorption = max(material.absorptionPerM, vec3<f32>(0.0)) * facing * mask;
  let scattering = (max(material.scatteringPerM, vec3<f32>(0.0)) + foamScattering * max(material.foamScatteringPerM, vec3<f32>(0.0))) * facing * mask;
  return SingleLayerWaterSurfaceData(normalize(tangentToWorld * tangentNormal), clamp(roughness, 0.0, 1.0), 1.0, foamOpacity,
    absorption, scattering, physicalIor, material.phaseG, max(material.maximumOpticalDistanceM, 0.0),
    refractionPixelNormalStrength, material.refractionDepthBias, material.colorScaleBehindWater,
    material.waterAlbedo / max(material.causticsMaxIntensity, 0.00001), (undersideOpacity + foamOpacity) * mask, foamEmissive);
}
