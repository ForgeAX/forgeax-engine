// UE 5.8.1 TemporalSuperResolution.cpp:3220-3224 history weight parameters.
const TSR_HISTORY_SAMPLE_COUNT: f32 = 16.0;
const TSR_REJECTED_SAMPLE_COUNT: f32 = 2.0;
const TSR_VELOCITY_SAMPLE_COUNT: f32 = 4.0;

struct TsrParams {
  jitter: vec2<f32>,
  previousJitter: vec2<f32>,
  inputSize: vec2<f32>,
  previousInputSize: vec2<f32>,
  historyValid: u32,
  analysisValid: u32,
  frameIndex: u32,
  hasSecondary: u32,
  hasCoverage: u32,
  deltaSeconds: f32,
  outputSize: vec2<f32>,
  // Depth model for UE ComputePixelDeviceZError: (perspective tanHalfFovX / width, orthographic halfWidth / width, orthographic far, 0).
  depthModel: vec4<f32>,
  // UE flickering terms (TemporalSuperResolution.cpp): x = TotalVariationCountInvThreshold[0],
  // y = InvFlickeringMaxParallaxVelocity, z = scene exposure of the HdrWeight, w reserved.
  flicker: vec4<f32>,
  // UE View.ClipToPrevClip and RotationalClipToPrevClip (TemporalSuperResolution.cpp:2140-2148),
  // both unjittered, column-vector convention.
  clipToPrevClip: mat4x4<f32>,
  rotationalClipToPrevClip: mat4x4<f32>,
  // (P22, P32, P23, P33) of the projection: clip.z = P22 * viewZ + P32, clip.w = P23 * viewZ + P33.
  projectionZ: vec4<f32>,
  // UE ClipToResurrectionClip (TSRDecimateHistory.usf:230): the current unjittered clip to the clip
  // of the snapshot frame the resurrection reads, and its availability in resurrection.x.
  clipToResurrectionClip: mat4x4<f32>,
  resurrection: vec4<u32>,
};

// Reject decision alpha (UE HistoryRejectionOutput BitMask, TSRRejectShading.usf:880-882):
// stored in rgba8unorm as bitMask / 255.0; bit 0 is ShouldSpatialAntiAlias, bit 1 is bResurrectHistory.
fn tsrDecisionSpatial(a: f32) -> bool { return (u32(round(a * 255.0)) & 1u) != 0u; }
fn tsrDecisionResurrected(a: f32) -> bool { return (u32(round(a * 255.0)) & 2u) != 0u; }

// Exposure scalar for shading/guide/luma spaces (default 1 when uninitialized).
fn tsrExposure(exposure: f32) -> f32 { return select(exposure, 1.0, exposure <= 0.0); }

// UE 4-bit spatial anti-aliasing offset encoding inside rgba8unorm: exact 0 stays 0/255,
// quantized offsets [-0.5, +0.5] in 1/14 steps map to integer codes [1..15] / 255.
fn tsrAaEncode(offset: vec2<f32>) -> vec2<f32> {
  let q = clamp(round(offset * 14.0) + 8.0, vec2<f32>(1.0), vec2<f32>(15.0));
  return select(q * (1.0 / 255.0), vec2<f32>(0.0), offset == vec2<f32>(0.0));
}
fn tsrAaDecode(encoded: vec2<f32>) -> vec2<f32> {
  let q = round(encoded * 255.0);
  return select((q - 8.0) * (0.5 / 7.0), vec2<f32>(0.0), q < vec2<f32>(0.5));
}

fn tsrScreenToUv(ndc: vec2<f32>) -> vec2<f32> { return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5); }
// Clip position of a pixel at a view depth, from TsrParams.projectionZ.
fn tsrClipAtDepth(ndc: vec2<f32>, viewDepth: f32, projectionZ: vec4<f32>) -> vec4<f32> {
  let viewZ = -viewDepth;
  let w = projectionZ.z * viewZ + projectionZ.w;
  return vec4<f32>(ndc * w, projectionZ.x * viewZ + projectionZ.y, w);
}
// Screen position (xy) and clip w of the surface at uv in the snapshot frame a resurrection reads
// (TSRRejectShading.usf:351-353). A w <= 0 is behind the snapshot camera.
fn tsrResurrectionScreen(uv: vec2<f32>, viewDepth: f32, clipToResurrectionClip: mat4x4<f32>,
  projectionZ: vec4<f32>) -> vec3<f32> {
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let clip = clipToResurrectionClip * tsrClipAtDepth(ndc, viewDepth, projectionZ);
  return vec3<f32>(clip.xy / clip.w, clip.w);
}

fn tsrLuma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
}

// Bounded analysis encoding; radiance history itself stays linear HDR.
fn tsrGuide(c: vec3<f32>) -> vec3<f32> {
  let safe = clamp(c, vec3<f32>(0.0), vec3<f32>(65504.0));
  // Sixteen stops cover finite positive FP16 radiance without the high-end
  // saturation of c/(1+c), which hides persistent HDR shading changes.
  return log2(vec3<f32>(1.0) + safe) / 16.0;
}

// UE 5.8.1 TSRColorSpace.ush / TSRShadingAnalysis.ush guide color space (GCS) and the
// shading LDR spaces derived from it. Exposure is 1 until the engine pre-exposes input.
const TSR_GCS_SCALE: f32 = 0.17;
const TSR_MAX_HALF: f32 = 65504.0;
// HdrWeightY / HdrWeight4 (TSRColorSpace.ush:166-174, 191-219): the Karis weight of a luma (x4) on
// exposed scene color. The engine exposes after TSR, so the exposure scalar multiplies the radiance.
// The caller passes params.flicker.z: stages that include this file need not bind TsrParams.
fn tsrHdrWeightY(luma: f32, exposure: f32) -> f32 {
  return max(0.0001, 1.0/(luma*exposure + 4.0));
}
fn tsrLuma4(c: vec3<f32>) -> f32 { return 2.0*c.g + c.r + c.b; }
fn tsrHdrWeight4(c: vec3<f32>, exposure: f32) -> f32 { return tsrHdrWeightY(tsrLuma4(c), exposure); }
fn tsrLinearToGcs(c: vec3<f32>) -> vec3<f32> {
  let safe = clamp(c, vec3<f32>(0.0), vec3<f32>(TSR_MAX_HALF));
  return safe / (safe + vec3<f32>(TSR_GCS_SCALE));
}
fn tsrGcsToLinear(g: vec3<f32>) -> vec3<f32> {
  return g * min(vec3<f32>(TSR_GCS_SCALE) / max(vec3<f32>(1.0) - g, vec3<f32>(1e-6)), vec3<f32>(TSR_MAX_HALF));
}
// kHistoryAccumulationPreceptionAdd = 1.0 (TSRShadingAnalysis.ush:92-107).
fn tsrAddPerceptionAdd(c: vec3<f32>) -> vec3<f32> { return c / (c + vec3<f32>(1.0)); }
fn tsrRemovePerceptionAdd(c: vec3<f32>) -> vec3<f32> {
  return c * min(vec3<f32>(1.0) / max(vec3<f32>(1.0) - c, vec3<f32>(1e-6)), vec3<f32>(TSR_MAX_HALF));
}
// fastClamp tolerates an inverted range: the upper bound wins.
fn tsrFastClamp(x: vec3<f32>, low: vec3<f32>, high: vec3<f32>) -> vec3<f32> {
  return min(max(x, low), high);
}

// UE TSRMeasureFlickeringLuma.usf:62-65: GLuma = SMCSToGCS(dot(LinearToSMCS(color), kMoireSMCSWeights)),
// with SMCS = GCS^2 (TSRColorSpace.ush:35) and kMoireSMCSWeights = 1/3 (ush:46-47).
fn tsrFlickerLuma(c: vec3<f32>) -> f32 {
  let g = tsrLinearToGcs(c);
  return sqrt(dot(g * g, vec3<f32>(1.0 / 3.0)));
}

fn tsrGuideToLinear(g: vec3<f32>) -> vec3<f32> {
  return exp2(g * 16.0) - vec3<f32>(1.0);
}

fn tsrInside(uv: vec2<f32>) -> bool {
  return all(uv >= vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0));
}

fn tsrPixel(uv: vec2<f32>, size: vec2<u32>) -> vec2<i32> {
  return clamp(vec2<i32>(uv * vec2<f32>(size)), vec2<i32>(0), vec2<i32>(size) - 1);
}

// UE ProcessPrevAtomicTexturesSamples parallax rejection (TSRClosestOccluder.ush:198-330), gathered
// instead of scattered: the four bilinear previous-frame taps each weigh DepthRejection =
// saturate(2 - |historyDepth - depth| / epsilon), epsilon = 3 pixel radii * 2 + the depth error of
// this pixel (ush:238-251); a mask under 0.5 is a parallax disocclusion (ush:330). The temporal
// tuple has no depth velocity (UE subtracts DilatedScreenVelocity.z), so the previous depth is
// expected to equal the current one and the former 2% bound stays as the epsilon floor. Hole
// filling (ush:300-327) is tsrReproject. depthModel is TsrParams.depthModel.
fn tsrParallaxMask(previous: texture_2d<f32>, previousUv: vec2<f32>, depth: f32,
  depthModel: vec4<f32>, motionUv: vec2<f32>, allowVelocityMatch: bool) -> f32 {
  let size = vec2<i32>(textureDimensions(previous));
  let position = previousUv * vec2<f32>(size) - vec2<f32>(0.5);
  let base = vec2<i32>(floor(position));
  let fraction = position - vec2<f32>(base);
  let ortho = depthModel.z > 0.0;
  let radius = depthModel.x * depth + depthModel.y;
  // |depth - ConvertFromDeviceZ(DeviceZ + ComputePixelDeviceZError)| for both projections.
  let depthError = select(depth - 1.0 / (2.0 / depth - 1.0 / (depth + radius * 2.0)), radius * 2.0, ortho);
  var mask = 0.0;
  for (var i = 0; i < 4; i++) {
    let corner = vec2<i32>(i & 1, i >> 1);
    let weight = (select(1.0 - fraction.x, fraction.x, corner.x == 1)) *
      (select(1.0 - fraction.y, fraction.y, corner.y == 1));
    let sample = unpackSceneTemporalV1(textureLoad(previous, clamp(base + corner, vec2<i32>(0), size - 1), 0));
    let historyRadius = depthModel.x * sample.viewDepth + depthModel.y;
    let epsilon = max(historyRadius * 6.0 + abs(depthError), max(0.02, depth * 0.02));
    let depthRejection = saturate(2.0 - abs(sample.viewDepth - depth) / epsilon);
    // UE 5.8.1 TSRClosestOccluder.ush:300-328: dim down parallax rejection when the previous
    // surface moved with the same screen velocity (no relative parallax -> subpixel jitter across
    // a static/co-moving silhouette or grazing depth slope, not a parallax disocclusion).
    let velDiff = length((sample.motionUv - motionUv) * vec2<f32>(size));
    let minParallaxMask = select(0.0, saturate(1.0 - velDiff), allowVelocityMatch);
    let rejection = max(depthRejection, minParallaxMask);
    mask += weight * select(0.0, rejection, sample.validDepth && sample.motionValid);
  }
  return mask;
}

struct TsrGeometry {
  packed: vec4<f32>,
  depthEdge: bool,
};

fn tsrExpectedPrevDepth(uv: vec2<f32>, depth: f32, depthModel: vec4<f32>,
  clipToPrevClip: mat4x4<f32>, projectionZ: vec4<f32>) -> f32 {
  if (depthModel.z > 0.0 || abs(projectionZ.z) < 0.5) { return depth; }
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let prevClip = clipToPrevClip * tsrClipAtDepth(ndc, depth, projectionZ);
  return select(depth, prevClip.w, prevClip.w > 1e-4 && prevClip.w < 1e30);
}

fn tsrGeometryMatches(a: SceneTemporalV1, previous: texture_2d<f32>, previousUv: vec2<f32>,
  expectedDepth: f32, depthModel: vec4<f32>, edge: bool, speed: f32) -> bool {
  if (!a.validDepth || !a.motionValid) { return false; }
  let b = unpackSceneTemporalV1(textureLoad(previous,
    tsrPixel(previousUv, textureDimensions(previous)), 0));
  if (b.validDepth) { return tsrParallaxMask(previous, previousUv, expectedDepth, depthModel, a.motionUv, true) >= 0.5; }
  // A stationary edge can alternate foreground and clear coverage under
  // jitter. New/moving/invalid surfaces still take the hard rejection path.
  return edge && speed < 0.25;
}

// Hole filling (UE TSRClosestOccluder.ush:300-327, TSRDecimateHistory.usf:435-472). A pixel whose own
// reprojection reaches another surface is a parallax disocclusion; UE then reprojects it with the
// velocity of the closest surface that covered that spot, extruding the neighbouring history out from
// behind the occluder. UE scatters the current velocities into the previous frame with atomics, which
// WebGL2 lacks, so the occluder's velocity is the one its own previous-frame scene temporal recorded:
// exact for constant velocity. Like UE, only a closer surface in the four bilinear taps qualifies.
// Unlike UE the extruded position must reach a matching surface, otherwise the history stays unused.
// Returns the occluder motion in xy and 1 in z when a closer occluder exists.
fn tsrOccluderMotion(previous: texture_2d<f32>, previousUv: vec2<f32>, depth: f32) -> vec3<f32> {
  let size = vec2<i32>(textureDimensions(previous));
  let base = vec2<i32>(floor(previousUv * vec2<f32>(size) - vec2<f32>(0.5)));
  var found = vec3<f32>(0.0);
  var closest = depth;
  for (var i = 0; i < 4; i++) {
    let corner = vec2<i32>(i & 1, i >> 1);
    let sample = unpackSceneTemporalV1(textureLoad(previous, clamp(base + corner, vec2<i32>(0), size - 1), 0));
    if (sample.validDepth && sample.motionValid && sample.viewDepth < closest) {
      closest = sample.viewDepth;
      found = vec3<f32>(sample.motionUv, 1.0);
    }
  }
  return found;
}

struct TsrReprojection {
  motionUv: vec2<f32>,
  // The pixel's own reprojection reaches its surface (UE: not a parallax disocclusion).
  matches: bool,
  // History can be fetched at previousUv = uv - motionUv: matches, or hole filling reaches a surface.
  usable: bool,
};

fn tsrReproject(a: SceneTemporalV1, previous: texture_2d<f32>, uv: vec2<f32>, motionUv: vec2<f32>,
  depthModel: vec4<f32>, clipToPrevClip: mat4x4<f32>, projectionZ: vec4<f32>, edge: bool) -> TsrReprojection {
  let previousUv = uv - motionUv;
  let speed = length(motionUv * vec2<f32>(textureDimensions(previous)));
  let inside = tsrInside(previousUv);
  let expectedDepth = tsrExpectedPrevDepth(uv, a.viewDepth, depthModel, clipToPrevClip, projectionZ);
  if (inside && tsrGeometryMatches(a, previous, previousUv, expectedDepth, depthModel, edge, speed)) {
    return TsrReprojection(motionUv, true, true);
  }
  if (inside && a.validDepth && a.motionValid) {
    let occluder = tsrOccluderMotion(previous, previousUv, expectedDepth);
    let filledUv = uv - occluder.xy;
    if (occluder.z > 0.0 && tsrInside(filledUv) &&
      tsrParallaxMask(previous, filledUv, expectedDepth, depthModel, motionUv, false) >= 0.5) {
      return TsrReprojection(occluder.xy, false, true);
    }
  }
  return TsrReprojection(motionUv, false, false);
}

// Coverage holes at a jittered silhouette are not new surfaces. Borrow one
// complete nearest-depth tuple; never interpolate depth, motion or validity.
fn tsrClosestTemporal(source: texture_2d<f32>, uv: vec2<f32>, radius: i32) -> TsrGeometry {
  return tsrClosestTemporalAt(source, tsrPixel(uv, textureDimensions(source)), radius);
}

fn tsrClosestTemporalAt(source: texture_2d<f32>, center: vec2<i32>, radius: i32) -> TsrGeometry {
  let size = textureDimensions(source);
  var packed = textureLoad(source, center, 0);
  // Explicit material/motion invalidity is a hard veto, not a coverage hole.
  if (packed.z >= 0.0 && packed.w >= 1.0) { return TsrGeometry(packed,false); }
  var background = packed.z < 0.0;
  var farthest = packed.z;
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let p = clamp(center + vec2<i32>(x,y), vec2<i32>(0), vec2<i32>(size)-1);
      let candidate = textureLoad(source, p, 0);
      background = background || candidate.z < 0.0;
      farthest = max(farthest,candidate.z);
      if (candidate.z >= 0.0 && candidate.w < 2.0 &&
        (packed.z < 0.0 || candidate.z < packed.z)) {
        packed = candidate;
      }
    }
  }
  return TsrGeometry(packed, packed.z >= 0.0 && (background || farthest-packed.z > 0.0025+packed.z*0.01));
}
