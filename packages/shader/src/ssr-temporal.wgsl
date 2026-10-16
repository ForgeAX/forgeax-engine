#define_import_path forgeax_ssr::temporal
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, encodeStandardNormalRoughness, decodeStandardNormalRoughness}

// SSR temporal resolve keeps history as a renderer-owned consumer resource.
// History alpha stores absolute source view depth; its sign records whether
// that lattice point missed last frame. This distinguishes transient thin
// coverage from consecutive loss without a new allocation.
struct SsrTemporalParams {
  historyValid : u32,
  maxHistoryWeight : f32,
  depthThreshold : f32,
  normalThreshold : f32,
  currentJitterUv : vec2<f32>,
  previousJitterUv : vec2<f32>,
};

@group(0) @binding(0) var currentTrace : texture_2d<f32>;
@group(0) @binding(1) var currentDepth : texture_depth_2d;
@group(0) @binding(2) var currentNormal : texture_2d<u32>;
@group(0) @binding(3) var previousHistory : texture_2d<f32>;
@group(0) @binding(4) var currentTemporal : texture_2d<f32>;
@group(0) @binding(5) var historyOutput : texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<uniform> params : SsrTemporalParams;
// Keep the resolved confidence separate from the history depth lane. History
// alpha remains the source view depth required for rejection.
@group(0) @binding(7) var resolvedOutput : texture_storage_2d<rgba16float, write>;
#import forgeax_view::common::View
@group(0) @binding(8) var<uniform> view : View;
// Four bytes retain presentation reactivity (R), the actual octahedral normal
// (GB), and fixed-lattice confidence (A). G uses seven normal bits and one
// fixed-lattice source-reactive flag; B uses eight normal bits. The presentation
// response is never read back as a source flag. Encoding shares the GBuffer kernel.
// Reconstructing a prior shading normal from neighboring half-float depths
// confuses thin side faces with the adjoining top surface.
@group(0) @binding(9) var previousSurface : texture_2d<f32>;
@group(0) @binding(10) var surfaceOutput : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(11) var currentHitReactivity : texture_2d<f32>;

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn finiteUnit(value : f32) -> f32 {
  return select(0.0, clamp(value, 0.0, 1.0), isFinite(value));
}

fn finitePositive(value : f32) -> f32 {
  return select(0.0, value, isFinite(value) && value >= 0.0);
}

fn reprojectUv(uv : vec2<f32>, motion : vec2<f32>) -> vec2<f32> {
  // Both history slots use the fixed unjittered lattice. Jitter belongs
  // only to reconstruction of this frame's trace, never to history feedback.
  return uv - motion;
}

fn depthReject(current : f32, previous : f32) -> bool {
  if (!isFinite(current) || !isFinite(previous) || current < 0.0 || previous < 0.0) {
    return true;
  }
  let threshold = max(params.depthThreshold, 1e-4) + current * 0.01;
  return abs(current - previous) > threshold;
}

fn normalReject(current : vec3<f32>, previous : vec3<f32>) -> bool {
  let currentLength = length(current);
  let previousLength = length(previous);
  if (!isFinite(currentLength) || !isFinite(previousLength) || currentLength <= 1e-4 || previousLength <= 1e-4) {
    return true;
  }
  let agreement = dot(current / currentLength, previous / previousLength);
  return !isFinite(agreement) || agreement < clamp(params.normalThreshold, -1.0, 1.0);
}

fn viewDistance(depth : f32) -> f32 {
  let near = view.temporalProjection.x;
  let far = view.temporalProjection.y;
  return select(0.0, select(near / (depth + (1.0 - depth) * (near / far)),
    far - depth * (far - near), view.temporalProjection.z > 0.5),
    isFinite(depth) && depth > 0.0 && depth <= 1.0);
}

fn ssrLatticeCoordinate(uv : vec2<f32>, fullSize : vec2<u32>) -> vec2<f32> {
  // Half-resolution centers correspond to full pixels 2*p + 0.5.
  return (uv * vec2<f32>(fullSize) - vec2<f32>(0.5)) * 0.5;
}

struct SsrHistorySample {
  color : vec4<f32>,
  missing : bool,
  reactivity : f32,
};

fn ssrHistoryTap(pixel : vec2<i32>, expectedDepth : f32, normal : vec3<f32>, footprintWeight : f32) -> SsrHistorySample {
  // The nearest miss state always has positive bilinear weight. Zero-weight
  // taps contribute neither history nor source state, so do not fetch them.
  if (footprintWeight <= 0.0) { return SsrHistorySample(vec4<f32>(0.0), false, 0.0); }
  let history = textureLoad(previousHistory, pixel, 0);
  let surface = textureLoad(previousSurface, pixel, 0);
  let packedNormalSource = u32(round(surface.g * 255.0));
  let sourceReactivity = f32(packedNormalSource & 1u);
  if (depthReject(expectedDepth, abs(history.a)) || normalReject(normal, decodeStandardNormalRoughness(
      u32(round(f32(packedNormalSource >> 1u) * (4095.0 / 127.0)))
        | (u32(round(surface.b * 4095.0)) << 12u)).xyz)) {
    return SsrHistorySample(vec4<f32>(0.0), false, 0.0);
  }
  let weight = footprintWeight * finiteUnit(surface.a);
  return SsrHistorySample(vec4<f32>(history.rgb * weight, weight), history.a < 0.0, sourceReactivity * weight);
}

fn sampleSsrHistory(uv : vec2<f32>, fullSize : vec2<u32>, expectedDepth : f32, normal : vec3<f32>) -> SsrHistorySample {
  let coordinate = ssrLatticeCoordinate(uv, fullSize);
  let first = vec2<i32>(floor(coordinate));
  let fraction = fract(coordinate);
  let last = vec2<i32>(textureDimensions(previousHistory, 0)) - vec2<i32>(1);
  let tap00 = ssrHistoryTap(clamp(first, vec2<i32>(0), last),
    expectedDepth, normal, (1.0 - fraction.x) * (1.0 - fraction.y));
  let tap10 = ssrHistoryTap(clamp(first + vec2<i32>(1, 0), vec2<i32>(0), last),
    expectedDepth, normal, fraction.x * (1.0 - fraction.y));
  let tap01 = ssrHistoryTap(clamp(first + vec2<i32>(0, 1), vec2<i32>(0), last),
    expectedDepth, normal, (1.0 - fraction.x) * fraction.y);
  let tap11 = ssrHistoryTap(clamp(first + vec2<i32>(1, 1), vec2<i32>(0), last),
    expectedDepth, normal, fraction.x * fraction.y);
  let sum = tap00.color + tap10.color + tap01.color + tap11.color;
  // Miss state belongs to the closest fixed-lattice point, not the brightest
  // confidence-weighted neighbor. A nearby new hit cannot revive a lost source.
  let nearestMissing = select(select(tap00.missing, tap10.missing, fraction.x >= 0.5),
    select(tap01.missing, tap11.missing, fraction.x >= 0.5), fraction.y >= 0.5);
  return SsrHistorySample(vec4<f32>(sum.rgb / max(sum.a, 1e-6), sum.a),
    nearestMissing,
    (tap00.reactivity + tap10.reactivity + tap01.reactivity + tap11.reactivity) / max(sum.a, 1e-6));
}

struct SsrCurrentSample {
  color : vec4<f32>,
  reactivity : f32,
};

// A tap carries confidence-premultiplied color until the footprint is summed.
fn ssrCurrentTap(pixel : vec2<i32>, expectedDepth : f32, normal : vec3<f32>, footprintWeight : f32) -> SsrCurrentSample {
  if (footprintWeight <= 0.0) { return SsrCurrentSample(vec4<f32>(0.0), 0.0); }
  let sourceNormal = loadStandardNormalRoughness(currentNormal, pixel * 2).xyz;
  let sourceDepth = viewDistance(textureLoad(currentDepth, pixel * 2, 0));
  if (depthReject(expectedDepth, sourceDepth) || normalReject(normal, sourceNormal)) {
    return SsrCurrentSample(vec4<f32>(0.0), 0.0);
  }
  let sample = textureLoad(currentTrace, pixel, 0);
  let weight = footprintWeight * finiteUnit(sample.a);
  // Source reactivity is independent of radiance confidence, including misses.
  var reactivity = 0.0;
  if (footprintWeight > 0.0) {
    reactivity = finiteUnit(textureLoad(currentHitReactivity, pixel, 0).r);
  }
  return SsrCurrentSample(vec4<f32>(sample.rgb * weight, weight), reactivity);
}

fn sampleCurrentSsr(uv : vec2<f32>, fullSize : vec2<u32>, expectedDepth : f32, normal : vec3<f32>) -> SsrCurrentSample {
  let coordinate = ssrLatticeCoordinate(uv, fullSize);
  let first = vec2<i32>(floor(coordinate));
  let fraction = fract(coordinate);
  let last = vec2<i32>(textureDimensions(currentTrace, 0)) - vec2<i32>(1);
  var sum = vec4<f32>(0.0);
  var reactivity = 0.0;
  let tap00 = ssrCurrentTap(clamp(first + vec2<i32>(0, 0), vec2<i32>(0), last),
    expectedDepth, normal, (1.0 - fraction.x) * (1.0 - fraction.y));
  sum += tap00.color;
  reactivity = max(reactivity, tap00.reactivity);
  let tap10 = ssrCurrentTap(clamp(first + vec2<i32>(1, 0), vec2<i32>(0), last),
    expectedDepth, normal, fraction.x * (1.0 - fraction.y));
  sum += tap10.color;
  reactivity = max(reactivity, tap10.reactivity);
  let tap01 = ssrCurrentTap(clamp(first + vec2<i32>(0, 1), vec2<i32>(0), last),
    expectedDepth, normal, (1.0 - fraction.x) * fraction.y);
  sum += tap01.color;
  reactivity = max(reactivity, tap01.reactivity);
  let tap11 = ssrCurrentTap(clamp(first + vec2<i32>(1, 1), vec2<i32>(0), last),
    expectedDepth, normal, fraction.x * fraction.y);
  sum += tap11.color;
  reactivity = max(reactivity, tap11.reactivity);
  return SsrCurrentSample(vec4<f32>(sum.rgb / max(sum.a, 1e-6), sum.a), reactivity);
}

// Reflection-only mip reduction. Confidence weighting avoids dark fringes
// where an SSR hit borders an unavailable screen-space sample.
@compute @workgroup_size(8, 8, 1)
fn ssr_reflection_mip(@builtin(global_invocation_id) id : vec3<u32>) {
  let size = textureDimensions(resolvedOutput);
  if (any(id.xy >= size)) { return; }
  let sourceSize = textureDimensions(currentTrace, 0);
  // For exact even 2x2 footprints, use four explicit loads. Hardware linear
  // filtering is intentionally avoided here: rgba16float filtering is allowed
  // to round differently between browser and Dawn backends, which would make
  // the captured SSR result non-portable at high-contrast reflection edges.
  if (sourceSize.x == size.x * 2u && sourceSize.y == size.y * 2u) {
    let source = id.xy * vec2<u32>(2u);
    let topLeft = textureLoad(currentTrace, vec2<i32>(source), 0);
    let topRight = textureLoad(currentTrace, vec2<i32>(source + vec2<u32>(1u, 0u)), 0);
    let bottomLeft = textureLoad(currentTrace, vec2<i32>(source + vec2<u32>(0u, 1u)), 0);
    let bottomRight = textureLoad(currentTrace, vec2<i32>(source + vec2<u32>(1u, 1u)), 0);
    textureStore(resolvedOutput, vec2<i32>(id.xy),
      (topLeft + topRight + bottomLeft + bottomRight) * 0.25);
    return;
  }
  let first = vec2<i32>(id.xy * sourceSize / size);
  let end = vec2<i32>((id.xy + vec2<u32>(1)) * sourceSize / size);
  var sum = vec4<f32>(0.0);
  var count = 0.0;
  for (var y = first.y; y < end.y; y++) {
    for (var x = first.x; x < end.x; x++) {
      let sample = textureLoad(currentTrace, vec2<i32>(x, y), 0);
      let coverage = clamp(sample.a, 0.0, 1.0);
      // The presentation level stores premultiplied radiance. Keep that
      // representation through every pyramid level so a filtered miss does
      // not pull black/invalid color into a valid hit.
      sum += vec4<f32>(sample.rgb, coverage);
      count += 1.0;
    }
  }
  textureStore(resolvedOutput, vec2<i32>(id.xy), vec4<f32>(sum.rgb / max(count, 1.0), sum.a / max(count, 1.0)));
}

struct NeighborhoodBounds {
  lower : vec3<f32>,
  upper : vec3<f32>,
};

fn ssrNeighborhoodRow(pixel : vec2<i32>, last : vec2<i32>) -> NeighborhoodBounds {
  let left = textureLoad(currentTrace, clamp(pixel + vec2<i32>(-1, 0), vec2<i32>(0), last), 0);
  let center = textureLoad(currentTrace, clamp(pixel, vec2<i32>(0), last), 0);
  let right = textureLoad(currentTrace, clamp(pixel + vec2<i32>(1, 0), vec2<i32>(0), last), 0);
  return NeighborhoodBounds(min(min(left.rgb, center.rgb), right.rgb), max(max(left.rgb, center.rgb), right.rgb));
}

fn neighborhoodClamp(pixel : vec2<i32>, size : vec2<u32>) -> NeighborhoodBounds {
  let last = vec2<i32>(size) - vec2<i32>(1);
  let top = ssrNeighborhoodRow(pixel + vec2<i32>(0, -1), last);
  let center = ssrNeighborhoodRow(pixel, last);
  let bottom = ssrNeighborhoodRow(pixel + vec2<i32>(0, 1), last);
  return NeighborhoodBounds(
    min(min(top.lower, center.lower), bottom.lower),
    max(max(top.upper, center.upper), bottom.upper),
  );
}

fn resolveSsrTemporal(
  current : vec4<f32>,
  history : vec4<f32>,
  historyConfidence : f32,
  previousMissing : bool,
  lower : vec3<f32>,
  upper : vec3<f32>,
  historyInBounds : bool,
  depthCompatible : bool,
  normalCompatible : bool,
  temporal : vec4<f32>,
) -> vec4<f32> {
  let clampedHistory = select(history.rgb, clamp(history.rgb, lower, upper), current.a > 0.0);
  let reactiveFactor = 1.0 - finiteUnit(temporal.w);
  let velocityFactor = 1.0 - finiteUnit(length(temporal.xy) * 64.0);
  let requestedWeight = finiteUnit(params.maxHistoryWeight);
  let accepted = params.historyValid != 0u && historyInBounds && depthCompatible && normalCompatible && historyConfidence > 0.001;
  // A single missing phase keeps thin-source energy. Repeated loss retires
  // confidence with a 0.4 ceiling. Recovery from that loss interpolates back
  // to 0.9; ordinary fractional coverage keeps the stable ceiling.
  let coverageRatio = finiteUnit(current.a / max(historyConfidence, 1e-6));
  let historyLimit = select(0.9, mix(0.4, 0.9, coverageRatio), previousMissing);
  let weight = select(0.0, min(requestedWeight, historyLimit) * reactiveFactor * velocityFactor, accepted);
  // Accumulate premultiplied confidence, not black radiance from a miss.
  // An accepted history survives a transient miss with bounded decay, while
  // a new hit with no valid history is immediately visible.
  let currentMass = (1.0 - weight) * finiteUnit(current.a);
  let historyMass = weight * finiteUnit(historyConfidence);
  let confidence = currentMass + historyMass;
  let resolved = (current.rgb * currentMass + clampedHistory * historyMass) / max(confidence, 1e-6);
  return vec4<f32>(resolved, confidence);
}

struct SsrTemporalSample {
  color : vec4<f32>,
  normal : vec3<f32>,
  depth : f32,
  reactivity : f32,
  missing : bool,
  sourceReactive : bool,
};

fn resolveSsrAt(uv : vec2<f32>, fullSize : vec2<u32>) -> SsrTemporalSample {
  let currentUv = uv + params.currentJitterUv;
  let fullPixel = clamp(vec2<i32>(currentUv * vec2<f32>(fullSize)), vec2<i32>(0), vec2<i32>(fullSize) - vec2<i32>(1));
  let depthNdc = textureLoad(currentDepth, vec2<i32>(fullPixel), 0);
  let currentDepthSample = viewDistance(depthNdc);
  let temporal = textureLoad(currentTemporal, fullPixel, 0);
  let historyUv = reprojectUv(uv, temporal.xy);
  let historyInBounds = all(historyUv >= vec2<f32>(0.0)) && all(historyUv <= vec2<f32>(1.0));
  let normal = loadStandardNormalRoughness(currentNormal, vec2<i32>(fullPixel)).xyz;
  // Empty depth cannot admit a current ray or compatible receiver history.
  // Retire it without reconstructing world position or fetching eight taps.
  if (currentDepthSample <= 0.0) {
    return SsrTemporalSample(vec4<f32>(0.0), normal, 0.0, 0.0, true, false);
  }
  let sourceUv = (vec2<f32>(fullPixel) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  let worldH = view.inverseViewProj * vec4<f32>(sourceUv.x * 2.0 - 1.0, 1.0 - sourceUv.y * 2.0, depthNdc, 1.0);
  let priorClip = view.temporalPreviousViewProj * vec4<f32>(worldH.xyz / worldH.w, 1.0);
  let current = sampleCurrentSsr(currentUv, fullSize, currentDepthSample, normal);
  // Perspective clip W is view distance; orthographic clip W is always one.
  var previousDepth = priorClip.w;
  if (view.temporalProjection.z > 0.5) {
    previousDepth = viewDistance(priorClip.z / max(abs(priorClip.w), 1e-8));
  }
  let history = sampleSsrHistory(historyUv, fullSize, previousDepth, normal);
  let size = textureDimensions(currentTrace, 0);
  let pixel = clamp(vec2<i32>(floor(ssrLatticeCoordinate(currentUv, fullSize) + vec2<f32>(0.5))), vec2<i32>(0), vec2<i32>(size) - vec2<i32>(1));
  // No current hit means the existing resolver deliberately accepts straight
  // history without color clipping. Do not fetch the unused nine-tap bounds.
  var bounds = NeighborhoodBounds(vec3<f32>(0.0), vec3<f32>(0.0));
  if (current.color.a > 0.0) { bounds = neighborhoodClamp(pixel, size); }
  // If a reactive reflected source vanishes, its last accepted evidence
  // survives the first miss. Do not feed a confidence-loss mask back through
  // consecutive misses: that would spread rejection over static thin edges.
  let sourceReactivity = max(current.reactivity, select(0.0, history.reactivity,
    current.color.a <= 0.0 && !history.missing));
  let resolved = resolveSsrTemporal(
    current.color,
    history.color,
    history.color.a,
    history.missing,
    bounds.lower,
    bounds.upper,
    historyInBounds,
    currentDepthSample > 0.0,
    true,
    vec4<f32>(temporal.xyz, max(temporal.w, sourceReactivity)),
  );
  // Retire unavailable radiance in SSR itself. Sampling loss is not source
  // motion: propagating even a one-code mask would reset TAA's stationary
  // age at static silhouettes. The trace's actual source flag survives its
  // first miss independently of presentation reconstruction.
  return SsrTemporalSample(resolved, normal, finitePositive(currentDepthSample),
    sourceReactivity, current.color.a <= 0.0, current.reactivity > 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn ssr_temporal(@builtin(global_invocation_id) globalId : vec3<u32>) {
  let size = textureDimensions(currentTrace, 0);
  if (any(globalId.xy >= size)) { return; }
  let pixel = vec2<i32>(globalId.xy);
  let fullSize = textureDimensions(currentDepth, 0);
  let uv = (vec2<f32>(globalId.xy * 2u) + vec2<f32>(0.5)) / vec2<f32>(fullSize);
  let history = resolveSsrAt(uv, fullSize);
  textureStore(historyOutput, pixel, vec4<f32>(history.color.rgb, select(history.depth, -history.depth, history.missing)));
  // Presentation remains on the current raster lattice expected by material
  // composition and the reflection mips. Store its radiance premultiplied by
  // confidence so the presentation pyramid can use hardware filtering without
  // darkening miss footprints. This output never feeds persistent history back
  // into itself; historyOutput above remains straight radiance + depth.
  var presented = history;
  if (any(params.currentJitterUv != vec2<f32>(0.0))) {
    presented = resolveSsrAt(uv - params.currentJitterUv, fullSize);
  }
  let packedNormal = encodeStandardNormalRoughness(history.normal, 0.0);
  let octNormal = vec2<f32>(f32(packedNormal & 4095u), f32((packedNormal >> 12u) & 4095u)) / 4095.0;
  let normalSource = (u32(round(octNormal.x * 127.0)) << 1u) | select(0u, 1u, history.sourceReactive);
  textureStore(surfaceOutput, pixel, vec4<f32>(presented.reactivity, f32(normalSource) / 255.0, octNormal.y, history.color.a));
  textureStore(resolvedOutput, pixel, vec4<f32>(presented.color.rgb * presented.color.a, presented.color.a));
}
