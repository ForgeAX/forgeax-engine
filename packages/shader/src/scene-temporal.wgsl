#define_import_path forgeax_scene_temporal

// The sole shader interpretation of forgeax::scene-data::temporal-v1.
// The packed target is rgba16float at render resolution and is sampled only.
// Coverage uses the main (possibly jittered) raster/depth lattice. Motion UV
// values themselves exclude jitter; an unjittered consumer offsets its read.

const SCENE_DATA_TEMPORAL_V1_CLEAR : vec4<f32> = vec4<f32>(0.0, 0.0, -1.0, 1.0);

struct SceneTemporalV1 {
  motionUv : vec2<f32>,
  viewDepth : f32,
  reactive : f32,
  validDepth : bool,
  // The reserved [2, 3] range of the packed reactive lane carries motion
  // invalidity. Valid samples keep reactive in [0, 1], including the
  // legitimate fully-reactive value 1, so the two meanings cannot collide.
  motionValid : bool,
};

fn unpackSceneTemporalV1(packed : vec4<f32>) -> SceneTemporalV1 {
  let invalidDepth = packed.z < 0.0;
  let validDepth = !invalidDepth;
  let viewDepth = select(0.0, exp2(packed.z) - 1.0, validDepth);
  let motionUv = packed.xy;
  let motionInvalid = packed.w >= 2.0;
  let reactive = clamp(packed.w - select(0.0, 2.0, motionInvalid), 0.0, 1.0);
  return SceneTemporalV1(motionUv, viewDepth, reactive, validDepth, !motionInvalid);
}

fn sceneTemporalUv(clip : vec4<f32>) -> vec2<f32> {
  let safeW = select(1e-6, clip.w, abs(clip.w) >= 1e-6);
  let ndc = clip.xy / safeW;
  return vec2<f32>(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
}

// Signed view-space Z shared by temporal reconstruction and Standard Cluster
// lookup. Both CPU and WGSL binners consume the negative camera-space depth:
// perspective uses -clip.w, while orthographic depth is reconstructed from
// the projection's near/far payload rather than Euclidean world distance.
fn sceneViewZ(clip : vec4<f32>, temporalProjection : vec4<f32>) -> f32 {
  let ndcDepth = clip.z / max(abs(clip.w), 1e-30);
  let orthographicViewZ = -(temporalProjection.y -
    ndcDepth * (temporalProjection.y - temporalProjection.x));
  return select(
    -clip.w,
    orthographicViewZ,
    temporalProjection.z >= 0.5,
  );
}

// The same signed view Z read back from the fragment's @builtin(position),
// as UE SvPositionToScreenPosition (Common.ush:1530-1542) reads SceneDepth
// from SvPosition.w instead of an interpolant. Fragment position.w is
// 1/clip.w and position.z is NDC depth, so perspective -clip.w and the
// screen-linear orthographic depth both come back without a varying.
fn sceneFragmentViewZ(position : vec4<f32>, temporalProjection : vec4<f32>) -> f32 {
  let orthographicViewZ = -(temporalProjection.y -
    position.z * (temporalProjection.y - temporalProjection.x));
  return select(
    -1.0 / position.w,
    orthographicViewZ,
    temporalProjection.z >= 0.5,
  );
}

fn sceneTemporalViewDepth(clip : vec4<f32>, temporalProjection : vec4<f32>) -> f32 {
  return log2(1.0 + max(-sceneViewZ(clip, temporalProjection), 0.0));
}

fn packSceneTemporalV1(
  currentClip : vec4<f32>,
  previousClip : vec4<f32>,
  temporalProjection : vec4<f32>,
  reactive : f32,
) -> vec4<f32> {
  return packSceneTemporalV1WithValidity(
    currentClip,
    previousClip,
    temporalProjection,
    reactive,
    true,
  );
}

fn packSceneTemporalV1WithValidity(
  currentClip : vec4<f32>,
  previousClip : vec4<f32>,
  temporalProjection : vec4<f32>,
  reactive : f32,
  motionValid : bool,
) -> vec4<f32> {
  return vec4<f32>(
    sceneTemporalUv(currentClip) - sceneTemporalUv(previousClip),
    sceneTemporalViewDepth(currentClip, temporalProjection),
    clamp(reactive, 0.0, 1.0) + select(0.0, 2.0, !motionValid),
  );
}

// Match UE's signed square-root transfer for two UNORM16 components.
const SCENE_VELOCITY_BIAS = 32767.0 / 65535.0;
const SCENE_VELOCITY_SCALE = 0.2495;
const SCENE_VELOCITY_INVALID_MOTION = 0xffffffffu;
@id(64009) override sceneVelocityWithDepthOutput : bool = false;

fn encodeSceneVelocity(motionUv: vec2<f32>) -> u32 {
  let ndc = motionUv * vec2<f32>(2.0, -2.0);
  let curved = sign(ndc) * sqrt(abs(ndc) * 2.0);
  let encoded = clamp(curved * SCENE_VELOCITY_SCALE + SCENE_VELOCITY_BIAS, vec2<f32>(0.0), vec2<f32>(1.0));
  // Reserve zero for unwritten pixels and the saturated endpoint for invalid history.
  return clamp(pack2x16unorm(encoded), 1u, SCENE_VELOCITY_INVALID_MOTION - 1u);
}

fn decodeSceneVelocity(word: u32) -> vec2<f32> {
  let curved = (unpack2x16unorm(word) - SCENE_VELOCITY_BIAS) / SCENE_VELOCITY_SCALE;
  return curved * abs(curved) * vec2<f32>(0.25, -0.25);
}

// Screen Probe's extended attachment retains the previous device Z and
// responsiveness in the second word. Basic velocity only stores the first.
const SCENE_VELOCITY_INVALID_DEPTH = 0xffffffffu;
const SCENE_VELOCITY_RESPONSIVE_BIT = 0x80000000u;

fn sceneVelocityPreviousDepth(word: u32) -> f32 {
  return bitcast<f32>((word & ~SCENE_VELOCITY_RESPONSIVE_BIT) - 1u);
}

fn sceneVelocityReactive(word: u32) -> f32 {
  return select(0.0, 1.0, word != SCENE_VELOCITY_INVALID_DEPTH && (word & SCENE_VELOCITY_RESPONSIVE_BIT) != 0u);
}

fn encodeSceneVelocityWithDepth(temporal: vec4<f32>, previousClip: vec4<f32>) -> vec2<u32> {
  let xy = encodeSceneVelocity(temporal.xy);
  let depth = previousClip.z / previousClip.w;
  let valid = temporal.w < 2.0 && previousClip.w > 0.0 && previousClip.w < 1e30 && depth >= 0.0 && depth <= 1.0;
  let responsive = select(0u, SCENE_VELOCITY_RESPONSIVE_BIT, temporal.w > 0.0);
  let word = select(SCENE_VELOCITY_INVALID_DEPTH, (bitcast<u32>(max(depth, 0.0)) + 1u) | responsive, valid);
  return vec2<u32>(xy, word);
}

fn encodeSceneVelocityRaster(temporal: vec4<f32>, previousClip: vec4<f32>) -> vec2<u32> {
  let packed = encodeSceneVelocityWithDepth(temporal, previousClip);
  // When R32Uint drops the depth word, mark rejection in the remaining word.
  let invalidBasicMotion = !sceneVelocityWithDepthOutput && temporal.w >= 2.0;
  return vec2<u32>(select(packed.x, SCENE_VELOCITY_INVALID_MOTION, invalidBasicMotion), packed.y);
}
