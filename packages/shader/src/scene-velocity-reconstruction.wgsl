// Reconstruct camera motion from the current jittered raster depth. The two
// unjittered matrices match the object writer's velocity convention.
fn sceneTemporalFromVelocity(
  pixel : vec2<i32>,
  depth : texture_depth_2d,
  velocity : texture_2d<u32>,
  view : View,
) -> vec4<f32> {
  let deviceZ = textureLoad(depth, pixel, 0);
  if (deviceZ <= 0.0) { return SCENE_DATA_TEMPORAL_V1_CLEAR; }
  let uv = (vec2<f32>(pixel) + 0.5) / vec2<f32>(textureDimensions(depth));
  let ndc = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), deviceZ, 1.0);
  let homogeneous = view.inverseViewProj * ndc;
  let world = homogeneous / homogeneous.w;
  let current = view.temporalCurrentViewProj * world;
  let packed = textureLoad(velocity, pixel, 0).xy;
  if (packed.x != 0u) {
    let invalid = packed.x == SCENE_VELOCITY_INVALID_MOTION;
    return vec4<f32>(
      select(decodeSceneVelocity(packed.x), vec2<f32>(0.0), invalid),
      sceneTemporalViewDepth(current, view.temporalProjection),
      select(sceneVelocityReactive(packed.y), 2.0, invalid),
    );
  }
  return packSceneTemporalV1WithValidity(
    current,
    view.temporalPreviousViewProj * world,
    view.temporalProjection,
    0.0,
    true,
  );
}


// Depth comparisons in temporal history retain their log-view-depth domain.
fn loadSceneDepth(deviceZ : f32, view : View) -> f32 {
  let world = view.inverseViewProj * vec4<f32>(0.0, 0.0, deviceZ, 1.0);
  let current = view.temporalCurrentViewProj * (world / world.w);
  return sceneTemporalViewDepth(current, view.temporalProjection);
}


struct SceneVelocitySample {
  packed : vec4<f32>,
  depthEdge : bool,
};

fn closestSceneVelocity(
  center : vec2<i32>,
  radius : i32,
  sceneDepth : texture_depth_2d,
  velocity : texture_2d<u32>,
  view : View,
) -> SceneVelocitySample {
  let size = vec2<i32>(textureDimensions(sceneDepth));
  var nearest = clamp(center, vec2<i32>(0), size - vec2<i32>(1));
  var nearestZ = textureLoad(sceneDepth, nearest, 0);
  var farthestZ = nearestZ;
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let p = clamp(center + vec2<i32>(x, y), vec2<i32>(0), size - vec2<i32>(1));
      let deviceZ = textureLoad(sceneDepth, p, 0);
      farthestZ = min(farthestZ, deviceZ);
      if (deviceZ > nearestZ) { nearest = p; nearestZ = deviceZ; }
    }
  }
  // TAA integrates stochastic coverage across frames. Match the float
  // temporal path by carrying its nearest valid neighbor through a depth edge.
  let packed = sceneTemporalFromVelocity(nearest, sceneDepth, velocity, view);
  var depthEdge = false;
  if (nearestZ > 0.0) {
    depthEdge = farthestZ <= 0.0 ||
      loadSceneDepth(farthestZ, view) - packed.z > 0.0025 + packed.z * 0.01;
  }
  return SceneVelocitySample(packed, depthEdge);
}
