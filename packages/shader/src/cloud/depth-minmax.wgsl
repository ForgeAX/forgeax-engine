#define_import_path forgeax_cloud::depth_minmax
#import forgeax_view::common::View
#import forgeax_cloud::geometry::{CLOUD_UNTRACED_DEPTH_METERS}

// Device Z is reverse-Z; only zero is sky. Output is a linear ray distance in m.
fn cloud_scene_depth_meters(deviceZ: f32, uv: vec2f, inverseViewProjection: mat4x4f, cameraMeters: vec3f) -> f32 {
  if deviceZ <= 0.0 { return CLOUD_UNTRACED_DEPTH_METERS; }
  let ndc = uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0);
  let world = inverseViewProjection * vec4f(ndc, deviceZ, 1.0);
  return distance(world.xyz / world.w, cameraMeters);
}

// Each member uses its own full-resolution UV before reduction, including odd edges.
fn cloud_scene_depth_range_meters(depth: texture_depth_2d, origin: vec2i, footprint: vec2u,
  inverseViewProjection: mat4x4f, cameraMeters: vec3f) -> vec2f {
  let size = textureDimensions(depth);
  var nearMeters = CLOUD_UNTRACED_DEPTH_METERS;
  var farMeters = 0.0;
  for (var y = 0u; y < footprint.y; y += 1u) {
    for (var x = 0u; x < footprint.x; x += 1u) {
      let pixel = origin + vec2i(i32(x), i32(y));
      if any(pixel < vec2i(0)) || any(pixel >= vec2i(size)) { continue; }
      let uv = (vec2f(pixel) + 0.5) / vec2f(size);
      let meters = cloud_scene_depth_meters(textureLoad(depth, pixel, 0), uv,
        inverseViewProjection, cameraMeters);
      nearMeters = min(nearMeters, meters);
      farMeters = max(farMeters, meters);
    }
  }
  return vec2f(nearMeters, max(nearMeters, farMeters));
}

// R is the least (farthest) reverse Device Z and G is the greatest (nearest).
// Back-project both endpoints at the selected trace pixel. The existing ray
// marcher works in meters.
fn cloud_mode0_depth_range_meters(deviceZ: vec2f, uv: vec2f,
  inverseViewProjection: mat4x4f, rayOriginMeters: vec3f) -> vec2f {
  let nearMeters = cloud_scene_depth_meters(deviceZ.g, uv, inverseViewProjection, rayOriginMeters);
  let farMeters = cloud_scene_depth_meters(deviceZ.r, uv, inverseViewProjection, rayOriginMeters);
  let kilometers = min(vec2f(nearMeters, farMeters) * 0.001, vec2f(65504.0));
  return kilometers * 1000.0;
}

fn cloud_mode0_noise(atlas: texture_2d<f32>, tracePosition: vec2f, phase: f32, viewSampleBudget: f32) -> f32 {
  if phase < 0.0 { return 0.5; }
  let pixel = vec2u(tracePosition * 4.0) & vec2u(127u);
  let slice = (u32(max(phase, 1.0)) - 1u) & 7u;
  let noise = textureLoad(atlas, vec2i(vec2u(pixel.x, pixel.y + slice * 128u)), 0).r;
  return cloud_mode0_view_sample_phase(noise, viewSampleBudget);
}

// The reference budget is CLOUD_BASE_SAMPLE_COUNTS.view in the render policy.
// Below it, taper the strength cubically to suppress coarse-step flicker while keeping all eight phases.
fn cloud_mode0_view_sample_phase(noise: f32, viewSampleBudget: f32) -> f32 {
  let budgetRatio = clamp(viewSampleBudget / 96.0, 0.0, 1.0);
  return mix(0.5, noise, budgetRatio * budgetRatio * budgetRatio);
}

// UE desktop Mode 0 publishes linear sight-line distances in kilometers.
fn cloud_mode0_pack_depth_km(representativeMeters: f32, rangeMeters: vec2f) -> vec4f {
  return clamp(vec4f(representativeMeters, rangeMeters.y, rangeMeters) * 0.001,
    vec4f(0.0), vec4f(65504.0));
}

// Cancel scene TAA jitter before using the renderer's inverse projection.
fn cloud_mode0_unjittered_uv(viewData: View, uv: vec2f) -> vec2f {
  let jitteredCenter = viewData.inverseViewProj * vec4f(0.0, 0.0, 1.0, 1.0);
  let unjitteredCenter = viewData.temporalCurrentViewProj * jitteredCenter;
  if abs(unjitteredCenter.w) < 1e-6 { return uv; }
  return uv - unjitteredCenter.xy / unjitteredCenter.w * vec2f(0.5, -0.5);
}
