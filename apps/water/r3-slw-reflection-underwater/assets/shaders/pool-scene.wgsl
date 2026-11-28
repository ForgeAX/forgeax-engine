#define_import_path water_pool::scene
#import forgeax_material::parameters::{material, tiles, tiles_sampler}
#import forgeax_water::caustics::heightfield::{waterHeight, waterNormal}
#import forgeax_view::common::{view}
#import water_pool::common::{AIR, WATER, sphereDistance, fieldUv, boxInterval}
#import forgeax_optics::interface::{refractInterface}

// Geometric approach adapted from Evan Wallace's MIT-licensed WebGL Water.
// The pool is a cutaway: back-facing walls are omitted, as in the reference.
@group(0) @binding(1) var causticField: texture_2d<f32>;
@group(0) @binding(2) var passDepth: texture_depth_2d;
@group(0) @binding(3) var<uniform> passInputs: vec4<f32>;
const ABOVE_COLOR: vec3<f32> = vec3<f32>(0.25, 1.0, 1.25);
const BELOW_COLOR: vec3<f32> = vec3<f32>(0.4, 0.9, 1.0);
const RIM: f32 = 2.0 / 12.0;
struct Hit { distance: f32, position: vec3<f32>, normal: vec3<f32>, kind: u32 };

fn poolHit(origin: vec3<f32>, ray: vec3<f32>, cutaway: bool) -> Hit {
  var hit = Hit(10000.0, vec3<f32>(0.0), vec3<f32>(0.0, 1.0, 0.0), 0u);
  for (var face = 0u; face < 5u; face++) {
    var normal = vec3<f32>(0.0, 1.0, 0.0);
    if (face == 1u) { normal = vec3<f32>(1.0, 0.0, 0.0); }
    if (face == 2u) { normal = vec3<f32>(-1.0, 0.0, 0.0); }
    if (face == 3u) { normal = vec3<f32>(0.0, 0.0, 1.0); }
    if (face == 4u) { normal = vec3<f32>(0.0, 0.0, -1.0); }
    let divisor = dot(ray, normal);
    if (abs(divisor) < 0.00001 || (cutaway && divisor >= 0.0)) { continue; }
    let t = (-1.0 - dot(origin, normal)) / divisor;
    let p = origin + ray * t;
    var inside = all(abs(p.xz) <= vec2<f32>(1.0001));
    if (face > 0u) {
      inside = p.y >= -1.0 && p.y <= RIM && select(abs(p.x), abs(p.z), face < 3u) <= 1.0001;
    }
    if (t > 0.0001 && t < hit.distance && inside) { hit = Hit(t, p, normal, 1u); }
  }
  let t = sphereDistance(origin, ray);
  if (t < hit.distance) {
    let p = origin + ray * t;
    hit = Hit(t, p, normalize(p - material.ball.xyz), 2u);
  }
  return hit;
}

fn sky(ray: vec3<f32>) -> vec3<f32> {
  // Match the reference's muted blue sky rather than a saturated blue fill.
  // These are display values: this feature runs after the output transform.
  let horizon = mix(vec3<f32>(0.65, 0.72, 0.79), vec3<f32>(0.18, 0.30, 0.47), pow(max(ray.y, 0.0), 0.55));
  let cloud = sin(ray.x * 5.0 + ray.z * 3.0) * sin(ray.z * 7.0 - ray.x * 2.0);
  let wisps = smoothstep(0.12, 0.8, cloud) * smoothstep(0.08, 0.5, ray.y);
  let sun = pow(max(dot(ray, normalize(material.lightDirection)), 0.0), 5000.0);
  return mix(horizon, vec3<f32>(0.95), wisps * 0.8) + vec3<f32>(10.0, 8.0, 6.0) * sun;
}

fn concentration(point: vec3<f32>, flat: vec3<f32>) -> f32 {
  let uv = fieldUv(point, flat);
  let raw = textureSampleLevel(causticField, tiles_sampler, clamp(uv, vec2<f32>(0.001), vec2<f32>(0.999)), 0.0).r;
  let inside = all(uv > vec2<f32>(0.0)) && all(uv < vec2<f32>(1.0));
  return select(1.0, mix(1.0, min(raw, 5.0), material.appearance.y), inside && material.appearance.x > 0.5);
}

fn sphereShadow(point: vec3<f32>, flat: vec3<f32>) -> f32 {
  // A distance-dependent blob penumbra on the same unfolded reference plane.
  let plane = point + flat * ((-1.0 - point.y) / flat.y);
  let dir = (material.ball.xyz - plane) / material.ball.w;
  let area = cross(dir, flat);
  let dist = dot(dir, -flat);
  let value = 1.0 + (dot(area, area) - 1.0) / max(0.005, 0.05 + dist * 0.025);
  let shadow = 1.0 / (1.0 + exp(-clamp(value, -50.0, 50.0)));
  return mix(1.0, shadow, clamp(dist * 2.0, 0.0, 1.0));
}

fn rimShadow(point: vec3<f32>, flat: vec3<f32>) -> f32 {
  let interval = boxInterval(point, -flat);
  let value = -200.0 / (1.0 + 10.0 * (interval.y - interval.x)) * (point.y - flat.y * interval.y - RIM);
  return 1.0 / (1.0 + exp(clamp(value, -50.0, 50.0)));
}

fn shade(hit: Hit, ray: vec3<f32>) -> vec3<f32> {
  let p = hit.position;
  let flat = refractInterface(-normalize(material.lightDirection), vec3<f32>(0.0, 1.0, 0.0), AIR, WATER).direction;
  let submerged = p.y < waterHeight(p.xz);
  let diffuse = max(dot(-flat, hit.normal), 0.0);
  if (hit.kind == 2u) {
    let radius = material.ball.w;
    var color = vec3<f32>(0.5);
    color *= 1.0 - 0.9 / pow((1.0 + radius - abs(p.x)) / radius, 3.0);
    color *= 1.0 - 0.9 / pow((1.0 + radius - abs(p.z)) / radius, 3.0);
    color *= 1.0 - 0.9 / pow((p.y + 1.0 + radius) / radius, 3.0);
    var light = diffuse * 0.5;
    if (submerged) { light *= concentration(p, flat) * 0.8 * rimShadow(p, flat); }
    return color + light;
  }
  var tileUv = p.xz * 0.5 + 0.5;
  if (abs(hit.normal.x) > 0.5) { tileUv = p.yz * 0.5 + vec2<f32>(1.0, 0.5); }
  if (abs(hit.normal.z) > 0.5) { tileUv = p.yx * 0.5 + vec2<f32>(1.0, 0.5); }
  // Explicit ray-cone footprint stays valid inside divergent analytic hits.
  // A fixed mip aliases distant grout, while implicit derivatives here are invalid.
  let footprint = f32(textureDimensions(tiles).x) * material.viewport.z * length(p - view.cameraPos)
    / (material.viewport.y * max(0.1, abs(dot(ray, hit.normal))));
  let albedo = textureSampleLevel(tiles, tiles_sampler, tileUv, max(0.0, log2(footprint))).rgb;
  var scale = 0.5 / max(length(p), 0.001);
  scale *= 1.0 - 0.9 / pow(max(length(p - material.ball.xyz) / material.ball.w, 1.0), 4.0);
  if (submerged) {
    scale += diffuse * concentration(p, flat) * 0.4 * sphereShadow(p, flat) * rimShadow(p, flat);
  } else {
    scale += diffuse * rimShadow(p, flat) * 0.5;
  }
  return albedo * scale;
}

fn trace(origin: vec3<f32>, ray: vec3<f32>, tint: vec3<f32>) -> vec3<f32> {
  let hit = poolHit(origin, ray, false);
  var color = sky(ray);
  if (hit.kind != 0u) { color = shade(hit, ray); }
  if (ray.y < 0.0) { color *= tint; }
  return color;
}

@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}
fn sceneSample(pixel: vec2<f32>) -> vec3<f32> {
  let uv = pixel / material.viewport.xy;
  let ndc = uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0);
  let far = view.inverseViewProj * vec4<f32>(ndc, 0.0001, 1.0);
  let eye = view.cameraPos;
  let ray = normalize(far.xyz / far.w - eye);
  let direct = poolHit(eye, ray, true);
  let safeY = select(-0.00001, ray.y, abs(ray.y) > 0.00001);
  var t = -eye.y / safeY;
  for (var i = 0u; i < 5u; i++) { t = (waterHeight((eye + ray * t).xz) - eye.y) / safeY; }
  let surface = eye + ray * t;
  let waterHit = t > 0.0 && t < direct.distance && all(abs(surface.xz) < vec2<f32>(1.0));
  var color = vec3<f32>(0.0);
  if (direct.kind != 0u) {
    color = shade(direct, ray);
    if (direct.position.y < waterHeight(direct.position.xz)) { color *= BELOW_COLOR * 1.2; }
  }
  if (waterHit) {
    let below = eye.y < waterHeight(eye.xz) && all(abs(eye.xz) < vec2<f32>(1.0));
    var coord = surface.xz;
    for (var i = 0u; i < 5u; i++) { coord += waterNormal(coord).xz * 0.02; }
    let geometric = waterNormal(coord);
    let normal = normalize(vec3<f32>(geometric.x * 2.0, geometric.y, geometric.z * 2.0)) * select(1.0, -1.0, below);
    let reflected = reflect(ray, normal);
    let refracted = refractInterface(ray, normal, select(AIR, WATER, below), select(WATER, AIR, below));
    let minimum = select(0.25, 0.5, below);
    let fresnel = select(mix(minimum, 1.0, pow(1.0 - max(dot(-ray, normal), 0.0), 3.0)), 1.0, refracted.status != 0u);
    let tint = select(ABOVE_COLOR, BELOW_COLOR, below);
    let reflection = trace(surface + reflected * 0.0001, reflected, tint);
    var transmission = vec3<f32>(0.0);
    if (refracted.status == 0u) {
      transmission = trace(surface + refracted.direction * 0.0001, refracted.direction, tint);
      if (below) { transmission *= vec3<f32>(0.8, 1.0, 1.1); }
    }
    color = mix(transmission, reflection, fresnel);
  }
  return color;
}

@fragment fn fs_main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = p.xy / material.viewport.xy;
  if (passInputs.y > 0.5) { return vec4<f32>(vec3<f32>(textureLoad(passDepth, vec2<i32>(p.xy), 0)), 1.0); }
  if (material.appearance.w > 0.5) {
    let raw = textureSampleLevel(causticField, tiles_sampler, uv, 0.0).r;
    return vec4<f32>(vec3<f32>(raw * 0.2), 1.0);
  }
  // Integrate actual reflection/refraction rays, including analytic silhouettes.
  // Raster MSAA cannot smooth geometry intersected inside a fullscreen fragment.
  let color = (
    sceneSample(p.xy + vec2<f32>(-0.25, -0.25)) +
    sceneSample(p.xy + vec2<f32>( 0.25, -0.25)) +
    sceneSample(p.xy + vec2<f32>(-0.25, 0.25)) +
    sceneSample(p.xy + vec2<f32>( 0.25, 0.25))
  ) * 0.25;
  return vec4<f32>(color * passInputs.x, 1.0);
}
