#define_import_path forgeax_cloud::reconstruct

struct CloudReconstructionSample {
  far: vec4f,
  near: vec4f,
  depthMeters: vec4f,
}

// The caller reconstructs a world point from the meter-valued representative distance.
// An invalid homogeneous result deliberately returns an out-of-bounds UV for cold fill.
fn cloud_history_uv(worldPositionMeters: vec3f, previousViewProjection: mat4x4f) -> vec2f {
  let clip = previousViewProjection * vec4f(worldPositionMeters, 1.0);
  if (clip.w <= 0.0) { return vec2f(-1.0); }
  return vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
}

fn cloud_reconstruct_sample(
  current: CloudReconstructionSample,
  history: CloudReconstructionSample,
  pixel: vec2u,
  pixelOffset: vec2u,
  historyUv: vec2f,
  historyValid: bool,
  currentExposure: f32,
  historyExposure: f32,
  minimumReprojectionDistanceMeters: f32,
  disableDisocclusionDistanceMeters: f32,
) -> CloudReconstructionSample {
  let n = current.depthMeters;
  let h = history.depthMeters;
  let phaseSample = all((pixel % vec2u(2u)) == pixelOffset);
  let validUv = all(historyUv > vec2f(0.0)) && all(historyUv < vec2f(1.0));
  let applyDisocclusion = any(n.yzw < vec3f(disableDisocclusionDistanceMeters)) ||
    any(h.yzw < vec3f(disableDisocclusionDistanceMeters));
  let depthEdge = abs(n.z - n.w) > 2000.0 && abs(n.z - n.y) < abs(n.w - n.y);
  let rejectDepth = (applyDisocclusion && (depthEdge || abs(h.y - n.y) > 2000.0)) || abs(n.z - h.z) > 1000.0;
  if (!historyValid || phaseSample || !validUv || n.x < minimumReprojectionDistanceMeters || rejectDepth) {
    return current;
  }
  let exposure = vec4f(vec3f(currentExposure / historyExposure), 1.0);
  return CloudReconstructionSample(history.far * exposure, history.near * exposure, h);
}
