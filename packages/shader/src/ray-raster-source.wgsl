#define_import_path forgeax_ray::raster_source
#import forgeax_view::common::{View, hash32}
#import forgeax_pbr::gbuffer::{decodeStandardNormalRoughness}
#import forgeax_pbr::ray_bsdf::{rayBasis}

@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var normal: texture_2d<u32>;
@group(0) @binding(2) var identity: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> records: array<vec4u>;
@group(0) @binding(4) var<uniform> view: View;
// Seed and sample index belong to the submitted frame, not a CPU readback.
@group(0) @binding(5) var<uniform> sample: vec4u;
@group(0) @binding(6) var<storage, read_write> rays: array<vec4u>;

fn worldPosition(pixel: vec2f, value: f32, extent: vec2u) -> vec3f {
  let uv = pixel / vec2f(extent);
  let p = view.inverseViewProj * vec4f(uv * vec2f(2,-2) + vec2f(-1,1), value, 1);
  return p.xyz / p.w;
}

// PathState.state.w keeps the producer diagnostic: 0 background, 1 active,
// 2 hemisphere null, 3 invalid row/primitive, 4 invalid depth/position,
// 5 invalid coverage flags, 6 mismatched extent. It is not transport validity.
fn reject(base: u32, reason: u32) {
  rays[base + 3u].w = bitcast<u32>(1.0);
  rays[base + 4u].w = reason;
}

// One submitted G-buffer receiver. `status` 0 background, 1 accepted, or a reject reason.
struct RasterReceiver {
  status: u32,
  position: vec3f,
  ng: vec3f,
  ns: vec3f,
  roughness: f32,
  outgoing: vec3f,
  bias: f32,
  footprint: f32,
}

fn loadRasterReceiver(id: u32) -> RasterReceiver {
  var receiver = RasterReceiver(0u, vec3f(0), vec3f(0), vec3f(0), 0.0, vec3f(0), 0.0, 0.0);
  let extent = textureDimensions(depth);
  if (arrayLength(&rays) != extent.x * extent.y * 5u ||
      any(textureDimensions(normal) != extent) ||
      any(textureDimensions(identity) != extent)) { receiver.status = 6u; return receiver; }
  let pixel = vec2i(i32(id % extent.x), i32(id / extent.x));
  let surface = textureLoad(identity, pixel, 0);
  let z = textureLoad(depth, pixel, 0);
  if (all(surface == vec4u(0u)) && z == 0.0) { return receiver; }
  receiver.status = 5u;
  if ((surface.w != 1u && surface.w != 3u) || surface.x == 0u) { return receiver; }
  receiver.status = 3u;
  if (surface.x > arrayLength(&records) / 4u) { return receiver; }
  let row = (surface.x - 1u) * 4u;
  let elements = records[row + 2u].z;
  if (elements == 0u || elements % 3u != 0u || surface.y >= elements / 3u) { return receiver; }
  receiver.status = 4u;
  if (!(z > 0.0 && z <= 1.0)) { return receiver; }
  let center = vec2f(pixel) + vec2f(0.5);
  let position = worldPosition(center, z, extent);
  if (!all(abs(position) < vec3f(1e30))) { return receiver; }
  let footprint = max(length(worldPosition(center + vec2f(1,0), z, extent) - position),
                      length(worldPosition(center + vec2f(0,1), z, extent) - position));
  if (!(footprint >= 0.0 && footprint < 1e30)) { return receiver; }
  let shading = decodeStandardNormalRoughness(textureLoad(normal, pixel, 0).x);
  receiver.status = 1u;
  receiver.position = position;
  receiver.ng = decodeStandardNormalRoughness(surface.z).xyz;
  receiver.ns = shading.xyz;
  receiver.roughness = shading.w;
  receiver.outgoing = view.cameraPos - position;
  receiver.bias = max(1e-4, max(max(abs(position.x), abs(position.y)), abs(position.z)) * 1e-5);
  receiver.footprint = footprint;
  return receiver;
}

fn writeRasterRay(base: u32, receiver: RasterReceiver, direction: vec3f, accepted: bool, rng: u32) {
  rays[base] = bitcast<vec4u>(vec4f(receiver.position + receiver.ng * receiver.bias, receiver.footprint));
  rays[base + 1u] = bitcast<vec4u>(vec4f(direction, 1.0));
  rays[base + 2u] = bitcast<vec4u>(vec4f(1, 1, 1, 0));
  rays[base + 4u] = vec4u(select(0u,1u,accepted), 0u, rng, select(2u,1u,accepted));
}

fn unitRandom(x: u32) -> f32 { return f32(x >> 8u) * (1.0 / 16777216.0); }

@compute @workgroup_size(64) fn generateRasterRays(@builtin(global_invocation_id) id: vec3u) {
  let base = id.x * 5u;
  if (base >= arrayLength(&rays)) { return; }
  for (var lane = 0u; lane < 5u; lane++) { rays[base + lane] = vec4u(0u); }
  let receiver = loadRasterReceiver(id.x);
  if (receiver.status != 1u) { if (receiver.status != 0u) { reject(base, receiver.status); } return; }
  let rng = hash32(id.x ^ sample.x ^ hash32(sample.y));
  let u = unitRandom(rng);
  let v = unitRandom(hash32(rng));
  let radius = sqrt(u);
  let phi = 6.28318530718 * v;
  // Normalize after backend trigonometry so t remains a world-space distance.
  let direction = normalize(rayBasis(receiver.ns) * vec3f(radius * cos(phi), radius * sin(phi), sqrt(1.0-u)));
  let outgoing = receiver.outgoing;
  // Rejected directions keep their zero-contribution mass; never resample.
  let accepted = dot(direction, receiver.ng) > 0.0 && dot(outgoing, receiver.ng) > 0.0 &&
    dot(outgoing, receiver.ns) > 0.0;
  // Unit diffuse cone spread follows the existing reference approximation.
  // Unit Lambert * cosine / cosine-PDF is one: this produces D = E/pi.
  // Receiver material response belongs to the later composite, after filtering.
  writeRasterRay(base, receiver, direction, accepted, rng);
}

// Lite reflections: sample.zw carry maxRoughnessToTrace and its fade length (f32 bits).
// Dedicated rays sample the GGX NDF reflected about the view (split-sum pre-filtered
// radiance, unit throughput). Above the trace limit the ray follows a cosine lobe
// around the rough-specular dominant direction, whose mean is E(R)/pi: the same
// quantity UE LumenScreenProbeGather evaluates as rough specular. Inside the fade
// one ray picks the dedicated lobe with UE LumenCombineReflectionsAlpha probability,
// so the expectation is exactly the combined lerp. Response (DFG x AO) and the SSR
// replacement belong to the composite.
fn reflectionTraceAlpha(roughness: f32) -> f32 {
  let limit = bitcast<f32>(sample.z);
  let fade = max(bitcast<f32>(sample.w), 1e-3);
  return clamp((limit - roughness) / fade, 0.0, 1.0);
}

@compute @workgroup_size(64) fn generateReflectionRays(@builtin(global_invocation_id) id: vec3u) {
  let base = id.x * 5u;
  if (base >= arrayLength(&rays)) { return; }
  for (var lane = 0u; lane < 5u; lane++) { rays[base + lane] = vec4u(0u); }
  let receiver = loadRasterReceiver(id.x);
  if (receiver.status != 1u) { if (receiver.status != 0u) { reject(base, receiver.status); } return; }
  let v = normalize(receiver.outgoing);
  let n = receiver.ns;
  var rng = hash32(id.x ^ sample.x ^ hash32(sample.y ^ 0x5bd1e995u));
  let dedicated = unitRandom(rng) < reflectionTraceAlpha(receiver.roughness);
  let alpha = max(receiver.roughness * receiver.roughness, 1e-4);
  let mirror = reflect(-v, n);
  // Frostbite specular dominant direction; collapses to the mirror direction as alpha -> 0.
  let lerpFactor = (1.0 - alpha) * (sqrt(1.0 - alpha) + alpha);
  let dominant = normalize(mix(n, mirror, lerpFactor));
  let basis = rayBasis(select(dominant, n, dedicated));
  var direction = mirror;
  var accepted = false;
  // Conditional sampling over the visible hemisphere normalizes the lobe like
  // split-sum pre-filtering; at most four tries keep the work bounded.
  for (var attempt = 0u; attempt < 4u && !accepted; attempt++) {
    rng = hash32(rng);
    let u = unitRandom(rng);
    rng = hash32(rng);
    let phi = 6.28318530718 * unitRandom(rng);
    if (dedicated) {
      let z = sqrt((1.0 - u) / (1.0 + (alpha * alpha - 1.0) * u));
      let r = sqrt(max(1.0 - z * z, 0.0));
      direction = reflect(-v, basis * vec3f(r * cos(phi), r * sin(phi), z));
    } else {
      let r = sqrt(u);
      direction = basis * vec3f(r * cos(phi), r * sin(phi), sqrt(1.0 - u));
    }
    direction = normalize(direction);
    accepted = dot(direction, receiver.ng) > 0.0 && dot(direction, n) > 0.0;
  }
  accepted = accepted && dot(receiver.outgoing, receiver.ng) > 0.0 && dot(receiver.outgoing, n) > 0.0;
  writeRasterRay(base, receiver, direction, accepted, rng);
}
