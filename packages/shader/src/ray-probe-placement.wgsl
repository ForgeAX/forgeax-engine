#define_import_path forgeax_ray::probe_placement
#import forgeax_view::common::View
#import forgeax_pbr::gbuffer::decodeStandardNormalRoughness
#import forgeax_scene_temporal::sceneViewZ

struct PlacementProbe { baseCell: vec4f, key: vec4u }
struct PlacementState { offset: vec4f, key: vec4u }
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var normal: texture_2d<u32>;
@group(0) @binding(2) var identity: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> records: array<vec4u>;
@group(0) @binding(4) var<uniform> view: View;
@group(0) @binding(5) var<storage, read> probes: array<PlacementProbe>;
@group(0) @binding(6) var<storage, read> accepted: array<PlacementState>;
@group(0) @binding(7) var<storage, read_write> candidate: array<PlacementState>;
@group(0) @binding(8) var<storage, read_write> diagnostics: array<vec4u>;
@group(0) @binding(9) var<uniform> viewRect: vec4u;

fn placementInputStatus(probe: PlacementProbe, old: PlacementState) -> u32 {
  let cell = probe.baseCell.w;
  if (any(probe.key.xy == vec2u(0u)) || any(probe.key.xy != old.key.xy) ||
      probe.key.z > 1u || probe.key.w != 0u || any(old.key.zw != vec2u(0u)) ||
      !all(abs(probe.baseCell.xyz) < vec3f(1e30)) || !(cell > 1e-20 && cell < 1e20) ||
      !all(abs(old.offset.xyz) <= vec3f(0.25 * cell)) || old.offset.w != 0.0) { return 2u; }
  let extent = textureDimensions(depth);
  if (any(textureDimensions(normal) != extent) || any(textureDimensions(identity) != extent) ||
      any(viewRect.xy >= extent) || any(viewRect.zw == vec2u(0u)) ||
      any(viewRect.zw > extent - viewRect.xy) ||
      view.temporalProjection.z != 0.0 ||
      !(view.temporalProjection.x > 0.0 && view.temporalProjection.y > view.temporalProjection.x &&
        view.temporalProjection.y < 1e30)) { return 3u; }
  return 0u;
}

// UE IF mode 1: point-sample the raster, but reconstruct the same continuous UV.
// The lit-Standard roster is qualified by the caller, not inferred from a normal.
fn placementContribution(probe: PlacementProbe, old: PlacementState, lane: u32) -> vec4u {
  if (probe.key.z == 0u) { return vec4u(0u); }
  let center = probe.baseCell.xyz + old.offset.xyz;
  let clip = view.worldViewProj * vec4f(center, 1.0);
  if (!(clip.w > 0.0) || !all(abs(clip) < vec4f(1e30))) { return vec4u(0u); }
  var sampleOffset = (vec2f(f32(lane) / 64.0, f32(reverseBits(lane) >> 16u) / 65536.0) - 0.5) * 16.0;
  if (lane == 0u) { sampleOffset = vec2f(0.0); }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5) + sampleOffset / vec2f(viewRect.zw);
  // Signed conversion intentionally truncates toward zero, matching reviewed mode 1.
  let pixel = vec2i(vec2f(viewRect.xy) + uv * vec2f(viewRect.zw));
  if (any(pixel < vec2i(viewRect.xy)) || any(pixel >= vec2i(viewRect.xy + viewRect.zw))) { return vec4u(0u); }
  let surface = textureLoad(identity, pixel, 0);
  let z = textureLoad(depth, pixel, 0);
  if (!(z > 0.0 && z <= 1.0) || (surface.w != 1u && surface.w != 3u) ||
      surface.x == 0u || surface.x > arrayLength(&records) / 4u) { return vec4u(0u); }
  let elements = records[(surface.x - 1u) * 4u + 2u].z;
  if (elements == 0u || elements % 3u != 0u || surface.y >= elements / 3u) { return vec4u(0u); }
  let homogeneous = view.inverseViewProj * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), z, 1.0);
  let world = homogeneous.xyz / homogeneous.w;
  if (!all(abs(world) < vec3f(1e30))) { return vec4u(0u); }
  let surfaceClip = view.worldViewProj * vec4f(world, 1.0);
  let surfaceDepth = -sceneViewZ(surfaceClip, view.temporalProjection);
  let centerDepth = -sceneViewZ(clip, view.temporalProjection);
  let cell = probe.baseCell.w;
  if (!(surfaceDepth > 0.0 && centerDepth > surfaceDepth - 0.05 * cell)) { return vec4u(0u); }
  let toCamera = view.cameraPos - world;
  if (!(dot(toCamera, toCamera) > 1e-20)) { return vec4u(0u); }
  let ns = decodeStandardNormalRoughness(textureLoad(normal, pixel, 0).x).xyz;
  let ideal = world + (0.2 * ns + 0.8 * normalize(toCamera)) * (0.1875 * cell) - probe.baseCell.xyz;
  if (!all(abs(ideal) < vec3f(0.25 * cell))) { return vec4u(0u); }
  let quantized = vec3u(clamp(round(ideal * (64.0 / cell) + 64.0), vec3f(0.0), vec3f(128.0)));
  return vec4u(quantized, 1u);
}

var<workgroup> sumX: atomic<u32>;
var<workgroup> sumY: atomic<u32>;
var<workgroup> sumZ: atomic<u32>;
var<workgroup> count: atomic<u32>;

@compute @workgroup_size(64) fn placeRasterProbes(
  @builtin(workgroup_id) group: vec3u,
  @builtin(local_invocation_index) lane: u32,
) {
  let index = group.x;
  let probe = probes[index];
  let old = accepted[index];
  if (lane == 0u) {
    atomicStore(&sumX, 0u); atomicStore(&sumY, 0u); atomicStore(&sumZ, 0u); atomicStore(&count, 0u);
  }
  workgroupBarrier();
  let status = placementInputStatus(probe, old);
  if (status == 0u) {
    let contribution = placementContribution(probe, old, lane);
    atomicAdd(&sumX, contribution.x); atomicAdd(&sumY, contribution.y);
    atomicAdd(&sumZ, contribution.z); atomicAdd(&count, contribution.w);
  }
  workgroupBarrier();
  if (lane == 0u) {
    let samples = atomicLoad(&count);
    var next = old;
    if (samples > 0u) {
      let sums = vec3f(f32(atomicLoad(&sumX)), f32(atomicLoad(&sumY)), f32(atomicLoad(&sumZ)));
      next.offset = vec4f((sums / f32(samples) - 64.0) / (64.0 / probe.baseCell.w), 0.0);
    }
    candidate[index] = next;
    diagnostics[index] = vec4u(probe.key.xy, select(status, 1u, samples > 0u), samples);
  }
}
