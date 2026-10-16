import type { RenderGraphBuilder, RenderGraphError } from '@forgeax/engine-render-graph';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../../errors/render';
import type { RenderPipelineFrame, RenderPipelineTarget } from '../../render-pipeline';
import { SCENE_DATA_TEMPORAL_V1_SCHEMA } from '../../temporal/scene-data';
import { addTypedFullscreenPass } from '../../typed-render-graph-primitives';
import type {
  RenderFeaturePlan,
  RenderFeaturePlanContext,
  RenderFeaturePlanView,
  RenderFeatureWorkPlan,
} from '../plan';
import type { RenderFeature, RenderFeatureExtractContext } from '../types';
import {
  effectiveMotionBlurSampleCount,
  MOTION_BLUR_PARAMS_BYTE_SIZE,
  type MotionBlurParams,
  motionBlurExposureScale,
  motionBlurTemporalDemand,
  validateMotionBlurParams,
} from './motion-blur-params';

export const MOTION_BLUR_FEATURE_IDENTITY = 'forgeax.motion-blur';

export function addMotionBlurPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: RenderPipelineTarget,
  temporal: RenderPipelineTarget,
  output: RenderPipelineTarget,
): Result<void, RenderGraphError> {
  return addTypedFullscreenPass(graph, {
    name: 'motion-blur',
    shader: MOTION_BLUR_FEATURE_IDENTITY,
    input,
    additionalReads: [{ key: 'scene-temporal', target: temporal }],
    outputs: [output],
  });
}

export interface MotionBlurFeatureFrame {
  readonly params: MotionBlurParams | undefined;
  readonly demanded: boolean;
  /** Raw accepted-submit interval; it is never replaced by ECS clamp time. */
  readonly frameDeltaSeconds: number;
  /** Temporal reset already admitted by the shared renderer transaction. */
  readonly reset: boolean;
}

export interface MotionBlurFeatureInput {
  readonly params: Partial<MotionBlurParams> | undefined;
  readonly frameDeltaSeconds?: number;
  readonly reset?: boolean;
}

/**
 * Compute owner for the long-vector lane.  The summary is one 32-byte record
 * per 16x16 tile and the reconstruction is fused: a long vector reuses an
 * even-pixel (half-resolution) source lattice and performs depth-guided
 * acceptance in the same dispatch. There is no scatter, atomic, or
 * radius-squared neighbourhood work.
 */
export const MOTION_BLUR_COMPUTE_WGSL = `struct MotionBlurComputeParams {
  shutterAngle : f32,
  maxRadiusPixels : f32,
  sampleCount : u32,
  reset : u32,
  targetFps : f32,
  exposureScale : f32,
  frameDeltaSeconds : f32,
  flags : u32,
};

struct MotionBlurTileSummary {
  // The two motion lanes retain the source pixel that supplied the direction.
  // Those anchors let a bounded midpoint tap hit a sparse source without
  // adding a color read or growing the 32-byte per-tile summary.
  maxMotionAndLength : vec4<f32>,
  secondaryMotionAndDepth : vec4<f32>,
};

struct TemporalSample {
  motion : vec2<f32>,
  depth : f32,
  reactive : f32,
  validDepth : bool,
  motionValid : bool,
};

struct MotionBlurSupport {
  primaryMotion : vec2<f32>,
  secondaryMotion : vec2<f32>,
  primaryAnchor : vec2<i32>,
  secondaryAnchor : vec2<i32>,
  primaryRadius : f32,
  secondaryRadius : f32,
  valid : bool,
  longVector : bool,
};

struct MotionBlurTap {
  pixel : vec2<i32>,
  fallbackPixel : vec2<i32>,
  valid : bool,
  fallbackValid : bool,
};

struct MotionBlurFilter {
  color0 : vec4<f32>,
  color1 : vec4<f32>,
  color2 : vec4<f32>,
  color3 : vec4<f32>,
  depth0 : f32,
  depth1 : f32,
  depth2 : f32,
  depth3 : f32,
  coverage0 : f32,
  coverage1 : f32,
  coverage2 : f32,
  coverage3 : f32,
  receiver : vec2<i32>,
  motion : vec2<f32>,
  radius : f32,
  receiverMask : u32,
  validMask : u32,
  valid : bool,
};

struct MotionBlurCacheSample {
  color : vec4<f32>,
  coverage : f32,
  valid : bool,
};

struct MotionBlurSource {
  pixel : vec2<i32>,
  motion : vec2<f32>,
  depth : f32,
  radius : f32,
  coverage0 : f32,
  coverage1 : f32,
  coverage2 : f32,
  coverage3 : f32,
  receiverMask : u32,
  valid : bool,
};

@group(0) @binding(0) var currentColor : texture_2d<f32>;
@group(0) @binding(1) var sceneTemporal : texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> tileSummary : array<MotionBlurTileSummary>;
@group(0) @binding(3) var outputColor : texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<uniform> params : MotionBlurComputeParams;

// Reconstruct a bounded part of a partially covered opaque edge and fund it
// by attenuating the matching empty-background trail. The fixed factor keeps
// the work and the energy adjustment independent of the blur radius.
const EDGE_FILL_FACTOR : f32 = 0.99;

// One 8x8 workgroup covers a 16x16 tile. Each invocation reads a 2x2
// footprint, then the workgroup reduction combines the values without
// write contention or a serial 256-pixel loop.
var<workgroup> tileMotionScratch : array<vec2<f32>, 64>;
var<workgroup> tileLengthScratch : array<f32, 64>;
var<workgroup> tileSourceScratch : array<vec2<i32>, 64>;
var<workgroup> tileSecondaryMotionScratch : array<vec2<f32>, 64>;
var<workgroup> tileSecondaryLengthScratch : array<f32, 64>;
var<workgroup> tileSecondarySourceScratch : array<vec2<i32>, 64>;
// The reconstruction workgroup owns a 4x4 half-resolution result cache for
// its 8x8 output footprint. Each owner computes the complete bounded support
// filter once. Full-resolution lanes only select a depth-compatible cached
// result after the uniform barrier, with no cross-workgroup dependency.
// Four quadrants are kept per half-cell. Each owner pays four receiver
// center-color reads and at most supportCount (<=15) accepted source-color
// reads; midpoint anchor recovery reuses an existing slot and adds no read
// budget. The shared result retains odd/even coverage instead of spreading an
// odd row across both rows.
var<workgroup> halfFilteredColor : array<vec4<f32>, 64>;
var<workgroup> halfFilteredDepth : array<f32, 64>;
var<workgroup> halfFilteredCoverage : array<f32, 64>;
var<workgroup> halfFilteredReceiver : array<vec2<i32>, 16>;
var<workgroup> halfFilteredMotion : array<vec2<f32>, 16>;
var<workgroup> halfFilteredRadius : array<f32, 16>;
var<workgroup> halfFilteredValid : array<u32, 64>;
var<workgroup> longVectorScratch : array<u32, 64>;
// A reconstruct workgroup covers one 8x8 output footprint. Its first lane
// derives the complete bounded tile neighbourhood once and publishes the top
// two source directions for all lanes and all designated half-resolution
// owners. This keeps summary work O(P/T^2), rather than repeating a tile walk
// per output pixel.
var<workgroup> neighbourhoodPrimaryMotion : vec2<f32>;
var<workgroup> neighbourhoodPrimaryLength : f32;
var<workgroup> neighbourhoodPrimaryAnchor : vec2<i32>;
var<workgroup> neighbourhoodSecondaryMotion : vec2<f32>;
var<workgroup> neighbourhoodSecondaryLength : f32;
var<workgroup> neighbourhoodSecondaryAnchor : vec2<i32>;

// maxRadiusPixels is authored at [0,64], so a 16-pixel tile support reaches
// at most four tiles. The fixed 9x9 lattice is geometrically derived from its
// index, then intersected with the circular/AABB support. It is a constant
// bounded metadata walk: no loop scales with the requested radius and no
// radius-squared per-pixel storage or write path is introduced.
const MAX_TILE_REACH : i32 = 4;
const TILE_NEIGHBORHOOD_SIDE : u32 = 9u;
const TILE_NEIGHBORHOOD_COUNT : u32 = 81u;

fn finite(value : f32) -> bool {
  return value == value && abs(value) < 3.402823e+38;
}

fn pixelInBounds(pixel : vec2<i32>, dimensions : vec2<i32>) -> bool {
  return pixel.x >= 0 && pixel.y >= 0 && pixel.x < dimensions.x && pixel.y < dimensions.y;
}

fn decodeDepth(packed : f32) -> f32 {
  if (packed < 0.0) { return 0.0; }
  return exp2(packed) - 1.0;
}

fn temporalAt(pixel : vec2<i32>, dimensions : vec2<i32>) -> TemporalSample {
  let samplePixel = clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1));
  let packed = textureLoad(sceneTemporal, samplePixel, 0);
  let invalidMotion = packed.w >= 2.0;
  return TemporalSample(
    packed.xy,
    decodeDepth(packed.z),
    clamp(packed.w - select(0.0, 2.0, invalidMotion), 0.0, 1.0),
    packed.z >= 0.0,
    !invalidMotion,
  );
}

fn depthReject(center : f32, sample : f32) -> bool {
  return sample > center + max(0.01, center * 0.01);
}

fn distinctDirection(a : vec2<f32>, b : vec2<f32>) -> bool {
  let aLength = length(a);
  let bLength = length(b);
  if (aLength <= 1e-5 || bLength <= 1e-5) { return false; }
  // Keep only genuinely different directions. Opposite signs still carry
  // separate source segments, while nearly parallel candidates do not spend
  // the bounded second-direction slot.
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
  // A source segment owns a one-pixel coverage tube. This is a bounded
  // geometric test, not a radius-sized source scan, and lets a sparse mover
  // cover a static receiver without accepting a far/orthogonal source.
  return abs(along) <= radius + 0.75 && perpendicular <= 0.75;
}

fn symmetricOffset(index : u32, count : u32, motion : vec2<f32>) -> vec2<f32> {
  let denominator = max(f32(count), 1.0);
  return motion * (2.0 * (f32(index) + 0.5) / denominator - 1.0);
}

fn tileNeighborhoodOffset(index : u32) -> vec2<i32> {
  let x = i32(index % TILE_NEIGHBORHOOD_SIDE) - MAX_TILE_REACH;
  let y = i32(index / TILE_NEIGHBORHOOD_SIDE) - MAX_TILE_REACH;
  return vec2<i32>(x, y);
}

fn tileOffsetWithinSupport(offset : vec2<i32>, tileReach : i32) -> bool {
  if (offset.x == 0 && offset.y == 0) { return false; }
  let boundedReach = min(max(tileReach, 1), MAX_TILE_REACH);
  // The bounded lattice is a square around the receiver tile. The precise
  // AABB/circle intersection below decides whether a diagonal tile really
  // intersects the support; a circular pre-filter here would drop the
  // (±2,±2) and boundary cases before that exact test can run.
  return abs(offset.x) <= boundedReach && abs(offset.y) <= boundedReach;
}

fn tileIntersectsSupport(
  receiverPixel : vec2<i32>,
  candidateTile : vec2<i32>,
  dimensions : vec2<i32>,
  supportRadius : f32,
) -> bool {
  // Use the receiver-to-tile-AABB lower bound. This includes every tile whose
  // contents can intersect the support, including signs and diagonals, while
  // rejecting an outside-support tile before loading its summary.
  let tileMin = vec2<f32>(candidateTile * 16);
  let tileMax = min(tileMin + vec2<f32>(16.0), vec2<f32>(dimensions));
  let receiver = vec2<f32>(receiverPixel) + vec2<f32>(0.5);
  let dx = max(max(tileMin.x - receiver.x, 0.0), receiver.x - tileMax.x);
  let dy = max(max(tileMin.y - receiver.y, 0.0), receiver.y - tileMax.y);
  let distance = vec2<f32>(dx, dy);
  return dot(distance, distance) <= supportRadius * supportRadius + 1.0;
}

fn tileIntersectsWorkgroupSupport(
  workgroupBase : vec2<i32>,
  candidateTile : vec2<i32>,
  dimensions : vec2<i32>,
  supportRadius : f32,
) -> bool {
  // A workgroup's 8x8 rectangle is the conservative receiver domain for one
  // shared metadata walk. The AABB lower bound includes every pixel in that
  // rectangle that can reach the candidate tile, including diagonal/sign
  // variants, while rejecting a tile fully outside the support.
  let tileMin = vec2<f32>(candidateTile * 16);
  let tileMax = min(tileMin + vec2<f32>(16.0), vec2<f32>(dimensions));
  let groupMin = vec2<f32>(workgroupBase) + vec2<f32>(0.5);
  let groupMax = min(groupMin + vec2<f32>(8.0), vec2<f32>(dimensions));
  let dx = max(max(tileMin.x - groupMax.x, 0.0), groupMin.x - tileMax.x);
  let dy = max(max(tileMin.y - groupMax.y, 0.0), groupMin.y - tileMax.y);
  let distance = vec2<f32>(dx, dy);
  return dot(distance, distance) <= supportRadius * supportRadius + 1.0;
}

fn scanTileNeighbourhood(
  workgroupBase : vec2<i32>,
  dimensions : vec2<i32>,
) {
  let tiles = (vec2<u32>(dimensions) + vec2<u32>(15)) / vec2<u32>(16);
  let tileCoordinate = workgroupBase / vec2<i32>(16);
  let currentIndex = u32(tileCoordinate.y) * tiles.x + u32(tileCoordinate.x);
  let current = tileSummary[currentIndex];
  var primary = current.maxMotionAndLength.xy * vec2<f32>(dimensions) * params.exposureScale;
  var primaryLength = length(primary);
  var primaryAnchor = vec2<i32>(
    i32(current.maxMotionAndLength.z),
    i32(current.maxMotionAndLength.w),
  );
  var secondary = current.secondaryMotionAndDepth.xy * vec2<f32>(dimensions) * params.exposureScale;
  var secondaryLength = length(secondary);
  var secondaryAnchor = vec2<i32>(
    i32(current.secondaryMotionAndDepth.z),
    i32(current.secondaryMotionAndDepth.w),
  );
  let supportRadius = min(max(params.maxRadiusPixels, 1.0), 64.0);
  let tileReach = min(MAX_TILE_REACH, max(1, i32(ceil(supportRadius / 16.0))));
  for (var tileCandidateIndex = 0u; tileCandidateIndex < TILE_NEIGHBORHOOD_COUNT; tileCandidateIndex += 1u) {
    let offset = tileNeighborhoodOffset(tileCandidateIndex);
    if (!tileOffsetWithinSupport(offset, tileReach)) { continue; }
    let candidateTile = tileCoordinate + offset;
    if (
      candidateTile.x < 0 ||
      candidateTile.y < 0 ||
      candidateTile.x >= i32(tiles.x) ||
      candidateTile.y >= i32(tiles.y) ||
      !tileIntersectsWorkgroupSupport(workgroupBase, candidateTile, dimensions, supportRadius)
    ) { continue; }
    let candidate = tileSummary[u32(candidateTile.y) * tiles.x + u32(candidateTile.x)];
    let candidatePrimary = candidate.maxMotionAndLength.xy * vec2<f32>(dimensions) * params.exposureScale;
    let candidatePrimaryLength = length(candidatePrimary);
    let candidatePrimaryAnchor = vec2<i32>(
      i32(candidate.maxMotionAndLength.z),
      i32(candidate.maxMotionAndLength.w),
    );
    if (candidatePrimaryLength > primaryLength) {
      let previousPrimary = primary;
      let previousLength = primaryLength;
      let previousAnchor = primaryAnchor;
      primary = candidatePrimary;
      primaryLength = candidatePrimaryLength;
      primaryAnchor = candidatePrimaryAnchor;
      if (previousLength > 1e-5 && distinctDirection(primary, previousPrimary) && previousLength > secondaryLength) {
        secondary = previousPrimary;
        secondaryLength = previousLength;
        secondaryAnchor = previousAnchor;
      }
    } else if (
      candidatePrimaryLength > secondaryLength &&
      distinctDirection(primary, candidatePrimary)
    ) {
      secondary = candidatePrimary;
      secondaryLength = candidatePrimaryLength;
      secondaryAnchor = candidatePrimaryAnchor;
    }
    let candidateSecondary = candidate.secondaryMotionAndDepth.xy * vec2<f32>(dimensions) * params.exposureScale;
    let candidateSecondaryLength = length(candidateSecondary);
    let candidateSecondaryAnchor = vec2<i32>(
      i32(candidate.secondaryMotionAndDepth.z),
      i32(candidate.secondaryMotionAndDepth.w),
    );
    if (candidateSecondaryLength > secondaryLength && distinctDirection(primary, candidateSecondary)) {
      secondary = candidateSecondary;
      secondaryLength = candidateSecondaryLength;
      secondaryAnchor = candidateSecondaryAnchor;
    }
  }
  neighbourhoodPrimaryMotion = primary;
  neighbourhoodPrimaryLength = primaryLength;
  neighbourhoodPrimaryAnchor = primaryAnchor;
  neighbourhoodSecondaryMotion = secondary;
  neighbourhoodSecondaryLength = secondaryLength;
  neighbourhoodSecondaryAnchor = secondaryAnchor;
}

fn validMotionParameters() -> bool {
  return
    finite(params.frameDeltaSeconds) &&
    params.frameDeltaSeconds > 0.0 &&
    params.frameDeltaSeconds <= 0.1 &&
    finite(params.exposureScale) &&
    params.exposureScale > 0.0 &&
    finite(params.targetFps) &&
    params.targetFps >= 0.0 &&
    params.targetFps <= 240.0 &&
    params.targetFps == floor(params.targetFps) &&
    params.sampleCount >= 4u &&
    params.maxRadiusPixels > 0.0 &&
    finite(params.maxRadiusPixels) &&
    params.shutterAngle > 0.0;
}

fn sourceMotionPixels(sample : TemporalSample, dimensions : vec2<i32>) -> vec2<f32> {
  return sample.motion * vec2<f32>(dimensions) * params.exposureScale;
}

fn sourceRadius(motionPixels : vec2<f32>, shutter : f32) -> f32 {
  return min(length(motionPixels) * shutter * 0.5, params.maxRadiusPixels);
}

fn resolveMotionBlurSupport(
  pixel : vec2<i32>,
  dimensions : vec2<i32>,
) -> MotionBlurSupport {
  var empty = MotionBlurSupport(
    vec2<f32>(0.0),
    vec2<f32>(0.0),
    vec2<i32>(0),
    vec2<i32>(0),
    0.0,
    0.0,
    false,
    false,
  );
  if (!pixelInBounds(pixel, dimensions) || !validMotionParameters() || params.reset != 0u) {
    return empty;
  }
  let center = temporalAt(pixel, dimensions);
  if (!center.validDepth || !center.motionValid) { return empty; }
  let shutter = clamp(params.shutterAngle / 360.0, 0.0, 1.0);
  let centerMotion = sourceMotionPixels(center, dimensions);
  let centerLength = length(centerMotion);
  var primaryMotion = centerMotion;
  var primaryLength = centerLength;
  var primaryAnchor = pixel;
  var secondaryMotion = neighbourhoodSecondaryMotion;
  var secondaryLength = neighbourhoodSecondaryLength;
  var secondaryAnchor = neighbourhoodSecondaryAnchor;
  if (neighbourhoodPrimaryLength > primaryLength) {
    if (distinctDirection(primaryMotion, neighbourhoodPrimaryMotion)) {
      secondaryMotion = primaryMotion;
      secondaryLength = primaryLength;
      secondaryAnchor = pixel;
    }
    primaryMotion = neighbourhoodPrimaryMotion;
    primaryLength = neighbourhoodPrimaryLength;
    primaryAnchor = neighbourhoodPrimaryAnchor;
  } else if (
    neighbourhoodPrimaryLength > secondaryLength &&
    distinctDirection(primaryMotion, neighbourhoodPrimaryMotion)
  ) {
    secondaryMotion = neighbourhoodPrimaryMotion;
    secondaryLength = neighbourhoodPrimaryLength;
    secondaryAnchor = neighbourhoodPrimaryAnchor;
  }
  if (
    secondaryLength <= 1e-5 ||
    !distinctDirection(primaryMotion, secondaryMotion)
  ) {
    secondaryMotion = vec2<f32>(0.0);
    secondaryLength = 0.0;
  }
  empty.primaryMotion = primaryMotion;
  empty.secondaryMotion = secondaryMotion;
  empty.primaryAnchor = primaryAnchor;
  empty.secondaryAnchor = secondaryAnchor;
  empty.primaryRadius = sourceRadius(primaryMotion, shutter);
  empty.secondaryRadius = sourceRadius(secondaryMotion, shutter);
  empty.valid = empty.primaryRadius > 1e-5 || empty.secondaryRadius > 1e-5;
  empty.longVector = max(empty.primaryRadius, empty.secondaryRadius) > 8.0;
  return empty;
}

fn sourceAnchorForReceiver(
  receiverPixel : vec2<i32>,
  anchor : vec2<i32>,
  motion : vec2<f32>,
  dimensions : vec2<i32>,
) -> vec2<i32> {
  // A tile summary has one source anchor, while a horizontal source may span
  // the tile's perpendicular axis. Project that anchor onto the receiver's
  // motion line before the midpoint read. The following source footprint
  // validates the projected pixel, so a thin or off-axis source cannot be
  // invented by the projection.
  let motionLength = length(motion);
  if (motionLength <= 1e-5) { return anchor; }
  let direction = motion / motionLength;
  let delta = vec2<f32>(receiverPixel - anchor);
  let perpendicular = delta - direction * dot(delta, direction);
  let projected = vec2<f32>(anchor) + perpendicular;
  let candidate = vec2<i32>(floor(projected + vec2<f32>(0.5)));
  return clamp(candidate, vec2<i32>(0), dimensions - vec2<i32>(1));
}

fn supportTap(
  receiverPixel : vec2<i32>,
  index : u32,
  count : u32,
  motion : vec2<f32>,
  radius : f32,
  anchor : vec2<i32>,
  dimensions : vec2<i32>,
) -> MotionBlurTap {
  // Preserve the geometric midpoint as the primary sample. The source anchor
  // is a recovery coordinate for a sparse tile summary, not a replacement for
  // the receiver's authored support. It is tried only when this midpoint has
  // no valid source, and therefore never adds a color read or a tap.
  var fallbackPixel = vec2<i32>(0);
  var fallbackValid = false;
  if (index == count / 2u) {
    fallbackPixel = sourceAnchorForReceiver(receiverPixel, anchor, motion, dimensions);
    fallbackValid = pixelInBounds(fallbackPixel, dimensions);
  }
  let direction = motion / max(length(motion), 1e-5);
  let offset = symmetricOffset(index, count, direction * radius);
  let dimensionsF = vec2<f32>(dimensions);
  let uv = (vec2<f32>(receiverPixel) + vec2<f32>(0.5) + offset) / dimensionsF;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) {
    return MotionBlurTap(vec2<i32>(0), fallbackPixel, false, fallbackValid);
  }
  let candidate = vec2<i32>(floor(uv * dimensionsF));
  return MotionBlurTap(candidate, fallbackPixel, pixelInBounds(candidate, dimensions), fallbackValid);
}

fn sourceAt(
  receiverPixel : vec2<i32>,
  sourcePixel : vec2<i32>,
  centerDepth : f32,
  shutter : f32,
  dimensions : vec2<i32>,
) -> MotionBlurSource {
  let empty = MotionBlurSource(
    vec2<i32>(0),
    vec2<f32>(0.0),
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0u,
    false,
  );
  if (!pixelInBounds(sourcePixel, dimensions)) { return empty; }
  let source = temporalAt(sourcePixel, dimensions);
  if (!source.validDepth || !source.motionValid || depthReject(centerDepth, source.depth)) {
    return empty;
  }
  let motionPixels = sourceMotionPixels(source, dimensions);
  let radius = sourceRadius(motionPixels, shutter);
  if (!sourceVelocitySegmentCovers(receiverPixel, sourcePixel, motionPixels, radius)) {
    return empty;
  }
  return MotionBlurSource(
    sourcePixel,
    motionPixels,
    source.depth,
    radius,
    1.0,
    1.0,
    1.0,
    1.0,
    0u,
    true,
  );
}

// A half-resolution owner represents a complete 2x2 receiving footprint. The
// source motion test is evaluated against every receiving pixel in that
// footprint, so odd/even rows and columns remain visible without a second
// filter pass or an unbounded neighbourhood walk.
fn sourceAtFootprint(
  receiverPixel : vec2<i32>,
  sourcePixel : vec2<i32>,
  centerDepth : f32,
  shutter : f32,
  dimensions : vec2<i32>,
) -> MotionBlurSource {
  var selected = MotionBlurSource(
    vec2<i32>(0),
    vec2<f32>(0.0),
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0u,
    false,
  );
  var selectedDepth = 3.402823e+38;
  var coverage0 = 0.0;
  var coverage1 = 0.0;
  var coverage2 = 0.0;
  var coverage3 = 0.0;
  var selectedReceiverMask = 0u;
  for (var y = 0u; y < 2u; y += 1u) {
    for (var x = 0u; x < 2u; x += 1u) {
      let candidatePixel = sourcePixel + vec2<i32>(i32(x), i32(y));
      if (!pixelInBounds(candidatePixel, dimensions)) { continue; }
      let temporal = temporalAt(candidatePixel, dimensions);
      if (!temporal.validDepth || !temporal.motionValid || depthReject(centerDepth, temporal.depth)) {
        continue;
      }
      let motionPixels = sourceMotionPixels(temporal, dimensions);
      let radius = sourceRadius(motionPixels, shutter);
      var receiverMask = 0u;
      // A source half-cell and a receiver half-cell share the same integer
      // displacement. This one-to-one correspondence keeps a diagonal source
      // from being counted for all four receiver quadrants just because its
      // tube crosses the quadrant. The segment test still supplies the motion
      // support and depth/validity checks remain source-owned.
      let receiver = receiverPixel + vec2<i32>(i32(x), i32(y));
      if (
        pixelInBounds(receiver, dimensions) &&
        sourceVelocitySegmentCovers(receiver, candidatePixel, motionPixels, radius)
      ) {
        receiverMask = receiverMask | (1u << (y * 2u + x));
      }
      if (receiverMask == 0u) { continue; }
      if (!selected.valid || temporal.depth < selectedDepth) {
        selected = MotionBlurSource(
          candidatePixel,
          motionPixels,
          temporal.depth,
          radius,
          0.0,
          0.0,
          0.0,
          0.0,
          receiverMask,
          true,
        );
        selectedDepth = temporal.depth;
        coverage0 = 0.0;
        coverage1 = 0.0;
        coverage2 = 0.0;
        coverage3 = 0.0;
        selectedReceiverMask = receiverMask;
      }
      if (abs(temporal.depth - selectedDepth) <= 1e-4) {
        // The common integer displacement above gives each source cell one
        // receiver quadrant. The matching footprint therefore contributes its
        // full unit overlap to that one owner.
        if ((receiverMask & 1u) != 0u) { coverage0 += 1.0; }
        if ((receiverMask & 2u) != 0u) { coverage1 += 1.0; }
        if ((receiverMask & 4u) != 0u) { coverage2 += 1.0; }
        if ((receiverMask & 8u) != 0u) { coverage3 += 1.0; }
        selectedReceiverMask = selectedReceiverMask | receiverMask;
      }
    }
  }
  if (selected.valid) {
    // The owner samples a 2x2 source footprint but pays for one color read.
    // Each receiving quadrant keeps the fraction of that footprint that is
    // covered at the selected depth. This preserves energy at boundaries and
    // carries a one-pixel odd-row feature into its real row only.
    selected.coverage0 = min(coverage0, 1.0) * select(0.0, 1.0, (selectedReceiverMask & 1u) != 0u);
    selected.coverage1 = min(coverage1, 1.0) * select(0.0, 1.0, (selectedReceiverMask & 2u) != 0u);
    selected.coverage2 = min(coverage2, 1.0) * select(0.0, 1.0, (selectedReceiverMask & 4u) != 0u);
    selected.coverage3 = min(coverage3, 1.0) * select(0.0, 1.0, (selectedReceiverMask & 8u) != 0u);
    selected.receiverMask = selectedReceiverMask;
  }
  return selected;
}

fn midpointTileOwnership(
  receiverPixel : vec2<i32>,
  source : MotionBlurSource,
) -> f32 {
  // A recovered tile anchor represents one two-pixel source footprint. The
  // footprint is split across the finite, geometrically derived tile bands of
  // the support segment. One half-cell owner per band claims the represented
  // midpoint slot, rather than painting every receiver in the interval.
  let sourcePixel = source.pixel;
  let motionLength = length(source.motion);
  if (motionLength <= 1e-5 || source.radius <= 1e-5) { return 0.0; }
  let receiverTile = receiverPixel / vec2<i32>(16);
  let sourceTile = sourcePixel / vec2<i32>(16);
  let tileDelta = vec2<f32>(sourceTile - receiverTile);
  let direction = source.motion / motionLength;
  let along = abs(dot(tileDelta, direction));
  let perpendicular = abs(tileDelta.x * direction.y - tileDelta.y * direction.x);
  let tileReach = min(4, max(1, i32(ceil(source.radius / 16.0))));
  if (along < 1.0 || ceil(along) > f32(tileReach) || perpendicular > 1.0) { return 0.0; }
  let groupBase = (receiverPixel / vec2<i32>(8)) * vec2<i32>(8);
  let local = receiverPixel - groupBase;
  let ownerX = select(
    clamp(((sourcePixel.x - groupBase.x) / 2) * 2, 0, 6),
    select(0, 6, sourcePixel.x > receiverPixel.x),
    sourcePixel.x != receiverPixel.x,
  );
  let ownerY = select(
    clamp(((sourcePixel.y - groupBase.y) / 2) * 2, 0, 6),
    select(0, 6, sourcePixel.y > receiverPixel.y),
    sourcePixel.y != receiverPixel.y,
  );
  if (local.x != ownerX || local.y != ownerY) { return 0.0; }
  let sourceFootprintLength = 2.0;
  let supportLength = max(2.0 * source.radius, sourceFootprintLength);
  // Divide the finite footprint ownership over every reachable tile band.
  // This keeps the total recovery mass bounded when the support grows from
  // 32 to 64 pixels while retaining a nonzero owner at any in-view band.
  return min(1.0, sourceFootprintLength / (supportLength * f32(tileReach)));
}

fn integrateLongColor(
  filtered : vec4<f32>,
  validCount : f32,
  hasAcceptedSource : bool,
  uncovered : f32,
  count : u32,
  supportCount : u32,
  centerColor : vec4<f32>,
  centerMoving : bool,
) -> vec4<f32> {
  // Uncovered ownership is decremented at the same time as validCount is incremented
  // for both geometric and midpoint-recovered samples. Keep the derived cap
  // as a guard against floating point accumulation and make the ownership
  // transfer explicit instead of adding an independent brightness term.
  let conservedUncovered = min(
    max(uncovered, 0.0),
    max(f32(supportCount) - validCount, 0.0),
  );
  // A moving receiver can be partially covered at a silhouette edge. Use the
  // accepted foreground only for the receiver's missing current coverage; a
  // fully covered receiver keeps the original center contribution and the
  // Dawn energy contract remains unchanged for uniform opaque surfaces.
  let acceptedColor = select(
    vec3<f32>(0.0),
    filtered.rgb / max(validCount, 1.0),
    hasAcceptedSource && validCount > 0.0,
  );
  // Preserve the color target's authored alpha as the output floor. It is
  // separate from the RGB test below, which identifies an empty background
  // receiver without treating alpha as a scene-coverage attachment.
  let missingForeground = 1.0 - clamp(centerColor.a, 0.0, 1.0);
  let edgeCoverage = select(missingForeground, 1.0, centerMoving);
  let edgeFill = acceptedColor * edgeCoverage * EDGE_FILL_FACTOR;
  let movingFallback = select(centerColor.rgb, edgeFill, hasAcceptedSource && validCount > 0.0);
  let background = select(vec3<f32>(0.0), movingFallback, centerMoving);
  // The accepted colour can come from a transparent receiver's moving
  // foreground. Carry the same bounded support coverage into alpha so that
  // RGB written outside the current silhouette is not composited as black.
  // Preserve the receiver's authored coverage as a floor: blur must not make
  // an already visible pixel disappear.
  let acceptedAlpha = select(
    0.0,
    filtered.a / max(validCount, 1.0),
    validCount > 0.0,
  );
  let acceptedCoverage = validCount + missingForeground * conservedUncovered;
  let reconstructedAlpha = acceptedAlpha * acceptedCoverage / max(f32(count), 1.0);
  let outputAlpha = clamp(max(centerColor.a, reconstructedAlpha), 0.0, 1.0);
  let emptyReceiver =
    !centerMoving &&
    hasAcceptedSource &&
    max(max(abs(centerColor.r), abs(centerColor.g)), abs(centerColor.b)) < 1e-4;
  let sourceScale = select(1.0, 1.0 - EDGE_FILL_FACTOR, emptyReceiver);
  let sourceContribution = filtered.rgb * sourceScale;
  let trailScale = select(1.0, 1.0 - EDGE_FILL_FACTOR, emptyReceiver);
  let trailContribution = background * conservedUncovered * trailScale;
  return vec4<f32>(
    (sourceContribution + centerColor.rgb + trailContribution) / max(f32(count), 1.0),
    outputAlpha,
  );
}

fn longSupportFilter(
  receiverPixel : vec2<i32>,
  support : MotionBlurSupport,
  centerDepth : f32,
  dimensions : vec2<i32>,
) -> MotionBlurFilter {
  var empty = MotionBlurFilter(
    vec4<f32>(0.0),
    vec4<f32>(0.0),
    vec4<f32>(0.0),
    vec4<f32>(0.0),
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    0.0,
    receiverPixel,
    vec2<f32>(0.0),
    0.0,
    0u,
    0u,
    false,
  );
  if (!support.valid) { return empty; }
  let count = min(params.sampleCount, 16u);
  // The authored tier is the total source colour-read budget. Reserve one slot
  // for the receiver/background contribution; the remaining bounded taps
  // (at most 15) are split between the two source directions when needed.
  let supportCount = max(count - 1u, 1u);
  let useSecondDirection = support.secondaryRadius > 1e-5 && distinctDirection(support.primaryMotion, support.secondaryMotion);
  let primaryCount = select(supportCount, max(supportCount / 2u, 1u), useSecondDirection);
  let secondaryCount = max(supportCount - primaryCount, 1u);
  let shutter = clamp(params.shutterAngle / 360.0, 0.0, 1.0);
  let center = temporalAt(receiverPixel, dimensions);
  // Keep each receiving quadrant's own center color. Reusing the owner
  // pixel for all four quadrants causes a one-pixel parity shift to duplicate
  // a bright source (or erase a bright receiver) in the half-resolution cache.
  var centerColor0 = colorAt(receiverPixel, dimensions);
  var centerColor1 = colorAt(receiverPixel + vec2<i32>(1, 0), dimensions);
  var centerColor2 = colorAt(receiverPixel + vec2<i32>(0, 1), dimensions);
  var centerColor3 = colorAt(receiverPixel + vec2<i32>(1, 1), dimensions);
  var filtered0 = vec4<f32>(0.0);
  var filtered1 = vec4<f32>(0.0);
  var filtered2 = vec4<f32>(0.0);
  var filtered3 = vec4<f32>(0.0);
  var validCount0 = 0.0;
  var validCount1 = 0.0;
  var validCount2 = 0.0;
  var validCount3 = 0.0;
  var hasAcceptedSource0 = false;
  var hasAcceptedSource1 = false;
  var hasAcceptedSource2 = false;
  var hasAcceptedSource3 = false;
  var uncovered0 = f32(supportCount);
  var uncovered1 = f32(supportCount);
  var uncovered2 = f32(supportCount);
  var uncovered3 = f32(supportCount);
  var midpointFallbackPixel = vec2<i32>(0);
  var midpointFallbackValid = false;
  var midpointFallbackRadius = 0.0;
  var nearestDepth0 = 3.402823e+38;
  var nearestDepth1 = 3.402823e+38;
  var nearestDepth2 = 3.402823e+38;
  var nearestDepth3 = 3.402823e+38;
  for (var index = 0u; index < 16u; index += 1u) {
    if (index >= supportCount) { break; }
    let secondDirection = useSecondDirection && index >= primaryCount;
    let localIndex = select(index, index - primaryCount, secondDirection);
    let localCount = select(primaryCount, secondaryCount, secondDirection);
    let selectedMotion = select(support.primaryMotion, support.secondaryMotion, secondDirection);
    let selectedRadius = select(support.primaryRadius, support.secondaryRadius, secondDirection);
    let tap = supportTap(
      receiverPixel,
      localIndex,
      localCount,
      selectedMotion,
      selectedRadius,
      select(support.primaryAnchor, support.secondaryAnchor, secondDirection),
      dimensions,
    );
    if (!tap.valid) {
      if (tap.fallbackValid && selectedRadius > midpointFallbackRadius) {
        midpointFallbackPixel = tap.fallbackPixel;
        midpointFallbackValid = true;
        midpointFallbackRadius = selectedRadius;
      }
      continue;
    }
    let source = sourceAtFootprint(
      receiverPixel,
      tap.pixel,
      centerDepth,
      shutter,
      dimensions,
    );
    if (!source.valid) {
      if (tap.fallbackValid && selectedRadius > midpointFallbackRadius) {
        midpointFallbackPixel = tap.fallbackPixel;
        midpointFallbackValid = true;
        midpointFallbackRadius = selectedRadius;
      }
      continue;
    }
    let sampleColor = colorAt(source.pixel, dimensions);
    // Keep the receiver's own color as the center contribution. A source
    // footprint may cover an adjacent receiver quadrant without being the
    // receiver itself; substituting its color here creates odd/even-alignment
    // brightening at thin-object boundaries.
    if ((source.receiverMask & 1u) != 0u) {
      filtered0 += sampleColor * source.coverage0;
      validCount0 += source.coverage0;
      hasAcceptedSource0 = true;
      uncovered0 = max(uncovered0 - source.coverage0, 0.0);
      nearestDepth0 = min(nearestDepth0, source.depth);
    }
    if ((source.receiverMask & 2u) != 0u) {
      filtered1 += sampleColor * source.coverage1;
      validCount1 += source.coverage1;
      hasAcceptedSource1 = true;
      uncovered1 = max(uncovered1 - source.coverage1, 0.0);
      nearestDepth1 = min(nearestDepth1, source.depth);
    }
    if ((source.receiverMask & 4u) != 0u) {
      filtered2 += sampleColor * source.coverage2;
      validCount2 += source.coverage2;
      hasAcceptedSource2 = true;
      uncovered2 = max(uncovered2 - source.coverage2, 0.0);
      nearestDepth2 = min(nearestDepth2, source.depth);
    }
    if ((source.receiverMask & 8u) != 0u) {
      filtered3 += sampleColor * source.coverage3;
      validCount3 += source.coverage3;
      hasAcceptedSource3 = true;
      uncovered3 = max(uncovered3 - source.coverage3, 0.0);
      nearestDepth3 = min(nearestDepth3, source.depth);
    }
  }
  // A tile anchor recovers a sparse source only for the widest support tier,
  // where the fixed geometric lattice can leave a source between taps. It
  // spends the represented midpoint ownership of the finite support segment;
  // every accepted colour, coverage and depth contribution uses that same
  // bounded ownership, so the fallback cannot create an opaque stripe. The
  // shorter tiers keep their exact geometric energy and do not need recovery.
  if (midpointFallbackValid && max(support.primaryRadius, support.secondaryRadius) > 32.0) {
    let fallbackSource = sourceAtFootprint(
      receiverPixel,
      midpointFallbackPixel,
      centerDepth,
      shutter,
      dimensions,
    );
    if (fallbackSource.valid) {
      let midpointWeight = midpointTileOwnership(receiverPixel, fallbackSource);
      if (
        midpointWeight > 0.0
      ) {
        let fallbackColor = colorAt(fallbackSource.pixel, dimensions);
        let fallbackWeight0 = fallbackSource.coverage0 * midpointWeight;
        let fallbackWeight1 = fallbackSource.coverage1 * midpointWeight;
        let fallbackWeight2 = fallbackSource.coverage2 * midpointWeight;
        let fallbackWeight3 = fallbackSource.coverage3 * midpointWeight;
        if (validCount0 <= 0.0 && (fallbackSource.receiverMask & 1u) != 0u) {
          let ownedWeight0 = min(fallbackWeight0, uncovered0);
          if (ownedWeight0 > 0.0) {
            filtered0 += fallbackColor * ownedWeight0;
            validCount0 += ownedWeight0;
            hasAcceptedSource0 = true;
            uncovered0 = max(uncovered0 - ownedWeight0, 0.0);
            nearestDepth0 = min(nearestDepth0, fallbackSource.depth);
          }
        }
        if (validCount1 <= 0.0 && (fallbackSource.receiverMask & 2u) != 0u) {
          let ownedWeight1 = min(fallbackWeight1, uncovered1);
          if (ownedWeight1 > 0.0) {
            filtered1 += fallbackColor * ownedWeight1;
            validCount1 += ownedWeight1;
            hasAcceptedSource1 = true;
            uncovered1 = max(uncovered1 - ownedWeight1, 0.0);
            nearestDepth1 = min(nearestDepth1, fallbackSource.depth);
          }
        }
        if (validCount2 <= 0.0 && (fallbackSource.receiverMask & 4u) != 0u) {
          let ownedWeight2 = min(fallbackWeight2, uncovered2);
          if (ownedWeight2 > 0.0) {
            filtered2 += fallbackColor * ownedWeight2;
            validCount2 += ownedWeight2;
            hasAcceptedSource2 = true;
            uncovered2 = max(uncovered2 - ownedWeight2, 0.0);
            nearestDepth2 = min(nearestDepth2, fallbackSource.depth);
          }
        }
        if (validCount3 <= 0.0 && (fallbackSource.receiverMask & 8u) != 0u) {
          let ownedWeight3 = min(fallbackWeight3, uncovered3);
          if (ownedWeight3 > 0.0) {
            filtered3 += fallbackColor * ownedWeight3;
            validCount3 += ownedWeight3;
            hasAcceptedSource3 = true;
            uncovered3 = max(uncovered3 - ownedWeight3, 0.0);
            nearestDepth3 = min(nearestDepth3, fallbackSource.depth);
          }
        }
      }
    }
  }
  let moving0 = temporalAt(receiverPixel, dimensions);
  let moving1 = temporalAt(receiverPixel + vec2<i32>(1, 0), dimensions);
  let moving2 = temporalAt(receiverPixel + vec2<i32>(0, 1), dimensions);
  let moving3 = temporalAt(receiverPixel + vec2<i32>(1, 1), dimensions);
  let motion0 = sourceMotionPixels(moving0, dimensions);
  let motion1 = sourceMotionPixels(moving1, dimensions);
  let motion2 = sourceMotionPixels(moving2, dimensions);
  let motion3 = sourceMotionPixels(moving3, dimensions);
  let centerMoving0 = moving0.validDepth && moving0.motionValid && sourceRadius(motion0, shutter) > 1e-5;
  let centerMoving1 = moving1.validDepth && moving1.motionValid && sourceRadius(motion1, shutter) > 1e-5;
  let centerMoving2 = moving2.validDepth && moving2.motionValid && sourceRadius(motion2, shutter) > 1e-5;
  let centerMoving3 = moving3.validDepth && moving3.motionValid && sourceRadius(motion3, shutter) > 1e-5;
  empty.color0 = integrateLongColor(filtered0, validCount0, hasAcceptedSource0, uncovered0, count, supportCount, centerColor0, centerMoving0);
  empty.color1 = integrateLongColor(filtered1, validCount1, hasAcceptedSource1, uncovered1, count, supportCount, centerColor1, centerMoving1);
  empty.color2 = integrateLongColor(filtered2, validCount2, hasAcceptedSource2, uncovered2, count, supportCount, centerColor2, centerMoving2);
  empty.color3 = integrateLongColor(filtered3, validCount3, hasAcceptedSource3, uncovered3, count, supportCount, centerColor3, centerMoving3);
  empty.depth0 = select(centerDepth, nearestDepth0, validCount0 > 0.0);
  empty.depth1 = select(centerDepth, nearestDepth1, validCount1 > 0.0);
  empty.depth2 = select(centerDepth, nearestDepth2, validCount2 > 0.0);
  empty.depth3 = select(centerDepth, nearestDepth3, validCount3 > 0.0);
  empty.coverage0 = validCount0 / max(f32(supportCount), 1.0);
  empty.coverage1 = validCount1 / max(f32(supportCount), 1.0);
  empty.coverage2 = validCount2 / max(f32(supportCount), 1.0);
  empty.coverage3 = validCount3 / max(f32(supportCount), 1.0);
  empty.motion = select(support.primaryMotion, support.secondaryMotion, support.primaryRadius <= 1e-5);
  empty.radius = max(support.primaryRadius, support.secondaryRadius);
  empty.receiverMask =
    select(0u, 1u, validCount0 > 0.0 || centerMoving0) |
    select(0u, 2u, validCount1 > 0.0 || centerMoving1) |
    select(0u, 4u, validCount2 > 0.0 || centerMoving2) |
    select(0u, 8u, validCount3 > 0.0 || centerMoving3);
  empty.validMask =
    select(0u, 1u, validCount0 > 0.0 || centerMoving0) |
    select(0u, 2u, validCount1 > 0.0 || centerMoving1) |
    select(0u, 4u, validCount2 > 0.0 || centerMoving2) |
    select(0u, 8u, validCount3 > 0.0 || centerMoving3);
  empty.valid = empty.validMask != 0u;
  return empty;
}

fn colorAt(pixel : vec2<i32>, dimensions : vec2<i32>) -> vec4<f32> {
  return textureLoad(currentColor, clamp(pixel, vec2<i32>(0), dimensions - vec2<i32>(1)), 0);
}

fn cacheFootprintContains(receiverPixel : vec2<i32>, ownerPixel : vec2<i32>) -> bool {
  return
    receiverPixel.x >= ownerPixel.x && receiverPixel.x <= ownerPixel.x + 1 &&
    receiverPixel.y >= ownerPixel.y && receiverPixel.y <= ownerPixel.y + 1;
}

fn cachedSupportCovers(
  receiverPixel : vec2<i32>,
  ownerPixel : vec2<i32>,
  motion : vec2<f32>,
  radius : f32,
) -> bool {
  if (!cacheFootprintContains(receiverPixel, ownerPixel)) { return false; }
  let motionLength = length(motion);
  if (motionLength <= 1e-5 || radius <= 1e-5) { return false; }
  let direction = motion / motionLength;
  let delta = vec2<f32>(receiverPixel - ownerPixel);
  let along = dot(delta, direction);
  let perpendicular = abs(delta.x * direction.y - delta.y * direction.x);
  return abs(along) <= radius + 1.0 && perpendicular <= 1.0;
}

fn cachedDirectionMatches(support : MotionBlurSupport, motion : vec2<f32>) -> bool {
  let motionLength = length(motion);
  if (motionLength <= 1e-5) { return false; }
  let direction = motion / motionLength;
  if (support.primaryRadius > 1e-5 && abs(dot(normalize(support.primaryMotion), direction)) >= 0.94) {
    return true;
  }
  return support.secondaryRadius > 1e-5 && abs(dot(normalize(support.secondaryMotion), direction)) >= 0.94;
}

fn depthGuidedHalfResolutionColor(
  localId : vec3<u32>,
  receiverPixel : vec2<i32>,
  support : MotionBlurSupport,
  centerDepth : f32,
) -> MotionBlurCacheSample {
  let cell = vec2<i32>(localId.xy / vec2<u32>(2));
  let quadrant = (localId.y % 2u) * 2u + (localId.x % 2u);
  var selected = MotionBlurCacheSample(vec4<f32>(0.0), 0.0, false);
  var selectedDelta = 3.402823e+38;
  // Search the bounded adjacent cache cells, but accept only a cell whose
  // authored 2x2 footprint and direction actually cover this receiver.
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let candidateCell = cell + vec2<i32>(x, y);
      if (candidateCell.x < 0 || candidateCell.y < 0 || candidateCell.x >= 4 || candidateCell.y >= 4) { continue; }
      let cacheCellIndex = u32(candidateCell.y * 4 + candidateCell.x);
      let index = cacheCellIndex * 4u + quadrant;
      if (
        halfFilteredValid[index] == 0u ||
        depthReject(centerDepth, halfFilteredDepth[index]) ||
        !cachedDirectionMatches(support, halfFilteredMotion[cacheCellIndex]) ||
        !cachedSupportCovers(
          receiverPixel,
          halfFilteredReceiver[cacheCellIndex],
          halfFilteredMotion[cacheCellIndex],
          halfFilteredRadius[cacheCellIndex],
        )
      ) { continue; }
      let delta = abs(halfFilteredDepth[index] - centerDepth);
      if (!selected.valid || delta < selectedDelta) {
        selected.color = halfFilteredColor[index];
        selected.coverage = halfFilteredCoverage[index];
        selectedDelta = delta;
        selected.valid = true;
      }
    }
  }
  return selected;
}

@compute @workgroup_size(8, 8)
fn tile_summary(
  @builtin(global_invocation_id) id : vec3<u32>,
  @builtin(local_invocation_id) localId : vec3<u32>,
  @builtin(local_invocation_index) localIndex : u32,
  @builtin(workgroup_id) workgroupId : vec3<u32>,
) {
  let dimensions = textureDimensions(sceneTemporal);
  let tiles = (dimensions + vec2<u32>(15)) / vec2<u32>(16);
  let tile = workgroupId.xy;
  let inTile = tile.x < tiles.x && tile.y < tiles.y;
  var maxMotion = vec2<f32>(0.0);
  var maxLength = 0.0;
  var maxSource = vec2<i32>(0);
  var secondaryMotion = vec2<f32>(0.0);
  var secondaryLength = 0.0;
  var secondarySource = vec2<i32>(0);
  for (var localY = 0u; localY < 2u; localY += 1u) {
    for (var localX = 0u; localX < 2u; localX += 1u) {
      let pixel = tile * vec2<u32>(16) + localId.xy * vec2<u32>(2) + vec2<u32>(localX, localY);
      if (!inTile || pixel.x >= dimensions.x || pixel.y >= dimensions.y) { continue; }
      let sample = temporalAt(vec2<i32>(pixel), vec2<i32>(dimensions));
      if (!sample.validDepth || !sample.motionValid) { continue; }
      let motionLength = length(sample.motion * vec2<f32>(dimensions));
      if (motionLength > maxLength) {
        if (distinctDirection(maxMotion, sample.motion)) {
          secondaryMotion = maxMotion;
          secondaryLength = maxLength;
          secondarySource = maxSource;
        }
        maxLength = motionLength;
        maxMotion = sample.motion;
        maxSource = vec2<i32>(pixel);
      } else if (
        motionLength > secondaryLength &&
        distinctDirection(maxMotion, sample.motion)
      ) {
        secondaryLength = motionLength;
        secondaryMotion = sample.motion;
        secondarySource = vec2<i32>(pixel);
      }
    }
  }
  tileMotionScratch[localIndex] = maxMotion;
  tileLengthScratch[localIndex] = maxLength;
  tileSourceScratch[localIndex] = maxSource;
  tileSecondaryMotionScratch[localIndex] = secondaryMotion;
  tileSecondaryLengthScratch[localIndex] = secondaryLength;
  tileSecondarySourceScratch[localIndex] = secondarySource;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride = stride / 2u) {
    if (localIndex < stride) {
      let otherIndex = localIndex + stride;
      let otherLength = tileLengthScratch[otherIndex];
      if (otherLength > tileLengthScratch[localIndex]) {
        let oldMotion = tileMotionScratch[localIndex];
        let oldLength = tileLengthScratch[localIndex];
        let oldSource = tileSourceScratch[localIndex];
        tileLengthScratch[localIndex] = otherLength;
        tileMotionScratch[localIndex] = tileMotionScratch[otherIndex];
        tileSourceScratch[localIndex] = tileSourceScratch[otherIndex];
        if (
          oldLength > 1e-5 &&
          distinctDirection(tileMotionScratch[localIndex], oldMotion) &&
          oldLength > tileSecondaryLengthScratch[localIndex]
        ) {
          tileSecondaryLengthScratch[localIndex] = oldLength;
          tileSecondaryMotionScratch[localIndex] = oldMotion;
          tileSecondarySourceScratch[localIndex] = oldSource;
        }
      }
      if (
        tileSecondaryLengthScratch[otherIndex] > tileSecondaryLengthScratch[localIndex] &&
        distinctDirection(
          tileMotionScratch[localIndex],
          tileSecondaryMotionScratch[otherIndex],
        )
      ) {
        tileSecondaryLengthScratch[localIndex] = tileSecondaryLengthScratch[otherIndex];
        tileSecondaryMotionScratch[localIndex] = tileSecondaryMotionScratch[otherIndex];
        tileSecondarySourceScratch[localIndex] = tileSecondarySourceScratch[otherIndex];
      }
      if (
        tileLengthScratch[otherIndex] > tileSecondaryLengthScratch[localIndex] &&
        distinctDirection(tileMotionScratch[localIndex], tileMotionScratch[otherIndex])
      ) {
        tileSecondaryLengthScratch[localIndex] = tileLengthScratch[otherIndex];
        tileSecondaryMotionScratch[localIndex] = tileMotionScratch[otherIndex];
        tileSecondarySourceScratch[localIndex] = tileSourceScratch[otherIndex];
      }
    }
    workgroupBarrier();
  }
  if (localIndex == 0u && inTile) {
    let tileIndex = tile.y * tiles.x + tile.x;
    tileSummary[tileIndex] = MotionBlurTileSummary(
      vec4<f32>(
        tileMotionScratch[0],
        f32(tileSourceScratch[0].x),
        f32(tileSourceScratch[0].y),
      ),
      vec4<f32>(
        tileSecondaryMotionScratch[0],
        f32(tileSecondarySourceScratch[0].x),
        f32(tileSecondarySourceScratch[0].y),
      ),
    );
  }
}

@compute @workgroup_size(8, 8)
fn reconstruct(
  @builtin(global_invocation_id) id : vec3<u32>,
  @builtin(local_invocation_id) localId : vec3<u32>,
  @builtin(workgroup_id) workgroupId : vec3<u32>,
) {
  let dimensions = textureDimensions(currentColor);
  let colorDimensions = vec2<i32>(dimensions);
  let pixel = vec2<i32>(id.xy);
  let inBounds = id.x < dimensions.x && id.y < dimensions.y;
  let workgroupBase = vec2<i32>(workgroupId.xy * vec2<u32>(8));
  let ownsHalfCell = (localId.x % 2u == 0u) && (localId.y % 2u == 0u);
  let halfIndex = (localId.y / 2u) * 4u + (localId.x / 2u);
  let localIndex = localId.y * 8u + localId.x;
  if (localIndex == 0u) {
    scanTileNeighbourhood(workgroupBase, colorDimensions);
  }
  workgroupBarrier();
  let support = resolveMotionBlurSupport(pixel, colorDimensions);
  let longVector = support.valid && support.longVector;

  longVectorScratch[localId.y * 8u + localId.x] = select(0u, 1u, longVector);
  workgroupBarrier();
  for (var longStride = 32u; longStride > 0u; longStride = longStride / 2u) {
    let localIndex = localId.y * 8u + localId.x;
    if (localIndex < longStride) {
      longVectorScratch[localIndex] = max(
        longVectorScratch[localIndex],
        longVectorScratch[localIndex + longStride],
      );
    }
    workgroupBarrier();
  }
  let anyLongVector = longVectorScratch[0] != 0u;
  if (anyLongVector && ownsHalfCell) {
    // Every designated owner evaluates the full support exactly once. The
    // cached result includes filtered color, nearest accepted depth, and
    // coverage; no 2x2 prefilter is substituted for the long gather.
    let sourcePixel = workgroupBase + vec2<i32>(localId.xy);
    let sourceSupport = resolveMotionBlurSupport(sourcePixel, colorDimensions);
    let filtered = longSupportFilter(
      sourcePixel,
      sourceSupport,
      temporalAt(sourcePixel, colorDimensions).depth,
      colorDimensions,
    );
    halfFilteredReceiver[halfIndex] = sourcePixel;
    halfFilteredMotion[halfIndex] = filtered.motion;
    halfFilteredRadius[halfIndex] = filtered.radius;
    let cacheBase = halfIndex * 4u;
    halfFilteredColor[cacheBase] = filtered.color0;
    halfFilteredColor[cacheBase + 1u] = filtered.color1;
    halfFilteredColor[cacheBase + 2u] = filtered.color2;
    halfFilteredColor[cacheBase + 3u] = filtered.color3;
    halfFilteredDepth[cacheBase] = filtered.depth0;
    halfFilteredDepth[cacheBase + 1u] = filtered.depth1;
    halfFilteredDepth[cacheBase + 2u] = filtered.depth2;
    halfFilteredDepth[cacheBase + 3u] = filtered.depth3;
    halfFilteredCoverage[cacheBase] = filtered.coverage0;
    halfFilteredCoverage[cacheBase + 1u] = filtered.coverage1;
    halfFilteredCoverage[cacheBase + 2u] = filtered.coverage2;
    halfFilteredCoverage[cacheBase + 3u] = filtered.coverage3;
    halfFilteredValid[cacheBase] = select(0u, 1u, (filtered.validMask & 1u) != 0u);
    halfFilteredValid[cacheBase + 1u] = select(0u, 1u, (filtered.validMask & 2u) != 0u);
    halfFilteredValid[cacheBase + 2u] = select(0u, 1u, (filtered.validMask & 4u) != 0u);
    halfFilteredValid[cacheBase + 3u] = select(0u, 1u, (filtered.validMask & 8u) != 0u);
  }
  workgroupBarrier();
  // No invocation can return before both uniform barriers above. This keeps
  // odd extents and out-of-bounds lanes from allowing a long source to read a
  // cache entry that another invocation has not published yet.
  if (!inBounds) {
    return;
  }
  if (!support.valid) {
    textureStore(outputColor, pixel, colorAt(pixel, colorDimensions));
    return;
  }
  if (longVector) {
    let cached = depthGuidedHalfResolutionColor(
      localId,
      pixel,
      support,
      temporalAt(pixel, colorDimensions).depth,
    );
    if (cached.valid) {
      textureStore(outputColor, pixel, cached.color);
    } else {
      textureStore(outputColor, pixel, colorAt(pixel, colorDimensions));
    }
    return;
  }
  let useSecondDirection = support.secondaryRadius > 1e-5 && distinctDirection(support.primaryMotion, support.secondaryMotion);
  let count = min(params.sampleCount, 16u);
  let supportCount = max(count - 1u, 1u);
  let primaryCount = select(supportCount, max(supportCount / 2u, 1u), useSecondDirection);
  let secondaryCount = max(supportCount - primaryCount, 1u);
  let shutter = clamp(params.shutterAngle / 360.0, 0.0, 1.0);
  let center = temporalAt(pixel, colorDimensions);
  let centerMotion = sourceMotionPixels(center, colorDimensions);
  let centerMoving = center.validDepth && center.motionValid && sourceRadius(centerMotion, shutter) > 1e-5;
  let centerColor = colorAt(pixel, colorDimensions);
  var accum = vec4<f32>(0.0);
  var weight = 0.0;
  for (var index = 0u; index < 16u; index += 1u) {
    if (index >= supportCount) { break; }
    let secondDirection = useSecondDirection && index >= primaryCount;
    let localIndex = select(index, index - primaryCount, secondDirection);
    let localCount = select(primaryCount, secondaryCount, secondDirection);
    let selectedMotion = select(support.primaryMotion, support.secondaryMotion, secondDirection);
    let selectedRadius = select(support.primaryRadius, support.secondaryRadius, secondDirection);
    let tap = supportTap(
      pixel,
      localIndex,
      localCount,
      selectedMotion,
      selectedRadius,
      select(support.primaryAnchor, support.secondaryAnchor, secondDirection),
      colorDimensions,
    );
    if (!tap.valid) { continue; }
    let source = sourceAt(pixel, tap.pixel, center.depth, shutter, colorDimensions);
    if (!source.valid) { continue; }
    let sampleColor = colorAt(source.pixel, colorDimensions);
    accum += sampleColor;
    weight += 1.0;
  }
  let uncovered = max(f32(supportCount) - weight, 0.0);
  let acceptedColor = select(vec3<f32>(0.0), accum.rgb / max(weight, 1.0), weight > 0.0);
  let missingForeground = 1.0 - clamp(centerColor.a, 0.0, 1.0);
  let edgeCoverage = select(missingForeground, 1.0, centerMoving);
  let edgeFill = acceptedColor * edgeCoverage * EDGE_FILL_FACTOR;
  let movingFallback = select(centerColor.rgb, edgeFill, weight > 0.0);
  let uncoveredColor = select(vec3<f32>(0.0), movingFallback, centerMoving);
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
  textureStore(
    outputColor,
    pixel,
    vec4<f32>((sourceContribution + centerColor.rgb + trailContribution) / max(f32(count), 1.0), outputAlpha),
  );
}
`;

export function encodeMotionBlurComputeParams(
  params: MotionBlurParams,
  frameDeltaSeconds = 1 / 60,
  reset = false,
): Uint8Array {
  const bytes = new Uint8Array(MOTION_BLUR_PARAMS_BYTE_SIZE);
  const view = new DataView(bytes.buffer);
  // Keep invalid timing out of the GPU parameter block. The reset bit carries
  // the discontinuity; a finite zero makes the bypass deterministic and
  // avoids propagating NaN payloads through backend validation.
  const uniformDeltaSeconds = Number.isFinite(frameDeltaSeconds) ? frameDeltaSeconds : 0;
  view.setFloat32(0, params.shutterAngle, true);
  view.setFloat32(4, params.maxRadiusPixels, true);
  view.setUint32(8, effectiveMotionBlurSampleCount(params.sampleCount), true);
  view.setUint32(12, reset ? 1 : 0, true);
  view.setFloat32(16, params.targetFps, true);
  view.setFloat32(20, motionBlurExposureScale(uniformDeltaSeconds, params.targetFps), true);
  view.setFloat32(24, uniformDeltaSeconds, true);
  view.setUint32(28, 0, true);
  return bytes;
}

function positiveDimension(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.ceil(value as number) : 1;
}

export function planMotionBlur(
  params: MotionBlurParams,
  context: RenderFeaturePlanView & Pick<RenderFeaturePlanContext, 'caps'>,
  temporal: Pick<MotionBlurFeatureFrame, 'frameDeltaSeconds' | 'reset'> = {
    frameDeltaSeconds: 1 / 60,
    reset: false,
  },
): Result<RenderFeatureWorkPlan, RenderError> {
  if (!motionBlurTemporalDemand(params)) return ok({ resources: [], passes: [] });
  try {
    const sceneTemporal = context.sceneData.require(SCENE_DATA_TEMPORAL_V1_SCHEMA);
    const outputFormat =
      context.targets.find((target) => target.name === 'motion-output')?.format ?? 'rgba16float';
    const fullscreen = {
      kind: 'fullscreen-program' as const,
      name: 'motion-blur',
      source: 'forgeax::shader::motion-blur',
      reads: ['scene-color', 'scene-temporal'] as const,
      params: {
        byteSize: MOTION_BLUR_PARAMS_BYTE_SIZE,
        defaultValue: new Uint8Array(MOTION_BLUR_PARAMS_BYTE_SIZE),
      },
    };
    const computeCapable =
      context.caps.compute === true &&
      context.caps.storageBuffer === true &&
      context.caps.storageTexture === true &&
      context.caps.rgba16floatRenderable === true &&
      outputFormat === 'rgba16float';
    if (computeCapable) {
      const width = positiveDimension(context.frame.width);
      const height = positiveDimension(context.frame.height);
      const tileWidth = Math.max(1, Math.ceil(width / 16));
      const tileHeight = Math.max(1, Math.ceil(height / 16));
      return ok({
        resources: [
          {
            kind: 'compute-program',
            name: 'motion-blur-compute',
            program: {
              wgsl: MOTION_BLUR_COMPUTE_WGSL,
              entryPoints: ['tile_summary', 'reconstruct'],
              bindings: [
                {
                  entries: [
                    {
                      binding: 0,
                      visibility: 4,
                      texture: { sampleType: 'float', viewDimension: '2d' },
                    },
                    {
                      binding: 1,
                      visibility: 4,
                      texture: { sampleType: 'float', viewDimension: '2d' },
                    },
                    { binding: 2, visibility: 4, buffer: { type: 'storage' } },
                    {
                      binding: 3,
                      visibility: 4,
                      storageTexture: {
                        access: 'write-only',
                        format: 'rgba16float',
                        viewDimension: '2d',
                      },
                    },
                    { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
                  ],
                },
              ],
            },
          },
          {
            kind: 'buffer',
            name: 'motion-blur-tile-summary',
            size: tileWidth * tileHeight * 32,
            usage: ['storage'] as const,
          },
          {
            kind: 'buffer',
            name: 'motion-blur-compute-params',
            size: MOTION_BLUR_PARAMS_BYTE_SIZE,
            usage: ['uniform'] as const,
            data: encodeMotionBlurComputeParams(params, temporal.frameDeltaSeconds, temporal.reset),
          },
          {
            kind: 'prepared-gpu-resource',
            name: 'motion-blur-input',
            resource: { kind: 'texture-view' as const, value: undefined },
            logicalTarget: 'motion-input',
          },
          {
            kind: 'prepared-gpu-resource',
            name: 'motion-blur-temporal',
            resource: { kind: 'texture-view' as const, value: undefined },
            logicalTarget: sceneTemporal,
          },
          {
            kind: 'prepared-gpu-resource',
            name: 'motion-blur-output',
            resource: { kind: 'texture-view' as const, value: undefined },
            logicalTarget: 'motion-output',
          },
          {
            kind: 'compute-bindings',
            name: 'motion-blur-compute-bindings',
            program: 'motion-blur-compute',
            entries: [
              { binding: 0, resource: 'motion-blur-input' },
              { binding: 1, resource: 'motion-blur-temporal' },
              { binding: 2, resource: 'motion-blur-tile-summary' },
              { binding: 3, resource: 'motion-blur-output' },
              { binding: 4, resource: 'motion-blur-compute-params' },
            ],
          },
        ],
        passes: [
          {
            kind: 'compute',
            name: 'motion-blur-tile-summary',
            program: 'motion-blur-compute',
            bindings: 'motion-blur-compute-bindings',
            dispatches: [
              {
                kind: 'direct',
                entryPoint: 'tile_summary',
                workgroups: [tileWidth, tileHeight, 1],
              },
            ],
          },
          {
            kind: 'compute',
            // Keep the public post-process identity stable while the compute
            // lane adds its private tile-summary producer before it.
            name: 'motion-blur',
            program: 'motion-blur-compute',
            bindings: 'motion-blur-compute-bindings',
            dispatches: [
              {
                kind: 'direct',
                entryPoint: 'reconstruct',
                workgroups: [
                  Math.max(1, Math.ceil(width / 8)),
                  Math.max(1, Math.ceil(height / 8)),
                  1,
                ],
              },
            ],
          },
        ],
      });
    }
    return ok({
      resources: [
        fullscreen,
        {
          kind: 'graphics-program',
          name: 'motion-blur-pipeline',
          program: {
            shader: MOTION_BLUR_FEATURE_IDENTITY,
            vertexLayout: 'none',
            colorFormats: [outputFormat],
            sampleCount: 1,
          },
        },
        {
          kind: 'graphics-bindings',
          name: 'motion-blur-bindings',
          program: 'motion-blur-pipeline',
          values: {
            group: 1,
            fullscreen: true,
            shader: MOTION_BLUR_FEATURE_IDENTITY,
            input: 'motion-input',
            temporal: sceneTemporal,
          },
          logicalTargets: { input: 'motion-input' },
        },
      ],
      passes: [
        {
          kind: 'raster',
          name: 'motion-blur',
          colorAttachments: [{ target: 'motion-output', loadOp: 'clear', storeOp: 'store' }],
          sampledTargets: ['motion-input', sceneTemporal],
          draws: [
            {
              program: 'motion-blur-pipeline',
              bindings: ['motion-blur-bindings'],
              vertexData: [],
              vertexLayout: 'none',
              draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
            },
          ],
        },
      ],
    });
  } catch (cause) {
    return err(cause as RenderError);
  }
}

export function createMotionBlurFeature(): RenderFeature<
  Readonly<Record<string, MotionBlurFeatureFrame>>
> {
  return Object.freeze({
    identity: MOTION_BLUR_FEATURE_IDENTITY,
    shaderModuleMode: 'immediate' as const,
    extract: (context: RenderFeatureExtractContext) => {
      const frames: Record<string, MotionBlurFeatureFrame> = Object.create(null);
      for (const view of context.views) {
        if (!view.render) continue;
        const input = view.motionBlur;
        const validated = validateMotionBlurParams(input?.params);
        if (!validated.ok) return err(validated.error as unknown as RenderError);
        const params = input?.params === undefined ? undefined : validated.value;
        frames[view.identity] = {
          params,
          demanded: motionBlurTemporalDemand(params),
          frameDeltaSeconds: input?.frameDeltaSeconds ?? 1 / 60,
          reset: input?.reset === true,
        };
      }
      return ok(frames);
    },
    plan: (
      frames: Readonly<Record<string, MotionBlurFeatureFrame>>,
      context: RenderFeaturePlanContext,
    ): Result<RenderFeaturePlan, RenderError> => {
      const work: RenderFeaturePlan['work'][number][] = [];
      for (const view of context.views) {
        const frame = frames[view.identity];
        if (!view.render || frame?.params === undefined) continue;
        const planned = planMotionBlur(frame.params, { ...view, caps: context.caps }, frame);
        if (!planned.ok) return planned;
        work.push({ scope: { view: view.identity }, ...planned.value });
      }
      return ok({ work });
    },
  });
}
