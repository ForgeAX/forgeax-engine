#define_import_path forgeax_view::motion_blur

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::fullscreen_triangle
#import forgeax_scene_temporal::{unpackSceneTemporalV1}

// The post-process owns one bounded gather.  The producer and temporal
// transaction stays shared with TAA/SSR; this shader never creates another
// temporal target, scans a radius-sized neighbourhood, or writes a per-pixel queue.
struct MotionBlurParams {
  shutterAngle : f32,
  maxRadiusPixels : f32,
  sampleCount : u32,
  reset : u32,
  targetFps : f32,
  exposureScale : f32,
  frameDeltaSeconds : f32,
  flags : u32,
};

// Oil imports functions rather than WGSL type declarations. Keeping this small
// consumer projection beside the accessor call keeps depth/reactive decoding
// owned by forgeax_scene_temporal::unpackSceneTemporalV1.
struct MotionBlurTemporalSample {
  motionUv : vec2<f32>,
  viewDepth : f32,
  reactive : f32,
  validDepth : bool,
  motionValid : bool,
};

@group(1) @binding(0) var currentColor : texture_2d<f32>;
@group(1) @binding(1) var linearSampler : sampler;
@group(1) @binding(2) var<uniform> params : MotionBlurParams;
@group(1) @binding(3) var sceneTemporal : texture_2d<f32>;

// Match the compute lane's bounded edge reconstruction and background trail
// redistribution. The fallback is a fixed factor, never a radius-sized read.
const EDGE_FILL_FACTOR : f32 = 0.99;

// The limited raster lane has no tile-summary producer. Derive a bounded
// direction lattice from the candidate index instead of carrying a hand-picked
// ring. The first eight directions cover the near field; the remaining radial
// shells are support-intersected and remain a fixed metadata budget.
const RASTER_CANDIDATE_DIRECTION_COUNT : u32 = 8u;
const RASTER_CANDIDATE_SHELL_COUNT : u32 = 4u;
const RASTER_CANDIDATE_COUNT : u32 =
  RASTER_CANDIDATE_DIRECTION_COUNT * RASTER_CANDIDATE_SHELL_COUNT;

fn rasterCandidateOffset(index : u32, supportPixels : f32) -> vec2<f32> {
  let directionIndex = index % RASTER_CANDIDATE_DIRECTION_COUNT;
  let shell = index / RASTER_CANDIDATE_DIRECTION_COUNT + 1u;
  let angle = f32(directionIndex) * 0.7853981633974483;
  // Four support shells are a bounded approximation of the raster lane. The
  // final shell reaches the authored radius; no radius-sized loop is used.
  let radius = max(1.0, supportPixels) * f32(shell) / f32(RASTER_CANDIDATE_SHELL_COUNT);
  return vec2<f32>(cos(angle), sin(angle)) * radius;
}

fn depthReject(center : f32, sample : f32) -> bool {
  // A source farther than the receiving surface cannot bleed through a
  // foreground edge.  A nearer source is allowed to cover a static receiver.
  return sample > center + max(0.01, center * 0.01);
}

fn pixelInBounds(pixel : vec2<i32>, dimensions : vec2<i32>) -> bool {
  return pixel.x >= 0 && pixel.y >= 0 && pixel.x < dimensions.x && pixel.y < dimensions.y;
}

fn symmetricOffset(index : u32, count : u32, motion : vec2<f32>) -> vec2<f32> {
  let denominator = max(f32(count), 1.0);
  // Midpoint integration over the complete symmetric support [-1, 1].
  // Keeping the half-step is essential: the end taps reach the authored
  // radius instead of silently shrinking it as the tap count changes.
  return motion * (2.0 * (f32(index) + 0.5) / denominator - 1.0);
}

fn isFinite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn distinctDirection(a : vec2<f32>, b : vec2<f32>) -> bool {
  let aLength = length(a);
  let bLength = length(b);
  if (aLength <= 1e-5 || bLength <= 1e-5) { return false; }
  return abs(dot(a / aLength, b / bLength)) < 0.94;
}

fn sourceVelocitySegmentCovers(
  receiverPixel : vec2<i32>,
  sourcePixel : vec2<i32>,
  motionPixels : vec2<f32>,
  radius : f32,
) -> bool {
  let delta = vec2<f32>(receiverPixel - sourcePixel);
  let motionLength = length(motionPixels);
  if (motionLength <= 1e-5 || radius <= 1e-5) { return false; }
  let direction = motionPixels / motionLength;
  let along = dot(delta, direction);
  let perpendicular = abs(delta.x * direction.y - delta.y * direction.x);
  return abs(along) <= radius + 0.75 && perpendicular <= 0.75;
}

struct MotionBlurDirectionCandidates {
  primary : vec2<f32>,
  secondary : vec2<f32>,
  primaryLength : f32,
  secondaryLength : f32,
};

fn temporalAt(
  pixel : vec2<i32>,
  colorDimensions : vec2<i32>,
  temporalDimensions : vec2<i32>,
) -> MotionBlurTemporalSample {
  let colorUv = (vec2<f32>(pixel) + vec2<f32>(0.5)) / vec2<f32>(colorDimensions);
  let temporalPixel = vec2<i32>(floor(colorUv * vec2<f32>(temporalDimensions)));
  let samplePixel = clamp(
    temporalPixel,
    vec2<i32>(0),
    temporalDimensions - vec2<i32>(1),
  );
  let unpacked = unpackSceneTemporalV1(textureLoad(sceneTemporal, samplePixel, 0));
  return MotionBlurTemporalSample(
    unpacked.motionUv,
    unpacked.viewDepth,
    unpacked.reactive,
    unpacked.validDepth,
    unpacked.motionValid,
  );
}

fn selectNeighbourMotion(
  center : MotionBlurTemporalSample,
  pixel : vec2<i32>,
  colorDimensions : vec2<i32>,
  temporalDimensions : vec2<i32>,
  shutter : f32,
  exposureScale : f32,
  maxRadiusPixels : f32,
) -> MotionBlurDirectionCandidates {
  var selected = center.motionUv * vec2<f32>(colorDimensions) * exposureScale;
  var selectedLength = length(selected);
  var secondary = vec2<f32>(0.0);
  var secondaryLength = 0.0;
  // The derived lattice expands with the authored support but keeps a fixed
  // 32-probe upper bound. A candidate is metadata-only until its decoded
  // source velocity proves that it covers this receiver.
  for (var index = 0u; index < RASTER_CANDIDATE_COUNT; index += 1u) {
    let offset = rasterCandidateOffset(index, maxRadiusPixels);
    let candidatePixel = pixel + vec2<i32>(round(offset));
    if (!pixelInBounds(candidatePixel, colorDimensions)) { continue; }
    let candidate = temporalAt(candidatePixel, colorDimensions, temporalDimensions);
    if (
      !candidate.validDepth ||
      !candidate.motionValid ||
      depthReject(center.viewDepth, candidate.viewDepth)
    ) { continue; }
    let candidateMotion = candidate.motionUv * vec2<f32>(colorDimensions) * exposureScale;
    let candidateLength = min(length(candidateMotion) * shutter * 0.5, maxRadiusPixels);
    if (
      !sourceVelocitySegmentCovers(
        pixel,
        candidatePixel,
        candidateMotion,
        candidateLength,
      )
    ) { continue; }
    let selectedRadius = min(selectedLength * shutter * 0.5, maxRadiusPixels);
    if (candidateLength > selectedRadius) {
      if (selectedLength > 1e-5 && distinctDirection(selected, candidateMotion)) {
        secondary = selected;
        secondaryLength = selectedLength;
      }
      selected = candidateMotion;
      selectedLength = length(candidateMotion);
    } else if (
      candidateLength > min(secondaryLength * shutter * 0.5, maxRadiusPixels) &&
      distinctDirection(selected, candidateMotion)
    ) {
      secondary = candidateMotion;
      secondaryLength = length(candidateMotion);
    }
  }
  return MotionBlurDirectionCandidates(selected, secondary, selectedLength, secondaryLength);
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertexIndex);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let colorDimensions = vec2<i32>(textureDimensions(currentColor));
  let temporalDimensions = vec2<i32>(textureDimensions(sceneTemporal));
  let pixel = clamp(
    vec2<i32>(floor(in.uv * vec2<f32>(colorDimensions))),
    vec2<i32>(0),
    colorDimensions - vec2<i32>(1),
  );
  let packed = temporalAt(pixel, colorDimensions, temporalDimensions);
  let shutter = clamp(params.shutterAngle / 360.0, 0.0, 1.0);
  let invalidDepth = !packed.validDepth;
  let invalidMotion = !packed.motionValid;
  let invalidInterval =
    !isFinite(params.frameDeltaSeconds) ||
    params.frameDeltaSeconds <= 0.0 ||
    params.frameDeltaSeconds > 0.1 ||
    !isFinite(params.exposureScale) ||
    params.exposureScale <= 0.0 ||
    !isFinite(params.targetFps) ||
    params.targetFps < 0.0 ||
    params.targetFps > 240.0 ||
    params.targetFps != floor(params.targetFps);
  let reset = params.reset != 0u;
  // Invalid pairs cannot produce a trustworthy blur. Guard them before the
  // fixed neighbour probe so new/topology-invalid pixels pay no candidate or
  // color-gather cost. Reactive remains a separate TAA confidence signal.
  if (
    invalidDepth ||
    invalidMotion ||
    reset ||
    invalidInterval ||
    params.sampleCount < 4u ||
    shutter <= 0.0 ||
    params.maxRadiusPixels <= 0.0
  ) {
    return textureLoad(currentColor, pixel, 0);
  }
  let candidates = selectNeighbourMotion(
    packed,
    pixel,
    colorDimensions,
    temporalDimensions,
    shutter,
    params.exposureScale,
    params.maxRadiusPixels,
  );
  // Radius is half of the complete symmetric support. Keeping this separate
  // from the direction makes the authored shutter length independent of tap count.
  let radius = min(candidates.primaryLength * shutter * 0.5, params.maxRadiusPixels);
  let secondaryRadius = min(
    candidates.secondaryLength * shutter * 0.5,
    params.maxRadiusPixels,
  );
  let hasSecondary =
    secondaryRadius > 1e-5 && distinctDirection(candidates.primary, candidates.secondary);
  let motion = normalize(select(vec2<f32>(0.0), candidates.primary, radius > 1e-5));
  if (radius <= 1e-5 && !hasSecondary) {
    return textureLoad(currentColor, pixel, 0);
  }

  // Reserve one colour read for the receiving pixel. The remaining reads are
  // the bounded support budget; coverage and the uncovered domain stay
  // separate so a sparse foreground sample never becomes an opaque pixel.
  let centerColor = textureLoad(currentColor, pixel, 0);
  let centerMoving = packed.motionValid && length(packed.motionUv) > 1e-5;
  var accum = vec4<f32>(0.0);
  var weight = 0.0;
  let dimensions = vec2<f32>(colorDimensions);
  let count = min(params.sampleCount, 16u);
  let supportCount = max(count - 1u, 1u);
  let primaryCount = select(supportCount, max(supportCount / 2u, 1u), hasSecondary);
  let secondaryCount = max(supportCount - primaryCount, 1u);
  for (var index = 0u; index < 16u; index += 1u) {
    if (index >= supportCount) { break; }
    let secondDirection = hasSecondary && index >= primaryCount;
    let selectedCount = select(primaryCount, secondaryCount, secondDirection);
    let selectedIndex = select(index, index - primaryCount, secondDirection);
    let selectedMotion = select(
      motion,
      normalize(select(vec2<f32>(0.0), candidates.secondary, secondaryRadius > 1e-5)),
      secondDirection,
    );
    let selectedRadius = select(radius, secondaryRadius, secondDirection);
    let offset = symmetricOffset(selectedIndex, selectedCount, selectedMotion * selectedRadius) / dimensions;
    let sampleUv = in.uv + offset;
    // Drop out-of-view taps and renormalize instead of repeatedly sampling
    // the border texel, which creates bright/dark edge streaks.
    if (sampleUv.x < 0.0 || sampleUv.y < 0.0 || sampleUv.x >= 1.0 || sampleUv.y >= 1.0) {
      continue;
    }
    let samplePixel = vec2<i32>(floor(sampleUv * dimensions));
    if (!pixelInBounds(samplePixel, colorDimensions)) { continue; }
    let sampleTemporal = temporalAt(samplePixel, colorDimensions, temporalDimensions);
    if (
      sampleTemporal.validDepth &&
      sampleTemporal.motionValid &&
      !depthReject(packed.viewDepth, sampleTemporal.viewDepth) &&
      sourceVelocitySegmentCovers(
        pixel,
        samplePixel,
        sampleTemporal.motionUv * vec2<f32>(colorDimensions) * params.exposureScale,
        min(
          length(sampleTemporal.motionUv * vec2<f32>(colorDimensions) * params.exposureScale) *
            shutter * 0.5,
          params.maxRadiusPixels,
        ),
      )
    ) {
      let sampleColor = textureSampleLevel(currentColor, linearSampler, sampleUv, 0.0);
      accum += sampleColor;
      weight += 1.0;
    }
  }
  let uncovered = max(f32(supportCount) - weight, 0.0);
  // A moving receiver can be partially covered at a silhouette edge. Use the
  // accepted foreground only for missing current coverage; a fully covered
  // receiver keeps the original center contribution.
  let acceptedColor = select(vec3<f32>(0.0), accum.rgb / max(weight, 1.0), weight > 0.0);
  // Preserve the color target's authored alpha as the output floor. It is
  // separate from the RGB test below, which identifies an empty background
  // receiver without treating alpha as a scene-coverage attachment.
  let missingForeground = 1.0 - clamp(centerColor.a, 0.0, 1.0);
  let edgeCoverage = select(missingForeground, 1.0, centerMoving);
  let edgeFill = acceptedColor * edgeCoverage * EDGE_FILL_FACTOR;
  let movingFallback = select(centerColor.rgb, edgeFill, weight > 0.0);
  let uncoveredColor = select(vec3<f32>(0.0), movingFallback, centerMoving);
  // Carry accepted moving-foreground coverage into alpha. Otherwise an
  // RGB edge reconstructed outside the current silhouette remains transparent
  // and is composited as a black band on the target.
  let acceptedAlpha = select(0.0, accum.a / max(weight, 1.0), weight > 0.0);
  let acceptedCoverage = weight + missingForeground * uncovered;
  let reconstructedAlpha = acceptedAlpha * acceptedCoverage / max(f32(count), 1.0);
  let outputAlpha = clamp(max(centerColor.a, reconstructedAlpha), 0.0, 1.0);
  let emptyReceiver =
    !centerMoving &&
    weight > 0.0 &&
    max(max(abs(centerColor.r), abs(centerColor.g)), abs(centerColor.b)) < 1e-4;
  let sourceScale = select(1.0, 1.0 - EDGE_FILL_FACTOR, emptyReceiver);
  let sourceContribution = accum.rgb * sourceScale;
  let trailScale = select(1.0, 1.0 - EDGE_FILL_FACTOR, emptyReceiver);
  let trailContribution = uncoveredColor * uncovered * trailScale;
  return vec4<f32>(
    (sourceContribution + centerColor.rgb + trailContribution) / max(f32(count), 1.0),
    outputAlpha,
  );
}
