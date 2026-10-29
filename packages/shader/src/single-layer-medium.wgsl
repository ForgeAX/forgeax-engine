#define_import_path forgeax::single-layer-medium

#import forgeax_clipping::planes::{applyViewClipping}
#import forgeax_material::single_layer_medium_surface_v1::{SingleLayerMediumSurfaceInput, SingleLayerMediumSurfaceData}
#import forgeax_view::common::{View, Mesh, InstanceData, view}
#import forgeax_view::fog::{view_fog}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_view::common::{sceneIndexDraw, SCENE_INDEX_LOCAL_IDENTITY}
#else
#import forgeax_view::common::{meshes, instances}
#endif
#import forgeax_scene_temporal::{sceneViewZ}
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
#import forgeax_material::parameters::{MATERIAL_SCENE_ROW_VEC4_COUNT}
#endif
#import forgeax_pbr::ibl_sampling::{sampleIblDiffuse, environmentReflectionDirection}
#import forgeax_pbr::ibl_shared::{inverseRotateEnvironment}
#import forgeax_pbr::pmrem::{samplePmrem}
#import forgeax_pbr::lighting_probe::{evaluateProbeDiffuse}
#import forgeax_pbr::lighting_directional::{evalDirectionalShadowFactorAtPixel}
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster::{get_ssao_intensity}
#endif
#pragma material_slot surface
#import forgeax_material::slot::surface::{evaluate_surface}

struct VsIn {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) tangent: vec4<f32>,
};

struct VsOut {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) positionOS: vec3<f32>,
  @location(1) positionWS: vec3<f32>,
  @location(2) normalWS: vec3<f32>,
  @location(3) tangentWS: vec4<f32>,
  @location(4) uv0: vec2<f32>,
  @location(5) viewDirectionWS: vec3<f32>,
  @location(6) @interpolate(flat) materialIndex: u32,
  @location(7) @interpolate(flat) surfaceInstanceIndex: u32,
  @location(8) @interpolate(flat) probeIdentity: vec2<u32>,
};

#ifdef STORAGE_BUFFER_AVAILABLE
struct SurfaceFrameInputWords {
  words: array<u32, 12>,
};

struct SurfaceSharedFrameInput {
  frameTimeAndPadding: vec4<f32>,
};

struct SurfaceDirectAddress {
  frameBase: u32,
  instanceCount: u32,
  padding0: u32,
  padding1: u32,
};

@group(3) @binding(4) var<storage, read> surfaceFrameInputs: array<SurfaceFrameInputWords>;
@group(3) @binding(5) var<uniform> surfaceSharedFrameInput: SurfaceSharedFrameInput;
#ifndef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@group(3) @binding(6) var<uniform> surfaceDirectAddress: SurfaceDirectAddress;
#endif
#endif

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
struct SingleLayerMediumSceneMaterialRow {
  payload: array<vec4<f32>, MATERIAL_SCENE_ROW_VEC4_COUNT>,
};

@group(1) @binding(46) var<storage, read> sceneMaterials: array<SingleLayerMediumSceneMaterialRow>;
@group(3) @binding(2) var<storage, read> visibleItems: array<vec4<u32>>;
#endif

// The generic material record owner appends the transmission pair after the
// empty medium parameter region and six IBL entries (bindings 7 and 8).
@group(1) @binding(1) var mediumIrradianceMap: texture_cube<f32>;
@group(1) @binding(2) var mediumIrradianceSampler: sampler;
@group(1) @binding(3) var mediumPrefilterMap: texture_2d<f32>;
@group(1) @binding(4) var mediumPrefilterSampler: sampler;
@group(1) @binding(5) var mediumBrdfLut: texture_2d<f32>;
struct SurfaceSkylightUniforms {
  intensity: f32,
  colorR: f32,
  colorG: f32,
  colorB: f32,
  rotation: vec4<f32>,
};
@group(1) @binding(6) var<uniform> mediumSkylight: SurfaceSkylightUniforms;
@group(1) @binding(7) var surfaceBackdropSampler: sampler;
@group(1) @binding(8) var surfaceBackdropTexture: texture_2d<f32>;

// These bindings are renderer-owned graph inputs. Binding 9/10 is the
// independent r32float depth copy; 11/12 and 13/14 are the nearest-layer
// color/depth pair produced by the previous medium pass.
@group(1) @binding(9) var surfaceRawDepthSampler: sampler;
@group(1) @binding(10) var surfaceRawDepthTexture: texture_2d<f32>;
@group(1) @binding(11) var surfaceNearestLayerSampler: sampler;
@group(1) @binding(12) var surfaceNearestLayerTexture: texture_2d<f32>;
@group(1) @binding(13) var surfaceNearestDepthSampler: sampler;
@group(1) @binding(14) var surfaceNearestDepthTexture: texture_2d<f32>;
struct PlanarReflectionUniform {
  viewProjection: mat4x4<f32>,
  plane: vec4<f32>,
  enabledAndPadding: vec4<f32>,
};
@group(1) @binding(15) var planarReflectionTexture: texture_2d<f32>;
@group(1) @binding(16) var<uniform> planarReflection: PlanarReflectionUniform;

fn samplePlanarReflection(position: vec3<f32>, normal: vec3<f32>, fallback: vec3<f32>) -> vec3<f32> {
  if (planarReflection.enabledAndPadding.x == 0.0 ||
      abs(dot(planarReflection.plane, vec4<f32>(position, 1.0))) > 0.001 ||
      abs(dot(normal, planarReflection.plane.xyz)) < 0.999) { return fallback; }
  let clip = planarReflection.viewProjection * vec4<f32>(position, 1.0);
  if (clip.w <= 0.0) { return fallback; }
  let uv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return fallback; }
  let reflected = textureSampleLevel(planarReflectionTexture, surfaceBackdropSampler, uv, 0.0);
  return reflected.rgb + fallback * (1.0 - clamp(reflected.a, 0.0, 1.0));
}


// Direct draws and the GPU-driven lane consume the renderer's retained SH9
// projection. The scene/visible/dynamic-input group keeps one ABI while the
// optional object Probe page contributes the local diffuse response.
#ifdef PROBE_BLEND_AVAILABLE
@group(3) @binding(1) var<storage, read> probeBlendRecords: array<vec4<f32>>;
#endif

#ifdef CLUSTER_FORWARD_AVAILABLE
@group(2) @binding(7) var ssaoBlurredTexture: texture_2d<f32>;
@group(2) @binding(8) var ssaoBlurredSampler: sampler;
#endif

struct SurfaceFrameFacts {
  frameTime: f32,
  eventRangeStart: u32,
  eventRangeCount: u32,
  instanceIndex: u32,
  background: vec3<f32>,
  backgroundDepth: f32,
  backgroundAvailable: u32,
};

// World coordinates in ForgeaX are metres. A sky miss still needs a finite
// endpoint so Beer-Lambert and refraction remain continuous when the opaque
// depth producer has no geometry at a pixel. The value is supplied by the
// authored Surface ABI; this constant is only an invalid-authoring fallback.
const SURFACE_SKY_MISS_DISTANCE: f32 = 1000.0;
const SURFACE_NEAREST_DEPTH_EPSILON: f32 = 0.0005;
// Background admission operates in hardware depth, not meters. A broad layer
// tolerance rejects real shallow bottoms and turns the shoreline into a sky miss.
const SURFACE_BACKGROUND_DEPTH_EPSILON: f32 = 0.0000001;
const SURFACE_BACKGROUND_REASON_VALID: u32 = 0u;
const SURFACE_BACKGROUND_REASON_FOREGROUND: u32 = 1u;
const SURFACE_BACKGROUND_REASON_EDGE: u32 = 2u;
const SURFACE_BACKGROUND_REASON_UNAVAILABLE: u32 = 3u;

fn surfaceFrameFacts(index: u32) -> SurfaceFrameFacts {
#ifdef STORAGE_BUFFER_AVAILABLE
  let words = surfaceFrameInputs[index].words;
  return SurfaceFrameFacts(
    surfaceSharedFrameInput.frameTimeAndPadding.x,
    words[1],
    words[2],
    words[3],
    vec3<f32>(bitcast<f32>(words[4]), bitcast<f32>(words[5]), bitcast<f32>(words[6])),
    bitcast<f32>(words[8]),
    // The typed medium graph always publishes the paired raw-depth and
    // backdrop resources, so availability is a property of the graph, not of
    // a per-instance row. A row that was never written (no dynamicInput page,
    // or a candidate row the CPU projection did not address) reads as zero and
    // used to discard the whole water surface.
    1u,
  );
#else
  return SurfaceFrameFacts(0.0, 0u, 0u, index, vec3<f32>(0.0), 0.0, 0u);
#endif
}

fn surfaceDirectFrameIndex(instanceIndex: u32) -> u32 {
#ifdef STORAGE_BUFFER_AVAILABLE
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  return instanceIndex;
#else
  return surfaceDirectAddress.frameBase + instanceIndex;
#endif
#else
  return instanceIndex;
#endif
}

fn mediumSurfaceToCameraDirection(
  worldPosition: vec3<f32>,
  cameraPos: vec3<f32>,
  inverseViewProj: mat4x4<f32>,
  orthographic: bool,
) -> vec3<f32> {
  // Perspective rays originate at the camera and therefore vary with the
  // surface position. Orthographic rays are parallel: unprojecting the clip
  // center at the WebGPU near/far planes recovers one camera-facing direction
  // that is shared by every vertex, including off-axis water.
  let nearH = inverseViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0);
  let farH = inverseViewProj * vec4<f32>(0.0, 0.0, 0.5, 1.0);
  let nearWorld = nearH.xyz / max(abs(nearH.w), 1e-30);
  let farWorld = farH.xyz / max(abs(farH.w), 1e-30);
  return select(cameraPos - worldPosition, nearWorld - farWorld, orthographic);
}

fn surfaceVertex(
  vertex: VsIn,
  entityWorld: mat4x4<f32>,
  localFromInstance: mat4x4<f32>,
  worldViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  inverseViewProj: mat4x4<f32>,
  orthographic: bool,
  surfaceInstanceIndex: u32,
  materialIndex: u32,
  probeIdentity: vec2<u32>,
) -> VsOut {
  let localFromWorld = entityWorld * localFromInstance;
  let worldPosition = (localFromWorld * vec4<f32>(vertex.position, 1.0)).xyz;
  let worldNormal = normalize((localFromWorld * vec4<f32>(vertex.normal, 0.0)).xyz);
  let worldTangent = normalize((localFromWorld * vec4<f32>(vertex.tangent.xyz, 0.0)).xyz);

  var output: VsOut;
  output.clipPosition = worldViewProj * vec4<f32>(worldPosition, 1.0);
  output.positionOS = vertex.position;
  output.positionWS = worldPosition;
  output.normalWS = worldNormal;
  output.tangentWS = vec4<f32>(worldTangent, vertex.tangent.w);
  output.uv0 = vertex.uv;
  output.viewDirectionWS = mediumSurfaceToCameraDirection(
    worldPosition,
    cameraPos,
    inverseViewProj,
    orthographic,
  );
  output.materialIndex = materialIndex;
  output.surfaceInstanceIndex = surfaceInstanceIndex;
  output.probeIdentity = probeIdentity;
  return output;
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
fn sceneIndexVertex(vertex: VsIn, drawIndex: u32) -> VsOut {
  // visible.x is the GPU Scene instance row; visible.z is the view candidate
  // row, which keys the whole-bound surface frame input table per draw.
  let visibleItem = visibleItems[drawIndex];
  let draw = sceneIndexDraw(visibleItem.x);
  return surfaceVertex(vertex, draw.world, SCENE_INDEX_LOCAL_IDENTITY, view.worldViewProj, view.cameraPos, view.inverseViewProj, view.temporalProjection.z >= 0.5, visibleItem.z, visibleItem.y, draw.probe);
}
#endif

@vertex
fn vs_main(vertex: VsIn, @builtin(instance_index) instanceIndex: u32) -> VsOut {
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  // This variant binds only the GPU Scene tables; every entry reads the
  // visible stream.
  return sceneIndexVertex(vertex, instanceIndex);
#else
  let surfaceInstanceIndex = surfaceDirectFrameIndex(instanceIndex);
  return surfaceVertex(vertex, meshes[0u].worldFromLocal, instances[instanceIndex].localFromInstance, view.worldViewProj, view.cameraPos, view.inverseViewProj, view.temporalProjection.z >= 0.5, surfaceInstanceIndex, 0u, vec2<u32>(0u));
#endif
}

#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
@vertex
fn vs_scene_index(vertex: VsIn, @builtin(instance_index) drawIndex: u32) -> VsOut {
  return sceneIndexVertex(vertex, drawIndex);
}
#endif

fn makeSurfaceInput(input: VsOut, frame: SurfaceFrameFacts, frontFacing: bool) -> SingleLayerMediumSurfaceInput {
  var surfaceInput: SingleLayerMediumSurfaceInput;
  surfaceInput.positionOS = input.positionOS;
  surfaceInput.positionWS = input.positionWS;
  surfaceInput.geometricNormalWS = input.normalWS;
  surfaceInput.tangentWS = input.tangentWS;
  surfaceInput.viewDirectionWS = input.viewDirectionWS;
  surfaceInput.uv0 = input.uv0;
  surfaceInput.uv1 = vec2<f32>(0.0);
  surfaceInput.uv2 = vec2<f32>(0.0);
  surfaceInput.uv3 = vec2<f32>(0.0);
  surfaceInput.uv4 = vec2<f32>(0.0);
  surfaceInput.uv5 = vec2<f32>(0.0);
  surfaceInput.uv6 = vec2<f32>(0.0);
  surfaceInput.uv7 = vec2<f32>(0.0);
  surfaceInput.vertexColor = vec4<f32>(1.0);
  surfaceInput.frontFacing = frontFacing;
  surfaceInput.frameTime = frame.frameTime;
  surfaceInput.eventRangeStart = frame.eventRangeStart;
  surfaceInput.eventRangeCount = frame.eventRangeCount;
  surfaceInput.instanceIndex = frame.instanceIndex;
  return surfaceInput;
}

fn surfacePixel(pixelPosition: vec4<f32>, dimensions: vec2<u32>) -> vec2<i32> {
  let extent = vec2<f32>(dimensions);
  return vec2<i32>(clamp(pixelPosition.xy, vec2<f32>(0.0), extent - vec2<f32>(1.0)));
}

fn surfaceUv(pixel: vec2<i32>, dimensions: vec2<u32>) -> vec2<f32> {
  return (vec2<f32>(pixel) + vec2<f32>(0.5)) / max(vec2<f32>(dimensions), vec2<f32>(1.0));
}

fn surfacePixelOffset(pixel: vec2<i32>, offset: vec2<i32>, dimensions: vec2<u32>) -> vec2<i32> {
  // Keep this helper arithmetic-only. The caller must validate the returned
  // coordinate before any textureLoad; clamping would repeat an edge texel and
  // turn an invalid displaced footprint into a seemingly valid sample.
  _ = dimensions;
  return pixel + offset;
}

fn surfacePixelInBounds(pixel: vec2<i32>, dimensions: vec2<u32>) -> bool {
  let nonNegative = all(pixel >= vec2<i32>(0));
  let unsignedPixel = vec2<u32>(max(pixel, vec2<i32>(0)));
  return nonNegative && unsignedPixel.x < dimensions.x && unsignedPixel.y < dimensions.y;
}

struct SurfaceBackgroundSample {
  color: vec3<f32>,
  depth: f32,
  uv: vec2<f32>,
  valid: bool,
  reason: u32,
};

// Color and depth are sampled from the same 3x3 neighborhood. A displaced
// sample is admitted only when the complete footprint is behind this water
// fragment; this rejects foreground water, shore crossings, and roughness
// footprints that would otherwise mix a riverbed endpoint with a foreground
// color. The zero-offset sample may use its center texel as the explicit
// original-UV fallback when its neighbors are unavailable.
fn sampleSurfaceBackground(frame: SurfaceFrameFacts, pixelPosition: vec4<f32>, roughness: f32, offset: vec2<f32>) -> SurfaceBackgroundSample {
  let depthDimensions = textureDimensions(surfaceRawDepthTexture);
  let colorDimensions = textureDimensions(surfaceBackdropTexture);
  let sameExtent = colorDimensions.x == depthDimensions.x && colorDimensions.y == depthDimensions.y;
  let displacedPosition = pixelPosition.xy + offset * vec2<f32>(depthDimensions);
  let centerPixel = vec2<i32>(floor(displacedPosition));
  let centerInBounds = surfacePixelInBounds(centerPixel, depthDimensions);
  var centerDepth = 0.0;
  if (centerInBounds) {
    centerDepth = textureLoad(surfaceRawDepthTexture, centerPixel, 0).r;
  }
  let centerDepthValid = centerInBounds && centerDepth > 0.0 && centerDepth <= 1.0;
  let centerBehindWater = centerDepth < pixelPosition.z - pixelPosition.z * SURFACE_BACKGROUND_DEPTH_EPSILON;
  let centerValid = sameExtent && frame.backgroundAvailable != 0u && centerDepthValid && centerBehindWater;
  let originalOffset = all(abs(offset) < vec2<f32>(0.000001));
  var colorSum = vec3<f32>(0.0);
  var depthSum = 0.0;
  var uvSum = vec2<f32>(0.0);
  var validCount = 0u;
  var allValid = true;
  var hadForeground = false;
  var hadEdge = !centerInBounds;
  for (var y: i32 = -1; y <= 1; y = y + 1) {
    for (var x: i32 = -1; x <= 1; x = x + 1) {
      let pixel = surfacePixelOffset(centerPixel, vec2<i32>(x, y), depthDimensions);
      let inBounds = surfacePixelInBounds(pixel, depthDimensions);
      var depth = 0.0;
      if (inBounds) {
        depth = textureLoad(surfaceRawDepthTexture, pixel, 0).r;
      } else {
        hadEdge = true;
      }
      let depthValid = inBounds && depth > 0.0 && depth <= 1.0;
      let behindWater = depth < pixelPosition.z - pixelPosition.z * SURFACE_BACKGROUND_DEPTH_EPSILON;
      let valid = inBounds && sameExtent && frame.backgroundAvailable != 0u && depthValid && behindWater;
      allValid = allValid && valid;
      if (depthValid && !behindWater) {
        hadForeground = true;
      }
      if (valid) {
        let uv = clamp(surfaceUv(pixel, depthDimensions), vec2<f32>(0.0), vec2<f32>(1.0));
        // The validity mask is shared by color and depth. LOD zero keeps a
        // rough refraction footprint from filtering across a rejected edge;
        // roughness still controls the probe reflection below.
        colorSum = colorSum + textureSampleLevel(surfaceBackdropTexture, surfaceBackdropSampler, uv, 0.0).rgb;
        depthSum = depthSum + depth;
        uvSum = uvSum + uv;
        validCount = validCount + 1u;
      }
    }
  }
  let footprintValid = allValid && validCount == 9u;
  // Only the original UV may use a center fallback. A displaced center is
  // never accepted after its 3x3 footprint was rejected.
  let valid = sameExtent && frame.backgroundAvailable != 0u && (footprintValid || (originalOffset && centerValid));
  var color = frame.background;
  var depth = centerDepth;
  var uv = clamp(surfaceUv(centerPixel, depthDimensions), vec2<f32>(0.0), vec2<f32>(1.0));
  // The paired resolver already selected the color belonging to the nearest
  // hardware-depth sample at this pixel. Preserve that exact pair when the
  // refracted ray has no screen-space displacement; averaging the surrounding
  // texels here would reintroduce the color/depth divorce that the paired
  // resolve exists to prevent at thin foreground and shoreline edges.
  if (footprintValid && !originalOffset) {
    color = colorSum / 9.0;
    depth = depthSum / 9.0;
    uv = uvSum / 9.0;
  } else if (centerValid) {
    color = textureLoad(surfaceBackdropTexture, centerPixel, 0).rgb;
  }
  var reason = SURFACE_BACKGROUND_REASON_VALID;
  if (!valid) {
    reason = select(
      select(SURFACE_BACKGROUND_REASON_EDGE, SURFACE_BACKGROUND_REASON_FOREGROUND, hadForeground),
      SURFACE_BACKGROUND_REASON_EDGE,
      hadEdge,
    );
    if (!sameExtent || frame.backgroundAvailable == 0u) {
      reason = SURFACE_BACKGROUND_REASON_UNAVAILABLE;
    }
  }
  return SurfaceBackgroundSample(color, depth, uv, valid, reason);
}

fn sampleRawDepth(pixelPosition: vec4<f32>) -> f32 {
  let dimensions = textureDimensions(surfaceRawDepthTexture);
  return textureLoad(surfaceRawDepthTexture, surfacePixel(pixelPosition, dimensions), 0).r;
}

fn reconstructBackgroundWorld(uv: vec2<f32>, depth: f32) -> vec3<f32> {
  // WebGPU's clip-space Z is already in [0, 1]. The Y flip maps framebuffer
  // coordinates to the camera matrix convention used by View.inverseViewProj.
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * clip;
  return world.xyz / max(abs(world.w), 1e-30);
}

fn validateSurfaceBackgroundEndpoint(
  sample: SurfaceBackgroundSample,
  surfacePosition: vec3<f32>,
  surfaceNormal: vec3<f32>,
) -> SurfaceBackgroundSample {
  if (!sample.valid) {
    return sample;
  }
  let endpoint = reconstructBackgroundWorld(sample.uv, sample.depth);
  // A background endpoint must remain on the water side of the authored
  // surface plane. This rejects a refracted ray that crossed the water plane
  // into the camera-facing half-space, while preserving the original sample
  // as the only fallback selected by the caller.
  if (dot(endpoint - surfacePosition, surfaceNormal) > SURFACE_NEAREST_DEPTH_EPSILON) {
    var rejected = sample;
    rejected.valid = false;
    rejected.reason = SURFACE_BACKGROUND_REASON_FOREGROUND;
    return rejected;
  }
  return sample;
}

fn sampleNearestCoverage(pixelPosition: vec4<f32>, rawDepth: f32) -> f32 {
  let dimensions = textureDimensions(surfaceNearestLayerTexture);
  let pixel = surfacePixel(pixelPosition, dimensions);
  let nearestDepth = textureLoad(surfaceNearestDepthTexture, pixel, 0).x;
  let nearestCoverage = textureSampleLevel(
    surfaceNearestLayerTexture,
    surfaceNearestLayerSampler,
    surfaceUv(pixel, dimensions),
    0.0,
  ).a;
  let nearestValid = nearestCoverage > 0.0 && nearestDepth > 0.0 && nearestDepth > rawDepth - nearestDepth * SURFACE_NEAREST_DEPTH_EPSILON;
  return select(0.0, nearestCoverage, nearestValid);
}

fn sampleSkyReflection(normal: vec3<f32>, viewDirection: vec3<f32>, roughness: f32) -> vec3<f32> {
  let reflectedDirection = environmentReflectionDirection(normal, viewDirection, roughness);
  let rotated = inverseRotateEnvironment(reflectedDirection, mediumSkylight.rotation);
  let environment = samplePmrem(
    mediumPrefilterMap,
    mediumPrefilterSampler,
    vec3<f32>(rotated.x, -rotated.y, rotated.z),
    roughness,
  );
  return environment * vec3<f32>(mediumSkylight.colorR, mediumSkylight.colorG, mediumSkylight.colorB) * max(mediumSkylight.intensity, 0.0);
}

fn sampleMediumDiffuse(
  normal: vec3<f32>,
  pixelPosition: vec4<f32>,
  probeIdentity: vec2<u32>,
) -> vec3<f32> {
  let skyScale = vec3<f32>(
    mediumSkylight.colorR,
    mediumSkylight.colorG,
    mediumSkylight.colorB,
  ) * max(mediumSkylight.intensity, 0.0);
  let skyIrradiance = sampleIblDiffuse(
    normal,
    mediumSkylight.rotation,
    mediumIrradianceMap,
    mediumIrradianceSampler,
  ) * skyScale;
  var diffuse = skyIrradiance;
#ifdef PROBE_BLEND_AVAILABLE
#ifdef GPU_DRIVEN_SCENE_INDEX_AVAILABLE
  let requestedProbeBase = probeIdentity.x * 16u;
  let probeInBounds = requestedProbeBase + 9u < arrayLength(&probeBlendRecords);
  let probeBase = select(0u, requestedProbeBase, probeInBounds);
  let probeHeader = probeBlendRecords[probeBase];
  let probeIdentityValid =
    probeInBounds &&
    u32(probeHeader.x) + 1u == probeIdentity.x &&
    u32(probeHeader.y) == probeIdentity.y;
#else
  let probeBase = 0u;
  let probeIdentityValid = true;
#endif
  let probeShPreblend = array<vec4<f32>, 9>(
    probeBlendRecords[probeBase + 1u], probeBlendRecords[probeBase + 2u], probeBlendRecords[probeBase + 3u],
    probeBlendRecords[probeBase + 4u], probeBlendRecords[probeBase + 5u], probeBlendRecords[probeBase + 6u],
    probeBlendRecords[probeBase + 7u], probeBlendRecords[probeBase + 8u], probeBlendRecords[probeBase + 9u],
  );
  if (probeIdentityValid) {
    diffuse = evaluateProbeDiffuse(
      probeShPreblend,
      probeBlendRecords[probeBase].z,
      normal,
      skyIrradiance,
      vec3<f32>(1.0),
      vec3<f32>(1.0),
      0.0,
    );
  }
#endif
#ifdef CLUSTER_FORWARD_AVAILABLE
  let dimensions = vec2<f32>(textureDimensions(surfaceBackdropTexture));
  let ssaoUv = clamp(pixelPosition.xy / max(dimensions, vec2<f32>(1.0)), vec2<f32>(0.0), vec2<f32>(1.0));
  let ssao = textureSample(ssaoBlurredTexture, ssaoBlurredSampler, ssaoUv).r;
  // The AO producer already applied the intensity exponent before filtering.
  diffuse *= select(1.0, ssao, get_ssao_intensity() > 0.0);
#endif
  return diffuse;
}

fn fresnelWeight(normal: vec3<f32>, viewDirection: vec3<f32>, ior: f32) -> f32 {
  let f = (ior - 1.0) / (ior + 1.0);
  let f0 = f * f;
  return clamp(f0 + (1.0 - f0) * pow(1.0 - max(dot(normal, viewDirection), 0.0), 5.0), 0.0, 1.0);
}

// Sun glint: the Three.js Water specular term. The mirrored sun direction against
// the eye, raised to a shininess that follows the Surface roughness
// (2 / roughness^2 - 2, ~137 for 0.12 where Three.js defaults to 100), scaled by
// the main DirectionalLight colour (intensity premultiplied) at Three's 0.5 weight.
// The lobe widens with the screen-space change of the normal across the pixel
// (Toksvig-style), so far, sub-pixel waves blur into a soft sheen instead of
// sparkling; near, resolved waves keep a tight highlight. The caller applies
// Fresnel, the shadow factor and the foam cover.
fn mediumSunGlint(
  normal: vec3<f32>,
  viewDirection: vec3<f32>,
  lightDirection: vec3<f32>,
  roughness: f32,
  footprintVariance: f32,
) -> f32 {
  let mirrored = reflect(-lightDirection, normal);
  let cosine = max(dot(mirrored, viewDirection), 0.0);
  let shininess = clamp(2.0 / (roughness * roughness + footprintVariance) - 2.0, 1.0, 1000.0);
  return 0.5 * pow(cosine, shininess);
}

fn surfaceFinite(value: f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn surfaceSkyMissDistance(surface: SingleLayerMediumSurfaceData) -> f32 {
  let authoredDistance = surface.maxDistanceMeters;
  let authoredValid = surfaceFinite(authoredDistance) && authoredDistance > 0.0;
  // The upper bound prevents an invalidly large authored value from creating
  // an unbounded Beer-Lambert path. Valid values remain Surface/Cook facts;
  // only invalid data uses the ABI fallback.
  return clamp(select(SURFACE_SKY_MISS_DISTANCE, authoredDistance, authoredValid), 0.001, 100000.0);
}

// Compute 1 - exp(-x) without losing the zero-extinction limit to float
// cancellation. The series is the same analytic function used by the CPU
// oracle for small x, while the regular exponential handles longer paths.
fn mediumOneMinusExpNeg(x: f32) -> f32 {
  let safeX = max(x, 0.0);
  if (safeX < 0.001) {
    let x2 = safeX * safeX;
    return safeX * (1.0 - safeX * 0.5 + x2 / 6.0 - safeX * x2 / 24.0);
  }
  return 1.0 - exp(-safeX);
}

fn mediumSingleScatterIntegral(sigmaS: f32, sigmaT: f32, distance: f32) -> f32 {
  let safeScattering = max(sigmaS, 0.0);
  let safeDistance = max(distance, 0.0);
  let extinction = max(sigmaT, 0.0);
  if (extinction <= 0.0) {
    return safeScattering * safeDistance;
  }
  return safeScattering * mediumOneMinusExpNeg(extinction * safeDistance) / extinction;
}

fn composeNearestLayer(surface: SingleLayerMediumSurfaceData) -> vec4<f32> {
  // The first pass is an occlusion/coverage fact for the color pass. It must
  // not publish a diagnostic or constant water color that can replace the
  // opaque riverbed backdrop.
  return vec4<f32>(0.0, 0.0, 0.0, clamp(surface.coverage, 0.0, 1.0));
}

fn clipDepth(input: VsOut) -> f32 {
  // Fragment @builtin(position).z is already framebuffer/window depth in the
  // WebGPU depth space used by the raw-depth and nearest-layer producers.
  return clamp(input.clipPosition.z, 0.0, 1.0);
}

fn mediumColorVisible(input: VsOut, surface: SingleLayerMediumSurfaceData, frame: SurfaceFrameFacts) -> bool {
  if (surface.coverage <= 0.0 || frame.backgroundAvailable == 0u) {
    return false;
  }
  let rawDepth = sampleRawDepth(input.clipPosition);
  let rawDepthForNearest = select(0.0, rawDepth, rawDepth > 0.0 && rawDepth <= 1.0);
  let nearestCoverage = sampleNearestCoverage(input.clipPosition, rawDepthForNearest);
  let nearestDepth = textureLoad(
    surfaceNearestDepthTexture,
    surfacePixel(input.clipPosition, textureDimensions(surfaceNearestDepthTexture)),
    0,
  ).x;
  // The nearest pass has already admitted the closest water surface. Reject
  // farther layers while keeping the opaque background as the transmission
  // source for the admitted layer.
  return !(nearestCoverage > 0.0 && clipDepth(input) < nearestDepth - nearestDepth * SURFACE_NEAREST_DEPTH_EPSILON);
}

fn composeColor(input: SingleLayerMediumSurfaceInput, surface: SingleLayerMediumSurfaceData, frame: SurfaceFrameFacts, frontFacing: bool, pixelPosition: vec4<f32>, probeIdentity: vec2<u32>) -> vec4<f32> {
  // The authored/ripple normal controls optical shading, while the immutable
  // interpolated geometry normal owns the water-volume half-space. A strong
  // wave must never move the shoreline plane used to admit a background end.
  let shadingNormal = normalize(surface.normalWS);
  let orientedNormal = select(shadingNormal, -shadingNormal, !frontFacing);
  let geometricPlaneNormal = normalize(input.geometricNormalWS);
  let orientedPlaneNormal = select(geometricPlaneNormal, -geometricPlaneNormal, !frontFacing);
  let viewDirection = normalize(input.viewDirectionWS);
  let ior = max(surface.ior, 1.0001);
  let roughness = clamp(surface.roughness, 0.04, 1.0);
  let refractedDirection = refract(-viewDirection, orientedNormal, 1.0 / ior);
  let travelDirection = select(orientedNormal, normalize(refractedDirection), length(refractedDirection) > 0.000001);
  let centerBackground = validateSurfaceBackgroundEndpoint(
    sampleSurfaceBackground(frame, pixelPosition, roughness, vec2<f32>(0.0)),
    input.positionWS,
    orientedPlaneNormal,
  );
  let skyMissDistance = surfaceSkyMissDistance(surface);
  var centerPathLength = skyMissDistance;
  var distortion = vec2<f32>(0.0);
  if (centerBackground.valid) {
    let centerEndpoint = reconstructBackgroundWorld(centerBackground.uv, centerBackground.depth);
    centerPathLength = min(length(centerEndpoint - input.positionWS), skyMissDistance);
    distortion = travelDirection.xy * clamp(centerPathLength * 0.01, 0.0, 0.08);
  }
  let backgroundSample = validateSurfaceBackgroundEndpoint(
    sampleSurfaceBackground(frame, pixelPosition, roughness, distortion),
    input.positionWS,
    orientedPlaneNormal,
  );
  // A rejected displaced footprint falls back to the original-UV sample. The
  // accepted endpoint is reconstructed again so the metric path matches the
  // exact color/depth pair that won admission.
  var acceptedBackground = centerBackground;
  if (backgroundSample.valid) {
    acceptedBackground = backgroundSample;
  }
  var pathLength = skyMissDistance;
  if (acceptedBackground.valid) {
    let acceptedEndpoint = reconstructBackgroundWorld(acceptedBackground.uv, acceptedBackground.depth);
    pathLength = min(length(acceptedEndpoint - input.positionWS), skyMissDistance);
  }
  var background = frame.background;
  if (frame.backgroundAvailable != 0u && acceptedBackground.valid) {
    background = acceptedBackground.color;
  }
  let sigmaS = max(surface.scattering, vec3<f32>(0.0));
  let sigmaT = max(surface.absorption + sigmaS, vec3<f32>(0.0));
  let transmittance = exp(-sigmaT * pathLength);
  let lightDirection = normalize(-view.lightDir);
  let phaseG = clamp(surface.phaseG, -0.95, 0.95);
  let phaseCosine = dot(lightDirection, -viewDirection);
  let phaseDenominator = max(1.0 + phaseG * phaseG - 2.0 * phaseG * phaseCosine, 0.0001);
  let phase = (1.0 - phaseG * phaseG) / (12.5663706 * pow(phaseDenominator, 1.5));
  let inScatter = vec3<f32>(
    mediumSingleScatterIntegral(sigmaS.x, sigmaT.x, pathLength),
    mediumSingleScatterIntegral(sigmaS.y, sigmaT.y, pathLength),
    mediumSingleScatterIntegral(sigmaS.z, sigmaT.z, pathLength),
  ) * phase;
  let directionalShadow = evalDirectionalShadowFactorAtPixel(
    orientedNormal,
    input.positionWS,
    sceneViewZ(pixelPosition, view.temporalProjection),
    0u,
    pixelPosition.xy,
  );
  let normalFootprint = fwidth(orientedNormal);
  let footprintVariance = dot(normalFootprint, normalFootprint);
  let directLight = directionalShadow * max(dot(orientedNormal, lightDirection), 0.0) * view.lightColor;
  let light = directLight + sampleMediumDiffuse(orientedNormal, pixelPosition, probeIdentity);
  let transmissionColor = background * transmittance + inScatter * light;
  let fresnel = fresnelWeight(orientedNormal, viewDirection, ior);
  let reflection = samplePlanarReflection(input.positionWS, orientedPlaneNormal, sampleSkyReflection(orientedNormal, viewDirection, roughness));
  let foam = clamp(surface.foam, 0.0, 1.0);
  let foamColor = mix(transmissionColor, vec3<f32>(0.9, 0.95, 1.0), foam);
  // Fresnel is the sole energy split: the transmitted and reflected terms
  // sum to one even when the sampled background is a sky miss.
  let glint = mediumSunGlint(orientedNormal, viewDirection, lightDirection, roughness, footprintVariance)
    * fresnel * view.lightColor * directionalShadow * (1.0 - foam);
  let shaded = foamColor * (1.0 - fresnel) + reflection * fresnel + glint;
  // The opaque fog pass already fogged the backdrop at its own depth. Fog the
  // water surface's own light at the water depth and keep that carried
  // backdrop as is, the way translucent_fog_transmission does for glass.
  let carried = background * transmittance * (1.0 - foam) * (1.0 - fresnel);
  let fog = view_fog(view, input.positionWS);
  let waterOpacity = vec3<f32>(1.0) - transmittance * (1.0 - foam) * (1.0 - fresnel);
  let result = (shaded - carried) * fog.transmittance + carried + waterOpacity * fog.inscatter;
  return vec4<f32>(max(result, vec3<f32>(0.0)), clamp(surface.coverage, 0.0, 1.0));
}

@fragment
fn fs_nearest_layer(input: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let frame = surfaceFrameFacts(input.surfaceInstanceIndex);
  let surfaceInput = makeSurfaceInput(input, frame, frontFacing);
  applyViewClipping(surfaceInput.positionWS, false);
  let surface = evaluate_surface(surfaceInput);
  if (surface.coverage <= 0.0) {
    discard;
  }
  return composeNearestLayer(surface);
}

@fragment
fn fs_color(input: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let frame = surfaceFrameFacts(input.surfaceInstanceIndex);
  let surfaceInput = makeSurfaceInput(input, frame, frontFacing);
  applyViewClipping(surfaceInput.positionWS, false);
  let surface = evaluate_surface(surfaceInput);
  if (!mediumColorVisible(input, surface, frame)) {
    discard;
  }
  return composeColor(surfaceInput, surface, frame, frontFacing, input.clipPosition, input.probeIdentity);
}

// Keep the Engine material's default publication usable by callers that do
// not select a record-mode entry explicitly; the typed Standard owner selects
// fs_nearest_layer/fs_color for the two actual medium submissions.
@fragment
fn fs_main(input: VsOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4<f32> {
  let frame = surfaceFrameFacts(input.surfaceInstanceIndex);
  let surfaceInput = makeSurfaceInput(input, frame, frontFacing);
  applyViewClipping(surfaceInput.positionWS, false);
  let surface = evaluate_surface(surfaceInput);
  if (!mediumColorVisible(input, surface, frame)) {
    discard;
  }
  return composeColor(surfaceInput, surface, frame, frontFacing, input.clipPosition, input.probeIdentity);
}
