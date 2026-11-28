// UE 5.8.1 DilateVelocity (TSRDilateVelocity.usf:148-331, 375-389) on the unjittered input
// lattice. Each pixel reads the scene tuple at its jittered raster sample and borrows the
// closest tuple of its plus-shaped neighbourhood (FindClosestDepthOffset,
// TSRDepthVelocityAnalysis.ush:278-329). Outputs: the dilated tuple, and
// (ReprojectionEdge, has reprojection offset, geometric depth edge, IsMovingMask).
struct TsrDilateResult {
  @location(0) dilated: vec4<f32>,
  @location(1) edge: vec4<f32>,
};

// ConvertToDeviceZ: reverse-Z, nearer is larger and cleared background is 0. The engine stores
// view depth, so the perspective device Z is its reciprocal and the orthographic one is linear
// (depthModel.z is the orthographic far plane, 0 for perspective).
fn tsrDeviceZAtDepth(depth: f32) -> f32 {
  return select(1.0 / depth, saturate(1.0 - depth / params.depthModel.z), params.depthModel.z > 0.0);
}
fn tsrTupleDepth(packed: vec4<f32>) -> f32 { return max(exp2(packed.z) - 1.0, 1e-6); }
fn tsrDeviceZ(packed: vec4<f32>) -> f32 {
  return select(tsrDeviceZAtDepth(tsrTupleDepth(packed)), 0.0, packed.z < 0.0);
}
// ComputePixelDeviceZError (ush:41-47) with GetDepthPixelRadiusForProjectionType (Common.ush:1489).
fn tsrPixelDeviceZError(packed: vec4<f32>) -> f32 {
  let depth = tsrTupleDepth(packed);
  let radius = params.depthModel.x * depth + params.depthModel.y;
  return select(
    abs(tsrDeviceZAtDepth(depth + radius * 2.0) - tsrDeviceZAtDepth(depth)), 0.0, packed.z < 0.0);
}

fn tsrLoadTemporal(p: vec2<i32>) -> vec4<f32> {
  return loadSceneTemporal(clamp(p, vec2<i32>(0), vec2<i32>(textureDimensions(sceneTemporal)) - 1));
}

struct TsrClosest {
  packed: vec4<f32>,
  z: f32,
  key: i32,
};
// PackDepthAndOffset orders by device Z, then by the offset bits (ush:264-267). A tuple whose
// motion is invalid can witness depth but never lends its motion.
fn tsrConsider(best: ptr<function, TsrClosest>, candidate: vec4<f32>, offset: vec2<i32>) {
  let z = tsrDeviceZ(candidate);
  let key = (1 + offset.x) + 4 * (1 + offset.y);
  if (candidate.w < 2.0 && (z > (*best).z || (z == (*best).z && key > (*best).key))) {
    (*best).packed = candidate;
    (*best).z = z;
    (*best).key = key;
  }
}

// IsMovingMask (TSRDilateVelocity.usf:333-365). The engine tuple carries no depth velocity, so the
// previous depth is the static reprojection of the current one; the world term
// length(W - PrevW) / (2 * pixelRadius) - 1 then reduces to half the lateral residual in input
// pixels that camera movement does not explain.
fn tsrIsMoving(tuple: vec4<f32>, pixel: vec2<i32>) -> f32 {
  let temporal = unpackSceneTemporalV1(tuple);
  if (!temporal.validDepth) { return 0.0; }
  if (!temporal.motionValid) { return 1.0; }
  let uv = (vec2<f32>(pixel) + 0.5) / params.inputSize;
  let ndc = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let clip = tsrClipAtDepth(ndc, temporal.viewDepth, params.projectionZ);
  let staticClip = params.clipToPrevClip * clip;
  let rotationalClip = params.rotationalClipToPrevClip * clip;
  // A degenerate projection has no reprojection to judge: leave the pixel static.
  if (abs(staticClip.w) < 1e-6 || abs(rotationalClip.w) < 1e-6) { return 0.0; }
  let staticUv = tsrScreenToUv(staticClip.xy / staticClip.w);
  let rotationalUv = tsrScreenToUv(rotationalClip.xy / rotationalClip.w);
  let worldPixels = length((uv - temporal.motionUv - staticUv) * params.inputSize);
  let parallaxPixels = length((rotationalUv - staticUv) * params.inputSize);
  let moving = max(saturate(worldPixels * 0.5 - 1.0),
    saturate(parallaxPixels * params.flicker.y - 0.5));
  return select(moving, 1.0, temporal.reactive > 0.0);
}

fn tsrDilate(pixel: vec2<i32>, origin: vec2<i32>) -> TsrDilateResult {
  let center = pixel;
  let own = tsrDilateSample(center, origin);
  var best = TsrClosest(own, tsrDeviceZ(own), 5);
  // Explicit material or motion invalidity is a hard veto, not a coverage hole.
  let vetoed = own.z >= 0.0 && own.w >= 1.0;
  if (!vetoed) {
    let error = tsrPixelDeviceZError(own);
    // All four opposite pairs of the 3x3 neighborhood (UE TSRDepthVelocityAnalysis.ush:288),
    // all resident in dilateTile LDS (zero extra texture loads), so diagonal silhouettes and thin
    // lines share one consistent dilation authority between analyze and reconstruct.
    let offsets = array<vec2<i32>, 4>(
      vec2<i32>(1, 0),
      vec2<i32>(0, 1),
      vec2<i32>(1, 1),
      vec2<i32>(1, -1),
    );
    for (var i = 0; i < 4; i++) {
      let offset = offsets[i];
      let a = tsrDilateSample(center + offset, origin);
      let b = tsrDilateSample(center - offset, origin);
      let za = tsrDeviceZ(a);
      let zb = tsrDeviceZ(b);
      // CONFIG_DEPTH_EDGE_DETECTION: dilate only where the centre sits behind the pair.
      if ((za + zb) * 0.5 - best.z > max(abs(zb - za) * 0.25, error)) {
        tsrConsider(&best, a, offset);
        tsrConsider(&best, b, -offset);
      }
    }
  }
  var background = own.z < 0.0;
  var farthest = own.z;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let s = tsrDilateSample(center + vec2<i32>(x, y), origin);
      background = background || s.z < 0.0;
      farthest = max(farthest, s.z);
    }
  }
  let depthEdge = !vetoed && best.packed.z >= 0.0 &&
    (background || farthest - best.packed.z > 0.0025 + best.packed.z * 0.01);
  let hasOffset = any(best.packed != own);
  // ComputeReprojectionEdge (ush:550-557).
  let delta = (best.packed.xy - own.xy) * params.inputSize;
  let edge = saturate(1.1 - dot(abs(delta), vec2<f32>(1.1)));
  return TsrDilateResult(best.packed,
    vec4<f32>(edge, select(0.0, 1.0, hasOffset), select(0.0, 1.0, depthEdge),
      tsrIsMoving(best.packed, pixel)));
}
