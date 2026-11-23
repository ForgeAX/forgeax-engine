#define_import_path forgeax::single-layer-water
#import forgeax_view::common::{forwardScreenSurface}
#import forgeax_cloud::layer::{viewLinearSampler}

#import forgeax_ssr::forward::{forwardSsrWater}
#import forgeax_pbr::sky_sh_polynomial::{SkyShPolynomial}
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
#import forgeax_material::water_transition_continuity::{waterMeshTransitionContinuity}
#endif
#pragma material_slot surface
#pragma material_slot deformation
#import forgeax_material::slot::surface::{evaluate_surface}
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
#import forgeax_material::slot::deformation::{deform_water_vertex}
#import forgeax_material::water_deformation_input::{waterDeformationInput, waterVertexFlowMPerSec}
#endif
#import forgeax_material::water_fluid::{waterFluidSample}
#import forgeax_material::water_deformation_input::{waterVertexFlowXZ}
#import forgeax_material::single_layer_water_surface_v1::{SingleLayerWaterSurfaceInput, SingleLayerWaterSurfaceData}
#import forgeax_material::water_waves::{waterMeshTileVertex, waterMeshCoverageContains, waterDynamicBoundsContains, waterBodyData, waterMaterialDrawData, waterMeshWavePhaseAt, waterMeshInstanceTransformIndex}
#import forgeax_view::common::{view, transformNormal, meshReceivesShadows}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw}
#import forgeax_material::parameters::{MATERIAL_SCENE_ROW_VEC4_COUNT}
#else
#import forgeax_view::common::{meshes, instances}
#endif
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness}
#import forgeax_scene_temporal::{packSceneTemporalV1, sceneViewZ}
#import forgeax_clipping::planes::{applyViewClipping}
#import forgeax_shadow::surface::{projectShadowPosition}
#if WATER_SHADOW_PASS == false
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel}
#import forgeax_pbr::standard_lighting::{SkylightUniforms, sampleSkylightDiffuse, sampleStandardReflectionRadiance, evaluateStandardDirect}
#import forgeax_pbr::brdf::{standardDielectricF0}
#import forgeax_view::atmosphere::{view_apply_ground_direct_solar}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{sampleStandardAmbientOcclusion}
#endif
#endif

struct WaterVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(13) color: vec4<f32>,
#endif
};
struct WaterVertexOutput {
  @builtin(position) clip: vec4<f32>,
  @location(0) positionOS: vec3<f32>,
  @location(1) positionWS: vec3<f32>,
  @location(2) normalWS: vec3<f32>,
  @location(3) uv: vec2<f32>,
  @location(4) currentClip: vec4<f32>,
  @location(5) previousClip: vec4<f32>,
  @location(6) coverageXZ: vec2<f32>,
  @location(7) @interpolate(flat) instanceIndex: u32,
  @location(8) @interpolate(flat) materialIndex: u32,
  @location(9) maskAndVertexFlow: vec3<f32>,
  @location(10) @interpolate(flat) bodyIndex: u32,
  @location(11) tangentWS: vec4<f32>,
  @location(12) originalNormalWS: vec3<f32>,
  @location(13) @interpolate(flat) lighting: vec2<u32>,
  @location(14) originalPositionWS: vec3<f32>,
#ifdef VERTEX_COLOR_AVAILABLE
  @location(15) color: vec4<f32>,
#endif
};
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
struct WaterSceneMaterialRow { payload: array<vec4<f32>, MATERIAL_SCENE_ROW_VEC4_COUNT> };
@group(1) @binding(46) var<storage, read> sceneMaterials: array<WaterSceneMaterialRow>;
@group(3) @binding(2) var<storage, read> visibleItems: array<vec4<u32>>;
#endif

// User textures precede this region. Cook relocates these exact engine names.
#if WATER_SHADOW_PASS == false
@group(1) @binding(1) var<uniform> mediumSkySh: SkyShPolynomial;
@group(1) @binding(2) var mediumIrradianceSampler: sampler;
@group(1) @binding(3) var mediumPrefilterMap: texture_2d<f32>;
@group(1) @binding(4) var mediumPrefilterSampler: sampler;
@group(1) @binding(5) var mediumBrdfLut: texture_2d<f32>;
@group(1) @binding(6) var<uniform> mediumSkylight: SkylightUniforms;
#ifdef EXTENDED_LIGHTING_AVAILABLE
#if WATER_USE_SSR == true
@group(0) @binding(27) var forwardHiZ: texture_2d<f32>;
@group(0) @binding(28) var forwardSsrColor: texture_2d<f32>;
#endif
#endif
@group(1) @binding(7) var surfaceBackdropSampler: sampler;
@group(1) @binding(8) var surfaceBackdropTexture: texture_2d<f32>;
@group(1) @binding(9) var surfaceRawDepthSampler: sampler;
@group(1) @binding(10) var surfaceRawDepthTexture: texture_2d<f32>;
@group(1) @binding(11) var surfaceNearestLayerSampler: sampler;
@group(1) @binding(12) var surfaceNearestLayerTexture: texture_2d<f32>;
@group(1) @binding(13) var surfaceNearestDepthSampler: sampler;
@group(1) @binding(14) var surfaceNearestDepthTexture: texture_2d<f32>;
#if WATER_OCEAN_FOAM == true
#if WATER_USE_FOAM == true
@group(1) @binding(17) var surfaceFoamSimulationSampler: sampler;
@group(1) @binding(18) var surfaceFoamSimulationTexture: texture_2d<f32>;
@group(1) @binding(19) var surfaceFoamHeightSampler: sampler;
#endif
#endif
#endif

fn waterVertex(vertex: WaterVertexInput, index: u32, shadow: bool) -> WaterVertexOutput {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  let visible = visibleItems[index];
  let draw = sceneIndexDraw(visible.x);
  let currentMatrix = draw.world;
  let previousMatrix = draw.previousWorld;
  let materialIndex = visible.y;
  let lighting = vec2<u32>(draw.lightingChannels, select(0u, 1u, draw.receivesShadows));
#else
  let transformIndex = waterMeshInstanceTransformIndex(index);
  let currentMatrix = meshes[0u].worldFromLocal * instances[transformIndex].localFromInstance;
  let previousMatrix = meshes[0u].previousWorldFromLocal * instances[transformIndex].previousLocalFromInstance;
  let materialIndex = 0u;
#if STORAGE_BUFFER_AVAILABLE == true
  let lighting = vec2<u32>(meshes[0u].surface.z, select(0u, 1u, meshReceivesShadows(meshes[0u].temporal.y)));
#else
  let lighting = vec2<u32>(meshes[0u].surface.z, 1u);
#endif
#endif
  let tile = waterMeshTileVertex(vertex.position, index);
  let current = (currentMatrix * vec4<f32>(tile.position, 1.0)).xyz;
  let previous = (previousMatrix * vec4<f32>(tile.position, 1.0)).xyz;
  let normal = normalize(transformNormal(currentMatrix, vertex.normal));
  var color = vec4<f32>(1.0);
#ifdef VERTEX_COLOR_AVAILABLE
  color = vertex.color;
#endif
  let flow = waterVertexFlowXZ(color, currentMatrix);
  var currentPosition = current;
  var previousPosition = previous;
  var currentNormal = normal;
  var waterMask = 1.0;
  var bodyIndex = tile.bodyIndex;
#if MATERIAL_WATER_DEFORMATION_AVAILABLE == true
  let deformationInput = waterDeformationInput(tile.bodyIndex, tile.waveBodyIndex, current, previous, normal,
    view.cameraPos, tile.waveRelativeXZ, select(0u, 1u, tile.far), waterVertexFlowMPerSec(flow));
  var deformation = waterMeshTransitionContinuity(deformationInput, deform_water_vertex(deformationInput), index, vertex.position.xz);
  currentPosition = deformation.currentPositionM;
  previousPosition = deformation.previousPositionM;
  currentNormal = deformation.currentNormalYUp;
  waterMask = deformation.waterMask;
  bodyIndex = deformation.bodyRenderIndex;
#endif
#if WATER_FLUID_SIMULATION == true
  let fluid = waterFluidSample(bodyIndex, currentPosition.xz, 0u);
  let fluidPrevious = waterFluidSample(bodyIndex, previousPosition.xz, 4u);
  let fluidScale = material.fluidDisplacementMultiplier * material.showFluidSimulation;
  currentPosition.y += clamp(fluid.b * fluidScale, -material.maximumFluidDisplacementM, material.maximumFluidDisplacementM);
  previousPosition.y += clamp(fluidPrevious.b * fluidScale, -material.maximumFluidDisplacementM, material.maximumFluidDisplacementM);
#endif
  var output: WaterVertexOutput;
  output.clip = view.worldViewProj * vec4<f32>(currentPosition, 1.0);
  if (shadow) { output.clip = projectShadowPosition(vec4<f32>(currentPosition, 1.0), currentNormal); }
  output.positionOS = vertex.position;
  output.positionWS = currentPosition;
  output.normalWS = currentNormal;
  output.originalNormalWS = normal;
  output.originalPositionWS = current;
  output.uv = vertex.uv;
  output.currentClip = view.temporalCurrentViewProj * vec4<f32>(currentPosition, 1.0);
  output.previousClip = view.temporalPreviousViewProj * vec4<f32>(previousPosition, 1.0);
  output.coverageXZ = tile.coverageXZ;
  output.instanceIndex = index;
  output.materialIndex = materialIndex;
#ifdef VERTEX_COLOR_AVAILABLE
  output.color = color;
#endif
  output.maskAndVertexFlow = vec3<f32>(waterMask, flow);
  output.bodyIndex = bodyIndex;
  output.tangentWS = vec4<f32>(normalize((currentMatrix * vec4<f32>(vertex.tangent.xyz, 0.0)).xyz), vertex.tangent.w);
  output.lighting = lighting;
  return output;
}
@vertex fn vs_main(vertex: WaterVertexInput, @builtin(instance_index) index: u32) -> WaterVertexOutput {
  return waterVertex(vertex, index, false);
}
@vertex fn vs_scene_index(vertex: WaterVertexInput, @builtin(instance_index) index: u32) -> WaterVertexOutput {
  return waterVertex(vertex, index, false);
}
@vertex fn vs_water_shadow(vertex: WaterVertexInput, @builtin(instance_index) index: u32) -> WaterVertexOutput {
  return waterVertex(vertex, index, true);
}

fn waterSurfaceInput(input: WaterVertexOutput, frontFacing: bool) -> SingleLayerWaterSurfaceInput {
  var surface: SingleLayerWaterSurfaceInput;
  surface.positionOS = input.positionOS;
  surface.positionWS = input.positionWS;
  surface.geometricNormalWS = input.normalWS;
  surface.tangentWS = input.tangentWS;
  surface.viewDirectionWS = view.cameraPos - input.positionWS;
  surface.uv0 = input.uv;
  surface.uv1 = vec2<f32>(0.0); surface.uv2 = vec2<f32>(0.0); surface.uv3 = vec2<f32>(0.0);
  surface.uv4 = vec2<f32>(0.0); surface.uv5 = vec2<f32>(0.0); surface.uv6 = vec2<f32>(0.0); surface.uv7 = vec2<f32>(0.0);
  surface.vertexColor = vec4<f32>(1.0);
#ifdef VERTEX_COLOR_AVAILABLE
  surface.vertexColor = input.color;
#endif
  surface.vertexFlowXZ = input.maskAndVertexFlow.yz;
  surface.frontFacing = frontFacing;
  surface.frameTime = waterBodyData[input.bodyIndex].timeAndMask.x;
  surface.instanceIndex = input.instanceIndex;
  surface.eventRangeStart = 0u; surface.eventRangeCount = 0u;
  surface.pixelDepthM = max(0.0, -sceneViewZ(input.currentClip, view.temporalProjection));
  surface.originalNormalWS = input.originalNormalWS;
  surface.originalPositionWS = input.originalPositionWS;
  surface.wavePhaseXZ = waterMeshWavePhaseAt(input.instanceIndex, input.coverageXZ, input.originalPositionWS.xz);
#if WATER_SHADOW_PASS == false
  let sceneSize = vec2<f32>(textureDimensions(surfaceRawDepthTexture));
  let sceneUv = input.clip.xy / sceneSize;
  let sceneRawDepth = textureLoad(surfaceRawDepthTexture, vec2<i32>(input.clip.xy), 0).r;
  surface.sceneDepthWithoutWaterM = select(view.temporalProjection.y,
    waterViewDepth(sceneUv, sceneRawDepth), sceneRawDepth > 0.0);
#else
  surface.sceneDepthWithoutWaterM = surface.pixelDepthM;
#endif
  return surface;
}
fn waterCoverage(input: WaterVertexOutput, surface: SingleLayerWaterSurfaceData) -> bool {
  applyViewClipping(input.positionWS, false);
  return waterDynamicBoundsContains(input.bodyIndex, input.positionWS)
    && !(input.maskAndVertexFlow.x <= 0.0) && !(surface.coverage <= 0.0)
    && waterMeshCoverageContains(input.instanceIndex, input.coverageXZ);
}

struct WaterPrepassOutput {
  @location(0) normalRoughness: vec4<u32>,
  @location(1) coverage: vec4<f32>,
  @location(2) temporal: vec4<f32>,
};
@fragment fn fs_water_prepass(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> WaterPrepassOutput {
  let surfaceInput = waterSurfaceInput(input, frontFacing);
  let surface = evaluate_surface(surfaceInput);
  if (!waterCoverage(input, surface)) { discard; }
  let normal = select(-surface.normalWS, surface.normalWS, frontFacing);
  let coverage = clamp(surface.coverage * input.maskAndVertexFlow.x, 0.0, 1.0);
  var ssrCoverage = 0.0;
#if WATER_USE_REFLECTIONS == true
#if WATER_USE_SSR == true
  ssrCoverage = coverage;
#endif
#endif
  return WaterPrepassOutput(vec4<u32>(encodeStandardNormalRoughness(normal, surface.roughness), 0u, 0u, 0u),
    vec4<f32>(ssrCoverage, 0.0, 0.0, coverage),
    packSceneTemporalV1(input.currentClip, input.previousClip, view.temporalProjection, 0.0));
}
struct WaterVisibilityOutput {
  @location(0) coverage: vec4<f32>,
  @location(1) temporal: vec4<f32>,
};
@fragment fn fs_water_visibility(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> WaterVisibilityOutput {
  let surface = evaluate_surface(waterSurfaceInput(input, frontFacing));
  if (!waterCoverage(input, surface)) { discard; }
  let coverage = clamp(surface.coverage * input.maskAndVertexFlow.x, 0.0, 1.0);
  return WaterVisibilityOutput(vec4<f32>(0.0, 0.0, 0.0, coverage),
    packSceneTemporalV1(input.currentClip, input.previousClip, view.temporalProjection, 0.0));
}
@fragment fn fs_water_velocity(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let surfaceInput = waterSurfaceInput(input, frontFacing);
  let surface = evaluate_surface(surfaceInput);
  if (!waterCoverage(input, surface)) { discard; }
  return packSceneTemporalV1(input.currentClip, input.previousClip, view.temporalProjection, 0.0);
}
@fragment fn fs_water_shadow(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) {
  let surfaceInput = waterSurfaceInput(input, frontFacing);
  let surface = evaluate_surface(surfaceInput);
  if (!waterCoverage(input, surface)) { discard; }
}

#if WATER_SHADOW_PASS == false
fn waterWorld(uv: vec2<f32>, rawDepth: f32) -> vec3<f32> {
  let h = view.inverseViewProj * vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), rawDepth, 1.0);
  return h.xyz / h.w;
}
fn waterViewDepth(uv: vec2<f32>, rawDepth: f32) -> f32 {
  let world = waterWorld(uv, rawDepth);
  return -sceneViewZ(view.worldViewProj * vec4<f32>(world, 1.0), view.temporalProjection);
}
fn waterDeviceDepth(depthM: f32) -> f32 {
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  let orthographic = (far - depthM) / (far - near);
  return select(orthographic * near / max(depthM, 1e-30), orthographic, view.temporalProjection.z >= 0.5);
}
struct WaterSceneSample { color: vec3<f32>, depthM: f32, valid: bool };
// Color and depth share one bilateral 2x2 footprint.
fn waterSceneSample(uv: vec2<f32>, surfaceDepthM: f32, depthGradientM: f32) -> WaterSceneSample {
  let size = vec2<i32>(textureDimensions(surfaceRawDepthTexture));
  let linearDepth = textureNumLevels(surfaceRawDepthTexture) > 1u;
  let sampleUv = uv + vec2<f32>(0.5 / 256.0) / vec2<f32>(size);
  let position = sampleUv * vec2<f32>(size) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(position));
  let fraction = fract(position);
  var total = 0.0; var color = vec3<f32>(0.0); var depth = 0.0;
  for (var y = 0; y < 2; y++) { for (var x = 0; x < 2; x++) {
    let pixel = first + vec2<i32>(x, y);
    if (any(pixel < vec2<i32>(0)) || any(pixel >= size)) { continue; }
    let raw = textureLoad(surfaceRawDepthTexture, pixel, 0).r;
    let tapUv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(size);
    var depthM = view.temporalProjection.y;
    if (linearDepth) { depthM = min(raw, depthM); }
    else if (raw > 0.0) { depthM = waterViewDepth(tapUv, raw); }
    if (depthM + depthGradientM < surfaceDepthM) { continue; }
    let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
    total += weight; depth += depthM * weight;
    color += textureLoad(surfaceBackdropTexture, pixel, 0).rgb * weight;
  } }
  return WaterSceneSample(color / max(total, 1e-5), depth / max(total, 1e-5), total > 1e-5);
}
fn waterEnvBrdf(normal: vec3<f32>, toCamera: vec3<f32>, ior: f32, roughness: f32) -> f32 {
  let f = (ior - 1.0) / (ior + 1.0);
  let f0 = f * f;
  let lut = textureSampleLevel(mediumBrdfLut, mediumPrefilterSampler, vec2<f32>(max(dot(normal, toCamera), 0.0), roughness), 0.0).rg;
  return clamp(f0 * lut.x + clamp(50.0 * f0, 0.0, 1.0) * lut.y, 0.0, 1.0);
}
struct WaterColorOutput {
  @location(0) color: vec4<f32>,
  @location(1) captureSky: vec4<f32>,
  @location(2) reflectionWeight: vec4<f32>,
};
fn waterColor(input: WaterVertexOutput, surface: SingleLayerWaterSurfaceData, frontFacing: bool) -> WaterColorOutput {
  let size = vec2<f32>(textureDimensions(surfaceBackdropTexture));
  let uv = input.clip.xy / size;
  let surfaceDepthM = -sceneViewZ(input.currentClip, view.temporalProjection);
  let gradientM = max(abs(dpdx(surfaceDepthM)), abs(dpdy(surfaceDepthM)));
  let original = waterSceneSample(uv, surfaceDepthM, gradientM);
  let normal = normalize(select(-surface.normalWS, surface.normalWS, frontFacing));
  let toCamera = normalize(view.cameraPos - input.positionWS);
  let roughness = clamp(surface.roughness, 0.0, 1.0);
  let ior = max(surface.physicalIor, 1.0);
  var distortedUv = uv;
#if WATER_USE_REFRACTION == true
  // The unjittered rows contain projection scale times the camera basis.
  let rightRow = vec3<f32>(view.temporalCurrentViewProj[0].x, view.temporalCurrentViewProj[1].x, view.temporalCurrentViewProj[2].x);
  let upRow = vec3<f32>(view.temporalCurrentViewProj[0].y, view.temporalCurrentViewProj[1].y, view.temporalCurrentViewProj[2].y);
  let projectionScale = vec2<f32>(length(rightRow), length(upRow));
  let originalNormal = normalize(input.originalNormalWS);
  let normalDelta = originalNormal - normal;
  let viewportOffset = vec2<f32>(dot(normalDelta, normalize(rightRow)), dot(normalDelta, normalize(upRow)))
    * (surface.refractionPixelNormalStrength - 1.0);
  let bufferOffset = viewportOffset * vec2<f32>(view.viewportWidth, view.viewportHeight)
    * vec2<f32>(0.00023, -0.00023) * projectionScale;
  let thicknessM = original.depthM - surfaceDepthM;
  let biasRangeM = clamp(abs(surface.refractionDepthBias) * 0.005, 0.0, 0.50);
  let biasFade = clamp(thicknessM / max(0.01, biasRangeM) - surface.refractionDepthBias, 0.0, 1.0);
  let shallowFade = clamp(thicknessM / 0.30, 0.0, 1.0);
  distortedUv = clamp(uv + 4.0 * bufferOffset * biasFade * shallowFade,
    vec2<f32>(0.55) / size, vec2<f32>(1.0) - vec2<f32>(0.55) / size);
#endif
  let distorted = waterSceneSample(distortedUv, surfaceDepthM, gradientM);
  var behind = original;
  if (distorted.valid) { behind = distorted; }
  // Full-quality SLW BasePass integrates behind the surface on both faces.
  let distanceM = clamp(max(0.0, behind.depthM - surfaceDepthM),
    0.0, max(surface.maxDistanceMeters, 0.0));
  let sigmaS = max(surface.scattering, vec3<f32>(0.0));
  let sigmaT = max(surface.absorption, vec3<f32>(0.0)) + sigmaS;
  let transmittance = exp(-sigmaT * distanceM);
  let integral = clamp(sigmaS * (vec3<f32>(1.0) - transmittance) / max(sigmaT, vec3<f32>(0.001)), vec3<f32>(0.0), vec3<f32>(1.0));
  let g = clamp(surface.phaseG, -1.0, 1.0);
  let k = 1.55 * g - 0.55 * g * g * g;
  let refracted = refract(-toCamera, normal, 1.0 / max(ior, 1e-5));
  let cosine = dot(normalize(-view.lightDir), refracted);
  let phaseDenominator = 1.0 + k * cosine;
  let phase = select(0.0, (1.0 - k * k) / (12.5663706144 * max(phaseDenominator * phaseDenominator, 1e-8)), dot(refracted, refracted) > 0.0);
  let skyDiffuse = sampleSkylightDiffuse(mediumSkylight, normal, mediumSkySh)
    + mediumSkylight.ambientIrradiance.xyz * 0.3183098861837907;
  // Diffuse indirect E/pi combines with the isotropic 1/(4*pi) phase as one quarter.
  let ambient = skyDiffuse * 0.25;
  var shadow = 1.0;
  if (input.lighting.y != 0u) {
    shadow = evalDirectionalShadowFactorAtPixel(normal, input.positionWS, -surfaceDepthM, 0u, input.clip.xy);
  }
  let volumeSun = view_apply_ground_direct_solar(view, view.lightColor * shadow * phase, input.positionWS);
  let scattered = integral * (ambient + volumeSun);
  let envBrdf = waterEnvBrdf(normal, toCamera, ior, roughness);
  let colorScale = mix(vec3<f32>(1.0), max(surface.colorScaleBehindWater, vec3<f32>(0.0)), clamp(distanceM * 2.0, 0.0, 1.0));
  // Reconstruct the averaged view-space bilateral depth at this pixel.
  let behindWorld = waterWorld(uv, waterDeviceDepth(behind.depthM));
  let lightDistanceM = max(0.0, input.positionWS.y - behindWorld.y);
  let lightTransmittance = exp(-sigmaT * lightDistanceM);
  let transmission = transmittance * lightTransmittance * behind.color * colorScale;
  let volume = scattered * (1.0 - envBrdf) + transmission;
  let baseMaterialCoverageOverWater = clamp(surface.opacity, 0.0, 1.0);
  let waterVisibility = 1.0 - baseMaterialCoverageOverWater;
  // Opacity weights surface diffuse; specular retains its own F0.
  let direct = evaluateStandardDirect(input.positionWS, input.currentClip.xyz / input.currentClip.w,
    -surfaceDepthM, input.clip.xy, normal, toCamera,
    max(surface.baseColor, vec3<f32>(0.0)) * baseMaterialCoverageOverWater, vec3<f32>(0.0),
    0.0, max(roughness * roughness, 0.0001), vec3<f32>(standardDielectricF0(ior)), shadow,
    input.lighting.y != 0u, input.lighting.x, false,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    mediumBrdfLut, mediumPrefilterSampler,
#endif
  );
  var surfaceVisibility = 1.0;
#ifdef CLUSTER_FORWARD_AVAILABLE
  surfaceVisibility = sampleStandardAmbientOcclusion(input.positionWS, view.worldViewProj, forwardScreenSurface, viewLinearSampler);
#endif
  let surfaceDiffuse = skyDiffuse * surfaceVisibility * max(surface.baseColor, vec3<f32>(0.0)) * baseMaterialCoverageOverWater;
  let basePassColor = direct.radiance + surfaceDiffuse + volume * waterVisibility + surface.emissive;
  var captureSky = vec3<f32>(0.0);
  var reflectionWeight = 0.0;
#if WATER_USE_REFLECTIONS == true
  // Legacy SLW keeps its dominant direction unnormalized before probe projection.
  let r2 = roughness * roughness;
  let reflectionDirection = mix(normal, reflect(-toCamera, normal), (1.0 - r2) * (sqrt(1.0 - r2) + r2));
  captureSky = sampleStandardReflectionRadiance(mediumSkylight, input.positionWS, reflectionDirection, roughness,
    mediumPrefilterMap, mediumPrefilterSampler);
  let shoreFade = clamp(max(0.0, behind.depthM - surfaceDepthM) * 2.0, 0.0, 1.0);
  reflectionWeight = envBrdf * shoreFade;
#ifdef EXTENDED_LIGHTING_AVAILABLE
#if WATER_USE_SSR == true
  let screenReflection = forwardSsrWater(forwardHiZ, forwardSsrColor, view,
    input.positionWS, normal, toCamera, roughness);
  captureSky = screenReflection.rgb + captureSky * (1.0 - screenReflection.a);
#endif
#endif
#endif
  let coverage = clamp(surface.coverage * input.maskAndVertexFlow.x, 0.0, 1.0);
  return WaterColorOutput(vec4<f32>(max(basePassColor, vec3<f32>(0.0)), coverage), vec4<f32>(captureSky, coverage), vec4<f32>(reflectionWeight, roughness, 0.0, coverage));
}
@fragment fn fs_water_color(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> WaterColorOutput {
  let surfaceInput = waterSurfaceInput(input, frontFacing);
  let surface = evaluate_surface(surfaceInput);
  if (!waterCoverage(input, surface)) { discard; }
  let pixel = vec2<i32>(input.clip.xy);
  let nearest = textureLoad(surfaceNearestDepthTexture, pixel, 0).r;
  if (input.clip.z + 1e-7 < nearest) { discard; }
  return waterColor(input, surface, frontFacing);
}
@fragment fn fs_water_forward_color(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let surface = evaluate_surface(waterSurfaceInput(input, frontFacing));
  if (!waterCoverage(input, surface)) { discard; }
  let pixel = vec2<i32>(input.clip.xy);
  let nearest = textureLoad(surfaceNearestDepthTexture, pixel, 0).r;
  if (input.clip.z + 1e-7 < nearest) { discard; }
  let lit = waterColor(input, surface, frontFacing);
  return vec4<f32>(lit.color.rgb + lit.captureSky.rgb * lit.reflectionWeight.r, lit.color.a);
}
@fragment fn fs_main(input: WaterVertexOutput, @builtin(front_facing) frontFacing: bool) -> WaterColorOutput {
  let surfaceInput = waterSurfaceInput(input, frontFacing);
  let surface = evaluate_surface(surfaceInput);
  if (!waterCoverage(input, surface)) { discard; }
  return waterColor(input, surface, frontFacing);
}
#endif
