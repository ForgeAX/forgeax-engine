#define_import_path water_entry::motion
#import water_entry::geometry::{entry_crown_rim}

// Shared with every emitter; Parameters and the four material lanes retain their ABI.
struct VfxParameters {
  entryPosition: vec3<f32>,
  entryVelocity: vec3<f32>,
  // forgeax-vfx-default surfaceOffsetM = vec3<f32>(0.0, 0.0, 0.0)
  surfaceOffsetM: vec3<f32>,
  // forgeax-vfx-default surfaceVelocityMps = vec3<f32>(0.0, 0.0, 0.0)
  surfaceVelocityMps: vec3<f32>,
  surfaceNormal: vec3<f32>,
  // forgeax-vfx-default entryRadiusM = 0.6
  entryRadiusM: f32,
  // forgeax-vfx-default jetSpeed = 2.6
  jetSpeed: f32,
  // forgeax-vfx-default radialSpeed = 1.8
  radialSpeed: f32,
  // forgeax-vfx-default dropletSize = 0.012
  dropletSize: f32,
  // forgeax-vfx-default lifetime = 1.1
  lifetime: f32,
  // forgeax-vfx-default opacity = 0.72
  opacity: f32,
}

struct VfxCustom {
  subsurfaceGainOpacity: vec4<f32>,
  waterSphereShading: vec4<f32>,
  waterSphereFlattenSphere: vec4<f32>,
  waterSphereProjection: vec4<f32>,
}

fn entry_orientation(p: VfxParameters) -> vec4<f32> {
  let normal = normalize(p.surfaceNormal);
  let axis = cross(vec3<f32>(0.0, 1.0, 0.0), normal);
  let rotation = vec4<f32>(axis, 1.0 + normal.y);
  return select(vec4<f32>(1.0, 0.0, 0.0, 0.0), normalize(rotation), normal.y > -0.999);
}

fn entry_rotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

fn entry_drift(p: VfxParameters) -> vec3<f32> {
  let normal = normalize(p.surfaceNormal);
  return (p.entryVelocity - normal * dot(p.entryVelocity, normal)) * 0.08;
}

fn entry_delay(p: VfxParameters) -> f32 {
  let radius = max(p.entryRadiusM, 0.01);
  let speed = max(-dot(p.entryVelocity, normalize(p.surfaceNormal)), 0.0);
  return 2.0 * radius / max(speed, sqrt(9.81 * radius)) + 0.65 * sqrt(radius / 9.81);
}

fn entry_speed(p: VfxParameters, jet: bool) -> f32 {
  return p.jetSpeed * select(1.0, 0.72, jet);
}

fn entry_time(p: VfxParameters, age: f32, jet: bool) -> f32 {
  return max(age - select(0.0, entry_delay(p), jet), 0.0);
}

fn entry_scale(p: VfxParameters, age: f32, jet: bool) -> vec3<f32> {
  let time = entry_time(p, age, jet);
  let radius = max(p.entryRadiusM, 0.01);
  let speed = entry_speed(p, jet);
  let height = max(speed * time - 4.905 * time * time, 0.0);
  let width = select(radius + p.radialSpeed * time * 0.22, radius * 0.48, jet);
  return vec3<f32>(width, height, width);
}

fn entry_scale_velocity(p: VfxParameters, age: f32, jet: bool) -> vec3<f32> {
  let time = entry_time(p, age, jet);
  let radial = select(p.radialSpeed * 0.22, 0.0, jet);
  return vec3<f32>(radial, entry_speed(p, jet) - 9.81 * time, radial);
}

fn entry_alpha(p: VfxParameters, age: f32, jet: bool) -> f32 {
  let time = entry_time(p, age, jet);
  let flight = max(2.0 * entry_speed(p, jet) / 9.81, 0.01);
  // The raised sheet remains attached to the current water surface.
  return smoothstep(0.0, min(0.025, flight * 0.08), time) *
    (1.0 - smoothstep(flight * 0.48, flight * 0.92, time));
}

fn entry_edge(p: VfxParameters, age: f32, turn: f32, jet: bool) -> vec3<f32> {
  let rim = select(entry_crown_rim(turn), vec3<f32>(0.055, 1.0, 0.0), jet);
  return p.entryPosition + p.surfaceOffsetM + entry_drift(p) * age +
    entry_rotate(entry_orientation(p), rim * entry_scale(p, age, jet));
}

fn entry_edge_velocity(p: VfxParameters, age: f32, turn: f32, jet: bool) -> vec3<f32> {
  let rim = select(entry_crown_rim(turn), vec3<f32>(0.055, 1.0, 0.0), jet);
  return p.surfaceVelocityMps + entry_drift(p) + entry_rotate(entry_orientation(p),
    rim * entry_scale_velocity(p, age, jet));
}

fn entry_release(p: VfxParameters, phase: f32, jet: bool) -> f32 {
  let flight = 2.0 * entry_speed(p, jet) / 9.81;
  return select(0.0, entry_delay(p), jet) + flight *
    (0.14 + fract(phase * 17.37) * 0.36);
}
