#define_import_path forgeax_cloud::depth_minmax
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
