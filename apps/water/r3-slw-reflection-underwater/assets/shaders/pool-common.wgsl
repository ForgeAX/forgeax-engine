#define_import_path water_pool::common
#import forgeax_material::parameters::{material}

const AIR: f32 = 1.0;
const WATER: f32 = 1.333;
const FIELD_SCALE: f32 = 0.75;

fn boxInterval(origin: vec3<f32>, ray: vec3<f32>) -> vec2<f32> {
  let safe = select(vec3<f32>(0.000001), ray, abs(ray) > vec3<f32>(0.000001));
  let a = (vec3<f32>(-1.0) - origin) / safe;
  let b = (vec3<f32>(1.0, 2.0, 1.0) - origin) / safe;
  let lo = min(a, b);
  let hi = max(a, b);
  return vec2<f32>(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}
fn sphereDistance(origin: vec3<f32>, ray: vec3<f32>) -> f32 {
  let offset = origin - material.ball.xyz;
  let b = dot(offset, ray);
  let disc = b * b - dot(offset, offset) + material.ball.w * material.ball.w;
  let distance = -b - sqrt(max(0.0, disc));
  return select(10000.0, distance, disc >= 0.0 && distance > 0.0001);
}
fn fieldUv(point: vec3<f32>, flatRay: vec3<f32>) -> vec2<f32> {
  return (point.xz - point.y * flatRay.xz / flatRay.y) * (FIELD_SCALE * 0.5) + 0.5;
}
