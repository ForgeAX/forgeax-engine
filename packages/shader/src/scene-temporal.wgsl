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

// Desktop SceneVelocity uses two 16-bit UNORM values. WebGPU packs them into
// one renderable R32Uint word; zero denotes an unwritten pixel.
fn encodeSceneVelocity(temporal : vec4<f32>) -> u32 {
  if (temporal.w >= 2.0) { return 0u; }
  let ndc = temporal.xy * vec2<f32>(2.0, -2.0);
  let curved = sign(ndc) * sqrt(abs(ndc) * 2.0);
  let encoded = clamp(curved * 0.2495 + 32767.0 / 65535.0, vec2<f32>(0.0), vec2<f32>(1.0));
  let xy = vec2<u32>(floor(encoded * 65535.0 + 0.5));
  return xy.x | (xy.y << 16u);
}

fn decodeSceneVelocity(word : u32) -> vec2<f32> {
  let xy = vec2<f32>(f32(word & 65535u), f32(word >> 16u));
  let curved = ((xy - 32767.0) / 65535.0) / 0.2495;
  return curved * abs(curved) * vec2<f32>(0.25, -0.25);
}
