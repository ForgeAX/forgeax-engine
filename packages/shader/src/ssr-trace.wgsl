#define_import_path forgeax_ssr::trace
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}
#import forgeax_depth_pyramid::sample::{
  DEPTH_PYRAMID_EMPTY_DEPTH,
  linearizeViewDepth,
  depthPyramidCell,
  depthPyramidDepthOrEmpty,
  depthPyramidFootprintEnd,
  depthPyramidFootprintStart,
  depthPyramidLevelSize,
}

// The spatial trace is bounded by the public M1 contract.
const SSR_TRACE_MAX_COARSE_STEPS : u32 = 48u;
const SSR_TRACE_MAX_REFINE_STEPS : u32 = 5u;

@group(0) @binding(0) var sceneDepth : texture_depth_2d;
@group(0) @binding(1) var sceneNormal : texture_2d<u32>;
@group(0) @binding(2) var sceneColor : texture_2d<f32>;
@group(0) @binding(3) var depthPyramid : texture_2d<f32>;
@group(0) @binding(4) var traceOutput : texture_storage_2d<rgba16float, write>;

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
@group(0) @binding(8) var hitReactivityOutput : texture_storage_2d<r32float, write>;

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn finiteConfidence(value : f32) -> f32 {
  return select(0.0, clamp(value, 0.0, 1.0), isFinite(value));
}

fn traceConfidence(
  hit : f32,
  thickness : f32,
  facing : f32,
  edge : f32,
  roughness : f32,
  temporal : f32,
) -> f32 {
  let factors = vec3<f32>(hit, thickness, facing);
  let spatial = vec3<f32>(edge, roughness, temporal);
  if (!isFinite(factors.x) || !isFinite(factors.y) || !isFinite(factors.z) ||
      !isFinite(spatial.x) || !isFinite(spatial.y) || !isFinite(spatial.z)) {
    return 0.0;
  }
  return finiteConfidence(factors.x) * finiteConfidence(factors.y) *
    finiteConfidence(factors.z) * finiteConfidence(spatial.x) *
    finiteConfidence(spatial.y) * finiteConfidence(spatial.z);
}

fn traceEdge(uv : vec2<f32>) -> f32 {
  let distanceToEdge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  return clamp(distanceToEdge * 8.0, 0.0, 1.0);
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
  let level = min(traceLevel - 1u, textureNumLevels(depthPyramid) - 1u);
  let cell = depthPyramidCell(uv, depthPyramidLevelSize(depthPyramid, level));
  return depthPyramidDepthOrEmpty(textureLoad(depthPyramid, vec2<i32>(cell), i32(level)).r);
}

struct SsrTraceHit {
  hit : f32,
  uv : vec2<f32>,
  thickness : f32,
  reactivity : f32,
};

struct SsrDepthCandidate {
  valid : bool,
  pixel : vec2<u32>,
  uv : vec2<f32>,
  depth : f32,
  fraction : f32,
};

fn ssrInvalidDepthCandidate() -> SsrDepthCandidate {
  return SsrDepthCandidate(false, vec2<u32>(0u), vec2<f32>(0.0), 1.0, 0.0);
}

fn ssrRayFraction(uv : vec2<f32>, startUv : vec2<f32>, deltaUv : vec2<f32>,
  fallback : f32, endFraction : f32) -> f32 {
  let useX = abs(deltaUv.x) >= abs(deltaUv.y) && abs(deltaUv.x) > 1e-8;
  let useY = !useX && abs(deltaUv.y) > 1e-8;
  let xFraction = select(fallback, (uv.x - startUv.x) / deltaUv.x, useX);
  let yFraction = select(fallback, (uv.y - startUv.y) / deltaUv.y, useY);
  let fraction = select(xFraction, yFraction, useY);
  return clamp(select(fallback, fraction, isFinite(fraction)), 0.0, endFraction);
}

fn ssrRescueCandidateInRay(origin : vec3<f32>, direction : vec3<f32>,
  rayLength : f32, surface : vec3<f32>, normal : vec3<f32>,
  fullSize : vec2<u32>, pixel : vec2<u32>) -> bool {
  // A rescue may bypass the generic bisection, so it must still prove that
  // the candidate's tangent plane intersects the finite reflected segment.
  // The projected pixel check rejects a neighboring silhouette plane whose
  // depth happens to be within the broad thickness radius.
  let denominator = dot(direction, normal);
  let planeDistance = dot(surface - origin, normal) / denominator;
  if (!isFinite(denominator) || abs(denominator) <= 1e-5 ||
      !isFinite(planeDistance) || planeDistance <= 0.0 || planeDistance > rayLength) {
    return false;
  }
  let projected = projectWorldPosition(origin + direction * planeDistance);
  if (any(projected < vec2<f32>(0.0)) || any(projected >= vec2<f32>(1.0))) { return false; }
  let projectedPixel = min(vec2<u32>(projected * vec2<f32>(fullSize)), fullSize - vec2<u32>(1u));
  return all(projectedPixel == pixel);
}

// When the coarse march lands on an empty full-resolution texel, descend the
// already-produced closest-depth pyramid to recover the child footprint that
// contains the nearest surface. This keeps the public 48-step budget while
// retaining thin projected features between coarse samples.
fn locateSsrPyramidCandidate(uv : vec2<f32>, coarseLevel : u32, fullSize : vec2<u32>,
  startUv : vec2<f32>, deltaUv : vec2<f32>, fallbackFraction : f32,
  endFraction : f32) -> SsrDepthCandidate {
  if (coarseLevel == 0u || textureNumLevels(depthPyramid) == 0u) {
    return ssrInvalidDepthCandidate();
  }
  let level = coarseLevel - 1u;
  let size = depthPyramidLevelSize(depthPyramid, level);
  var coordinate = depthPyramidCell(uv, size);
  let depth = textureLoad(depthPyramid, vec2<i32>(coordinate), i32(level)).r;
  if (!isFinite(depth) || depth <= 0.0) { return ssrInvalidDepthCandidate(); }

  // Each reduction level stores the minimum of its complete integer-normalized
  // child footprint. Select the child that owns that minimum rather than
  // assuming the parent's center is the hit location. The final level-0
  // candidate is still validated against the real depth/normal/coverage
  // buffers below.
  var parentSize = size;
  for (var descend = coarseLevel; descend > 1u; descend -= 1u) {
    let nextLevel = descend - 2u;
    let nextSize = depthPyramidLevelSize(depthPyramid, nextLevel);
    let childStart = depthPyramidFootprintStart(coordinate, nextSize, parentSize);
    let childEnd = depthPyramidFootprintEnd(coordinate, nextSize, parentSize);
    var childCoordinate = vec2<u32>(0u);
    var childDepth = DEPTH_PYRAMID_EMPTY_DEPTH;
    var childFound = false;
    for (var childY = childStart.y; childY < childEnd.y; childY += 1u) {
      for (var childX = childStart.x; childX < childEnd.x; childX += 1u) {
        let candidate = min(vec2<u32>(childX, childY), nextSize - vec2<u32>(1u));
        let candidateDepth = textureLoad(
          depthPyramid,
          vec2<i32>(candidate),
          i32(nextLevel),
        ).r;
        if (isFinite(candidateDepth) && candidateDepth > 0.0 && candidateDepth < childDepth) {
          childCoordinate = candidate;
          childDepth = candidateDepth;
          childFound = true;
        }
      }
    }
    if (!childFound) { return ssrInvalidDepthCandidate(); }
    coordinate = childCoordinate;
    parentSize = nextSize;
  }

  // Pyramid level 0 is seeded from the shared integer source footprint
  // (`depthPyramidFootprintStart`/`End` over the full-resolution depth). Even dimensions are 2x2, while odd dimensions use the same
  // conservative ceil-end overlap as every reduction level. Its minimum depth
  // is not necessarily the footprint center, so select the actual nearest
  // valid source texel before validating coverage/normal.
  let pyramidSize = textureDimensions(depthPyramid, 0);
  let sourceStart = depthPyramidFootprintStart(coordinate, fullSize, pyramidSize);
  let sourceEnd = depthPyramidFootprintEnd(coordinate, fullSize, pyramidSize);
  var candidatePixel = sourceStart;
  var candidateRawDepth = 0.0;
  for (var sourceY = sourceStart.y; sourceY < sourceEnd.y; sourceY += 1u) {
    for (var sourceX = sourceStart.x; sourceX < sourceEnd.x; sourceX += 1u) {
      let sourcePixel = min(
        vec2<u32>(sourceX, sourceY),
        fullSize - vec2<u32>(1u),
      );
      let sourceDepth = textureLoad(sceneDepth, vec2<i32>(sourcePixel), 0);
      // Perspective and orthographic depth are monotonic with view distance,
      // so comparing the raw depth values preserves the pyramid's nearest owner.
      if (isFinite(sourceDepth) && sourceDepth > 0.0 && sourceDepth <= 1.0 &&
          sourceDepth > candidateRawDepth) {
        candidatePixel = sourcePixel;
        candidateRawDepth = sourceDepth;
      }
    }
  }
  if (!isFinite(candidateRawDepth) || candidateRawDepth <= 0.0 || candidateRawDepth > 1.0) {
    return ssrInvalidDepthCandidate();
  }
  let candidateDepth = textureLoad(sceneDepth, vec2<i32>(candidatePixel), 0);
  let candidateCenterUv = (vec2<f32>(candidatePixel) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  return SsrDepthCandidate(
    true,
    candidatePixel,
    candidateCenterUv,
    candidateDepth,
    ssrRayFraction(candidateCenterUv, startUv, deltaUv, fallbackFraction, endFraction),
  );
}

// A structural/direct trace may be supplied without a depth pyramid. Keep
// that path bounded too, but inspect a short projected neighborhood so a thin
// depth texel between two coarse samples is not silently lost.
fn locateSsrLocalCandidate(uv : vec2<f32>, pixel : vec2<u32>, fullSize : vec2<u32>,
  startUv : vec2<f32>, deltaUv : vec2<f32>, fallbackFraction : f32,
  endFraction : f32) -> SsrDepthCandidate {
  let span = max(abs(deltaUv.x) * f32(fullSize.x), abs(deltaUv.y) * f32(fullSize.y));
  if (!isFinite(span) || span <= 1e-5) { return ssrInvalidDepthCandidate(); }
  var bestOffset = 9;
  var bestDepth = 0.0;
  var bestPixel = pixel;
  for (var offset = -8; offset <= 8; offset += 1) {
    let sampleUv = uv + deltaUv * (f32(offset) / span);
    if (any(sampleUv < vec2<f32>(0.0)) || any(sampleUv >= vec2<f32>(1.0))) { continue; }
    let samplePixel = min(
      vec2<u32>(sampleUv * vec2<f32>(fullSize)),
      fullSize - vec2<u32>(1u),
    );
    let sampleDepth = textureLoad(sceneDepth, vec2<i32>(samplePixel), 0);
    let distanceFromCenter = abs(offset);
    if (sampleDepth > 0.0 && sampleDepth <= 1.0 &&
        (distanceFromCenter < bestOffset ||
          (distanceFromCenter == bestOffset && sampleDepth > bestDepth))) {
      bestOffset = distanceFromCenter;
      bestDepth = sampleDepth;
      bestPixel = samplePixel;
    }
  }
  if (bestOffset > 8) { return ssrInvalidDepthCandidate(); }
  let candidateUv = (vec2<f32>(bestPixel) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  return SsrDepthCandidate(
    true,
    bestPixel,
    candidateUv,
    bestDepth,
    ssrRayFraction(candidateUv, startUv, deltaUv, fallbackFraction, endFraction),
  );
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
  return SsrTraceHit(1.0, candidate.uv, clamp(1.0 - separation / radius, 0.0, 1.0), result.reactivity);
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
// The 48/5 bound, depth pyramid, material coverage, and BRDF owner remain explicit.
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
  var rayLength = maxDistance;
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
  let count = min(SSR_TRACE_MAX_COARSE_STEPS, max(1u, u32(ceil(max(span.x, span.y)))));
  let coarseLevel = min(maxTraceLevel, u32(floor(log2(max(1.0, max(span.x, span.y) / f32(count))))));
  let inverseStart = 1.0 / max(startDepth, 1e-5);
  let inverseEnd = 1.0 / max(endDepth, 1e-5);
  var lower = 0.0;
  var upper = 0.0;
  var found = false;
  var rescued = false;
  var rescuedUv = vec2<f32>(0.0);
  var rescuedThickness = 0.0;
  for (var step = 1u; step <= SSR_TRACE_MAX_COARSE_STEPS; step++) {
    if (step > count) { break; }
    let fraction = f32(step) / f32(count) * endFraction;
    let uv = startUv + deltaUv * fraction;
    let pixel = min(vec2<u32>(clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) *
      vec2<f32>(fullSize)), fullSize - vec2<u32>(1u));
    let rayDepth = 1.0 / mix(inverseStart, inverseEnd, fraction);
    // The ray can cross the surface after this sample but before leaving its
    // depth texel. Testing only rayDepth loses that crossing when the next
    // sample is sky. Extend the bracket to this texel's exit, not its neighbor;
    // the small pixel-space inset keeps the upper endpoint on the same texel.
    let moving = abs(deltaUv) > vec2<f32>(1e-8);
    let exitUv = (vec2<f32>(pixel) + select(vec2<f32>(0.0), vec2<f32>(1.0),
      deltaUv > vec2<f32>(0.0))) / vec2<f32>(fullSize);
    let exitFractions = select(vec2<f32>(endFraction),
      (exitUv - startUv) / select(vec2<f32>(1.0), deltaUv, moving), moving);
    let pixelSpan = max(abs(deltaUv.x) * f32(fullSize.x), abs(deltaUv.y) * f32(fullSize.y));
    let exitFraction = max(fraction,
      min(endFraction, min(exitFractions.x, exitFractions.y)) - 1e-4 / max(pixelSpan, 1.0));
    let exitDepth = 1.0 / mix(inverseStart, inverseEnd, exitFraction);
    let intervalDepth = max(rayDepth, exitDepth);
    // The pyramid contains point depths, not the minimum of an oblique surface's
    // entire texel footprint. Keep the authored thickness in this broad-phase
    // bound; the in-texel tangent intersection below still decides new hits.
    // A zero trace level means no reduced hierarchy is available. Its level-0
    // sample is the current full-resolution texel, so an empty texel must not
    // discard the bounded neighborhood rescue below.
    if (coarseLevel > 0u && sampleSsrTraceDepth(uv, coarseLevel) > intervalDepth + thickness) { continue; }
    var samplePixel = pixel;
    var sampleUv = uv;
    var sampleDepth = textureLoad(sceneDepth, vec2<i32>(pixel), 0);
    var sampleFraction = fraction;
    var candidate = ssrInvalidDepthCandidate();
    if (sampleDepth <= 0.0 || sampleDepth > 1.0) {
      candidate = locateSsrPyramidCandidate(
        uv,
        coarseLevel,
        fullSize,
        startUv,
        deltaUv,
        fraction,
        endFraction,
      );
      // A local neighborhood is only a rescue for a genuinely undersampled
      // projected step. On short rays the normal full-resolution march
      // already visits each texel; scanning a wide neighborhood there would
      // turn a nearby wall into a false hit on an otherwise empty sky ray.
      let projectedStepPixels = max(span.x, span.y) / f32(max(count, 1u));
      if (!candidate.valid && coarseLevel == 0u && projectedStepPixels > 2.0) {
        candidate = locateSsrLocalCandidate(
          uv,
          pixel,
          fullSize,
          startUv,
          deltaUv,
          fraction,
          endFraction,
        );
      }
      if (candidate.valid) {
        samplePixel = candidate.pixel;
        sampleUv = candidate.uv;
        sampleDepth = candidate.depth;
        sampleFraction = candidate.fraction;
      }
    }
    if (sampleDepth <= 0.0 || textureLoad(reflectionFallback, vec2<i32>(samplePixel), 0).a <= 0.5) { continue; }
    let sampleRayDepth = 1.0 / mix(inverseStart, inverseEnd, sampleFraction);
    let surfaceViewDepth = linearizeViewDepth(sampleDepth, view.temporalProjection);
    if (intervalDepth + thickness < surfaceViewDepth) { continue; }
    // A moving occluder can invalidate yesterday's hit even when its back
    // face or depth separation rejects today's radiance. Preserve that
    // evidence on misses; sky and samples beyond the ray interval contribute
    // nothing. This does not admit the occluder as a reflection source.
    result.reactivity = max(result.reactivity, ssrSourceReactivity(vec2<i32>(samplePixel)));
    let normal = loadStandardNormalRoughness(sceneNormal, vec2<i32>(samplePixel)).xyz;
    if (dot(normal, -direction) <= 0.0) { continue; }
    let surface = reconstructWorldPosition(sampleUv, sampleDepth);
    // Coarse steps can enter a face before its depth crossing and leave the
    // silhouette before the next sample. Intersect this sampled tangent plane
    // within the adjacent step interval, then validate against the actual hit
    // texel's depth, normal and coverage. Requiring the intersection to remain
    // in the coarse sample's single texel leaves periodic holes at corners.
    let planeHit = ssrRefineHit(origin, direction, rayLength, thickness, fullSize,
      samplePixel, sampleDepth, normal, result);
    if (planeHit.hit > 0.0) {
      let planeFraction = ssrRayFraction(planeHit.uv, startUv, deltaUv, sampleFraction, endFraction);
      if (planeFraction >= max(0.0, f32(step - 1u) / f32(count) * endFraction) &&
          planeFraction <= min(endFraction, f32(step + 1u) / f32(count) * endFraction)) {
        return planeHit;
      }
    }
    if (candidate.valid && !ssrRescueCandidateInRay(
      origin,
      direction,
      rayLength,
      surface,
      normal,
      fullSize,
      samplePixel,
    )) { continue; }
    if (sampleRayDepth < surfaceViewDepth) {
      // Extending the depth interval must not extend the sampled surface.
      // At a silhouette the neighboring texel may belong to another plane.
      if (!candidate.valid && !ssrRescueCandidateInRay(
        origin,
        direction,
        rayLength,
        surface,
        normal,
        fullSize,
        samplePixel,
      )) { continue; }
    }
    let neighbor = reconstructWorldPosition(sampleUv + vec2<f32>(1.0 / f32(fullSize.x), 0.0), sampleDepth);
    let radius = max(thickness, distance(surface, neighbor) * 3.0);
    let separation = length(cross(surface - origin, direction));
    if (!isFinite(separation) || separation > radius) { continue; }
    if (candidate.valid) {
      rescued = true;
      rescuedUv = sampleUv;
      rescuedThickness = clamp(1.0 - separation / radius, 0.0, 1.0);
    }
    let bracketLower = min(f32(step - 1u) / f32(count) * endFraction, sampleFraction);
    let bracketUpper = max(exitFraction, sampleFraction);
    lower = select(sampleFraction, bracketLower,
      sampleRayDepth >= surfaceViewDepth);
    upper = select(bracketUpper, sampleFraction, sampleRayDepth >= surfaceViewDepth);
    found = true;
    break;
  }
  if (!found) { return result; }
  // Depth crossing refinement is intentionally outside the march loop.
  for (var refine = 0u; refine < SSR_TRACE_MAX_REFINE_STEPS; refine++) {
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
  // The generic bisection can walk from a thin, valid rescue texel into the
  // adjacent sky texel. The rescue was already validated against the actual
  // depth/normal/coverage/thickness gates in the march, so preserve it before
  // the final endpoint rejection discards the whole trace.
  if (rescued && (depth <= 0.0 || dot(normal, -direction) <= 0.0 || !covered)) {
    return SsrTraceHit(1.0, rescuedUv, rescuedThickness, result.reactivity);
  }
  if (depth <= 0.0 || dot(normal, -direction) <= 0.0 || !covered) { return result; }
  // Preserve successful refinement and exact flat-face silhouettes. Smooth
  // shading can point a failed correction away from the depth surface; retry
  // with depth geometry, under the same source, facing and thickness checks.
  let refined = ssrRefineHit(origin, direction, maxDistance, thickness, fullSize,
    pixel, depth, normal, result);
  if (refined.hit > 0.0 || !ssrShadingNormalVaries(pixel, normal)) {
    if (refined.hit <= 0.0 && rescued) {
      // Pyramid/local rescue already validated the candidate against the full
      // depth, normal, coverage, ray-distance, and thickness gates. Preserve
      // that exact texel instead of letting the generic bisection walk back
      // onto the empty coarse sample.
      return SsrTraceHit(1.0, rescuedUv, rescuedThickness, result.reactivity);
    }
    return refined;
  }
  if (rescued) {
    return SsrTraceHit(1.0, rescuedUv, rescuedThickness, result.reactivity);
  }
  return ssrRefineGeometricHit(origin, direction, maxDistance, thickness, fullSize,
    pixel, depth, normal, result);
}

fn ssrHitTapAdmitted(pixel : vec2<i32>, rayDirection : vec3<f32>) -> bool {
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

@compute @workgroup_size(8, 8, 1)
fn ssr_trace(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let fullSize = textureDimensions(sceneColor, 0);
  let traceSize = max(fullSize / vec2<u32>(2u), vec2<u32>(1u));
  if (globalId.x >= traceSize.x || globalId.y >= traceSize.y) {
    return;
  }
  textureStore(hitReactivityOutput, vec2<i32>(globalId.xy), vec4<f32>(0.0));
  let fullPixel = min(globalId.xy * vec2<u32>(2u), fullSize - vec2<u32>(1u));
  let coarsestLevel = textureNumLevels(depthPyramid) - 1u;
  let maxTraceLevel = min(maxSsrTraceLevel(fullSize), coarsestLevel + 1u);
  let coarsestSize = depthPyramidLevelSize(depthPyramid, coarsestLevel);
  let coarsestPixel = min(globalId.xy, coarsestSize - vec2<u32>(1u));
  let depth = textureLoad(sceneDepth, vec2<i32>(fullPixel), 0);
  let normalData = loadStandardNormalRoughness(sceneNormal, vec2<i32>(fullPixel));
  let normalUnnormalized = normalData.xyz;
  let normalLength = length(normalUnnormalized);
  if (!isFinite(depth) || depth <= 0.0 || !isFinite(normalLength) || normalLength <= 1e-5 ||
      textureLoad(reflectionFallback, vec2<i32>(fullPixel), 0).a <= 0.5 ||
      !isFinite(view.ssrParams.w) || view.ssrParams.w <= 0.5 ||
      !isFinite(normalData.a) || normalData.a >= view.ssrParams.z) {
    textureStore(traceOutput, vec2<i32>(globalId.xy), vec4<f32>(0.0));
    return;
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
  let facing = clamp(dot(normal, viewDirection) * 8.0, 0.0, 1.0);
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
  textureStore(hitReactivityOutput, vec2<i32>(globalId.xy), vec4<f32>(hitResult.reactivity));
  let roughness = finiteConfidence(
    select(
      0.0,
      1.0 - smoothstep(roughnessLimit * 0.8, max(roughnessLimit, 1e-5), clamp(normalData.a, 0.0, 1.0)),
      roughnessLimit > 0.0,
    ),
  );
  let temporal = 1.0;
  let confidence = traceConfidence(
    hitResult.hit,
    hitResult.thickness,
    facing,
    edge,
    roughness,
    temporal,
  );
  if (confidence <= 0.0) {
    textureStore(traceOutput, vec2<i32>(globalId.xy), vec4<f32>(0.0));
    return;
  }
  let hitSample = sampleSsrHitSample(hitResult.uv, reflectionDirection);
  let hitColor = hitSample.color;
  if (!all(vec3<bool>(isFinite(hitColor.r), isFinite(hitColor.g), isFinite(hitColor.b)))) {
    textureStore(traceOutput, vec2<i32>(globalId.xy), vec4<f32>(0.0));
    return;
  }
  textureStore(traceOutput, vec2<i32>(globalId.xy), vec4<f32>(hitColor.rgb, confidence * hitColor.a));
  textureStore(hitReactivityOutput, vec2<i32>(globalId.xy), vec4<f32>(max(hitResult.reactivity, hitSample.reactivity)));
}
