#define_import_path forgeax_cloud::compose
#import forgeax_cloud::reconstruct::CloudReconstructionSample

fn cloud_select_depth_transport(far: vec4f, near: vec4f, minMaxDepthMeters: vec2f, sceneDepthMeters: f32) -> vec4f {
  return select(far, near, abs(sceneDepthMeters - minMaxDepthMeters.x) < abs(sceneDepthMeters - minMaxDepthMeters.y));
}

fn cloud_bilateral_upsample(samples: array<CloudReconstructionSample, 4>, sceneDepthMeters: f32, spatialWeights: vec4f, disableDisocclusionDistanceMeters: f32) -> vec4f {
  var allBehind = true;
  var allInFront = true;
  var allDistant = true;
  var minimum = samples[0].depthMeters.z;
  var maximum = samples[0].depthMeters.w;
  var closest = 3.402823e38;
  var selected = vec4f(0.0, 0.0, 0.0, 1.0);
  var blended = vec4f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < 4u; i += 1u) {
    let d = samples[i].depthMeters;
    allBehind = allBehind && d.x > sceneDepthMeters + 1.0 && d.z > sceneDepthMeters + 1.0;
    allInFront = allInFront && d.x <= d.z;
    allDistant = allDistant && all(d.yzw >= vec3f(disableDisocclusionDistanceMeters));
    minimum = min(minimum, min(d.z, d.w));
    maximum = max(maximum, max(d.z, d.w));
    let delta = min(abs(sceneDepthMeters - d.z), abs(sceneDepthMeters - d.w));
    if (delta < closest) {
      closest = delta;
      selected = cloud_select_depth_transport(samples[i].far, samples[i].near, d.zw, sceneDepthMeters);
    }
    let w = max(0.0, spatialWeights[i]);
    blended += samples[i].far * w;
    weight += w;
  }
  if (allBehind) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  if (allInFront && (maximum - minimum < 1000.0 || allDistant) && weight > 0.0) { return blended / weight; }
  return selected;
}

// Both depth lanes contain their own atmosphere and height fog already.
fn cloud_compose_transport(background: vec3f, cloud: vec4f) -> vec3f {
  return cloud.a * background + cloud.rgb;
}
