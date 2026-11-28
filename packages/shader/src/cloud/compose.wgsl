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

// -2: occluded, -1: bilinear far, otherwise 2 * sample index + (1 for near).
fn cloud_ue_upsample_choice(depthsKm: array<vec4f, 4>, sceneKm: f32,
    disableDisocclusionKm: f32) -> i32 {
  var allBehind = true;
  var allInFront = true;
  var allDistant = true;
  var minimum = min(depthsKm[0].z, depthsKm[0].w);
  var maximum = max(depthsKm[0].z, depthsKm[0].w);
  var closest = abs(sceneKm - depthsKm[0].w);
  var selected = 0;
  for (var i = 0u; i < 4u; i += 1u) {
    let depthKm = depthsKm[i];
    allBehind = allBehind && depthKm.x > sceneKm + 0.001;
    allInFront = allInFront && depthKm.x <= depthKm.z;
    allDistant = allDistant && all(depthKm.yzw >= vec3f(disableDisocclusionKm));
    minimum = min(minimum, min(depthKm.z, depthKm.w));
    maximum = max(maximum, max(depthKm.z, depthKm.w));
    let farDelta = abs(sceneKm - depthKm.w);
    if farDelta < closest {
      closest = farDelta;
      selected = i32(2u * i);
    }
    let nearDelta = abs(sceneKm - depthKm.z);
    if nearDelta < closest {
      closest = nearDelta;
      selected = i32(2u * i + 1u);
    }
  }
  if allBehind { return -2; }
  if allInFront && (maximum - minimum < 1.0 || allDistant) { return -1; }
  return selected;
}

// Both depth lanes contain their own atmosphere and height fog already.
fn cloud_compose_transport(background: vec3f, cloud: vec4f) -> vec3f {
  return cloud.a * background + cloud.rgb;
}
