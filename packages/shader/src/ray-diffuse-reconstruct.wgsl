#define_import_path forgeax_ray::diffuse_reconstruct
#import forgeax_view::common::{View}
#import forgeax_pbr::gbuffer::{decodeStandardNormalRoughness}
#import forgeax_scene_temporal::{unpackSceneTemporalV1, sceneViewZ}

// Linear, receiver-independent D. Weight/age are history statistics, never ray counts.
struct DiffuseHistoryPixel {
  radiance: vec4f,
  momentsDepthAge: vec4f,
  identityA: vec4u,
  identityB: vec4u,
  // Packed shading/geometric normals, current validity (0 background, 1 valid,
  // 2 invalid), and draw-local primitive. Primitive is diagnostic, not identity.
  surface: vec4u,
  positionFootprint: vec4f,
}
struct Reconstruction {
  // history valid, maximum history weight, temporal enabled, spatial radius.
  control: vec4u,
  // Current and previous accepted jitter, in UV units.
  jitter: vec4f,
  // Plane tolerance per footprint, relative depth tolerance, geometric/shading cosine.
  thresholds: vec4f,
}
@group(0) @binding(0) var<storage, read> rawD: array<vec4u>;
@group(0) @binding(1) var<storage, read> records: array<vec4u>;
@group(0) @binding(2) var<storage, read> previous: array<DiffuseHistoryPixel>;
@group(0) @binding(3) var<storage, read_write> current: array<DiffuseHistoryPixel>;
// D.xyz and validity. No reconstructed value is represented as a real ray count.
@group(0) @binding(4) var<storage, read_write> signal: array<vec4f>;
@group(0) @binding(5) var depth: texture_depth_2d;
@group(0) @binding(6) var normal: texture_2d<u32>;
@group(0) @binding(7) var identity: texture_2d<u32>;
@group(0) @binding(8) var motion: texture_2d<f32>;
@group(0) @binding(9) var<uniform> view: View;
@group(0) @binding(10) var<uniform> config: Reconstruction;
// Rejection bitset, accepted bilinear tap mask, effective weight (f32 bits),
// spatial support count. Read through the existing RHI Debug buffer inspector.
@group(0) @binding(11) var<storage, read_write> diagnostics: array<vec4u>;

fn finite3(v: vec3f) -> bool { return all(abs(v) < vec3f(1e30)); }
fn luminance(v: vec3f) -> f32 { return dot(v, vec3f(0.2126, 0.7152, 0.0722)); }
fn positionAt(pixel: vec2f, z: f32, extent: vec2u) -> vec3f {
  let uv = pixel / vec2f(extent);
  let p = view.inverseViewProj * vec4f(uv * vec2f(2,-2) + vec2f(-1,1), z, 1);
  return p.xyz / p.w;
}
fn inBounds(p: vec2i, extent: vec2u) -> bool {
  return all(p >= vec2i(0)) && all(p < vec2i(extent));
}
fn indexAt(p: vec2i, extent: vec2u) -> u32 {
  return u32(p.y) * extent.x + u32(p.x);
}
fn preparePixel(p: vec2i, extent: vec2u) -> DiffuseHistoryPixel {
  var result: DiffuseHistoryPixel;
  let i = indexAt(p, extent);
  let address = textureLoad(identity, p, 0);
  let z = textureLoad(depth, p, 0);
  if (all(address == vec4u(0)) && z == 0.0) { return result; }
  result.surface.z = 2u;
  if (address.x == 0u || address.x > arrayLength(&records) / 4u ||
      (address.w != 1u && address.w != 3u) || !(z > 0.0 && z <= 1.0)) { return result; }
  let row = (address.x - 1u) * 4u;
  if (records[row + 2u].z == 0u || address.y >= records[row + 2u].z / 3u) { return result; }
  let offset = i * 5u;
  let d = bitcast<vec3f>(rawD[offset].xyz);
  if (rawD[offset].w == 0u || rawD[offset + 1u].w != 0u ||
      !finite3(d) || any(d < vec3f(0))) { return result; }
  let temporal = unpackSceneTemporalV1(textureLoad(motion, p, 0));
  let center = vec2f(p) + vec2f(0.5);
  let position = positionAt(center, z, extent);
  let footprint = max(length(positionAt(center + vec2f(1,0), z, extent) - position),
    length(positionAt(center + vec2f(0,1), z, extent) - position));
  if (!finite3(position) || !(footprint >= 0.0 && footprint < 1e30) ||
      !temporal.validDepth || !(temporal.viewDepth >= 0.0 && temporal.viewDepth < 1e30)) { return result; }
  let y = luminance(d);
  if (!(y*y < 1e30)) { return result; }
  result.radiance = vec4f(d, 1);
  result.momentsDepthAge = vec4f(y, y*y, temporal.viewDepth, 1);
  result.identityA = records[row];
  result.identityB = records[row + 1u];
  result.surface = vec4u(textureLoad(normal, p, 0).x, address.z, 1u, address.y);
  result.positionFootprint = vec4f(position, footprint);
  return result;
}

// Hard admission precedes any weighting. No epsilon floor may admit another wall.
// UE StochasticLightingTileClassification does per-tap material/normal/depth
// admission. Exact instance/material identity and a plane test are conservative
// first-version ForgeaX choices, not a claim of identical UE material policy.
fn supportReject(a: DiffuseHistoryPixel, b: DiffuseHistoryPixel) -> u32 {
  if (b.surface.z != 1u || !finite3(b.radiance.xyz) || any(b.radiance.xyz < vec3f(0)) ||
      !(b.radiance.w >= 1.0 && b.radiance.w < 1e30) ||
      !finite3(b.positionFootprint.xyz) || !all(abs(b.momentsDepthAge) < vec4f(1e30))) { return 16u; }
  if (any(a.identityA != b.identityA) || any(a.identityB != b.identityB)) { return 2u; }
  let ag = decodeStandardNormalRoughness(a.surface.y).xyz;
  let bg = decodeStandardNormalRoughness(b.surface.y).xyz;
  let an = decodeStandardNormalRoughness(a.surface.x).xyz;
  let bn = decodeStandardNormalRoughness(b.surface.x).xyz;
  if (dot(ag,bg) < config.thresholds.z || dot(an,bn) < config.thresholds.w) { return 8u; }
  let delta = a.positionFootprint.xyz - b.positionFootprint.xyz;
  let scale = max(max(abs(a.positionFootprint.x),abs(a.positionFootprint.y)),abs(a.positionFootprint.z));
  let tolerance = max(max(1e-4, scale * 1e-6),
    min(a.positionFootprint.w,b.positionFootprint.w) * config.thresholds.x);
  if (max(abs(dot(delta,ag)),abs(dot(delta,bg))) > tolerance) { return 4u; }
  return 0u;
}

@compute @workgroup_size(64)
fn reconstructDiffuse(@builtin(global_invocation_id) id: vec3u) {
  let extent = textureDimensions(depth);
  let count = extent.x * extent.y;
  if (id.x >= count || id.x >= arrayLength(&current) || id.x >= arrayLength(&signal) ||
      id.x >= arrayLength(&diagnostics)) { return; }
  signal[id.x] = vec4f(0);
  diagnostics[id.x] = vec4u(64u,0u,0u,0u);
  current[id.x] = DiffuseHistoryPixel();
  current[id.x].surface.z = 2u;
  if (arrayLength(&rawD) != count * 5u || arrayLength(&previous) != count ||
      any(textureDimensions(normal) != extent) || any(textureDimensions(identity) != extent) ||
      any(textureDimensions(motion) != extent)) { return; }
  let p = vec2i(i32(id.x % extent.x),i32(id.x / extent.x));
  var value = preparePixel(p,extent);
  if (value.surface.z != 1u) { current[id.x] = value; return; }
  var reasons = 0u;
  var mask = 0u;
  let motionValue = unpackSceneTemporalV1(textureLoad(motion,p,0));
  var support = 0.0;
  var color = vec3f(0);
  var historyWeight = 0.0;
  var moments = vec2f(0);
  var age = 0.0;
  if (config.control.z == 0u || config.control.x == 0u) { reasons |= 128u; }
  else if (!motionValue.motionValid || !all(abs(motionValue.motionUv) < vec2f(1e30))) { reasons |= 32u; }
  else {
    let uv = (vec2f(p) + vec2f(0.5)) / vec2f(extent);
    let historyUv = uv - config.jitter.xy - motionValue.motionUv + config.jitter.zw;
    let clip = view.temporalPreviousViewProj * vec4f(value.positionFootprint.xyz,1);
    let expectedDepth = -sceneViewZ(clip,view.temporalProjection);
    let coordinate = historyUv * vec2f(extent) - vec2f(0.5);
    let origin = vec2i(floor(coordinate));
    let f = fract(coordinate);
    let weights = vec4f((1-f.x)*(1-f.y),f.x*(1-f.y),(1-f.x)*f.y,f.x*f.y);
    if (!(expectedDepth > 0.0 && expectedDepth < 1e30) || !all(abs(historyUv) < vec2f(1e10))) { reasons |= 4u; }
    else {
      for (var tap = 0u; tap < 4u; tap++) {
        let q = origin + vec2i(i32(tap & 1u),i32(tap >> 1u));
        if (!inBounds(q,extent)) { reasons |= 1u; continue; }
        if (weights[tap] == 0.0) { continue; }
        let old = previous[indexAt(q,extent)];
        let rejected = supportReject(value,old);
        if (rejected != 0u) { reasons |= rejected; continue; }
        if (!(abs(expectedDepth - old.momentsDepthAge.z) <= max(1e-3,expectedDepth*config.thresholds.y))) {
          reasons |= 4u; continue;
        }
        let w = weights[tap];
        support += w;
        color += old.radiance.xyz * w;
        historyWeight += old.radiance.w * w;
        moments += old.momentsDepthAge.xy * w;
        age += old.momentsDepthAge.w * w;
        mask |= 1u << tap;
      }
    }
  }
  if (support > 0.0) {
    // UE LumenScreenProbeGatherTemporal.ush: validity-weighted renormalization.
    color /= support;
    moments /= support;
    historyWeight = min(historyWeight/support, f32(max(1u,min(config.control.y,64u))-1u));
    historyWeight *= 1.0 - motionValue.reactive;
    // UE only enables diffuse neighborhood clipping in fast-update mode.
    // Our first version resets changed lighting/content generations instead.
    // Static raw estimates include legal zero events: clipping history to a
    // sparse current neighborhood would destroy energy and bias the mean.
    let alpha = 1.0 / (historyWeight+1.0);
    value.radiance = vec4f(mix(color,value.radiance.xyz,alpha),historyWeight+1.0);
    value.momentsDepthAge = vec4f(mix(moments,value.momentsDepthAge.xy,alpha),
      value.momentsDepthAge.z,min(age/support+1.0,65535.0));
  }
  current[id.x] = value;
  signal[id.x] = vec4f(value.radiance.xyz,1);
  diagnostics[id.x] = vec4u(reasons,mask,bitcast<u32>(value.radiance.w),0u);
}

@compute @workgroup_size(64)
fn spatialDiffuse(@builtin(global_invocation_id) id: vec3u) {
  let extent = textureDimensions(depth);
  if (id.x >= extent.x*extent.y || id.x >= arrayLength(&current) ||
      id.x >= arrayLength(&signal) || id.x >= arrayLength(&diagnostics)) { return; }
  let value = current[id.x];
  if (value.surface.z != 1u) { signal[id.x] = vec4f(0); return; }
  let p = vec2i(i32(id.x % extent.x),i32(id.x / extent.x));
  let radius = i32(min(config.control.w,2u));
  var sum = vec3f(0);
  var weight = 0.0;
  var support = 0u;
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let q = p + vec2i(x,y);
      if (!inBounds(q,extent)) { continue; }
      let neighbor = current[indexAt(q,extent)];
      if (supportReject(value,neighbor) != 0u) { continue; }
      let w = f32((radius+1-abs(x))*(radius+1-abs(y)));
      sum += neighbor.radiance.xyz * w;
      weight += w;
      support++;
    }
  }
  signal[id.x] = select(vec4f(0),vec4f(sum/max(weight,1e-30),1),weight>0.0);
  diagnostics[id.x].w = support;
}
