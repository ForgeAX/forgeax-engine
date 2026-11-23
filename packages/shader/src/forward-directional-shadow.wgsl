#import forgeax_view::common::{view, FullscreenOutput, fullscreen_triangle, DirectLightSlot, shadowParams, shadowMap, spotShadowMap, shadowSampler}
#import forgeax_pbr::lighting_directional::{sampleDirectionalShadowClip, sampleDirectionalPcss, sampleDirectionalSoftPcf, sampleDirectionalSizedPcf, pickCascadeLayer, directionalCascadeBlend}
#import forgeax_pbr::lighting_punctual::{pointShadowVisibility, spotShadowVisibilityAtClip, punctualRangeReaches, spotConeReaches, spotDefaultShadowParams}
#import forgeax_scene_temporal::{sceneFragmentViewZ}

@group(1) @binding(0) var sceneDepth : texture_depth_2d;
struct ScreenToShadow {
  cascade : array<mat4x4<f32>, 4>,
  spot : array<mat4x4<f32>, 4>,
  spotVolume : array<mat4x4<f32>, 4>,
  transition : vec4<f32>,
  clipSplits : vec4<f32>,
  clipBlendStarts : vec4<f32>,
  atlas : vec4<f32>,
  spotFade : vec4<f32>,
  pointFade : vec4<f32>,
};
@group(1) @binding(1) var<uniform> screenToShadow : ScreenToShadow;
@group(1) @binding(2) var<storage, read> lights : array<DirectLightSlot>;
@group(1) @binding(3) var projectionDepthSampler : sampler;

@vertex fn vs_main(@builtin(vertex_index) index : u32) -> FullscreenOutput {
  var output = fullscreen_triangle(index);
  output.position.z = 0.0;
  return output;
}

fn receiverClip(position : vec2<f32>, depth : f32) -> vec4<f32> {
  let uv = position / vec2<f32>(view.viewportWidth, view.viewportHeight);
  return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), depth, 1.0);
}

fn projectionGather(atlas : texture_depth_2d_array, layer : i32, uv : vec2<f32>,
    adjustedReference : vec4<f32>, baseReference : f32, invTransition : f32) -> vec4<f32> {
  let depth = textureGather(atlas, projectionDepthSampler, uv, layer);
  // A plane estimate may relieve occlusion but must not add self-shadowing.
  return clamp(max(adjustedReference, vec4<f32>(baseReference)) - depth * invTransition, vec4<f32>(0.0), vec4<f32>(1.0));
}

// Each gather yields bottom-left, bottom-right, top-right, top-left.
// Partial coverage is applied only to the outer row and column of the kernel.
fn projectionRow(left : vec4<f32>, right : vec4<f32>, phase : f32) -> vec2<f32> {
  return left.wx * (1.0 - phase) + left.zy + right.wx + right.zy * phase;
}

fn projectionFiveRow(atlas : texture_depth_2d_array, layer : i32, center : vec2<f32>,
    span : f32, phase : f32, adjustedReference : vec4<f32>, stepX : f32, baseReference : f32, invTransition : f32) -> vec2<f32> {
  let left = projectionGather(atlas, layer, center - vec2<f32>(span, 0.0), adjustedReference - 2.0 * stepX, baseReference, invTransition);
  let middle = projectionGather(atlas, layer, center, adjustedReference, baseReference, invTransition);
  let right = projectionGather(atlas, layer, center + vec2<f32>(span, 0.0), adjustedReference + 2.0 * stepX, baseReference, invTransition);
  return projectionRow(left, right, phase) + middle.wx + middle.zy;
}

// Match the fixed Gather footprints in UE's Manual3x3PCF and Manual5x5PCF.
fn projectionPcf(atlas : texture_depth_2d_array, layer : i32, uv : vec2<f32>,
    reference : f32, invTransition : f32, kernel : u32, gradient : vec2<f32>) -> f32 {
  let dimensions = screenToShadow.atlas.x;
  let texel = vec2<f32>(screenToShadow.atlas.y);
  let footprint = uv * dimensions - 0.5;
  let phase = fract(footprint);
  let center = (floor(footprint) + 1.0) * texel;
  // Precompute the four comparison references shared by each Gather.
  let step = gradient * (screenToShadow.atlas.y * invTransition);
  let baseReference = 1.0 + reference * invTransition;
  let referenceAtCenter = baseReference + dot(vec2<f32>(0.5) - phase, step);
  let biasA = 0.5 * (step.y - step.x);
  let biasB = 0.5 * (step.y + step.x);
  let adjustedReference = vec4<f32>(referenceAtCenter) + vec4<f32>(biasA, biasB, -biasA, -biasB);
  if (kernel == 1u) {
    let value = projectionGather(atlas, layer, center, adjustedReference, baseReference, invTransition);
    return mix(mix(value.w, value.z, phase.x), mix(value.x, value.y, phase.x), phase.y);
  }
  if (kernel == 3u) {
    let top = projectionRow(
      projectionGather(atlas, layer, center - texel, adjustedReference - step.x - step.y, baseReference, invTransition),
      projectionGather(atlas, layer, center + texel * vec2<f32>(1.0, -1.0), adjustedReference + step.x - step.y, baseReference, invTransition),
      phase.x);
    let bottom = projectionRow(
      projectionGather(atlas, layer, center + texel * vec2<f32>(-1.0, 1.0), adjustedReference - step.x + step.y, baseReference, invTransition),
      projectionGather(atlas, layer, center + texel, adjustedReference + step.x + step.y, baseReference, invTransition),
      phase.x);
    return (top.x * (1.0 - phase.y) + top.y + bottom.x + bottom.y * phase.y) * (1.0 / 9.0);
  }
  let span = 2.0 * texel;
  let top = projectionFiveRow(atlas, layer, center - vec2<f32>(0.0, span.y),
    span.x, phase.x, adjustedReference - 2.0 * step.y, step.x, baseReference, invTransition);
  let middle = projectionFiveRow(atlas, layer, center, span.x, phase.x, adjustedReference, step.x, baseReference, invTransition);
  let bottom = projectionFiveRow(atlas, layer, center + vec2<f32>(0.0, span.y),
    span.x, phase.x, adjustedReference + 2.0 * step.y, step.x, baseReference, invTransition);
  return (top.x * (1.0 - phase.y) + top.y + middle.x + middle.y + bottom.x + bottom.y * phase.y) * 0.04;
}

fn clipFromShadowUv(position : vec4<f32>) -> vec4<f32> {
  return vec4<f32>(2.0 * position.x - position.w, position.w - 2.0 * position.y, position.zw);
}

fn receiverShadowGradient(matrix : mat4x4<f32>, clip : vec4<f32>, projected : vec3<f32>,
    depthDelta : vec2<f32>) -> vec2<f32> {
  let dx = matrix[0] * (2.0 / view.viewportWidth) + matrix[2] * depthDelta.x;
  let dy = matrix[1] * (-2.0 / view.viewportHeight) + matrix[2] * depthDelta.y;
  // Differentiate the homogeneous divide, then fit the receiver in shadow UV/depth.
  let plane = cross(dx.xyz - projected * dx.w, dy.xyz - projected * dy.w);
  let signedGrad = -plane.xy * sign(plane.z) / max(abs(plane.z), max(length(plane) * 0.0872665, 1e-25));
  let contiguous = max(abs(dx.w), abs(dy.w)) < abs(clip.w) * 0.25;
  return select(vec2<f32>(0.0), signedGrad, contiguous);
}

fn screenDirectionalCascade(clip : vec4<f32>, layer : u32, pixel : vec2<f32>,
    depth : f32, depthDelta : vec2<f32>) -> f32 {
  let profile = u32(view.directionalShadowFilter.x);
  if (view.splitPlanes[3].w > 1.0001 ||
      (view.splitPlanes[3].w > 0.0 && view.splitPlanes[3].w < 0.9999) ||
      (profile == 7u && view.splitPlanes[0].w > 0.5)) {
    return sampleDirectionalShadowClip(clipFromShadowUv(clip), layer, vec3<f32>(0.0), normalize(-view.lightDir), 0u, pixel);
  }
  let projected = clip.xyz / clip.w;
  if (!(all(projected >= vec3<f32>(0.0)) && all(projected <= vec3<f32>(1.0)))) { return 1.0; }
  let matrix = screenToShadow.cascade[layer];
  let inverseTransition = screenToShadow.transition[layer];
  var gradient = receiverShadowGradient(matrix, clip, projected, depthDelta);
  let majorGradient = max(abs(gradient.x), abs(gradient.y));
  // A contact edge can share nearly the same view depth on two different planes.
  // Verify the screen derivatives before allowing a large light-space correction.
  // Ten half-texel transition widths correspond to five world shadow texels.
  if (majorGradient * (screenToShadow.atlas.y * inverseTransition) > 10.0) {
    let coord = vec2<i32>(pixel);
    let extent = vec2<i32>(textureDimensions(sceneDepth));
    let reliable = vec2<f32>(
      receiverAxisDepthDelta(coord, vec2<i32>(1, 0), depth, extent),
      receiverAxisDepthDelta(coord, vec2<i32>(0, 1), depth, extent));
    gradient = receiverShadowGradient(matrix, clip, projected, reliable);
  }
  if (profile == 4u || profile == 5u || profile == 7u) {
    // The shared filters express their tap offsets in shadow texels.
    let texelGradient = select(vec2<f32>(0.0), gradient * screenToShadow.atlas.y, view.splitPlanes[0].w < 0.5);
    let reference = projected.z + view.depthBias;
    if (profile == 7u) {
      return sampleDirectionalSoftPcf(projected.xy, i32(layer), reference, texelGradient, vec2<f32>(1.0));
    }
    return sampleDirectionalPcss(projected.xy, layer, reference, texelGradient, profile);
  }
  if (profile == 3u || (profile == 2u && view.splitPlanes[2].w != 0.0)) {
    // Explicit radius and tap density are independent. The default radius
    // already matches the fixed Gather footprint for the three-tap axis.
    let reference = projected.z + view.depthBias;
    return sampleDirectionalSizedPcf(projected.xy, i32(layer), reference,
      gradient * screenToShadow.atlas.y, vec2<f32>(1.0), select(3u, 5u, profile == 3u));
  }
  let kernel = select(select(3u, 5u, profile == 6u), 1u, profile == 1u);
  // UE clamps the receiver away from the far plane in forward depth.
  let reference = max(projected.z, view.depthBias);
  let visibility = projectionPcf(shadowMap, i32(layer), projected.xy, reference,
    inverseTransition, kernel, gradient);
  // UE's PCF overblur correction runs before cascade blending and light fade.
  return visibility * visibility;
}

fn receiverViewDepth(pixel : vec2<f32>, depth : f32, clip : vec4<f32>) -> f32 {
  let inverse = view.inverseViewProj;
  let worldW = dot(vec4<f32>(inverse[0].w, inverse[1].w, inverse[2].w, inverse[3].w), clip);
  return -sceneFragmentViewZ(vec4<f32>(pixel, depth, worldW), view.temporalProjection);
}

fn shadeDirectionalLayer(pixel : vec2<f32>, clip : vec4<f32>, first : u32, blend : f32,
    depthDelta : vec2<f32>) -> f32 {
  let samples = select(1u, 2u, blend > 0.0);
  var visibility = 0.0;
  for (var i = 0u; i < samples; i++) {
    let layer = first + i;
    visibility += select(1.0 - blend, blend, i != 0u) *
      screenDirectionalCascade(screenToShadow.cascade[layer] * clip, layer, pixel, clip.z, depthDelta);
  }
  return mix(1.0, visibility, 1.0 - view.splitPlanes[1].w);
}

fn shadeKnownCascade(pixel : vec2<f32>, depth : f32, clip : vec4<f32>, first : u32, count : u32,
    depthDelta : vec2<f32>) -> f32 {
  var blend = 0.0;
  if (first + 1u < count && view.cascadeBlend > 0.0 &&
      depth <= screenToShadow.clipBlendStarts[first]) {
    blend = directionalCascadeBlend(first, count, receiverViewDepth(pixel, depth, clip));
  }
  return shadeDirectionalLayer(pixel, clip, first, blend, depthDelta);
}

// Quad derivatives can cross a silhouette. Estimate that axis using the
// closer depth on either side instead of dropping the receiving plane.
fn receiverAxisDepthDelta(pixel : vec2<i32>, axis : vec2<i32>, depth : f32, extent : vec2<i32>) -> f32 {
  let low = pixel - axis;
  let high = pixel + axis;
  let lowDepth = textureLoad(sceneDepth, clamp(low, vec2<i32>(0), extent - 1), 0);
  let highDepth = textureLoad(sceneDepth, clamp(high, vec2<i32>(0), extent - 1), 0);
  let a = depth - lowDepth;
  let b = highDepth - depth;
  let validLow = lowDepth > 0.0 && all(low >= vec2<i32>(0));
  let validHigh = highDepth > 0.0 && all(high < extent);
  if (!validLow) { return select(0.0, b, validHigh); }
  if (!validHigh) { return a; }
  let difference = abs(a - b);
  let major = max(abs(a), abs(b));
  let minor = min(abs(a), abs(b));
  // Adjacent samples already agree, or one side clearly crosses a silhouette.
  if (difference <= major * 0.125 || minor <= major * 0.25) {
    return select(b, a, abs(a) <= abs(b));
  }
  let low2 = pixel - 2 * axis;
  let high2 = pixel + 2 * axis;
  let lowDepth2 = textureLoad(sceneDepth, clamp(low2, vec2<i32>(0), extent - 1), 0);
  let highDepth2 = textureLoad(sceneDepth, clamp(high2, vec2<i32>(0), extent - 1), 0);
  let aError = select(1.0, abs(a - (lowDepth - lowDepth2)), lowDepth2 > 0.0 && all(low2 >= vec2<i32>(0)));
  let bError = select(1.0, abs(b - (highDepth2 - highDepth)), highDepth2 > 0.0 && all(high2 < extent));
  return select(b, a, aError < bError || (aError == bError && abs(a) <= abs(b)));
}

fn directionalVisibility(pixel : vec2<f32>) -> f32 {
  let depth = textureLoad(sceneDepth, vec2<i32>(pixel), 0);
  let clip = receiverClip(pixel, depth);
  var depthDelta = vec2<f32>(dpdxFine(depth), dpdyFine(depth));
  let count = u32(view.cascadeCount);
  if (depth <= 0.0 || count == 0u) { return 1.0; }
  let edge = abs(depthDelta) >= vec2<f32>(depth * 0.25);
  if (any(edge)) {
    let coord = vec2<i32>(pixel);
    let extent = vec2<i32>(textureDimensions(sceneDepth));
    if (edge.x) { depthDelta.x = receiverAxisDepthDelta(coord, vec2<i32>(1, 0), depth, extent); }
    if (edge.y) { depthDelta.y = receiverAxisDepthDelta(coord, vec2<i32>(0, 1), depth, extent); }
  }
  if (screenToShadow.clipSplits.x < 0.0) {
    let viewDepth = receiverViewDepth(pixel, depth, clip);
    if (viewDepth > view.splitPlanes[count - 1u].x) { return 1.0; }
    let first = pickCascadeLayer(viewDepth, count);
    return shadeDirectionalLayer(pixel, clip, first, directionalCascadeBlend(first, count, viewDepth), depthDelta);
  }
  let split = screenToShadow.clipSplits;
  if (depth < split[count - 1u]) { return 1.0; }
  let first = select(0u, 1u, count > 1u && depth <= split.x) +
    select(0u, 1u, count > 2u && depth <= split.y) +
    select(0u, 1u, count > 3u && depth <= split.z);
  return shadeKnownCascade(pixel, depth, clip, first, count, depthDelta);
}

@fragment fn fs_main(in : FullscreenOutput) -> @location(0) f32 {
  return directionalVisibility(in.position.xy);
}

@fragment fn fs_directional_rgba(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(directionalVisibility(in.position.xy), 1.0, 1.0, 1.0);
}

@group(0) @binding(9) var ambientOcclusion : texture_2d<f32>;

@fragment fn fs_ao_alpha(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let visibility = textureLoad(ambientOcclusion, vec2<i32>(in.position.xy), 0).r;
  return vec4<f32>(0.0, 0.0, 0.0, visibility);
}

struct PunctualProjectionVertex {
  @builtin(position) position : vec4<f32>,
  @location(0) @interpolate(flat) lightSlot : u32,
};

@vertex fn vs_punctual(@builtin(vertex_index) index : u32,
    @builtin(instance_index) slot : u32) -> PunctualProjectionVertex {
  let clip = fullscreen_triangle(index).position;
  return PunctualProjectionVertex(vec4<f32>(clip.xy, 1.0, 1.0), slot);
}

const shadowFrustumTriangles = array<u32, 36>(
  0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
  0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
  0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5,
);

@vertex fn vs_spot_volume(@builtin(vertex_index) index : u32,
    @builtin(instance_index) slot : u32) -> PunctualProjectionVertex {
  let corner = shadowFrustumTriangles[index];
  let tile = lights[slot].metadata.y & 3u;
  let shadowClip = vec4<f32>(f32(corner & 1u) * 2.0 - 1.0,
    f32((corner >> 1u) & 1u) * 2.0 - 1.0, f32(corner >> 2u), 1.0);
  let clip = screenToShadow.spotVolume[tile] * shadowClip;
  return PunctualProjectionVertex(clip, slot);
}

const phi = 1.61803398875;
const sphereProxy = array<vec3<f32>, 12>(
  vec3<f32>(-1.0, phi, 0.0), vec3<f32>(1.0, phi, 0.0),
  vec3<f32>(-1.0, -phi, 0.0), vec3<f32>(1.0, -phi, 0.0),
  vec3<f32>(0.0, -1.0, phi), vec3<f32>(0.0, 1.0, phi),
  vec3<f32>(0.0, -1.0, -phi), vec3<f32>(0.0, 1.0, -phi),
  vec3<f32>(phi, 0.0, -1.0), vec3<f32>(phi, 0.0, 1.0),
  vec3<f32>(-phi, 0.0, -1.0), vec3<f32>(-phi, 0.0, 1.0),
);
const sphereProxyTriangles = array<u32, 60>(
  0,11,5, 0,5,1, 0,1,7, 0,7,10, 0,10,11,
  1,5,9, 5,11,4, 11,10,2, 10,7,6, 7,1,8,
  3,9,4, 3,4,2, 3,2,6, 3,6,8, 3,8,9,
  4,9,5, 2,4,11, 6,2,10, 8,6,7, 9,8,1,
);

@vertex fn vs_point_volume(@builtin(vertex_index) index : u32,
    @builtin(instance_index) slot : u32) -> PunctualProjectionVertex {
  let light = lights[slot];
  // 0.662 expands the inradius of the proxy to at least the light radius.
  let n = sphereProxy[sphereProxyTriangles[index]];
  let world = light.position.xyz + (0.662 * inverseSqrt(light.position.w)) * n;
  let clip = view.worldViewProj * vec4<f32>(world, 1.0);
  return PunctualProjectionVertex(clip, slot);
}

struct PunctualReceiver {
  clip : vec4<f32>,
  position : vec3<f32>,
  covered : bool,
};

fn punctualReceiver(in : PunctualProjectionVertex, light : DirectLightSlot) -> PunctualReceiver {
  let depth = textureLoad(sceneDepth, vec2<i32>(in.position.xy), 0);
  if (depth <= 0.0) { return PunctualReceiver(vec4<f32>(0.0), vec3<f32>(0.0), false); }
  let clip = receiverClip(in.position.xy, depth);
  let homogeneous = view.inverseViewProj * clip;
  let position = homogeneous.xyz / homogeneous.w;
  return PunctualReceiver(clip, position,
    punctualRangeReaches(light.position.xyz, position, light.position.w));
}

fn pointProjection(pixel : vec2<f32>, light : DirectLightSlot, receiver : PunctualReceiver,
    basic : bool) -> vec4<f32> {
  let layer = bitcast<i32>(light.metadata.y);
  let shadow = shadowParams[layer];
  let controls = shadowParams[4 + layer];
  let visibility = pointShadowVisibility(light.position.xyz, receiver.position, vec3<f32>(0.0),
    layer, shadow.x, shadow.y, shadow.z, 0.0, vec4<f32>(select(controls.x, 1.0, basic), controls.yzw),
    shadowParams[12 + layer].xyz, pixel);
  return vec4<f32>(mix(1.0, visibility, screenToShadow.pointFade[layer]));
}

@fragment fn fs_point(in : PunctualProjectionVertex) -> @location(0) vec4<f32> {
  let light = lights[in.lightSlot];
  let receiver = punctualReceiver(in, light);
  if (!receiver.covered) { discard; }
  return pointProjection(in.position.xy, light, receiver, false);
}

@fragment fn fs_point_basic(in : PunctualProjectionVertex) -> @location(0) vec4<f32> {
  let light = lights[in.lightSlot];
  let receiver = punctualReceiver(in, light);
  if (!receiver.covered) { discard; }
  return pointProjection(in.position.xy, light, receiver, true);
}

fn spotReceiver(in : PunctualProjectionVertex, light : DirectLightSlot) -> PunctualReceiver {
  var receiver = punctualReceiver(in, light);
  receiver.covered = receiver.covered && spotConeReaches(light.position.xyz, light.direction.xyz,
    light.colorTimesIntensity.w, light.direction.w, receiver.position);
  return receiver;
}

fn spotVisibility(pixel : vec2<f32>, light : DirectLightSlot, receiver : PunctualReceiver,
    tile : i32, filterParams : vec4<f32>) -> vec4<f32> {
  let clip = screenToShadow.spot[u32(tile)] * receiver.clip;
  let intensity = light.auxiliary.z * screenToShadow.spotFade[tile];
  return vec4<f32>(spotShadowVisibilityAtClip(clipFromShadowUv(clip),
    tile, light.auxiliary.x, filterParams, intensity, pixel));
}

@fragment fn fs_spot(in : PunctualProjectionVertex) -> @location(0) vec4<f32> {
  let light = lights[in.lightSlot];
  let receiver = spotReceiver(in, light);
  if (!receiver.covered) { discard; }
  let tile = i32(light.metadata.y & 3u);
  return spotVisibility(in.position.xy, light, receiver, tile, shadowParams[8 + tile]);
}

@fragment fn fs_spot_compact(in : PunctualProjectionVertex) -> @location(0) vec4<f32> {
  let light = lights[in.lightSlot];
  let receiver = spotReceiver(in, light);
  if (!receiver.covered) { discard; }
  let tile = i32(light.metadata.y & 3u);
  let filterParams = spotDefaultShadowParams(light.metadata.x);
  return spotVisibility(in.position.xy, light, receiver, tile, filterParams);
}

// Screen-projected Spots use the fixed 3x3 PCF footprint with native depth
// comparisons. Their perspective depth keeps the existing receiver bias.
@fragment fn fs_spot_gather(in : PunctualProjectionVertex) -> @location(0) vec4<f32> {
  let light = lights[in.lightSlot];
  let receiver = spotReceiver(in, light);
  if (!receiver.covered) { discard; }
  let tile = i32(light.metadata.y & 3u);
  let clip = screenToShadow.spot[tile] * receiver.clip;
  let projected = clip.xyz / clip.w;
  if (!(all(projected >= vec3<f32>(0.0)) && all(projected <= vec3<f32>(1.0)))) { return vec4<f32>(1.0); }
  let footprint = projected.xy * screenToShadow.atlas.z - 0.5;
  let phase = fract(footprint);
  let center = (floor(footprint) + 1.0) * screenToShadow.atlas.w;
  let depth = projected.z + light.auxiliary.x;
  let top = projectionRow(
    textureGatherCompare(spotShadowMap, shadowSampler, center, tile, depth, vec2<i32>(-1, -1)),
    textureGatherCompare(spotShadowMap, shadowSampler, center, tile, depth, vec2<i32>(1, -1)), phase.x);
  let bottom = projectionRow(
    textureGatherCompare(spotShadowMap, shadowSampler, center, tile, depth, vec2<i32>(-1, 1)),
    textureGatherCompare(spotShadowMap, shadowSampler, center, tile, depth, vec2<i32>(1, 1)), phase.x);
  let visibility = (top.x * (1.0 - phase.y) + top.y + bottom.x + bottom.y * phase.y) * (1.0 / 9.0);
  return vec4<f32>(mix(1.0, visibility, light.auxiliary.z * screenToShadow.spotFade[tile]));
}
