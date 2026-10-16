#define_import_path forgeax_view::depth_of_field_msaa

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle
#import forgeax_scene_temporal::{unpackSceneTemporalV1}

// Four vec4 rows keep the runtime UBO fixed at 64 bytes. Row 0 is the
// thin-lens camera, row 1 is image/quality policy, row 2 carries the active
// projection range plus the TAA-depth switch, and reserved.x carries the
// frame CoC coefficient in output pixels.
struct DepthOfFieldParams {
  optics : vec4<f32>,
  image : vec4<f32>,
  camera : vec4<f32>,
  reserved : vec4<f32>,
};

@group(1) @binding(0) var currentColor : texture_2d<f32>;
@group(1) @binding(1) var linearSampler : sampler;
@group(1) @binding(2) var<uniform> params : DepthOfFieldParams;
@group(1) @binding(3) var sceneDepth : texture_depth_multisampled_2d;
@group(1) @binding(4) var depthSampler : sampler;
@group(1) @binding(5) var extra0 : texture_2d<f32>;
@group(1) @binding(6) var extra1 : texture_2d<f32>;
@group(1) @binding(7) var extra2 : texture_2d<f32>;
@group(1) @binding(8) var extra3 : texture_2d<f32>;
@group(1) @binding(9) var extra4 : texture_2d<f32>;
@group(1) @binding(10) var extra5 : texture_2d<f32>;

fn validNumber(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

// Reverse-Z clears to 0, so raw 0 is uncovered background at the far plane:
// a real far-field source that blurs and lets far circles spread over it.
fn linearDepth(raw : f32) -> f32 {
  if (!validNumber(raw) || raw < 0.0 || raw > 1.0) {
    return 0.0;
  }
  let near = params.camera.x;
  let far = params.camera.y;
  if (!validNumber(near) || !validNumber(far) || near <= 0.0 || far <= near) {
    return 0.0;
  }
  let depthRatio = near / far;
  if (!validNumber(depthRatio) || depthRatio <= 0.0) {
    return 0.0;
  }
  let denominator = raw + (1.0 - raw) * depthRatio;
  if (!validNumber(denominator) || denominator <= 0.0) {
    return 0.0;
  }
  let distance = near / denominator;
  return select(0.0, distance, validNumber(distance) && distance > 0.0);
}

struct DepthSample {
  depth : f32,
  coverage : f32,
};

fn depthAndCoverageAt(uv : vec2<f32>) -> DepthSample {
  if (params.camera.z > 0.5) {
    let temporal = unpackSceneTemporalV1(textureSampleLevel(extra0, linearSampler, uv, 0.0));
    // Temporal-v1 validity is authoritative when requested: an invalid
    // sample is the temporal clear (no geometry), never jittered raw depth.
    // Like a raw reverse-Z clear it is background at the far plane.
    let valid = temporal.validDepth && validNumber(temporal.viewDepth) &&
      temporal.viewDepth > 0.0;
    let depth = select(linearDepth(0.0), temporal.viewDepth, valid);
    return DepthSample(depth, select(0.0, 1.0, depth > 0.0));
  }
  let size = vec2<i32>(textureDimensions(sceneDepth));
  let pixel = clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), size - vec2<i32>(1));
  var nearest = 0.0;
  for (var sampleIndex = 0u; sampleIndex < 4u; sampleIndex += 1u) {
    let raw = textureLoad(sceneDepth, pixel, sampleIndex);
    if (validNumber(raw) && raw >= 0.0 && raw <= 1.0) {
      nearest = max(nearest, raw);
    }
  }
  let depth = linearDepth(nearest);
  let layerTolerance = max(0.02, depth * 0.04);
  var nearestSamples = 0u;
  for (var sampleIndex = 0u; sampleIndex < 4u; sampleIndex += 1u) {
    let raw = textureLoad(sceneDepth, pixel, sampleIndex);
    if (validNumber(raw) && raw >= 0.0 && raw <= 1.0) {
      let sampleDepth = linearDepth(raw);
      if (sampleDepth > 0.0 && abs(sampleDepth - depth) <= layerTolerance) {
        nearestSamples += 1u;
      }
    }
  }
  let valid = nearestSamples > 0u && depth > 0.0 && validNumber(depth);
  // Preserve only the valid samples belonging to the conservative nearest
  // layer. Farther geometry in the same pixel must not inflate its coverage.
  return DepthSample(
    select(0.0, depth, valid),
    select(0.0, f32(nearestSamples) / 4.0, valid),
  );
}

fn depthAt(uv : vec2<f32>) -> f32 {
  return depthAndCoverageAt(uv).depth;
}

fn selectedCoc(coc : f32) -> bool {
  if (params.image.z < 0.5) {
    return abs(coc) > 0.001;
  }
  if (params.image.z < 1.5) {
    return coc < -0.001;
  }
  return coc > 0.001;
}

fn selectedCocForSide(coc : f32, nearSide : bool) -> bool {
  return select(coc > 0.001, coc < -0.001, nearSide);
}

fn tapLimit() -> f32 {
  if (params.image.w < 0.5) { return 16.0; }
  if (params.image.w < 1.5) { return 32.0; }
  return 64.0;
}

fn diskOffset(index : u32, count : f32) -> vec2<f32> {
  let i = f32(index);
  let angle = i * 2.39996323;
  // Tap count controls density, while this normalized disk keeps its radius
  // fixed. Changing quality therefore cannot change the optical blur radius.
  let radius = sqrt((i + 0.5) / max(count, 1.0));
  return vec2<f32>(cos(angle), sin(angle)) * radius;
}

fn sourceDiskOffset(index : u32, count : f32) -> vec2<f32> {
  // Reserve one quarter of the same tap budget for a bounded local disk.
  // The local taps keep small near circles visible at focal destinations at
  // every quality; the remaining taps still cover the authored max radius.
  let localCount = max(1.0, floor(count * 0.25));
  if (f32(index) < localCount) {
    return diskOffset(index, localCount) * min(params.image.y, 3.0);
  }
  return diskOffset(index - u32(localCount), max(count - localCount, 1.0)) * params.image.y;
}

fn signedCoc(depth : f32) -> f32 {
  if (depth <= 0.0 || !validNumber(depth)) { return 0.0; }
  // Keep this layout byte-for-byte aligned with packDepthOfFieldParams:
  // row0 = focus, f-stop, sensor height, focal length;
  // row1 = output height, max radius, side, quality;
  // row2 = near, far, temporal-depth flag, reserved;
  // row3.x = precomputed output-pixel CoC coefficient.
  let focus = params.optics.x;
  let outputHeight = params.image.x;
  let cocCoefficient = params.reserved.x;
  if (
    cocCoefficient <= 0.0 ||
    !validNumber(cocCoefficient) ||
    !validNumber(outputHeight) ||
    outputHeight <= 0.0
  ) {
    return 0.0;
  }
  let focusOverDepth = focus / depth;
  if (!validNumber(focusOverDepth)) {
    return 0.0;
  }
  let depthFactor = 1.0 - focusOverDepth;
  let radius = cocCoefficient * depthFactor;
  if (!validNumber(depthFactor) || !validNumber(radius)) {
    return 0.0;
  }
  return clamp(radius, -params.image.y, params.image.y);
}

fn cocAt(uv : vec2<f32>) -> f32 {
  let encoded = textureSampleLevel(extra0, linearSampler, uv, 0.0);
  return select(0.0, encoded.r, validNumber(encoded.r));
}

fn cocAtExtra1(uv : vec2<f32>) -> f32 {
  let encoded = textureSampleLevel(extra1, linearSampler, uv, 0.0);
  return select(0.0, encoded.r, validNumber(encoded.r));
}

fn cocCoverageAt(uv : vec2<f32>) -> f32 {
  let encoded = textureSampleLevel(extra0, linearSampler, uv, 0.0);
  return select(0.0, clamp(encoded.a, 0.0, 1.0), validNumber(encoded.a));
}

fn cocCoverageAtExtra1(uv : vec2<f32>) -> f32 {
  let encoded = textureSampleLevel(extra1, linearSampler, uv, 0.0);
  return select(0.0, clamp(encoded.a, 0.0, 1.0), validNumber(encoded.a));
}

// CoC radius is expressed in final output pixels while the graph may sample
// an internal RenderExtent. Keep UV offsets and source-circle distances on the
// internal lattice without changing the authored optical radius.
fn internalToOutputScale() -> f32 {
  return f32(textureDimensions(extra1).y) / max(params.image.x, 1.0);
}

fn circleKernelMean(sourceRadius : f32, domainRadius : f32) -> f32 {
  let sampleRadius = max(domainRadius, 1e-5);
  let kernelRadius = max(sourceRadius + 1.0, 1e-5);
  if (kernelRadius <= sampleRadius) {
    return max(
      (kernelRadius * kernelRadius) / (3.0 * sampleRadius * sampleRadius),
      1e-5,
    );
  }
  return max(1.0 - (2.0 * sampleRadius) / (3.0 * kernelRadius), 1e-5);
}

fn sourceKernelMean(sourceRadius : f32, tapCount : f32) -> f32 {
  // Match sourceDiskOffset: one quarter of the taps sample the local disk
  // and the remainder sample the full authored disk.
  let domainRadius = max(params.image.y, 1e-5);
  let localCount = max(1.0, floor(tapCount * 0.25));
  let outerCount = max(tapCount - localCount, 1.0);
  let localMean = circleKernelMean(sourceRadius, min(domainRadius, 3.0));
  let outerMean = circleKernelMean(sourceRadius, domainRadius);
  return max(
    (localCount * localMean + outerCount * outerMean) / max(tapCount, 1.0),
    1e-5,
  );
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertexIndex);
}

@fragment
fn fs_coc(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let depthSample = depthAndCoverageAt(in.uv);
  let coc = signedCoc(depthSample.depth);
  // CoC alpha carries source depth validity/coverage for every downstream
  // half-resolution pass; the blue channel remains the validity mirror.
  return vec4<f32>(coc, abs(coc), depthSample.coverage, depthSample.coverage);
}

fn prefilter(in : FullscreenOutput, nearSide : bool) -> vec4<f32> {
  let sourceSize = vec2<f32>(textureDimensions(currentColor));
  let texel = 1.0 / sourceSize;
  var color = vec3<f32>(0.0);
  var weight = 0.0;
  var coverage = 0.0;
  for (var index = 0u; index < 4u; index += 1u) {
    let offset = vec2<f32>(f32(index & 1u), f32(index >> 1u)) - vec2<f32>(0.5);
    let uv = clamp(in.uv + offset * texel, vec2<f32>(0.0), vec2<f32>(1.0));
    let coc = cocAt(uv);
    let cocCoverage = cocCoverageAt(uv);
    let valid = selectedCocForSide(coc, nearSide) && cocCoverage > 0.0;
    let sampleWeight = select(0.0, cocCoverage, valid);
    color += textureSampleLevel(currentColor, linearSampler, uv, 0.0).rgb * sampleWeight;
    weight += sampleWeight;
    coverage += select(0.0, 0.25 * cocCoverage, valid);
  }
  let positiveWeight = max(weight, 1e-5);
  // Keep color energy normalized by the accepted source area; coverage is
  // carried separately for later resolve confidence. A side with no selected
  // samples must retain the scene color so small-source coverage cannot mix a
  // black half-resolution fallback into a constant-color surface.
  let fallbackColor = textureSampleLevel(currentColor, linearSampler, in.uv, 0.0).rgb;
  let resolvedColor = select(fallbackColor, color / positiveWeight, weight > 0.0);
  return vec4<f32>(resolvedColor, coverage);
}


@fragment
fn fs_prefilter(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return prefilter(in, params.image.z < 1.5);
}

@fragment
fn fs_prefilter_near(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return prefilter(in, true);
}

@fragment
fn fs_prefilter_far(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return prefilter(in, false);
}
// Keep the range lost by the half-resolution color reduction. The metadata
// is deliberately side-local: opposite signed CoC values must never average
// into a false focus value, and gather needs source depth/radius facts rather
// than the destination pixel's CoC.
fn prefilterMetadata(in : FullscreenOutput, nearSide : bool) -> vec4<f32> {
  let sourceSize = vec2<f32>(textureDimensions(currentColor));
  let texel = 1.0 / sourceSize;
  var maxRadius = 0.0;
  var minDepth = 3.402823e+38;
  var maxDepth = 0.0;
  var coverage = 0.0;
  for (var index = 0u; index < 4u; index += 1u) {
    let offset = vec2<f32>(f32(index & 1u), f32(index >> 1u)) - vec2<f32>(0.5);
    let uv = clamp(in.uv + offset * texel, vec2<f32>(0.0), vec2<f32>(1.0));
    let coc = cocAtExtra1(uv);
    let cocCoverage = cocCoverageAtExtra1(uv);
    if (selectedCocForSide(coc, nearSide) && cocCoverage > 0.0) {
      let depthSample = depthAndCoverageAt(uv);
      maxRadius = max(maxRadius, abs(coc));
      if (depthSample.depth > 0.0 && depthSample.coverage > 0.0) {
        minDepth = min(minDepth, depthSample.depth);
        maxDepth = max(maxDepth, depthSample.depth);
        coverage += 0.25 * cocCoverage * depthSample.coverage;
      }
    }
  }
  let safeMinDepth = select(0.0, minDepth, coverage > 0.0);
  return vec4<f32>(maxRadius, safeMinDepth, maxDepth, coverage);
}


@fragment
fn fs_prefilter_metadata(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return prefilterMetadata(in, params.image.z < 1.5);
}

@fragment
fn fs_prefilter_metadata_near(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return prefilterMetadata(in, true);
}

@fragment
fn fs_prefilter_metadata_far(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return prefilterMetadata(in, false);
}
fn farDepthAccept(center : f32, sample : f32, distancePixels : f32, centerRadius : f32) -> bool {
  if (center <= 0.0 || sample <= 0.0) { return false; }
  // A nearer far-field circle spreads over the farther background behind it.
  // A farther source reaches this destination only inside the destination's
  // own circle, so sharp or less-blurred layers never gain a background halo.
  return sample <= center + max(0.02, center * 0.04) || distancePixels <= centerRadius + 0.5;
}

fn nearDepthAccept(center : f32, sample : f32) -> bool {
  if (center <= 0.0 || sample <= 0.0) { return false; }
  // Near circles may expand over a farther destination. The reverse order is
  // rejected so a background near sample cannot cover a foreground layer.
  return sample <= center + max(0.02, center * 0.04);
}

struct GatherAccumulator {
  color : vec3<f32>,
  weight : f32,
  coverage : f32,
};

struct GatherOutput {
  @location(0) near : vec4<f32>,
  @location(1) far : vec4<f32>,
  @location(2) background : vec4<f32>,
};

struct NearGatherOutput {
  @location(0) near : vec4<f32>,
  @location(1) background : vec4<f32>,
};

fn gatherSource(
  uv : vec2<f32>, coc : f32, cocCoverage : f32,
  distancePixels : f32, centerDepth : f32, centerRadius : f32, sharedDepth : f32,
  nearSide : bool, colorTexture : texture_2d<f32>, metadataTexture : texture_2d<f32>,
  accumulator : ptr<function, GatherAccumulator>,
) {
  let metadata = textureSampleLevel(metadataTexture, linearSampler, uv, 0.0);
  let sourceRadius = max(abs(coc), metadata.r);
  // A source circle contributes continuously at its boundary. This keeps
  // coverage conservative while avoiding a binary halo on sharp targets.
  let supportWeight = clamp(
    (sourceRadius + 1.0 - distancePixels) / max(sourceRadius + 1.0, 1.0),
    0.0,
    1.0,
  );
  // Half-resolution source color and confidence begin in the 2-3px
  // handoff. Smaller circles remain in the full-resolution paths below.
  let largeSourceFactor = smoothstep(2.0, 3.0, sourceRadius);
  // Half-resolution color and confidence must describe the same source
  // circles. Small near circles are reconstructed by smallBlur at full
  // resolution; letting them raise alpha here would attach their varying
  // destination coverage to a large foreground color.
  let sourceCoverageFactor = largeSourceFactor;
  if (supportWeight <= 0.0 || largeSourceFactor <= 0.0) { return; }
  var sampleDepth = sharedDepth;
  if (sampleDepth < 0.0) { sampleDepth = depthAt(uv); }
  let metadataDepth = metadata.a <= 0.0 ||
    (sampleDepth >= metadata.g - max(0.02, sampleDepth * 0.04) &&
      sampleDepth <= metadata.b + max(0.02, sampleDepth * 0.04));
  var depthMatch = false;
  if (nearSide) {
    depthMatch = nearDepthAccept(centerDepth, sampleDepth);
  } else {
    depthMatch = farDepthAccept(centerDepth, sampleDepth, distancePixels, centerRadius);
  }
  if (!metadataDepth || !depthMatch) { return; }
  let normalizedSupport = supportWeight / sourceKernelMean(sourceRadius, tapLimit());
  let sample = textureSampleLevel(colorTexture, linearSampler, uv, 0.0);
  // The prefiltered alpha is the sample's covered area. Color and resolve
  // coverage must use the same area weight or silhouettes change energy.
  let sampleAreaWeight = cocCoverage * sample.a;
  let rawSampleWeight = supportWeight * largeSourceFactor * sampleAreaWeight;
  let coverageWeight = normalizedSupport * sourceCoverageFactor * sampleAreaWeight;
  (*accumulator).color += sample.rgb * rawSampleWeight;
  (*accumulator).weight += rawSampleWeight;
  (*accumulator).coverage += coverageWeight;
}

fn resolveGather(accumulator : GatherAccumulator, capacity : f32, fallback : vec3<f32>) -> vec4<f32> {
  let positiveWeight = max(accumulator.weight, 1e-5);
  let alpha = clamp(accumulator.coverage / max(capacity, 1e-5), 0.0, 1.0);
  let color = select(fallback, accumulator.color / positiveWeight, accumulator.weight > 0.0);
  return vec4<f32>(color, alpha);
}

fn gather(in : FullscreenOutput, useNear : bool, useFar : bool) -> GatherOutput {
  let sourceSize = vec2<f32>(textureDimensions(extra1));
  let internalToOutput = internalToOutputScale();
  let centerDepth = depthAt(in.uv);
  let centerRadius = abs(cocAtExtra1(in.uv));
  var nearFallback = vec3<f32>(0.0);
  var farFallback = vec3<f32>(0.0);
  if (useNear) { nearFallback = textureSampleLevel(currentColor, linearSampler, in.uv, 0.0).rgb; }
  if (useFar) { farFallback = textureSampleLevel(extra4, linearSampler, in.uv, 0.0).rgb; }
  if (centerDepth <= 0.0) {
    return GatherOutput(vec4<f32>(nearFallback, 0.0), vec4<f32>(farFallback, 0.0), vec4<f32>(0.0));
  }
  var near = GatherAccumulator(vec3<f32>(0.0), 0.0, 0.0);
  var far = GatherAccumulator(vec3<f32>(0.0), 0.0, 0.0);
  var backgroundColor = vec3<f32>(0.0);
  var backgroundWeight = 0.0;
  var backgroundCoverage = 0.0;
  var coverageCapacity = 0.0;
  for (var index = 0u; index < 64u; index += 1u) {
    if (f32(index) >= tapLimit()) { break; }
    // All three source-driven kernels visit the same disk. Share only their
    // source facts; color, depth acceptance and coverage remain side-local.
    let offset = sourceDiskOffset(index, tapLimit()) * internalToOutput / sourceSize;
    let uv = clamp(in.uv + offset, vec2<f32>(0.0), vec2<f32>(1.0));
    let coc = cocAtExtra1(uv);
    let cocCoverage = cocCoverageAtExtra1(uv);
    // Even rejected candidates contribute to nominal source area.
    coverageCapacity += cocCoverage;
    if (cocCoverage <= 0.0) { continue; }
    let distancePixels = length((uv - in.uv) * sourceSize) / max(internalToOutput, 1e-5);
    var sampleDepth = -1.0;
    // Background reconstruction always needs depth. Far-only gather keeps
    // its depth lookup after support rejection inside gatherSource.
    if (useNear) { sampleDepth = depthAt(uv); }
    if (useNear && selectedCocForSide(coc, true)) {
      gatherSource(uv, coc, cocCoverage, distancePixels, centerDepth, centerRadius,
        sampleDepth, true, currentColor, extra2, &near);
    }
    if (useFar && selectedCocForSide(coc, false)) {
      gatherSource(uv, coc, cocCoverage, distancePixels, centerDepth, centerRadius,
        sampleDepth, false, extra4, extra3, &far);
    }
    if (useNear) {
      let sourceRadius = abs(coc);
      let supportWeight = clamp(
        (sourceRadius + 1.0 - distancePixels) / max(sourceRadius + 1.0, 1.0),
        0.0,
        1.0,
      );
      // Background coverage remains available for focal destinations. It is
      // the full-resolution near-source transition, not half-resolution blur.
      let nearSourceFactor = smoothstep(0.5, 2.0, sourceRadius);
      // Nominal source area includes every valid source candidate. Near
      // coverage below uses the full-resolution source factor; the denominator
      // does not.
      let normalizedSupport = supportWeight / sourceKernelMean(sourceRadius, tapLimit());
      let sourceSupport = normalizedSupport * nearSourceFactor * cocCoverage;
      let nearSource = coc < -0.001 && sourceSupport > 0.0;
      backgroundCoverage += select(0.0, sourceSupport, nearSource);
      // Fill from a farther visible neighbor. The one-sided test allows a
      // foreground center at z2 to recover a background at z8, while rejecting
      // a foreground contaminant sampled into a background center.
      let depthTolerance = max(0.02, centerDepth * 0.04);
      let depthMatch = centerDepth > 0.0 && sampleDepth > 0.0 &&
        sampleDepth >= centerDepth - depthTolerance;
      if (!depthMatch) { continue; }
      // CoC sign describes focus-side blur, not whether the sample is behind
      // the current foreground silhouette. A floor sample can still be near
      // the focus plane while it remains the visible background behind a near
      // wire. Keep the relative-depth test authoritative for that case.
      let behindCenter = sampleDepth > centerDepth + depthTolerance;
      let backgroundCandidate = coc >= -0.001 || behindCenter;
      if (!backgroundCandidate) { continue; }
      let sample = textureSampleLevel(extra5, linearSampler, uv, 0.0);
      let w = cocCoverage * sample.a;
      backgroundColor += sample.rgb * w;
      backgroundWeight += w;
    }
  }
  let hasBackground = backgroundWeight > 0.0 && coverageCapacity > 0.0;
  let confidence = select(0.0,
    clamp(backgroundCoverage / max(coverageCapacity, 1e-5), 0.0, 1.0), hasBackground);
  return GatherOutput(
    resolveGather(near, coverageCapacity, nearFallback),
    resolveGather(far, coverageCapacity, farFallback),
    vec4<f32>(backgroundColor / max(backgroundWeight, 1e-5), confidence),
  );
}

@fragment
fn fs_gather_both(in : FullscreenOutput) -> GatherOutput {
  return gather(in, true, true);
}

@fragment
fn fs_gather_near(in : FullscreenOutput) -> NearGatherOutput {
  let result = gather(in, true, false);
  return NearGatherOutput(result.near, result.background);
}

@fragment
fn fs_gather_far(in : FullscreenOutput) -> @location(0) vec4<f32> {
  return gather(in, false, true).far;
}

fn smallTapLimit() -> f32 {
  if (params.image.w < 0.5) { return 8.0; }
  if (params.image.w < 1.5) { return 16.0; }
  return 24.0;
}

fn smallBlur(uv : vec2<f32>, nearSide : bool, radiusPixels : f32) -> vec4<f32> {
  let sourceSize = vec2<f32>(textureDimensions(extra1));
  let internalToOutput = internalToOutputScale();
  let count = smallTapLimit();
  let centerDepth = depthAt(uv);
  var color = textureSampleLevel(currentColor, linearSampler, uv, 0.0).rgb;
  var weight = 1.0;
  for (var index = 0u; index < 24u; index += 1u) {
    if (f32(index) >= count) { break; }
    let sampleUv = clamp(uv + diskOffset(index, count) * radiusPixels * internalToOutput / sourceSize,
      vec2<f32>(0.0), vec2<f32>(1.0));
    let sourceCoc = cocAtExtra1(sampleUv);
    let sourceCoverage = cocCoverageAtExtra1(sampleUv);
    // Only the source-driven small kernel may contribute before the
    // half-resolution 2-3px handoff. Large source circles remain owned by
    // the gather result, even when the destination is focal.
    let smallSourceFactor = 1.0 - smoothstep(2.0, 3.0, abs(sourceCoc));
    let signedMatch = select(sourceCoc > 0.001, sourceCoc < -0.001, nearSide);
    let distancePixels = length((sampleUv - uv) * sourceSize) / max(internalToOutput, 1e-5);
    let supports = distancePixels <= abs(sourceCoc) + 0.5;
    let sampleDepth = depthAt(sampleUv);
    var depthMatch = false;
    if (nearSide) {
      depthMatch = nearDepthAccept(centerDepth, sampleDepth);
    } else {
      depthMatch = farDepthAccept(centerDepth, sampleDepth, distancePixels, radiusPixels);
    }
    let accepted = signedMatch && supports && depthMatch;
    let sampleWeight = select(0.0, sourceCoverage * smallSourceFactor, accepted);
    color += textureSampleLevel(currentColor, linearSampler, sampleUv, 0.0).rgb * sampleWeight;
    weight += sampleWeight;
  }
  let confidence = clamp((weight - 1.0) / max(weight, 1.0), 0.0, 1.0);
  return vec4<f32>(color / max(weight, 1.0), confidence);
}

@fragment
fn fs_composite(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let original = textureSampleLevel(currentColor, linearSampler, in.uv, 0.0);
  let coc = cocAtExtra1(in.uv);
  let nearBlur = textureSampleLevel(extra2, linearSampler, in.uv, 0.0);
  let farBlur = textureSampleLevel(extra3, linearSampler, in.uv, 0.0);
  let background = textureSampleLevel(extra4, linearSampler, in.uv, 0.0);
  let absoluteCoc = abs(coc);
  // Half-resolution passes own the large-radius portion only. Small radii
  // stay in the full-resolution path and a 2-3px region cross-fades both.
  let largeFactor = smoothstep(2.0, 3.0, absoluteCoc);
  let smallFactor = smoothstep(0.5, 2.0, absoluteCoc) *
    (1.0 - smoothstep(2.0, 3.0, absoluteCoc));
  var color = original.rgb;
  let focalDestination = absoluteCoc < 0.5;
  let smallSideEnabled = (coc < -0.001 && params.image.z < 1.5) ||
    (coc > 0.001 && (params.image.z < 0.5 || params.image.z >= 1.5));
  let hasSmallDestination = smallSideEnabled && smallFactor > 0.0;
  if (params.image.z < 1.5) {
    // Background reconstruction is a near-coverage contribution only. A
    // zero-confidence background must leave every focal/unselected pixel
    // untouched.
    // These alphas are source coverage, so a sharp destination may receive
    // a valid neighboring near circle. Zero coverage leaves focal pixels
    // untouched; the destination CoC only controls its own large/small mix.
    let nearCoverage = clamp(background.a, 0.0, 1.0);
    let nearBase = mix(color, background.rgb, nearCoverage);
    // Reconstruct the destination's small near circle before applying the
    // large near gather. This keeps a foreground silhouette from being
    // modulated by the destination floor CoC as it crosses the focus plane.
    if (hasSmallDestination && coc < -0.001) {
      let small = smallBlur(in.uv, true, min(absoluteCoc, 3.0));
      color = mix(nearBase, small.rgb, smallFactor);
    } else {
      color = nearBase;
    }
    // Near gather coverage is source-driven: a foreground circle may cover a
    // focal destination even when that destination's CoC is zero.
    let nearWeight = clamp(nearBlur.a, 0.0, 1.0);
    if (focalDestination && (nearWeight > 0.0 || nearCoverage > 0.0)) {
      // Keep the full-resolution source-driven kernel independent from the
      // half-resolution gather. Large source circles have zero smallBlur
      // confidence and remain owned by nearBlur below.
      let small = smallBlur(in.uv, true, 2.0);
      color = mix(color, small.rgb, small.a);
    }
    color = mix(color, nearBlur.rgb, nearWeight);
  }
  if (params.image.z < 0.5 || params.image.z >= 1.5) {
    let farWeight = clamp(farBlur.a * largeFactor, 0.0, 1.0);
    color = mix(color, farBlur.rgb, farWeight);
  }
  if (hasSmallDestination && coc > 0.001) {
    let small = smallBlur(in.uv, coc < -0.001, min(absoluteCoc, 3.0));
    color = mix(color, small.rgb, smallFactor);
  }
  return vec4<f32>(color, original.a);
}
