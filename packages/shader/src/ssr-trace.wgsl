#define_import_path forgeax_ssr::trace
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, decodeStandardNormalRoughness, loadStandardSceneSurfaceValid, loadCompactGBufferRoughness}
#import forgeax_scene_temporal::{unpackSceneTemporalV1}
#import forgeax_depth_pyramid::sample::{
  DEPTH_PYRAMID_EMPTY_DEPTH,
  linearizeViewDepth,
  depthPyramidCell,
  depthPyramidDepthOrEmpty,
  depthPyramidLevelSize,
}

// The spatial trace is bounded by the public M1 contract.
const SSR_TRACE_MAX_REFINE_STEPS : u32 = 5u;
const SSR_TRACE_MAX_HIZ_ITERATIONS : u32 = 64u;
// Without a depth hierarchy (maxTraceLevel == 0) the traversal degenerates to a
// texel-by-texel march, so it needs one iteration per texel of the projected span.
const SSR_TRACE_MAX_LINEAR_ITERATIONS : u32 = 1024u;

@group(0) @binding(0) var sceneDepth : texture_depth_2d;
@group(0) @binding(1) var sceneNormal : texture_2d<u32>;
@group(0) @binding(14) var defaultGBufferB : texture_2d<u32>;
@group(0) @binding(2) var sceneColor : texture_2d<f32>;
@group(0) @binding(3) var depthPyramid : texture_2d<f32>;
#if !PORTABLE_FRAGMENT
@group(0) @binding(4) var traceOutput : texture_storage_2d<rgba16float, write>;
#endif

// This is the existing Standard View UBO, not a second camera state source.
// The shader only consumes world/inverse projection and the validated SSR
// parameter tail published by the record stage.
#import forgeax_view::common::View
@group(0) @binding(5) var<uniform> view : View;
// RGB belongs to lighting; alpha is its exact Standard material coverage.
@group(0) @binding(6) var reflectionFallback : texture_2d<f32>;
@group(0) @binding(7) var sceneTemporal : texture_2d<f32>;
// Motion at a radiance source invalidates reflection history even when the
// receiver is stationary. This scalar is reactivity, not reflected velocity.
#if !PORTABLE_FRAGMENT
@group(0) @binding(8) var hitReactivityOutput : texture_storage_2d<r32float, write>;
#endif

// The graph always publishes the complete floor-halved depth chain.
fn ssrDepthPyramidLevelCount() -> u32 {
#if PORTABLE_FRAGMENT
  let size = textureDimensions(depthPyramid, 0);
  var remaining = max(size.x, size.y);
  var levels = 0u;
  for (var bit = 0u; bit < 32u; bit++) {
    if (remaining == 0u) { break; }
    levels += 1u;
    remaining >>= 1u;
  }
  return levels;
#else
  return textureNumLevels(depthPyramid);
#endif
}

#if !PORTABLE_FRAGMENT
// Water owns receiver facts. Its hit hierarchy comes from opaque depth.
@group(0) @binding(9) var waterOriginDepth : texture_depth_2d;
@group(0) @binding(10) var waterOriginNormal : texture_2d<u32>;
@group(0) @binding(11) var waterOriginCoverage : texture_2d<f32>;
struct WaterSsrParams {
  historyUvScaleBias: vec4<f32>,
  historyUvClamp: vec4<f32>,
  hitColorUvScaleBias: vec4<f32>,
  hitColorUvClamp: vec4<f32>,
  hitColorParams: vec4<f32>,
  traceParams: vec4<f32>,
};
@group(0) @binding(12) var<uniform> waterParams: WaterSsrParams;
@group(0) @binding(13) var waterSceneColorHistory: texture_2d<f32>;
#endif

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn finiteConfidence(value : f32) -> f32 {
  return select(0.0, clamp(value, 0.0, 1.0), isFinite(value));
}

fn traceConfidence(
  hit : f32,
  thickness : f32,
  edge : f32,
  roughness : f32,
  temporal : f32,
) -> f32 {
  let factors = vec2<f32>(hit, thickness);
  let spatial = vec3<f32>(edge, roughness, temporal);
  if (!isFinite(factors.x) || !isFinite(factors.y) ||
      !isFinite(spatial.x) || !isFinite(spatial.y) || !isFinite(spatial.z)) {
    return 0.0;
  }
  return finiteConfidence(factors.x) * finiteConfidence(factors.y) *
    finiteConfidence(spatial.x) * finiteConfidence(spatial.y) *
    finiteConfidence(spatial.z);
}

// UE ComputeHitVignetteFromScreenPos: fade over the outer 20% of screen
// space per axis, combined radially.
fn traceEdge(uv : vec2<f32>) -> f32 {
  let vignette = clamp(abs(uv * 2.0 - 1.0) * 5.0 - 4.0, vec2<f32>(0.0), vec2<f32>(1.0));
  return clamp(1.0 - dot(vignette, vignette), 0.0, 1.0);
}

fn reconstructWorldPosition(uv : vec2<f32>, depth : f32) -> vec3<f32> {
  let clip = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let world = view.inverseViewProj * clip;
  if (!isFinite(world.w) || world.w == 0.0) {
    return vec3<f32>(0.0);
  }
  return world.xyz / world.w;
}

fn projectWorldPosition(worldPosition : vec3<f32>) -> vec2<f32> {
  let clip = view.worldViewProj * vec4<f32>(worldPosition, 1.0);
  if (!isFinite(clip.w) || clip.w <= 1e-5) {
    return vec2<f32>(-1.0);
  }
  let ndc = clip.xy / clip.w;
  return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

fn projectWorldViewDistance(worldPosition : vec3<f32>) -> f32 {
  let clip = view.worldViewProj * vec4<f32>(worldPosition, 1.0);
  if (!isFinite(clip.w) || clip.w <= 1e-5) {
    return 0.0;
  }
  // The depth pyramid stores positive linear view distance. Perspective clip.w
  // is that distance; orthographic clip.w is constant and needs the projection
  // range. Comparing clip.z / clip.w with the pyramid mixes normalized depth and world units
  // and rejects every visible ray in ordinary scenes more than one unit away.
  return select(
    clip.w,
    view.temporalProjection.y - (clip.z / clip.w) *
      (view.temporalProjection.y - view.temporalProjection.x),
    view.temporalProjection.z > 0.5,
  );
}

// Trace levels address one depth hierarchy for the march: level 0 is the
// full-resolution scene depth and level n is depth-pyramid level n - 1.
fn maxSsrTraceLevel(fullSize : vec2<u32>) -> u32 {
  let extent = max(fullSize.x, fullSize.y);
  if (extent <= 1u) {
    return 0u;
  }
  return u32(floor(log2(f32(extent))));
}

fn sampleSsrTraceDepth(uv : vec2<f32>, traceLevel : u32) -> f32 {
  if (traceLevel == 0u) {
    let size = textureDimensions(sceneDepth, 0);
    let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
    let depth = textureLoad(sceneDepth, pixel, 0);
    if (depth <= 0.0 || depth > 1.0) { return DEPTH_PYRAMID_EMPTY_DEPTH; }
    return linearizeViewDepth(depth, view.temporalProjection);
  }
  let level = min(traceLevel - 1u, ssrDepthPyramidLevelCount() - 1u);
  let cell = depthPyramidCell(uv, depthPyramidLevelSize(depthPyramid, level));
  return depthPyramidDepthOrEmpty(textureLoad(depthPyramid, vec2<i32>(cell), i32(level)).r);
}

struct SsrTraceHit {
  hit : f32,
  uv : vec2<f32>,
  thickness : f32,
  reactivity : f32,
};

fn ssrRayFraction(uv : vec2<f32>, startUv : vec2<f32>, deltaUv : vec2<f32>,
  fallback : f32, endFraction : f32) -> f32 {
  let useX = abs(deltaUv.x) >= abs(deltaUv.y) && abs(deltaUv.x) > 1e-8;
  let useY = !useX && abs(deltaUv.y) > 1e-8;
  let xFraction = select(fallback, (uv.x - startUv.x) / deltaUv.x, useX);
  let yFraction = select(fallback, (uv.y - startUv.y) / deltaUv.y, useY);
  let fraction = select(xFraction, yFraction, useY);
  return clamp(select(fallback, fraction, isFinite(fraction)), 0.0, endFraction);
}

fn ssrSourceReactivity(pixel : vec2<i32>) -> f32 {
  let temporal = textureLoad(sceneTemporal, pixel, 0);
  let speed = length(temporal.xy);
  if (!isFinite(speed) || !isFinite(temporal.z) || temporal.z < 0.0 || !isFinite(temporal.w)) {
    return 1.0;
  }
  return clamp(max(speed * 64.0, temporal.w), 0.0, 1.0);
}

fn ssrShadingNormalVaries(pixel : vec2<u32>, normal : vec3<f32>) -> bool {
  let size = vec2<i32>(textureDimensions(sceneDepth, 0));
  // Only a locally varying, similarly oriented field makes the tangent plane
  // uncertain. A flat face ending at sky must retain its exact silhouette;
  // thickness alone is not permission to extend that face into empty space.
  for (var axis = 0u; axis < 2u; axis++) {
    for (var sign = -1; sign <= 1; sign += 2) {
      var offset = vec2<i32>(0);
      offset[axis] = sign;
      let tap = vec2<i32>(pixel) + offset;
      if (any(tap < vec2<i32>(0)) || any(tap >= size)) { continue; }
      if (textureLoad(sceneDepth, tap, 0) <= 0.0 ||
          textureLoad(reflectionFallback, tap, 0).a <= 0.5) { continue; }
      if (!loadStandardSceneSurfaceValid(sceneNormal, tap)) { continue; }
      let neighbor = loadStandardNormalRoughness(sceneNormal, tap).xyz;
      let delta = neighbor - normal;
      let agreement = dot(neighbor, normal) * inverseSqrt(max(dot(neighbor, neighbor) * dot(normal, normal), 1e-8));
      if (agreement > 0.9 && dot(delta, delta) > 1e-6) { return true; }
    }
  }
  return false;
}

fn ssrGeometricNormal(pixel : vec2<u32>, normal : vec3<f32>) -> vec3<f32> {
  // Recover a depth tangent from the nearest same-facing neighbor per axis.
  // Missing support on either axis retains the original normal; it does not
  // authorize a depth-only hit through a silhouette or uncovered surface.
  let size = textureDimensions(sceneDepth, 0);
  let center = reconstructWorldPosition((vec2<f32>(pixel) + 0.5) / vec2<f32>(size),
    textureLoad(sceneDepth, vec2<i32>(pixel), 0));
  var derivatives : array<vec3<f32>, 2>;
  for (var axis = 0u; axis < 2u; axis++) {
    var shortest = 3.402823e+38;
    for (var sign = -1; sign <= 1; sign += 2) {
      var offset = vec2<i32>(0);
      offset[axis] = sign;
      let tap = vec2<i32>(pixel) + offset;
      if (any(tap < vec2<i32>(0)) || any(tap >= vec2<i32>(size))) { continue; }
      let depth = textureLoad(sceneDepth, tap, 0);
      if (!loadStandardSceneSurfaceValid(sceneNormal, tap)) { continue; }
      let tapNormal = loadStandardNormalRoughness(sceneNormal, tap).xyz;
      if (depth <= 0.0 || dot(normal, tapNormal) < 0.9) { continue; }
      let point = reconstructWorldPosition((vec2<f32>(tap) + 0.5) / vec2<f32>(size), depth);
      let delta = (point - center) * f32(sign);
      let distance = dot(delta, delta);
      if (distance < shortest) { shortest = distance; derivatives[axis] = delta; }
    }
  }
  let product = cross(derivatives[0], derivatives[1]);
  let lengthSquared = dot(product, product);
  if (lengthSquared <= 1e-16) { return normal; }
  let geometric = product * inverseSqrt(lengthSquared);
  return select(-geometric, geometric, dot(geometric, normal) >= 0.0);
}

struct SsrSurfaceIntersection {
  valid : bool,
  position : vec3<f32>,
  uv : vec2<f32>,
  pixel : vec2<u32>,
  depth : f32,
  normal : vec3<f32>,
}

fn ssrIntersectSurface(origin : vec3<f32>, direction : vec3<f32>, maxDistance : f32,
  fullSize : vec2<u32>, pixel : vec2<u32>, depth : f32,
  normal : vec3<f32>) -> SsrSurfaceIntersection {
  var candidate : SsrSurfaceIntersection;
  // A depth texel describes its center, not the subpixel march coordinate.
  // Refine against that sample's tangent plane, then validate the projected
  // intersection against the actual depth buffer. Otherwise a stair-stepped
  // depth crossing displaces high-frequency reflected texture coordinates.
  let centerUv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  let surface = reconstructWorldPosition(centerUv, depth);
  let planeDistance = dot(surface - origin, normal) / dot(direction, normal);
  if (!isFinite(planeDistance) || planeDistance <= 0.0 || planeDistance > maxDistance) { return candidate; }
  let intersection = origin + direction * planeDistance;
  let hitUv = projectWorldPosition(intersection);
  if (any(hitUv < vec2<f32>(0.0)) || any(hitUv >= vec2<f32>(1.0))) { return candidate; }
  let hitPixel = min(vec2<u32>(hitUv * vec2<f32>(fullSize)), fullSize - vec2<u32>(1u));
  if (!loadStandardSceneSurfaceValid(sceneNormal, vec2<i32>(hitPixel))) { return candidate; }
  let hitDepth = textureLoad(sceneDepth, vec2<i32>(hitPixel), 0);
  let hitNormal = loadStandardNormalRoughness(sceneNormal, vec2<i32>(hitPixel)).xyz;
  if (hitDepth <= 0.0 || dot(hitNormal, -direction) <= 0.0 ||
      textureLoad(reflectionFallback, vec2<i32>(hitPixel), 0).a <= 0.5) { return candidate; }
  return SsrSurfaceIntersection(true, intersection, hitUv, hitPixel, hitDepth, hitNormal);
}

fn ssrValidateSurfaceHit(candidate : SsrSurfaceIntersection, validationNormal : vec3<f32>,
  thickness : f32, fullSize : vec2<u32>, result : SsrTraceHit) -> SsrTraceHit {
  if (!candidate.valid) { return result; }
  // Depth belongs to the texel center. Compare the intersection with that
  // sample's plane, not a constant-depth point fabricated at its UV. The latter
  // lowers confidence on an exact oblique-plane hit as jitter moves inside
  // the texel, periodically exposing fallback beneath a static reflection.
  let hitCenterUv = (vec2<f32>(candidate.pixel) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  let hitSurface = reconstructWorldPosition(hitCenterUv, candidate.depth);
  let neighbor = reconstructWorldPosition(hitCenterUv + vec2<f32>(1.0 / f32(fullSize.x), 0.0), candidate.depth);
  let radius = max(thickness, distance(hitSurface, neighbor) * 3.0);
  let separation = abs(dot(hitSurface - candidate.position, normalize(validationNormal)));
  if (!isFinite(separation) || separation > radius) { return result; }
  return SsrTraceHit(1.0, candidate.uv, 1.0, result.reactivity);
}

// Keep depth-normal recovery outside the flat tangent call graph. Software
// GPU compilers otherwise expand that recovery inside every coarse ray step,
// even when a boolean argument disables it at runtime.
fn ssrRefineHit(origin : vec3<f32>, direction : vec3<f32>, maxDistance : f32,
  thickness : f32, fullSize : vec2<u32>, pixel : vec2<u32>, depth : f32,
  normal : vec3<f32>, result : SsrTraceHit) -> SsrTraceHit {
  let candidate = ssrIntersectSurface(origin, direction, maxDistance, fullSize,
    pixel, depth, normal);
  return ssrValidateSurfaceHit(candidate, candidate.normal, thickness, fullSize, result);
}

fn ssrRefineGeometricHit(origin : vec3<f32>, direction : vec3<f32>, maxDistance : f32,
  thickness : f32, fullSize : vec2<u32>, pixel : vec2<u32>, depth : f32,
  normal : vec3<f32>, result : SsrTraceHit) -> SsrTraceHit {
  let candidate = ssrIntersectSurface(origin, direction, maxDistance, fullSize,
    pixel, depth, ssrGeometricNormal(pixel, normal));
  if (!candidate.valid) { return result; }
  return ssrValidateSurfaceHit(candidate, ssrGeometricNormal(candidate.pixel, candidate.normal),
    thickness, fullSize, result);
}

// Algorithm reference: Three.js SSRShader / SSRNode (MIT), inspected 2026-09-08:
// https://github.com/mrdoob/three.js/blob/4457aa3c5de4a05bbae4e0bee2d99d994c38a2bb/examples/jsm/tsl/display/SSRNode.js
// Projected-space stepping, reciprocal-depth interpolation, ray-distance
// thickness, and a separate crossing refinement avoid world-step holes.
// Mirror rays spend steps in proportion to their projected pixel span, as in
// Three's non-stochastic path. A small fixed budget stretches samples over
// thin silhouettes and can jump directly from in-front-of-wall to sky.
// The Hi-Z iteration and refine bounds, depth pyramid, material coverage, and BRDF owner remain explicit.
fn traceScreenRay(
  origin : vec3<f32>,
  direction : vec3<f32>,
  maxDistance : f32,
  thickness : f32,
  fullSize : vec2<u32>,
  coarsestDepth : f32,
  maxTraceLevel : u32,
) -> SsrTraceHit {
  var result = SsrTraceHit(0.0, vec2<f32>(0.0), 0.0, 0.0);
  if (!isFinite(maxDistance) || maxDistance <= 0.0 ||
      !isFinite(thickness) || thickness <= 0.0 || maxDistance < thickness ||
      !isFinite(coarsestDepth) || coarsestDepth <= 0.0) { return result; }
  let startDepth = projectWorldViewDistance(origin);
  let depthDirection = dot(vec3<f32>(view.worldViewProj[0].w,
    view.worldViewProj[1].w, view.worldViewProj[2].w), direction);
  // Like Unreal's RayCast (WorldTMax = SceneDepth), distant receivers get a
  // ray at least as long as their view depth; grazing ground keeps its reach.
  var rayLength = max(maxDistance, startDepth);
  if (depthDirection < -1e-5) {
    rayLength = min(rayLength, (startDepth - view.temporalProjection.x * 1.01) / -depthDirection);
  }
  if (rayLength <= 0.0) { return result; }
  let end = origin + direction * rayLength;
  let endDepth = projectWorldViewDistance(end);
  let startUv = projectWorldPosition(origin);
  let deltaUv = projectWorldPosition(end) - startUv;
  // Clip the projected segment to the viewport before spending the fixed budget.
  var endFraction = 1.0;
  if (deltaUv.x > 1e-6) { endFraction = min(endFraction, (1.0 - startUv.x) / deltaUv.x); }
  if (deltaUv.x < -1e-6) { endFraction = min(endFraction, -startUv.x / deltaUv.x); }
  if (deltaUv.y > 1e-6) { endFraction = min(endFraction, (1.0 - startUv.y) / deltaUv.y); }
  if (deltaUv.y < -1e-6) { endFraction = min(endFraction, -startUv.y / deltaUv.y); }
  let span = abs(deltaUv * endFraction * vec2<f32>(fullSize));
  let pixelSpan = max(span.x, span.y);
  let fullPixelSpan = max(abs(deltaUv.x) * f32(fullSize.x), abs(deltaUv.y) * f32(fullSize.y));
  if (!isFinite(fullPixelSpan) || fullPixelSpan <= 1e-5 || pixelSpan < 1.0) { return result; }
  let crossEpsilon = 1e-3 / fullPixelSpan;
  let moving = abs(deltaUv) > vec2<f32>(1e-8);
  let towardMax = deltaUv > vec2<f32>(0.0);
  let inverseStart = 1.0 / max(startDepth, 1e-5);
  let inverseEnd = 1.0 / max(endDepth, 1e-5);
  var lower = 0.0;
  var upper = 0.0;
  var found = false;
  // Leave the receiver texel before the first test: start at the exit of the
  // texel holding the ray origin. A whole pixel of the major axis would skip the
  // first part of the next texel, which a short or oblique ray may cross in.
  let originCell = min(vec2<u32>(clamp(startUv, vec2<f32>(0.0), vec2<f32>(1.0)) *
    vec2<f32>(fullSize)), fullSize - vec2<u32>(1u));
  let originBoundaryUv = (vec2<f32>(originCell) + select(vec2<f32>(0.0), vec2<f32>(1.0), towardMax)) /
    vec2<f32>(fullSize);
  let originExits = select(vec2<f32>(endFraction),
    (originBoundaryUv - startUv) / select(vec2<f32>(1.0), deltaUv, moving), moving);
  var t = clamp(min(originExits.x, originExits.y) + crossEpsilon, 0.0, endFraction);
  var level = 0u;
  let iterationBudget = select(u32(select(f32(SSR_TRACE_MAX_HIZ_ITERATIONS), view.ssrQuality.y, view.ssrQuality.y > 0.0)), u32(select(f32(SSR_TRACE_MAX_LINEAR_ITERATIONS), view.ssrQuality.z, view.ssrQuality.z > 0.0)),
    maxTraceLevel == 0u);
  // Keep the full traversal counter across candidate yields. The tangent-plane
  // validation stays outside the coarse march so native software compilers do
  // not expand its struct-return control flow inside every traversal step.
  var iteration = 0u;
  loop {
    var entryFraction : f32;
    var sampleFraction : f32;
    var exitFraction : f32;
    var rayMin : f32;
    var rayMax : f32;
    var sampleDepth : f32;
    var sampleUv : vec2<f32>;
    var pixel : vec2<u32>;
    var normal : vec3<f32>;
    var candidateReady = false;
    for (; iteration < SSR_TRACE_MAX_LINEAR_ITERATIONS; ) {
      if (t >= endFraction || iteration >= iterationBudget) { break; }
      iteration += 1u;
      entryFraction = t;
      let uv = startUv + deltaUv * t;
      var levelSize = fullSize;
      if (level > 0u) { levelSize = depthPyramidLevelSize(depthPyramid, level - 1u); }
      let cell = min(vec2<u32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(levelSize)),
        levelSize - vec2<u32>(1u));
      let boundaryUv = (vec2<f32>(cell) + select(vec2<f32>(0.0), vec2<f32>(1.0), towardMax)) /
        vec2<f32>(levelSize);
      let exitFractions = select(vec2<f32>(endFraction),
        (boundaryUv - startUv) / select(vec2<f32>(1.0), deltaUv, moving), moving);
      exitFraction = clamp(min(exitFractions.x, exitFractions.y), t, endFraction);
      // Reciprocal depth is linear along the projected segment, so the segment's
      // depth range is bounded by its endpoints.
      let entryDepth = 1.0 / mix(inverseStart, inverseEnd, t);
      let exitDepth = 1.0 / mix(inverseStart, inverseEnd, exitFraction);
      rayMin = min(entryDepth, exitDepth);
      rayMax = max(entryDepth, exitDepth);
      let cellCenterUv = (vec2<f32>(cell) + vec2<f32>(0.5)) / vec2<f32>(levelSize);
      // Closest-depth cells cover their whole integer footprint, so a cell
      // behind the segment's far end proves no texel in it is crossed.
      // At full resolution the centre depth is not the texel's depth range (an
      // oblique plane varies across it), so the exact tests below decide.
      if (level > 0u && sampleSsrTraceDepth(cellCenterUv, level) > rayMax) {
        t = exitFraction + crossEpsilon;
        level = min(level + 1u, maxTraceLevel);
        continue;
      }
      if (level > 0u) {
        level -= 1u;
        continue;
      }
      // Full-resolution texel whose depth the segment reaches.
      pixel = cell;
      sampleDepth = textureLoad(sceneDepth, vec2<i32>(pixel), 0);
      sampleUv = cellCenterUv;
      sampleFraction = clamp(ssrRayFraction(sampleUv, startUv, deltaUv, t, endFraction),
        entryFraction, exitFraction);
      t = exitFraction + crossEpsilon;
      // Climb again after every full-resolution texel so empty space is skipped.
      level = min(1u, maxTraceLevel);
      if (sampleDepth <= 0.0 || sampleDepth > 1.0 ||
          textureLoad(reflectionFallback, vec2<i32>(pixel), 0).a <= 0.5) { continue; }
      let surfaceViewDepth = linearizeViewDepth(sampleDepth, view.temporalProjection);
      // Already behind this surface for the whole texel: an occluder thicker
      // than the authored thickness hides what lies beyond, keep marching.
      if (rayMin > surfaceViewDepth + thickness) { continue; }
      // A moving occluder can invalidate yesterday's hit even when its back
      // face or depth separation rejects today's radiance. Preserve that
      // evidence on misses; sky and samples beyond the ray interval contribute
      // nothing. This does not admit the occluder as a reflection source.
      result.reactivity = max(result.reactivity, ssrSourceReactivity(vec2<i32>(pixel)));
      normal = loadStandardNormalRoughness(sceneNormal, vec2<i32>(pixel)).xyz;
      if (dot(normal, -direction) <= 0.0) { continue; }
      candidateReady = true;
      break;
    }
    if (!candidateReady) { break; }
    // Intersect the texel's tangent plane; accept it when the intersection
    // stays within one texel of the crossed segment.
    let planeHit = ssrRefineHit(origin, direction, rayLength, thickness, fullSize,
      pixel, sampleDepth, normal, result);
    if (planeHit.hit > 0.0) {
      let slack = 1.0 / fullPixelSpan;
      let planeFraction = ssrRayFraction(planeHit.uv, startUv, deltaUv, sampleFraction, endFraction);
      if (planeFraction >= entryFraction - slack &&
          planeFraction <= exitFraction + slack) {
        return planeHit;
      }
    }
    let surface = reconstructWorldPosition(sampleUv, sampleDepth);
    let neighbor = reconstructWorldPosition(sampleUv + vec2<f32>(1.0 / f32(fullSize.x), 0.0), sampleDepth);
    // The traversal proved the ray's depth range over this texel contains the
    // surface (or lies within thickness behind it). A grazing texel spans
    // that whole depth range, so the perpendicular tolerance scales with it,
    // like Unreal's slope-scaled CompareTolerance; 1.5 covers the off-axis
    // camera ray (depth gap / cos).
    let crossingTolerance = (rayMax - rayMin) * 1.5;
    let radius = max(max(thickness, distance(surface, neighbor) * 3.0), crossingTolerance);
    let separation = length(cross(surface - origin, direction));
    if (!isFinite(separation) || separation > radius) { continue; }
    lower = entryFraction;
    upper = exitFraction;
    found = true;
    break;
  }
  if (!found) { return result; }
  // Depth crossing refinement is intentionally outside the march loop.
  for (var refine = 0u; refine < u32(select(f32(SSR_TRACE_MAX_REFINE_STEPS), view.ssrQuality.w, view.ssrQuality.w > 0.0)); refine++) {
    let middle = (lower + upper) * 0.5;
    let uv = startUv + deltaUv * middle;
    let pixel = min(vec2<u32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) *
      vec2<f32>(fullSize)), fullSize - vec2<u32>(1u));
    let surfaceDepth = sampleSsrTraceDepth(uv, 0u);
    let rayDepth = 1.0 / mix(inverseStart, inverseEnd, middle);
    // A depth crossing on a rejected surface is not the accepted bracket.
    // Near contact points, depth-only bisection can walk backward onto the
    // receiver even though the coarse step correctly found the facing wall.
    let normal = loadStandardNormalRoughness(sceneNormal, vec2<i32>(pixel)).xyz;
    let covered = textureLoad(reflectionFallback, vec2<i32>(pixel), 0).a > 0.5;
    if (rayDepth >= surfaceDepth && covered && dot(normal, -direction) > 0.0) {
      upper = middle;
    } else {
      lower = middle;
    }
  }
  let uv = startUv + deltaUv * upper;
  let pixel = min(vec2<u32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) *
    vec2<f32>(fullSize)), fullSize - vec2<u32>(1u));
  let depth = textureLoad(sceneDepth, vec2<i32>(pixel), 0);
  let normal = loadStandardNormalRoughness(sceneNormal, vec2<i32>(pixel)).xyz;
  let covered = textureLoad(reflectionFallback, vec2<i32>(pixel), 0).a > 0.5;
  if (depth <= 0.0 || dot(normal, -direction) <= 0.0 || !covered) { return result; }
  // Preserve successful refinement and exact flat-face silhouettes. Smooth
  // shading can point a failed correction away from the depth surface; retry
  // with depth geometry, under the same source, facing and thickness checks.
  let refined = ssrRefineHit(origin, direction, rayLength, thickness, fullSize,
    pixel, depth, normal, result);
  if (refined.hit > 0.0 || !ssrShadingNormalVaries(pixel, normal)) {
    return refined;
  }
  return ssrRefineGeometricHit(origin, direction, rayLength, thickness, fullSize,
    pixel, depth, normal, result);
}

fn ssrHitTapAdmitted(pixel : vec2<i32>, rayDirection : vec3<f32>) -> bool {
  if (!loadStandardSceneSurfaceValid(sceneNormal, pixel)) { return false; }
  let normal = loadStandardNormalRoughness(sceneNormal, pixel).xyz;
  return textureLoad(reflectionFallback, pixel, 0).a > 0.5 && dot(normal, -rayDirection) > 0.0;
}

struct SsrHitSample {
  color : vec4<f32>,
  reactivity : f32,
};

fn sampleSsrHitSample(uv : vec2<f32>, rayDirection : vec3<f32>) -> SsrHitSample {
  // Like Three's colorNode.sample(hitUv), retain the refined subpixel hit.
  // Explicit bilinear loads preserve the existing sampler-free compute ABI.
  // Color and source reactivity use the same four admitted texels, so keep one
  // footprint walk instead of reloading normal/coverage for a second
  // independent reactivity pass. Preserve the old zero-weight guard for the
  // reactivity max; a zero-weight moving neighbor must not invalidate history.
  // Roughness filtering still belongs to the reflection-only mip pyramid.
  let size = vec2<i32>(textureDimensions(sceneColor, 0));
  let position = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(position));
  let fraction = fract(position);
  let last = size - vec2<i32>(1);
  var sum = vec4<f32>(0.0);
  var reactivity = 0.0;
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 2; x++) {
      let pixel = clamp(first + vec2<i32>(x, y), vec2<i32>(0), last);
      // Match the trace's Standard source-coverage admission for every tap.
      // Sky/background color is not hit radiance. Preserve its missing area
      // as confidence so composition supplies the receiver's own fallback.
      if (!ssrHitTapAdmitted(pixel, rayDirection)) {
        continue;
      }
      let weight = select(1.0 - fraction.x, fraction.x, x == 1) * select(1.0 - fraction.y, fraction.y, y == 1);
      let color = textureLoad(sceneColor, pixel, 0).rgb;
      sum += vec4<f32>(color * weight, weight);
      if (weight > 0.0) {
        reactivity = max(reactivity, ssrSourceReactivity(pixel));
      }
    }
  }
  return SsrHitSample(vec4<f32>(sum.rgb / max(sum.a, 1e-6), sum.a), reactivity);
}

#if !PORTABLE_FRAGMENT
fn waterScreenVignette(uv: vec2<f32>) -> f32 {
  let edge = clamp(abs(uv * 2.0 - vec2<f32>(1.0)) * 5.0 - vec2<f32>(4.0), vec2<f32>(0.0), vec2<f32>(1.0));
  return clamp(1.0 - dot(edge, edge), 0.0, 1.0);
}

fn waterReflectionRoughnessFade(roughness: f32, maximumRoughness: f32) -> f32 {
  return clamp(2.0 - 2.0 * waterParams.traceParams.z * roughness / clamp(maximumRoughness, 0.01, 1.0), 0.0, 1.0);
}

fn waterReflectionWeight(hitUv: vec2<f32>, colorUv: vec2<f32>, roughness: f32, maximumRoughness: f32) -> f32 {
  return waterReflectionRoughnessFade(roughness, maximumRoughness) * waterParams.hitColorParams.z *
    min(waterScreenVignette(hitUv), waterScreenVignette(colorUv));
}

fn sampleWaterHitColor(image: texture_2d<f32>, uv: vec2<f32>) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(image));
  let coordinate = uv * vec2<f32>(size) - vec2<f32>(0.5);
  let first = vec2<i32>(floor(coordinate));
  let fraction = fract(coordinate);
  let last = size - vec2<i32>(1);
  let top = mix(textureLoad(image, clamp(first, vec2<i32>(0), last), 0).rgb,
    textureLoad(image, clamp(first + vec2<i32>(1, 0), vec2<i32>(0), last), 0).rgb, fraction.x);
  let bottom = mix(textureLoad(image, clamp(first + vec2<i32>(0, 1), vec2<i32>(0), last), 0).rgb,
    textureLoad(image, clamp(first + vec2<i32>(1, 1), vec2<i32>(0), last), 0).rgb, fraction.x);
  return mix(top, bottom, fraction.y);
}

struct WaterSsrReceiver {
  valid: bool,
  origin: vec3<f32>,
  normal: vec3<f32>,
  toCamera: vec3<f32>,
  roughness: f32,
};

fn waterCameraForward() -> vec3<f32> {
  if (view.temporalProjection.z <= 0.5) {
    // Perspective clip.w is positive view distance. Its world-space row is
    // the camera axis and is unaffected by projection jitter.
    let direction = vec3<f32>(view.worldViewProj[0].w, view.worldViewProj[1].w, view.worldViewProj[2].w);
    let magnitude = length(direction);
    if (!isFinite(magnitude) || magnitude < 1e-8) { return vec3<f32>(0.0); }
    return direction / magnitude;
  }
  let nearH = view.inverseViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0);
  let farH = view.inverseViewProj * vec4<f32>(0.0, 0.0, 0.5, 1.0);
  if (!isFinite(nearH.w) || !isFinite(farH.w) || abs(nearH.w) < 1e-8 || abs(farH.w) < 1e-8) {
    return vec3<f32>(0.0);
  }
  let direction = farH.xyz / farH.w - nearH.xyz / nearH.w;
  let magnitude = length(direction);
  if (!isFinite(magnitude) || magnitude < 1e-8) { return vec3<f32>(0.0); }
  return direction / magnitude;
}

fn waterSsrReceiver(pixel: vec2<i32>, size: vec2<u32>) -> WaterSsrReceiver {
  var result: WaterSsrReceiver;
  let depth = textureLoad(waterOriginDepth, pixel, 0);
  let normal = decodeStandardNormalRoughness(textureLoad(waterOriginNormal, pixel, 0).r);
  let normalLength = length(normal.xyz);
  if (textureLoad(waterOriginCoverage, pixel, 0).r <= 0.0 || !isFinite(depth) || depth <= 0.0 ||
      !isFinite(normalLength) || normalLength < 1e-6 || !isFinite(normal.a) ||
      !isFinite(view.ssrParams.w) || view.ssrParams.w <= 0.5 || view.ssrParams.z <= 0.0) { return result; }
  let uv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(size);
  let origin = reconstructWorldPosition(uv, depth);
  let toCamera = select(view.cameraPos - origin, -waterCameraForward(), view.temporalProjection.z > 0.5);
  let cameraDistance = length(toCamera);
  if (!isFinite(cameraDistance) || cameraDistance < 1e-6) { return result; }
  return WaterSsrReceiver(true, origin, normal.xyz / normalLength, toCamera / cameraDistance, normal.a);
}

fn waterRayScreenClipFactor(start: vec2<f32>, step: vec2<f32>) -> f32 {
  let inverseLength = 0.5 * length(step);
  if (inverseLength < 1e-8) { return 1.0; }
  let scale = vec2<f32>(1.0) - max(abs(step + start * inverseLength) - vec2<f32>(inverseLength),
    vec2<f32>(0.0)) / max(abs(step), vec2<f32>(1e-8));
  return min(scale.x, scale.y) / inverseLength;
}

// Point-clamped HZB sampling selects one texel and the nearest explicit mip.
// Furthest positive view distance +inf is UE's reversed-Z empty value (zero).
fn waterFurthestDeviceDepth(uv: vec2<f32>, mip: f32) -> f32 {
  let level = min(u32(max(round(mip), 0.0)), textureNumLevels(depthPyramid) - 1u);
  let size = depthPyramidLevelSize(depthPyramid, level);
  let cell = depthPyramidCell(uv, size);
  let depth = textureLoad(depthPyramid, vec2<i32>(cell), i32(level)).r;
  if (!isFinite(depth) || depth <= 0.0) { return 0.0; }
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  return select((near / depth - near / far) / (1.0 - near / far),
    (far - depth) / (far - near), view.temporalProjection.z > 0.5);
}

struct WaterSsrHit {
  found: bool,
  uv: vec2<f32>,
  depth: f32,
};

// UE's active SSR cast tests four consecutive samples per batch. Each pair
// advances its explicit HZB mip; the first accepted depth interval interpolates
// adjacent differences. This consumer never enters the closest-depth rescue.
fn traceWaterProjectedRay(start: vec3<f32>, step: vec3<f32>, numSteps: u32,
  roughness: f32, stepOffset: f32, tolerance: f32) -> WaterSsrHit {
  var previousDiff = 0.0;
  var previousTime = stepOffset;
  let mipStep = 8.0 / f32(numSteps) * roughness;
  for (var batch = 0u; batch < numSteps; batch += 4u) {
    var differences: array<f32, 4>;
    var candidates: array<bool, 4>;
    for (var tap = 0u; tap < 4u; tap++) {
      let time = f32(batch + tap + 1u) + stepOffset;
      let position = start + step * time;
      let onscreen = all(position.xy >= vec2<f32>(0.0)) && all(position.xy < vec2<f32>(1.0));
      var sampledDepth = 0.0;
      if (onscreen) {
        sampledDepth = waterFurthestDeviceDepth(position.xy, 1.0 + f32((batch + tap) / 2u) * mipStep);
      }
      let difference = position.z - sampledDepth;
      differences[tap] = difference;
      candidates[tap] = batch + tap < numSteps && onscreen && sampledDepth != 0.0 &&
        abs(difference + tolerance) < tolerance;
    }
    for (var tap = 0u; tap < 4u; tap++) {
      let time = f32(batch + tap + 1u) + stepOffset;
      let difference = differences[tap];
      if (candidates[tap]) {
        let denominator = previousDiff - difference;
        let blend = clamp(select(0.0, previousDiff / denominator, abs(denominator) > 1e-8), 0.0, 1.0);
        let position = start + step * mix(previousTime, time, blend);
        return WaterSsrHit(true, position.xy, position.z);
      }
      previousDiff = difference;
      previousTime = time;
    }
  }
  return WaterSsrHit(false, vec2<f32>(0.0), 0.0);
}

fn waterTraceNoise(pixel: vec2<i32>) -> f32 {
  let frame = f32(u32(waterParams.hitColorParams.w) % 8u);
  let position = vec2<f32>(pixel) + vec2<f32>(0.5) + frame * vec2<f32>(47.0, 17.0) * 0.695;
  return fract(52.9829189 * fract(dot(position, vec2<f32>(0.06711056, 0.00583715)))) - 0.5;
}

fn traceWaterWorldRay(receiver: WaterSsrReceiver, pixel: vec2<i32>) -> WaterSsrHit {
  let miss = WaterSsrHit(false, vec2<f32>(0.0), 0.0);
  let maximumDistance = view.ssrParams.x;
  let numSteps = u32(waterParams.traceParams.x);
  let forward = waterCameraForward();
  if (!isFinite(maximumDistance) || maximumDistance <= 0.0 || numSteps == 0u ||
      dot(forward, forward) < 0.5) { return miss; }
  // Medium quality is a single mirror ray. Roughness controls the HZB mip and
  // reflection fade; visible-GGX ray sampling belongs to the higher qualities.
  let direction = reflect(-receiver.toCamera, receiver.normal);
  let viewDirectionZ = dot(direction, forward);
  let sceneDepth = projectWorldViewDistance(receiver.origin);
  var rayDistance = maximumDistance;
  if (viewDirectionZ < 0.0) {
    rayDistance = min(-0.95 * sceneDepth / viewDirectionZ, maximumDistance);
  }
  let startClip = view.worldViewProj * vec4<f32>(receiver.origin, 1.0);
  let endClip = view.worldViewProj * vec4<f32>(receiver.origin + direction * rayDistance, 1.0);
  // Project an equal forward depth excursion to obtain the source's slope
  // tolerance without uploading a second camera or projection matrix.
  let depthClip = startClip + view.worldViewProj * vec4<f32>(forward * rayDistance, 0.0);
  if (!isFinite(startClip.w) || startClip.w <= 1e-8 || !isFinite(endClip.w) || endClip.w <= 1e-8 ||
      !isFinite(depthClip.w) || depthClip.w <= 1e-8) { return miss; }
  let startScreen = startClip.xyz / startClip.w;
  let endScreen = endClip.xyz / endClip.w;
  let depthScreen = depthClip.z / depthClip.w;
  var screenStep = endScreen - startScreen;
  // The source SSR path extends its projected ray to the screen edge.
  screenStep *= waterRayScreenClipFactor(startScreen.xy, screenStep.xy);
  let slopeTolerance = (startScreen.z - depthScreen) * 4.0;
  let compareTolerance = select(max(abs(screenStep.z), slopeTolerance), max(0.0, slopeTolerance),
    view.temporalProjection.z > 0.5) / f32(numSteps);
  let start = vec3<f32>(startScreen.xy * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5), startScreen.z);
  let step = vec3<f32>(screenStep.xy * vec2<f32>(0.5, -0.5), screenStep.z) / f32(numSteps);
  if (!isFinite(compareTolerance) || compareTolerance <= 0.0 ||
      !all(vec3<bool>(isFinite(step.x), isFinite(step.y), isFinite(step.z)))) { return miss; }
  return traceWaterProjectedRay(start, step, numSteps, receiver.roughness, waterTraceNoise(pixel), compareTolerance);
}

fn waterHitPreviousScreen(hit: WaterSsrHit) -> vec2<f32> {
  let rawHitClip = vec4<f32>(hit.uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), hit.depth, 1.0);
  let rasterWorldH = view.inverseViewProj * rawHitClip;
  let currentNoAaClip = view.temporalCurrentViewProj * rasterWorldH;
  if (!isFinite(currentNoAaClip.w) || currentNoAaClip.w <= 1e-8) { return vec2<f32>(-1.0); }
  // UE feeds the raw jittered hit to its no-AA ClipToPrevClip. With
  // M_raster = J * M_noAA, inverse(M_noAA) = inverse(M_raster) * J.
  // Recover J from the existing matrices, then apply it to the raw hit;
  // subtracting jitter from the hit would change the source behavior.
  let clipJitter = rawHitClip.xy - currentNoAaClip.xy / currentNoAaClip.w;
  let noAaWorldH = view.inverseViewProj * vec4<f32>(rawHitClip.xy + clipJitter, rawHitClip.zw);
  let previousClip = view.temporalPreviousViewProj * noAaWorldH;
  var previousUv = vec2<f32>(-1.0);
  if (isFinite(previousClip.w) && previousClip.w > 1e-8) {
    previousUv = previousClip.xy / previousClip.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  }
  let size = textureDimensions(sceneTemporal);
  let pixel = clamp(vec2<i32>(hit.uv * vec2<f32>(size)), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
  let temporal = unpackSceneTemporalV1(textureLoad(sceneTemporal, pixel, 0));
  if (temporal.validDepth && temporal.motionValid && isFinite(temporal.motionUv.x) && isFinite(temporal.motionUv.y)) {
    // Water can replace this shared temporal texel while the hit scene stays opaque.
    // The coarse ray depth is not the sampled layer's exact depth.
    let opaqueViewDepth = linearizeViewDepth(textureLoad(sceneDepth, pixel, 0), view.temporalProjection);
    if (opaqueViewDepth < DEPTH_PYRAMID_EMPTY_DEPTH && isFinite(temporal.viewDepth)) {
      let logDepth = log2(1.0 + opaqueViewDepth);
      let exponent = (bitcast<u32>(logDepth) >> 23u) & 255u;
      let logSpacing = bitcast<f32>((max(exponent, 113u) - 10u) << 23u);
      // One FP16 log-depth step covers attachment conversion, plus f32 reconstruction.
      let depthTolerance = (1.0 + opaqueViewDepth) * (exp2(logSpacing) - 1.0)
        + max(1e-6, opaqueViewDepth * 1e-6);
      if (abs(temporal.viewDepth - opaqueViewDepth) <= depthTolerance) {
        previousUv = hit.uv - temporal.motionUv;
      }
    }
  }
  return previousUv;
}

fn waterHitHistoryColor(screenUv: vec2<f32>) -> vec3<f32> {
  let uv = clamp(screenUv * waterParams.hitColorUvScaleBias.xy + waterParams.hitColorUvScaleBias.zw,
    waterParams.hitColorUvClamp.xy, waterParams.hitColorUvClamp.zw);
  return sampleWaterHitColor(waterSceneColorHistory, uv) * waterParams.hitColorParams.y;
}

fn waterCurrentReflection(hit: WaterSsrHit, roughness: f32) -> vec4<f32> {
  if (!hit.found) { return vec4<f32>(0.0); }
  let weight = waterReflectionWeight(hit.uv, hit.uv, roughness, view.ssrParams.z);
  let color = sampleWaterHitColor(sceneColor, hit.uv);
  if (!all(vec3<bool>(isFinite(color.r), isFinite(color.g), isFinite(color.b))) || !isFinite(weight)) {
    return vec4<f32>(0.0);
  }
  return vec4<f32>(color, 1.0) * weight;
}

fn waterHistoryReflection(hit: WaterSsrHit, roughness: f32) -> vec4<f32> {
  if (waterParams.hitColorParams.x <= 0.5) { return waterCurrentReflection(hit, roughness); }
  if (!hit.found) { return vec4<f32>(0.0); }
  let previousScreen = waterHitPreviousScreen(hit);
  let weight = waterReflectionWeight(hit.uv, previousScreen, roughness, view.ssrParams.z);
  let color = waterHitHistoryColor(previousScreen);
  if (!all(vec3<bool>(isFinite(color.r), isFinite(color.g), isFinite(color.b))) || !isFinite(weight)) {
    return vec4<f32>(0.0);
  }
  return vec4<f32>(color, 1.0) * weight;
}

fn storeWaterCurrentReflection(globalId: vec3<u32>) {
  let size = textureDimensions(sceneColor);
  if (any(globalId.xy >= size)) { return; }
  let pixel = vec2<i32>(globalId.xy);
  textureStore(hitReactivityOutput, pixel, vec4<f32>(0.0));
  var reflection = vec4<f32>(0.0);
  let receiver = waterSsrReceiver(pixel, size);
  if (receiver.valid && waterReflectionRoughnessFade(receiver.roughness, view.ssrParams.z) > 0.0) {
    reflection = waterCurrentReflection(traceWaterWorldRay(receiver, pixel), receiver.roughness);
  }
  textureStore(traceOutput, pixel, reflection);
}

fn storeWaterHistoryReflection(globalId: vec3<u32>) {
  let size = textureDimensions(sceneColor);
  if (any(globalId.xy >= size)) { return; }
  let pixel = vec2<i32>(globalId.xy);
  textureStore(hitReactivityOutput, pixel, vec4<f32>(0.0));
  var reflection = vec4<f32>(0.0);
  let receiver = waterSsrReceiver(pixel, size);
  if (receiver.valid && waterReflectionRoughnessFade(receiver.roughness, view.ssrParams.z) > 0.0) {
    reflection = waterHistoryReflection(traceWaterWorldRay(receiver, pixel), receiver.roughness);
  }
  textureStore(traceOutput, pixel, reflection);
}

#endif
struct SsrTraceOutput {
  @location(0) color : vec4<f32>,
  @location(1) reactivity : f32,
}
// Rec. 709 luminance, matching the TAA resolve's Karis weights.
fn ssrLuminance(rgb : vec3<f32>) -> f32 {
  return dot(rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Unreal SSRTReflections.usf: SampleColor.rgb *= rcp(1 + Luminance(SampleColor.rgb)).
// The inverse lives in ssr-compose.wgsl (ssrLuminanceUnweight).
fn ssrLuminanceWeight(rgb : vec3<f32>) -> vec3<f32> {
  return rgb / (1.0 + max(0.0, ssrLuminance(rgb)));
}

fn evaluateSsrTrace(globalId : vec3<u32>, context : texture_2d<u32>, compact : bool) -> SsrTraceOutput {
  var output = SsrTraceOutput(vec4<f32>(0.0), 0.0);
  let fullSize = textureDimensions(sceneColor, 0);
  let traceScale = select(1.0, view.ssrQuality.x, view.ssrQuality.x > 0.0);
  let traceSize = max(vec2<u32>(vec2<f32>(fullSize) * traceScale), vec2<u32>(1u));
  if (globalId.x >= traceSize.x || globalId.y >= traceSize.y) {
    return output;
  }
  output.reactivity = 0.0;
  let fullPixel = min(vec2<u32>((vec2<f32>(globalId.xy) + vec2<f32>(0.5)) * vec2<f32>(fullSize) / vec2<f32>(traceSize)), fullSize - vec2<u32>(1u));
  if (!loadStandardSceneSurfaceValid(sceneNormal, vec2<i32>(fullPixel))) { return output; }
  let coarsestLevel = ssrDepthPyramidLevelCount() - 1u;
  let maxTraceLevel = min(maxSsrTraceLevel(fullSize), coarsestLevel + 1u);
  let coarsestSize = depthPyramidLevelSize(depthPyramid, coarsestLevel);
  let coarsestPixel = min(globalId.xy, coarsestSize - vec2<u32>(1u));
  let depth = textureLoad(sceneDepth, vec2<i32>(fullPixel), 0);
  var normalData = loadStandardNormalRoughness(sceneNormal, vec2<i32>(fullPixel));
  if (compact) { normalData.w = loadCompactGBufferRoughness(context, vec2<i32>(fullPixel)); }
  let coverage = textureLoad(reflectionFallback, vec2<i32>(fullPixel), 0).a;
  let normalUnnormalized = normalData.xyz;
  let normalLength = length(normalUnnormalized);
  if (!isFinite(depth) || depth <= 0.0 || !isFinite(normalLength) || normalLength <= 1e-5 ||
      coverage <= 0.5 ||
      !isFinite(view.ssrParams.w) || view.ssrParams.w <= 0.5 ||
      !isFinite(normalData.a) || normalData.a >= view.ssrParams.z) {
    output.color = vec4<f32>(0.0);
    return output;
  }
  let normal = select(
    vec3<f32>(0.0, 0.0, 1.0),
    normalUnnormalized / normalLength,
    isFinite(normalLength) && normalLength > 1e-5,
  );
  let coarsestDepth = textureLoad(depthPyramid, vec2<i32>(coarsestPixel), i32(coarsestLevel)).r;
  let uv = (vec2<f32>(fullPixel) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  // The record-side sentinel is deliberately binary: a finite zero means the
  // authored effect is disabled, while any non-finite value must fail closed.
  // Do not turn a disabled-but-valid View tail into a one-frame SSR request.
  let enabled = select(0.0, 1.0, isFinite(view.ssrParams.w) && view.ssrParams.w > 0.5);
  let maxDistance = enabled * view.ssrParams.x;
  let thickness = enabled * view.ssrParams.y;
  let roughnessLimit = enabled * clamp(view.ssrParams.z, 0.0, 1.0);
  let worldPosition = reconstructWorldPosition(uv, depth);
  let viewDirectionRaw = view.cameraPos - worldPosition;
  let viewDirectionLength = length(viewDirectionRaw);
  let viewDirection = select(
    vec3<f32>(0.0, 0.0, 1.0),
    viewDirectionRaw / viewDirectionLength,
    isFinite(viewDirectionLength) && viewDirectionLength > 1e-5,
  );
  let reflectionDirection = normalize(reflect(-viewDirection, normal));
  // Keep the reflected line anchored to the shaded receiver. A normal offset
  // moves the projected hit across fine source texels. The march starts beyond
  // the origin and rejects back-facing sources, including this receiver plane.
  let hitResult = traceScreenRay(
    worldPosition,
    reflectionDirection,
    maxDistance,
    thickness,
    fullSize,
    coarsestDepth,
    maxTraceLevel,
  );
  let edge = traceEdge(hitResult.uv);
  output.reactivity = hitResult.reactivity;
  let roughness = finiteConfidence(
    select(
      0.0,
      // UE GetRoughnessFade: full SSR up to half the limit, linear to zero at it.
      min(2.0 - 2.0 * clamp(normalData.a, 0.0, 1.0) / max(roughnessLimit, 1e-5), 1.0),
      roughnessLimit > 0.0,
    ),
  );
  let temporal = 1.0;
  let confidence = traceConfidence(
    hitResult.hit,
    hitResult.thickness,
    edge,
    roughness,
    temporal,
  );
  if (confidence <= 0.0) {
    output.color = vec4<f32>(0.0);
    return output;
  }
  let hitSample = sampleSsrHitSample(hitResult.uv, reflectionDirection);
  let hitColor = hitSample.color;
  if (!all(vec3<bool>(isFinite(hitColor.r), isFinite(hitColor.g), isFinite(hitColor.b)))) {
    output.color = vec4<f32>(0.0);
    return output;
  }
  // Unreal SSRTReflections.usf: each reflection ray's hit color is weighted by
  // 1 / (1 + luminance) before any averaging, and ScreenSpaceReflections
  // composition inverts it after the filter. Every SSR filter after this
  // point (temporal history, neighborhood clamp, roughness pyramid,
  // trilinear fetch) averages in this space, so a lone HDR texel (specular
  // highlight, emissive) cannot dominate its neighborhood as a firefly while
  // a uniform bright surface round-trips exactly.
  output.color = vec4<f32>(ssrLuminanceWeight(hitColor.rgb), confidence * hitColor.a);
  output.reactivity = max(hitResult.reactivity, hitSample.reactivity);
  return output;
}
#if PORTABLE_FRAGMENT
@vertex fn ssr_fullscreen(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  let positions = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
  return vec4<f32>(positions[index], 0.0, 1.0);
}
@fragment fn ssr_trace_fragment(@builtin(position) position : vec4<f32>) -> SsrTraceOutput {
  return evaluateSsrTrace(vec3<u32>(vec2<u32>(position.xy), 0u), sceneNormal, false);
}
@fragment fn ssr_trace_fragment_compact(@builtin(position) position : vec4<f32>) -> SsrTraceOutput {
  return evaluateSsrTrace(vec3<u32>(vec2<u32>(position.xy), 0u), defaultGBufferB, true);
}
#else
fn storeOpaqueSsrTrace(globalId : vec3<u32>, context : texture_2d<u32>, compact : bool) {
  if (any(globalId.xy >= textureDimensions(traceOutput))) { return; }
  let output = evaluateSsrTrace(globalId, context, compact);
  textureStore(traceOutput, vec2<i32>(globalId.xy), output.color);
  textureStore(hitReactivityOutput, vec2<i32>(globalId.xy), vec4<f32>(output.reactivity));
}
@compute @workgroup_size(8, 8, 1)
fn ssr_trace(@builtin(global_invocation_id) globalId : vec3<u32>) {
  storeOpaqueSsrTrace(globalId, sceneNormal, false);
}
@compute @workgroup_size(8, 8, 1)
fn ssr_trace_compact(@builtin(global_invocation_id) globalId : vec3<u32>) {
  storeOpaqueSsrTrace(globalId, defaultGBufferB, true);
}
#endif

#if !PORTABLE_FRAGMENT
@compute @workgroup_size(8, 8, 1)
fn ssr_water_trace(@builtin(global_invocation_id) globalId: vec3<u32>) {
  storeWaterCurrentReflection(globalId);
}

@compute @workgroup_size(8, 8, 1)
fn ssr_water_trace_history(@builtin(global_invocation_id) globalId: vec3<u32>) {
  storeWaterHistoryReflection(globalId);
}
#endif
