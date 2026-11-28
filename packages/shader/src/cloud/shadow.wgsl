#define_import_path forgeax_cloud::shadow
#import forgeax_cloud::geometry::{cloud_sphere_interval}

// UE SHADER_SHADOW_PS near-plane interval; zero length means zero occlusion.
fn cloud_bsm_trace_interval(origin: vec3f, direction: vec3f, radius: f32,
  bottom: f32, thickness: f32) -> vec2f {
  let radial = length(origin);
  let projection = dot(origin, direction);
  let outer = cloud_sphere_interval(radial, projection, radius + bottom + thickness);
  if outer.x == outer.y { return vec2f(-1.0); }
  let inner = cloud_sphere_interval(radial, projection, radius + bottom);
  if inner.x != inner.y {
    if !all(inner > vec2f(0.0)) { return vec2f(0.0); }
    return max(vec2f(0.0), vec2f(outer.x, inner.x));
  }
  return max(vec2f(0.0), outer);
}

// The UE nonnegative-depth 2x2 kernel reduces to an encoded-domain mean.
fn cloud_shadow_filter(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> vec3f {
  if cloud_shadow_is_invalid(a) || cloud_shadow_is_invalid(b) ||
    cloud_shadow_is_invalid(c) || cloud_shadow_is_invalid(d) {
    return CLOUD_SHADOW_INVALID_COLUMN;
  }
  return (a + b + c + d) * 0.25;
}

fn cloud_shadow_segment(index: u32, count: u32, distanceMeters: f32) -> vec2f {
  let start = f32(index) / f32(count);
  let end = f32(index + 1u) / f32(count);
  return distanceMeters * vec2f((start * start + end * end) * 0.5, end * end - start * start);
}

fn cloud_shadow_ray_octave_tau(baseTau: f32, occlusion: f32, octave: u32) -> f32 {
  let factor = clamp(occlusion, 0.0, 1.0);
  if (octave == 0u) { return baseTau; }
  if (octave == 1u) { return baseTau * factor; }
  return baseTau * factor * factor * factor;
}

fn cloud_shadow_map_octave_tau(baseTau: f32, occlusion: f32, octave: u32) -> f32 {
  if (octave == 0u) { return baseTau; }
  return baseTau * pow(clamp(occlusion, 0.0, 1.0), f32(octave));
}

// Initialize with vec4f(endMeters, 0, 0, 0); samples are linear midpoints.
fn cloud_shadow_accumulate(acc: vec4f, distanceMeters: f32, extinctionPerMeter: vec3f) -> vec4f {
  let gray = dot(max(extinctionPerMeter, vec3f(0.0)), vec3f(1.0 / 3.0));
  return vec4f(select(acc.x, min(acc.x, distanceMeters), gray > 0.0), acc.y + gray, acc.z + select(0.0, 1.0, gray > 0.0), 0.0);
}

const CLOUD_SHADOW_METERS_PER_KM: f32 = 1000.0;
// Reserve the largest finite R11 value. It also survives RGBA16F and RGBA32F.
const CLOUD_SHADOW_INVALID_COLUMN: vec3f = vec3f(65024.0, 0.0, 0.0);
const CLOUD_SHADOW_PACKABLE_MAX: vec3f = vec3f(64512.0, 65024.0, 64512.0);

fn cloud_shadow_is_invalid(column: vec3f) -> bool {
  return column.x == CLOUD_SHADOW_INVALID_COLUMN.x;
}

fn cloud_shadow_pack_column(frontMeters: f32, meanPerMeter: f32, maxTau: f32) -> vec3f {
  let column = vec3f(frontMeters / CLOUD_SHADOW_METERS_PER_KM, meanPerMeter, maxTau);
  if !all(column >= vec3f(0.0)) || !all(column <= CLOUD_SHADOW_PACKABLE_MAX) {
    return CLOUD_SHADOW_INVALID_COLUMN;
  }
  return column;
}

fn cloud_shadow_finish(acc: vec4f, endMeters: f32, stepMeters: f32, strength: f32, biasMeters: f32) -> vec3f {
  let frontMeters = select(endMeters, acc.x, acc.z > 0.0);
  return cloud_shadow_pack_column(
    max(0.0, frontMeters + biasMeters), strength * acc.y / max(1.0, acc.z),
    strength * acc.y * stepMeters,
  );
}

fn cloud_shadow_optical_depth(encoded: vec3f, receiverMeters: f32) -> f32 {
  let receiverKm = receiverMeters / CLOUD_SHADOW_METERS_PER_KM;
  let pathMeters = max(0.0, receiverKm - encoded.x) * CLOUD_SHADOW_METERS_PER_KM;
  return min(encoded.z, encoded.y * pathMeters);
}

// The caller tests projection coverage before loading; edge taps clamp to texels.
fn cloud_shadow_map_load_rgba(shadowMap: texture_2d<f32>, uv: vec2f, beerMap: bool) -> vec4f {
  let dimensions = vec2i(textureDimensions(shadowMap));
  let position = uv * vec2f(dimensions) - vec2f(0.5);
  let base = vec2i(floor(position));
  let fraction = fract(position);
  let last = dimensions - vec2i(1);
  let a = textureLoad(shadowMap, clamp(base, vec2i(0), last), 0);
  let b = textureLoad(shadowMap, clamp(base + vec2i(1, 0), vec2i(0), last), 0);
  let c = textureLoad(shadowMap, clamp(base + vec2i(0, 1), vec2i(0), last), 0);
  let d = textureLoad(shadowMap, clamp(base + vec2i(1, 1), vec2i(0), last), 0);
  if beerMap {
    let weights = vec4f(
      (1.0 - fraction.x) * (1.0 - fraction.y), fraction.x * (1.0 - fraction.y),
      (1.0 - fraction.x) * fraction.y, fraction.x * fraction.y,
    );
    if (weights.x > 0.0 && cloud_shadow_is_invalid(a.xyz)) ||
      (weights.y > 0.0 && cloud_shadow_is_invalid(b.xyz)) ||
      (weights.z > 0.0 && cloud_shadow_is_invalid(c.xyz)) ||
      (weights.w > 0.0 && cloud_shadow_is_invalid(d.xyz)) {
      return vec4f(CLOUD_SHADOW_INVALID_COLUMN, 1.0);
    }
  }
  return mix(mix(a, b, fraction.x), mix(c, d, fraction.x), fraction.y);
}

fn cloud_shadow_map_load(shadowMap: texture_2d<f32>, uv: vec2f) -> vec3f {
  return cloud_shadow_map_load_rgba(shadowMap, uv, true).xyz;
}

fn cloud_shadow_uv(offset: vec3f, right: vec3f, up: vec3f, widthMeters: f32) -> vec2f {
  return vec2f(dot(offset, right), dot(offset, up)) / widthMeters + vec2f(0.5);
}

fn cloud_shadow_query_tau(shadowMap: texture_2d<f32>, uv: vec2f, depthMeters: f32, farMeters: f32) -> f32 {
  let receiverMeters = select(depthMeters, clamp(depthMeters, 0.0, max(farMeters, 0.0)), farMeters > 0.0);
  return cloud_shadow_optical_depth(cloud_shadow_map_load(shadowMap, clamp(uv, vec2f(0.0), vec2f(1.0))), receiverMeters);
}

fn cloud_shadow_receiver_beer_factor(shadowMap: texture_2d<f32>, uv: vec2f, depthMeters: f32,
  farMeters: f32, strength: f32) -> f32 {
  let inRange = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  if !inRange && farMeters <= 0.0 { return 1.0; }
  return mix(1.0, exp(-cloud_shadow_query_tau(shadowMap, uv, depthMeters, farMeters)), clamp(strength, 0.0, 1.0));
}
