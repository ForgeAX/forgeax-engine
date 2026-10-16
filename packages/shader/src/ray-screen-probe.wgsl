#define_import_path forgeax_ray::screen_probe
#import forgeax_view::common::{View}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}
#import forgeax_depth_pyramid::sample::{depthPyramidCell, depthPyramidDepthOrEmpty, depthPyramidLevelSize}
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, sampleRadianceCacheAt, irradianceFieldOctTaps}
#ifdef IRRADIANCE_FIELD_VISIBILITY
#import forgeax_ray::irradiance_field_sample::{fieldSegmentVisibility}
#endif

// Screen Probe gather (UE LumenScreenProbeGather). Probes are placed on the
// G-buffer, trace an 8x8 world-space octahedron through the previous frame's
// scene color (HZB) and then the Global SDF/Card world (render owner kernel),
// and are integrated per pixel with the Irradiance Field as world fallback.

// Must match packScreenProbeFrame() in render/raytracing/screen-probe-plan.ts.
struct ScreenProbeFrame {
  // width, height, tilesX, tilesY
  extent: vec4u,
  // uniform probes, adaptive capacity, downsample, frame index
  probes: vec4u,
  // brdf importance, screen steps, history flags (1 scene, 2 pixel, 4 probe), max frames
  control: vec4u,
  // rgb environment radiance, w max trace distance
  environment: vec4f,
  // thickness, short-range AO radius, world origin bias, Card margin
  tuning: vec4f,
  // Global SDF query settings consumed by the world kernel
  query: vec4u,
  // Last accepted view geometry, kept across lighting-only temporal resets;
  // all zero (w included) after a geometric reset, which rejects every pixel.
  previousViewProj: mat4x4f,
  previousCameraPos: vec4f,
}
// pixel == SCREEN_PROBE_NONE marks an empty probe slot.
struct ScreenProbe { position: vec3f, distance: f32, normal: vec3f, pixel: u32 }
// One directional transport record: RGB/support (history uses w for age),
// plus the closest resolved endpoint. Negative distance means cache-only or
// unavailable transport. The 32-byte stride includes WGSL alignment padding.
struct ProbeRadiance { value: vec4f, hitDistance: f32 }
struct ProbeHistory { probe: ScreenProbe, radiance: array<ProbeRadiance, 64> }
// info: texel (6) | sub (2) << 6 | refined << 8 | used << 9 | status << 12
// hitDistance uses the existing trailing 4-byte padding: the ray stays 32 bytes.
// Negative means no resolved distance; zero is a supported immediate blocker.
struct ProbeRay { direction: vec3f, info: u32, radiance: vec3f, hitDistance: f32 }

const SCREEN_PROBE_NONE = 0xffffffffu;
const STATUS_RESOLVED = 0u;
const STATUS_WORLD = 1u;
const STATUS_FALLBACK = 2u;
const STATUS_CULLED = 3u;
const STATUS_INCOMPLETE = 4u;
// Scratch support: -1 missing scene, 0 missing radiance, 1 complete transport.
// Missing scene propagates to the pixel; it cannot request another cache fallback.
const SUPPORT_INCOMPLETE = -1.0;
const RAY_USED = 512u;
const RAY_REFINED = 256u;

// Unique group-0 bindings; each pipeline layout names only its entry's roster.
@group(0) @binding(0) var<uniform> probeFrame: ScreenProbeFrame;
@group(0) @binding(1) var<uniform> view: View;
@group(0) @binding(2) var gbufferDepth: texture_depth_2d;
@group(0) @binding(3) var gbufferNormal: texture_2d<u32>;
@group(0) @binding(4) var depthPyramid: texture_2d<f32>;
@group(0) @binding(5) var sceneColor: texture_2d<f32>;
@group(0) @binding(6) var<storage, read_write> probes: array<ScreenProbe>;
@group(0) @binding(7) var<storage, read> probesIn: array<ScreenProbe>;
@group(0) @binding(8) var<storage, read_write> adaptiveCount: array<atomic<u32>>;
@group(0) @binding(9) var<storage, read> adaptiveCountIn: array<u32>;
@group(0) @binding(10) var<storage, read_write> tileAdaptive: array<u32>;
@group(0) @binding(11) var<storage, read> tileAdaptiveIn: array<u32>;
@group(0) @binding(12) var<storage, read_write> rays: array<ProbeRay>;
@group(0) @binding(13) var<storage, read> raysIn: array<ProbeRay>;
@group(0) @binding(14) var<storage, read> previousScene: array<vec2u>;
@group(0) @binding(15) var<storage, read_write> previousSceneOut: array<vec2u>;
@group(0) @binding(16) var<storage, read> radianceIn: array<ProbeRadiance>;
// w is directional support, including an admitted retained cache estimate.
// Ray status still distinguishes actual resolved rays from cache reconstruction.
@group(0) @binding(17) var<storage, read_write> radianceOut: array<ProbeRadiance>;
@group(0) @binding(19) var<storage, read> filteredProbeRadiance: array<ProbeRadiance>;
@group(0) @binding(20) var<storage, read_write> integratedOut: array<vec4f>;
@group(0) @binding(21) var<storage, read> integrated: array<vec4f>;
@group(0) @binding(22) var<storage, read> historyIn: array<vec4f>;
@group(0) @binding(23) var<storage, read_write> historyOut: array<vec4f>;
@group(0) @binding(24) var<storage, read> metaIn: array<vec4u>;
@group(0) @binding(25) var<storage, read_write> metaOut: array<vec4u>;
@group(0) @binding(26) var<storage, read> probeHistoryIn: array<ProbeHistory>;
@group(0) @binding(27) var<storage, read_write> probeHistoryOut: array<ProbeHistory>;

fn spLinearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }
fn spGroupId(wid: vec3u, groups: vec3u) -> u32 { return wid.x + wid.y * groups.x; }

fn spHash(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}
fn spUnit(x: u32) -> f32 { return f32(spHash(x) >> 8u) / 16777216.0; }

fn spOctEncode(direction: vec3f) -> vec2f {
  let n = direction / (abs(direction.x) + abs(direction.y) + abs(direction.z));
  if (n.z >= 0.0) { return n.xy; }
  return (vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0));
}
fn spOctDecode(p: vec2f) -> vec3f {
  var n = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (n.z < 0.0) {
    n = vec3f((vec2f(1.0) - abs(n.yx)) * select(vec2f(-1.0), vec2f(1.0), n.xy >= vec2f(0.0)), n.z);
  }
  return normalize(n);
}
// Center direction of an 8x8 world-space octahedral texel.
fn texelDirection(texel: u32) -> vec3f {
  let xy = (vec2f(f32(texel % 8u), f32(texel / 8u)) + vec2f(0.5)) / 8.0;
  return spOctDecode(xy * 2.0 - vec2f(1.0));
}

fn extentSize() -> vec2u { return probeFrame.extent.xy; }
fn pixelIndex(pixel: vec2u) -> u32 { return pixel.y * probeFrame.extent.x + pixel.x; }
fn packPixel(pixel: vec2u) -> u32 { return pixel.x | (pixel.y << 16u); }
fn unpackPixel(packed: u32) -> vec2u { return vec2u(packed & 0xffffu, packed >> 16u); }
fn validDepth(z: f32) -> bool { return z > 0.0 && z < 1.0; }
fn gbufferMatches() -> bool { return all(textureDimensions(gbufferDepth) == extentSize()); }

fn worldPosition(pixel: vec2u, z: f32) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(extentSize());
  let p = view.inverseViewProj * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), z, 1.0);
  return p.xyz / p.w;
}

fn emptyProbe() -> ScreenProbe { return ScreenProbe(vec3f(0.0), 0.0, vec3f(0.0, 0.0, 1.0), SCREEN_PROBE_NONE); }

fn probeAt(pixel: vec2u) -> ScreenProbe {
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return emptyProbe(); }
  let position = worldPosition(pixel, z);
  let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  return ScreenProbe(position, length(view.cameraPos - position), normal, packPixel(pixel));
}

fn tileCount() -> vec2u { return probeFrame.extent.zw; }

// All tiles share one Hammersley offset. The interpolation lattice and its
// previous-frame projection use the same placement phase, not nominal centers.
fn probeSequence(frameIndex: u32) -> vec2f {
  let phase = frameIndex % 8u;
  let reversed = ((phase & 1u) << 2u) | (phase & 2u) | ((phase & 4u) >> 2u);
  return vec2f(f32(phase), f32(reversed)) * 0.125;
}
fn uniformProbeJitter(frameIndex: u32) -> vec2u {
  return vec2u(probeSequence(frameIndex) * f32(probeFrame.probes.z));
}
// Anchor the outermost samples to pixel centers at the viewport edges.
// Interior tiles retain their shared jitter; invert the two boundary intervals
// explicitly so nominal weights also follow placement on incompatible geometry.
fn uniformProbeAxis(pixel: f32, jitter: u32, extent: u32, tiles: u32) -> f32 {
  if (tiles == 1u) { return 0.0; }
  if (tiles == 2u) { return clamp((pixel - 0.5) / f32(extent - 1u), 0.0, 1.0); }
  let ds = f32(probeFrame.probes.z);
  let interior = (pixel - f32(jitter) - 0.5) / ds;
  if (interior < 1.0) {
    return clamp((pixel - 0.5) / (ds + f32(jitter)), 0.0, 1.0);
  }
  let lastInterior = f32(tiles - 2u);
  if (interior > lastInterior) {
    let start = lastInterior * ds + f32(jitter);
    return lastInterior + clamp((pixel - 0.5 - start) / (f32(extent - 1u) - start), 0.0, 1.0);
  }
  return interior;
}
fn uniformProbeGrid(pixel: vec2f, frameIndex: u32) -> vec2f {
  let jitter = uniformProbeJitter(frameIndex);
  let extent = extentSize();
  let tiles = tileCount();
  return vec2f(uniformProbeAxis(pixel.x, jitter.x, extent.x, tiles.x),
    uniformProbeAxis(pixel.y, jitter.y, extent.y, tiles.y));
}

// Plane and normal agreement between a probe and a receiver (UE
// ScreenProbeInterpolation depth/normal weights). Relative to view distance.
fn probeAgreement(probe: ScreenProbe, position: vec3f, normal: vec3f, distance: f32) -> f32 {
  if (probe.pixel == SCREEN_PROBE_NONE) { return 0.0; }
  let plane = abs(dot(probe.position - position, normal)) / max(0.03 * distance, 1e-4);
  let facing = max(dot(probe.normal, normal), 0.0);
  return exp(-plane * plane) * facing * facing * facing * facing;
}

// Coplanar surfaces can belong to separate rooms. Geometry agreement alone
// cannot admit transport between them: check the shared live scene projection
// from normal-biased endpoints, preserving unavailable coverage as rejection.
fn probeVisibility(probe: ScreenProbe, position: vec3f, normal: vec3f) -> f32 {
#ifdef IRRADIANCE_FIELD_VISIBILITY
  return fieldSegmentVisibility(position + normal * probeFrame.tuning.z,
    probe.position + probe.normal * probeFrame.tuning.z);
#else
  return 1.0;
#endif
}

struct UniformTaps { probes: vec4u, weights: vec4f }

// Invert the actual four placed positions; a nominal tile only selects taps.
// Incompatible or degenerate geometry keeps the existing covered weights.
fn probeInterpolationWeights(position: vec3f, fraction: vec2f,
    source: ptr<function, array<ScreenProbe, 4>>, agreement: vec4f) -> vec4f {
  let nominal = vec4f((1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y), (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y);
  if (any(agreement < vec4f(0.05))) { return nominal; }
  let p0 = (*source)[0].position;
  let a = (*source)[1].position - p0;
  let b = (*source)[2].position - p0;
  let c = (*source)[3].position - p0 - a - b;
  let tiles = tileCount();
  if (tiles.y == 1u || tiles.x == 1u) {
    let edge = select(a, b, tiles.x == 1u);
    let square = dot(edge, edge);
    if (square < 1e-8) { return nominal; }
    let value = clamp(dot(position - p0, edge) / square, 0.0, 1.0);
    return select(vec4f(1.0 - value, value, 0.0, 0.0),
      vec4f(1.0 - value, 0.0, value, 0.0), tiles.x == 1u);
  }
  var uv = fraction;
  let scale = max(dot(a, a) + dot(b, b), 1e-8);
  for (var iteration = 0u; iteration < 6u; iteration++) {
    let residual = position - (p0 + a * uv.x + b * uv.y + c * uv.x * uv.y);
    if (dot(residual, residual) <= 1e-10 * scale) { break; }
    let x = a + c * uv.y; let y = b + c * uv.x;
    let xx = dot(x, x); let xy = dot(x, y); let yy = dot(y, y);
    let determinant = xx * yy - xy * xy;
    if (determinant <= 1e-6 * xx * yy) { return nominal; }
    let xr = dot(x, residual); let yr = dot(y, residual);
    uv = clamp(uv + vec2f(yy * xr - xy * yr, xx * yr - xy * xr) / determinant,
      vec2f(0.0), vec2f(1.0));
  }
  let residual = position - (p0 + a * uv.x + b * uv.y + c * uv.x * uv.y);
  if (dot(residual, residual) > 1e-8 * scale) { return nominal; }
  return vec4f((1.0 - uv.x) * (1.0 - uv.y), uv.x * (1.0 - uv.y),
    (1.0 - uv.x) * uv.y, uv.x * uv.y);
}

// Bilinear uniform probes around a pixel; empty taps carry zero weight.
fn uniformTaps(pixel: vec2u, position: vec3f, normal: vec3f, distance: f32,
    source: ptr<function, array<ScreenProbe, 4>>) -> UniformTaps {
  let tiles = tileCount();
  let g = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  let f = g - vec2f(base);
  var out = UniformTaps(vec4u(SCREEN_PROBE_NONE), vec4f(0.0));
  var agreement = vec4f(0.0);
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let tile = min(base + offset, tiles - vec2u(1u));
    let index = tile.y * tiles.x + tile.x;
    out.probes[tap] = index;
    agreement[tap] = probeAgreement((*source)[tap], position, normal, distance);
  }
  out.weights = probeInterpolationWeights(position, f, source, agreement) * agreement;
  return out;
}

// One thread per uniform tile; it also empties the matching adaptive slot so
// stale adaptive probes from the previous frame never reach later stages.
@compute @workgroup_size(64) fn placeUniformProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let uniformCount = probeFrame.probes.x;
  if (i == 0u) { atomicStore(&adaptiveCount[0], 0u); }
  if (i >= uniformCount) { return; }
  if (i < probeFrame.probes.y) { probes[uniformCount + i] = emptyProbe(); }
  for (var s = 0u; s < 4u; s++) { tileAdaptive[i * 4u + s] = SCREEN_PROBE_NONE; }
  probes[i] = emptyProbe();
  if (!gbufferMatches()) { return; }
  let tiles = tileCount();
  let ds = probeFrame.probes.z;
  let tile = vec2u(i % tiles.x, i / tiles.x);
  let extent = extentSize();
  let jitter = uniformProbeJitter(probeFrame.probes.w);
  var sample = min(tile * ds + jitter, extent - vec2u(1u));
  sample = select(sample, vec2u(0u), (tile == vec2u(0u)) & (tiles > vec2u(1u)));
  sample = select(sample, extent - vec2u(1u), (tile == tiles - vec2u(1u)) & (tiles > vec2u(1u)));
  let candidates = array<vec2u, 2>(sample, tile * ds + vec2u(ds / 2u));
  for (var c = 0u; c < 2u; c++) {
    let pixel = min(candidates[c], extent - vec2u(1u));
    let probe = probeAt(pixel);
    if (probe.pixel != SCREEN_PROBE_NONE) { probes[i] = probe; return; }
  }
}

// Eligibility is independent of allocation. tileAdaptive holds one candidate
// flag per half-tile until compaction replaces it with the final probe index.
fn adaptivePixel(i: u32) -> vec2u {
  let sub = vec2u(i % (tileCount().x * 2u), i / (tileCount().x * 2u));
  let ds = probeFrame.probes.z;
  return min(sub * (ds / 2u) + vec2u(ds / 4u), extentSize() - vec2u(1u));
}
fn adaptiveTileSlot(i: u32) -> u32 {
  let sub = vec2u(i % (tileCount().x * 2u), i / (tileCount().x * 2u));
  let tile = sub / 2u;
  return (tile.y * tileCount().x + tile.x) * 4u + (sub.x & 1u) + ((sub.y & 1u) << 1u);
}
fn adaptiveEligible(i: u32) -> bool {
  if (i >= probeFrame.probes.x * 4u || probeFrame.probes.y == 0u || !gbufferMatches()) { return false; }
  let pixel = adaptivePixel(i);
  let candidate = probeAt(pixel);
  if (candidate.pixel == SCREEN_PROBE_NONE) { return false; }
  let tiles = tileCount();
  var source: array<ScreenProbe, 4>;
  let g = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    source[tap] = probes[tile.y * tiles.x + tile.x];
  }
  let taps = uniformTaps(pixel, candidate.position, candidate.normal, candidate.distance, &source);
  return dot(taps.weights, vec4f(1.0)) < 0.25;
}
var<workgroup> adaptivePrefix: array<u32, 64>;
var<workgroup> adaptiveBase: u32;

@compute @workgroup_size(64) fn placeAdaptiveProbes(@builtin(workgroup_id) wid: vec3u,
    @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
  let group = spGroupId(wid, groups);
  let i = group * 64u + lane;
  let eligible = select(0u, 1u, adaptiveEligible(i));
  adaptivePrefix[lane] = eligible;
  if (i < probeFrame.probes.x * 4u) { tileAdaptive[adaptiveTileSlot(i)] = eligible; }
  workgroupBarrier();
  if (lane == 0u && group < (probeFrame.probes.x * 4u + 63u) / 64u) {
    var count = 0u;
    for (var j = 0u; j < 64u; j++) { count += adaptivePrefix[j]; }
    atomicStore(&adaptiveCount[group + 1u], count);
    atomicAdd(&adaptiveCount[0], count);
  }
}

// Row-major receiver order determines both physical slots and admission when
// capacity is exhausted. Workgroup scheduling never selects a different tail.
@compute @workgroup_size(64) fn compactAdaptiveProbes(@builtin(workgroup_id) wid: vec3u,
    @builtin(num_workgroups) groups: vec3u, @builtin(local_invocation_index) lane: u32) {
  let group = spGroupId(wid, groups);
  let i = group * 64u + lane;
  var eligible = 0u;
  if (i < probeFrame.probes.x * 4u) { eligible = tileAdaptive[adaptiveTileSlot(i)]; }
  adaptivePrefix[lane] = eligible;
  workgroupBarrier();
  if (lane == 0u) {
    var base = 0u;
    for (var g = 0u; g < min(group, (probeFrame.probes.x * 4u + 63u) / 64u); g++) {
      base += atomicLoad(&adaptiveCount[g + 1u]);
    }
    adaptiveBase = base;
    var prefix = 0u;
    for (var j = 0u; j < 64u; j++) {
      let flag = adaptivePrefix[j];
      adaptivePrefix[j] = prefix;
      prefix += flag;
    }
  }
  workgroupBarrier();
  if (i >= probeFrame.probes.x * 4u) { return; }
  let slot = adaptiveTileSlot(i);
  tileAdaptive[slot] = SCREEN_PROBE_NONE;
  let ordinal = adaptiveBase + adaptivePrefix[lane];
  if (eligible == 0u || ordinal >= probeFrame.probes.y) { return; }
  let probe = probeFrame.probes.x + ordinal;
  probes[probe] = probeAt(adaptivePixel(i));
  tileAdaptive[slot] = probe;
}

fn probeLive(probe: u32) -> bool {
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return false; }
  if (probe >= probeFrame.probes.x && probe - probeFrame.probes.x >= adaptiveCountIn[0]) { return false; }
  return probesIn[probe].pixel != SCREEN_PROBE_NONE;
}

var<workgroup> texelPdf: array<f32, 64>;
var<workgroup> texelSlots: array<u32, 64>;

// One workgroup per probe. BRDF/light importance (UE ScreenProbeImportanceSampling):
// all positive-cosine texels around the probe normal retain a ray; the unused
// back-facing budget refines the highest estimated contribution into 2x2 sub-rays.
@compute @workgroup_size(64) fn generateProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let live = probeLive(probe);
  let record = probesIn[probe];
  let brdf = probeFrame.control.x != 0u;
  let pdf = select(1.0, max(dot(record.normal, texelDirection(texel)), 0.0), brdf);
  var priority = pdf;
  if (live && brdf && pdf > 0.0) {
    let cached = sampleRadianceCacheAt(record.position, record.normal, vec3f(0.0), texelDirection(texel), 0.25);
    if (cached.w > 0.0) {
      priority = pdf * max(dot(cached.xyz, vec3f(0.2126, 0.7152, 0.0722)), 0.0);
    }
  }
  // Cached light only guides refinement. Even known black retains the
  // positive-cosine base ray; missing coverage keeps the original BRDF rank.
  texelPdf[texel] = select(-1.0, priority, !brdf || pdf > 0.0);
  workgroupBarrier();
  var culled = 0u;
  var rank = 0u;
  for (var t = 0u; t < 64u; t++) {
    let other = texelPdf[t];
    if (other < 0.0) { culled++; continue; }
    if (other > texelPdf[texel] || (other == texelPdf[texel] && t < texel)) { rank++; }
  }
  let mine = texelPdf[texel];
  let refined = mine >= 0.0 && rank < culled / 3u;
  texelSlots[texel] = select(select(1u, 4u, refined), 0u, mine < 0.0);
  workgroupBarrier();
  var first = 0u;
  for (var t = 0u; t < texel; t++) { first += texelSlots[t]; }
  var used = 0u;
  for (var t = 0u; t < 64u; t++) { used += texelSlots[t]; }
  let base = probe * 64u;
  // A uniform tile keeps its angular sequence while its placed pixel jitters.
  // Adaptive compaction instead follows the receiver pixel, never its slot.
  // A fixed random rotation preserves all eight strata of the shared sequence.
  let seed = spHash(select(probe, record.pixel, probe >= probeFrame.probes.x));
  let jitter = fract(probeSequence(probeFrame.probes.w) + vec2f(spUnit(seed), spUnit(seed ^ 0x9e3779b9u)));
  let count = texelSlots[texel];
  for (var s = 0u; s < count; s++) {
    var xy = vec2f(f32(texel % 8u), f32(texel / 8u));
    var size = 8.0;
    if (refined) { xy = xy * 2.0 + vec2f(f32(s & 1u), f32(s >> 1u)); size = 16.0; }
    let direction = spOctDecode((xy + jitter) / size * 2.0 - vec2f(1.0));
    let status = select(STATUS_CULLED, STATUS_WORLD, live);
    let info = texel | (s << 6u) | select(0u, RAY_REFINED, refined) | RAY_USED | (status << 12u);
    rays[base + first + s] = ProbeRay(direction, info, vec3f(0.0), -1.0);
  }
  // Unassigned tail slots (at most two) stay inert.
  if (texel >= used) { rays[base + texel] = ProbeRay(vec3f(0.0, 0.0, 1.0), STATUS_CULLED << 12u, vec3f(0.0), -1.0); }
}

fn rayStatus(info: u32) -> u32 { return (info >> 12u) & 7u; }
fn withStatus(info: u32, status: u32) -> u32 { return (info & ~(7u << 12u)) | (status << 12u); }

fn traceViewDistance(clip: vec4f) -> f32 {
  return select(clip.w,
    view.temporalProjection.y - (clip.z / clip.w) * (view.temporalProjection.y - view.temporalProjection.x),
    view.temporalProjection.z > 0.5);
}

fn previousRadiance(position: vec3f) -> vec4f {
  let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
  if (!(clip.w > 0.0)) { return vec4f(0.0); }
  let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return vec4f(0.0); }
  let pixel = min(vec2u(uv * vec2f(extentSize())), extentSize() - vec2u(1u));
  let packed = previousScene[pixelIndex(pixel)];
  let rg = unpack2x16float(packed.x);
  let ba = unpack2x16float(packed.y);
  return vec4f(rg, ba.x, ba.y);
}

// One thread per ray: closest-depth HZB march through the previous frame's
// scene color (UE ScreenProbeTraceScreenTexture). Misses and unresolved rays
// keep status WORLD. Raster-empty space cannot certify world visibility: a thin
// or edge-on occluder may have no depth sample, so the world ray starts at its
// original receiver even when the screen march advanced through empty cells.
@compute @workgroup_size(64) fn traceScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  if (i >= (probeFrame.probes.x + probeFrame.probes.y) * 64u) { return; }
  var ray = rays[i];
  if (rayStatus(ray.info) != STATUS_WORLD) { return; }
  let steps = probeFrame.control.y;
  if (steps == 0u || (probeFrame.control.z & 1u) == 0u || !gbufferMatches()) { return; }
  let probe = probesIn[i / 64u];
  let extent = vec2f(extentSize());
  let origin = probe.position + probe.normal * probeFrame.tuning.z;
  let d = ray.direction;
  var tMax = probeFrame.environment.w;
  let c0 = view.worldViewProj * vec4f(origin, 1.0);
  let dc = view.worldViewProj * vec4f(d, 0.0);
  // Keep the segment in front of the near plane.
  let near = view.temporalProjection.x;
  if (view.temporalProjection.z < 0.5 && dc.w < 0.0) {
    tMax = min(tMax, max((c0.w - 1.5 * near) / -dc.w, 0.0));
  }
  if (!(c0.w > 0.0) || tMax <= 0.0) { return; }
  let c1 = c0 + dc * tMax;
  let uv0 = c0.xy / c0.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let uv1 = c1.xy / c1.w * vec2f(0.5, -0.5) + vec2f(0.5);
  let delta = uv1 - uv0;
  let pixels = length(delta * extent);
  if (pixels < 1.0) { return; }
  let w0 = traceViewDistance(c0);
  let w1 = traceViewDistance(c1);
  let perspective = view.temporalProjection.z < 0.5;
  let thickness = probeFrame.tuning.x;
  let maxLevel = textureNumLevels(depthPyramid) - 1u;
  var u = 1.0 / pixels;
  var level = 0u;
  for (var step = 0u; step < steps; step++) {
    if (u >= 1.0) { break; }
    let uv = uv0 + delta * u;
    if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { break; }
    let size = depthPyramidLevelSize(depthPyramid, level);
    let cell = depthPyramidCell(uv, size);
    // Parameter where the ray leaves this cell; the epsilon lands in the next one.
    var exitU = 1.0;
    for (var axis = 0u; axis < 2u; axis++) {
      if (abs(delta[axis]) > 1e-8) {
        let edge = (f32(cell[axis]) + select(0.0, 1.0, delta[axis] > 0.0)) / f32(size[axis]);
        exitU = min(exitU, (edge - uv0[axis]) / delta[axis]);
      }
    }
    exitU = min(max(exitU, u) + 0.25 / pixels, 1.0);
    let distanceAt = select(mix(w0, w1, u), 1.0 / mix(1.0 / w0, 1.0 / w1, u), perspective);
    let distanceExit = select(mix(w0, w1, exitU), 1.0 / mix(1.0 / w0, 1.0 / w1, exitU), perspective);
    let rayNear = min(distanceAt, distanceExit);
    let rayFar = max(distanceAt, distanceExit);
    let scene = depthPyramidDepthOrEmpty(textureLoad(depthPyramid, vec2i(cell), i32(level)).r);
    // Free only if the whole segment is in front of the cell's closest depth.
    if (rayFar < scene) {
      u = exitU;
      level = min(level + 1u, maxLevel);
      continue;
    }
    if (level > 0u) { level--; continue; }
    if (rayNear <= scene * (1.0 + thickness)) {
      let pixel = min(vec2u(uv * extent), extentSize() - vec2u(1u));
      let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
      let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
      if (validDepth(z) && dot(normal, d) < 0.0) {
        let hitPosition = worldPosition(pixel, z);
#ifdef IRRADIANCE_FIELD_VISIBILITY
        // HZB coverage can omit an edge-on wall. A screen hit may reuse color
        // only after the existing live scene projection certifies its segment.
        // Occlusion or unavailable coverage leaves the original WORLD ray intact.
        if (fieldSegmentVisibility(origin, hitPosition + normal * probeFrame.tuning.z) < 1.0) { break; }
#endif
        let radiance = previousRadiance(hitPosition);
        if (radiance.w > 0.0) {
          ray.radiance = radiance.xyz;
          ray.hitDistance = length(hitPosition - probe.position);
          ray.info = withStatus(ray.info, STATUS_RESOLVED);
          rays[i] = ray;
          return;
        }
      }
      break;
    }
    // Behind a surface the depth buffer proves nothing further: a later hit may
    // lie beyond a thin occluder (UE bUncertain), so the world ray takes over
    // from the original receiver.
    break;
  }
}

// One workgroup per probe, one thread per texel: average the texel's rays.
// Culled or unresolved texels sample the world radiance cache along the texel's
// direction; an 8x8 octahedral texel subtends the cache's finest (0.25 rad) cone.
@compute @workgroup_size(64) fn resolveProbeRays(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  if (!probeLive(probe)) { radianceOut[index] = ProbeRadiance(vec4f(0.0), -1.0); return; }
  var sum = vec3f(0.0);
  var count = 0.0;
  var incomplete = false;
  var hitDistance = -1.0;
  for (var r = 0u; r < 64u; r++) {
    let ray = raysIn[probe * 64u + r];
    if ((ray.info & RAY_USED) == 0u || (ray.info & 63u) != texel) { continue; }
    if (rayStatus(ray.info) == STATUS_INCOMPLETE) { incomplete = true; }
    if (rayStatus(ray.info) != STATUS_RESOLVED) { continue; }
    sum += ray.radiance;
    count += 1.0;
    if (ray.hitDistance >= 0.0 && (hitDistance < 0.0 || ray.hitDistance < hitDistance)) { hitDistance = ray.hitDistance; }
  }
  if (incomplete) { radianceOut[index] = ProbeRadiance(vec4f(0.0, 0.0, 0.0, SUPPORT_INCOMPLETE), -1.0); return; }
  if (count > 0.0) {
    radianceOut[index] = ProbeRadiance(vec4f(sum / count, 1.0), hitDistance);
    return;
  }
  // This cache receiver is a surface, even when the unresolved ray is tangent.
  // Keep the receiver bias and side test on its normal instead of moving the
  // query along the radiance direction through a nearby thin wall.
  let receiver = probesIn[probe];
  let fallback = sampleRadianceCacheAt(receiver.position, receiver.normal, vec3f(0.0), texelDirection(texel), 0.25);
  radianceOut[index] = ProbeRadiance(fallback, -1.0);
}

// Cascaded EMA mean age is the sum of each stage's (cap - 1).
// Share the author's reconstruction budget instead of doubling its response
// delay when both histories are active. A single active lane keeps the full cap.
fn probeHistoryCap() -> u32 {
  let cap = probeFrame.control.w;
  return select(cap, max(1u, cap / 2u), (probeFrame.control.z & 2u) != 0u);
}
fn pixelHistoryCap() -> u32 {
  let cap = probeFrame.control.w;
  return select(cap, cap - max(1u, cap / 2u) + 1u, (probeFrame.control.z & 4u) != 0u);
}

// Same-direction transport at a different receiver describes a shifted hit.
// Both spatial filtering and temporal reuse use the current/old closest known
// endpoint and the equivalent circular cone of the octahedral texel. Unknown
// endpoints preserve the existing geometric admission; zero is a real blocker.
fn probeParallaxWeight(deltaPosition: vec3f, texel: u32, currentDistance: f32, sourceDistance: f32) -> f32 {
  var distance = currentDistance;
  if (distance < 0.0 || (sourceDistance >= 0.0 && sourceDistance < distance)) { distance = sourceDistance; }
  if (distance < 0.0) { return 1.0; }
  let direction = texelDirection(texel);
  let delta = deltaPosition + direction * distance;
  let separation = length(delta);
  let angle = select(0.0, acos(clamp(dot(delta, direction) / max(separation, 1e-20), -1.0, 1.0)), separation > 1e-20);
  let cone = acos(clamp(1.0 - (0.0625 * octTexelSolidAngle(texel)) / 6.28318530718, -1.0, 1.0));
  return 1.0 - clamp(angle / cone, 0.0, 1.0);
}

var<workgroup> historyProbeIndices: array<u32, 4>;
var<workgroup> historyProbeWeights: array<f32, 4>;

// Retain resolved radiance before spatial filtering and cosine convolution.
// Reprojection follows geometry rather than adaptive slot identity. Only the
// previous uniform lattice supplies history; current adaptive receivers use
// the same covered plane/normal support. Missing current transport stays missing.
@compute @workgroup_size(64) fn temporalProbeRadiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  let record = probesIn[probe];
  if (texel == 0u) { probeHistoryOut[probe].probe = record; }
  // Geometry and scene visibility are independent of radiance direction.
  // One invocation derives the four actual-position weights for all 64 texels.
  if (texel == 0u) {
    for (var tap = 0u; tap < 4u; tap++) {
      historyProbeIndices[tap] = SCREEN_PROBE_NONE;
      historyProbeWeights[tap] = 0.0;
    }
    if (record.pixel != SCREEN_PROBE_NONE && record.distance > 0.0 &&
        (probeFrame.control.z & 4u) != 0u && probeHistoryCap() > 1u &&
        probeFrame.previousCameraPos.w > 0.0) {
      let clip = probeFrame.previousViewProj * vec4f(record.position, 1.0);
      if (clip.w > 0.0) {
        let uv = clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
        if (all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
          let tiles = tileCount();
          let g = uniformProbeGrid(uv * vec2f(extentSize()), (probeFrame.probes.w % 8u + 7u) % 8u);
          let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
          var source: array<ScreenProbe, 4>;
          var indices = vec4u(0u);
          var agreement = vec4f(0.0);
          for (var tap = 0u; tap < 4u; tap++) {
            let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
            indices[tap] = tile.y * tiles.x + tile.x;
            source[tap] = probeHistoryIn[indices[tap]].probe;
            agreement[tap] = probeAgreement(source[tap], record.position, record.normal, record.distance);
          }
          let weights = probeInterpolationWeights(record.position, g - vec2f(base), &source, agreement) * agreement;
          for (var tap = 0u; tap < 4u; tap++) {
            if (weights[tap] >= 1e-4 && source[tap].distance > 0.0 &&
                probeVisibility(source[tap], record.position, record.normal) == 1.0) {
              historyProbeIndices[tap] = indices[tap];
              historyProbeWeights[tap] = weights[tap];
            }
          }
        }
      }
    }
  }
  workgroupBarrier();
  let currentRecord = radianceIn[index];
  let current = currentRecord.value;
  if (record.pixel == SCREEN_PROBE_NONE || record.distance <= 0.0 || current.w != 1.0) {
    radianceOut[index] = currentRecord;
    probeHistoryOut[probe].radiance[texel] = ProbeRadiance(vec4f(0.0), -1.0);
    return;
  }
  var sum = vec3f(0.0);
  var total = 0.0;
  var geometricSupport = 0.0;
  var youngest = f32(probeHistoryCap());
  for (var tap = 0u; tap < 4u; tap++) {
    var weight = historyProbeWeights[tap];
    if (weight == 0.0) { continue; }
    let sourceProbe = probeHistoryIn[historyProbeIndices[tap]].probe;
    let retained = probeHistoryIn[historyProbeIndices[tap]].radiance[texel];
    let value = retained.value;
    if (value.w <= 0.0) { continue; }
    geometricSupport += weight;
    weight *= probeParallaxWeight(sourceProbe.position - record.position, texel,
      currentRecord.hitDistance, retained.hitDistance);
    if (weight <= 0.0) { continue; }
    sum += value.xyz * weight;
    total += weight;
    youngest = min(youngest, value.w);
  }
  var age = 1.0;
  var radiance = current.xyz;
  if (total > 0.0) {
    // RGB normalization must not promote a tiny surviving footprint to a
    // full history sample count. Reuse only the supported fraction of the
    // youngest history; the current resolved sample always contributes one.
    let overlap = clamp(total / geometricSupport, 0.0, 1.0);
    age = min(youngest * overlap + 1.0, f32(probeHistoryCap()));
    radiance = mix(sum / total, current.xyz, 1.0 / age);
  }
  radianceOut[index] = ProbeRadiance(vec4f(radiance, current.w), currentRecord.hitDistance);
  probeHistoryOut[probe].radiance[texel] = ProbeRadiance(vec4f(radiance, age), currentRecord.hitDistance);
}

// Visibility and plane/normal agreement belong to a probe pair, independent
// of its 64 radiance directions. Eight lanes evaluate the complete adjacent
// tile neighborhood once, including corners;
// every lane still admits only its own supported current/neighbor radiance.
var<workgroup> filterProbeIndices: array<u32, 8>;
var<workgroup> filterProbeWeights: array<f32, 8>;

@compute @workgroup_size(64) fn filterProbeRadiance(@builtin(workgroup_id) wid: vec3u,
    @builtin(local_invocation_index) texel: u32, @builtin(num_workgroups) groups: vec3u) {
  let probe = spGroupId(wid, groups);
  if (probe >= probeFrame.probes.x + probeFrame.probes.y) { return; }
  let index = probe * 64u + texel;
  if (texel < 8u) {
    filterProbeIndices[texel] = SCREEN_PROBE_NONE;
    filterProbeWeights[texel] = 0.0;
    if (probe < probeFrame.probes.x && probeLive(probe)) {
      let record = probesIn[probe];
      let tiles = tileCount();
      let tile = vec2i(vec2u(probe % tiles.x, probe / tiles.x));
      let offsets = array<vec2i, 8>(
        vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1),
        vec2i(1, 1), vec2i(1, -1), vec2i(-1, 1), vec2i(-1, -1));
      let other = tile + offsets[texel];
      if (all(other >= vec2i(0)) && all(other < vec2i(tiles))) {
        let neighbor = u32(other.y) * tiles.x + u32(other.x);
        if (probeLive(neighbor)) {
          let weight = probeAgreement(probesIn[neighbor], record.position, record.normal, record.distance);
          if (weight >= 0.05 && probeVisibility(probesIn[neighbor], record.position, record.normal) == 1.0) {
            filterProbeIndices[texel] = neighbor;
            filterProbeWeights[texel] = weight;
          }
        }
      }
    }
  }
  workgroupBarrier();
  let centerRecord = radianceIn[index];
  let center = centerRecord.value;
  if (probe >= probeFrame.probes.x || !probeLive(probe) || center.w != 1.0) { radianceOut[index] = centerRecord; return; }
  var sum = center.xyz;
  var total = 1.0;
  for (var k = 0u; k < 8u; k++) {
    var weight = filterProbeWeights[k];
    if (weight == 0.0) { continue; }
    let neighbor = radianceIn[filterProbeIndices[k] * 64u + texel];
    let value = neighbor.value;
    if (value.w != 1.0) { continue; }
    weight *= probeParallaxWeight(probesIn[filterProbeIndices[k]].position - probesIn[probe].position,
      texel, centerRecord.hitDistance, neighbor.hitDistance);
    sum += value.xyz * weight;
    total += weight;
  }
  radianceOut[index] = ProbeRadiance(vec4f(sum / total, center.w), centerRecord.hitDistance);
}

// Octahedral texels are not equal-area: solid angle is proportional to
// 1 / |v|^3 at the (folded, unnormalized) octahedron point, so texels around
// the poles cover up to 2.8x less than texels at the equator.
fn octTexelSolidAngle(texel: u32) -> f32 {
  let p = (vec2f(f32(texel % 8u), f32(texel / 8u)) + vec2f(0.5)) / 4.0 - vec2f(1.0);
  var v = vec3f(p, 1.0 - abs(p.x) - abs(p.y));
  if (v.z < 0.0) { v = vec3f((vec2f(1.0) - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), v.z); }
  let r = length(v);
  return 1.0 / (r * r * r);
}

// D(n) = E/pi at the actual receiver direction. Angular interpolation of
// preconvolved normal bins needs directions outside this cosine lobe and can
// reject a completely supported query. Only positive-cosine texels own support.
fn probeIrradianceAt(probe: u32, direction: vec3f) -> vec4f {
  var sum = vec3f(0.0);
  var total = 0.0;
  var support = 1.0;
  for (var texel = 0u; texel < 64u; texel++) {
    let weight = max(dot(direction, texelDirection(texel)), 0.0) * octTexelSolidAngle(texel);
    if (weight > 0.0) {
      let value = filteredProbeRadiance[probe * 64u + texel].value;
      support = min(support, value.w);
      sum += value.xyz * weight;
      total += weight;
    }
  }
  if (support != 1.0) { return vec4f(0.0, 0.0, 0.0, support); }
  return vec4f(sum / max(total, 1e-6), 1.0);
}

struct ShortRange { occlusion: f32, bent: vec3f }

// Short-range screen-space horizon AO and bent normal within `radius` world
// units. The probes cannot resolve contact occlusion below their spacing.
fn shortRange(pixel: vec2u, position: vec3f, normal: vec3f) -> ShortRange {
  let radius = probeFrame.tuning.y;
  if (radius <= 0.0) { return ShortRange(1.0, normal); }
  let extent = vec2f(extentSize());
  let toView = normalize(view.cameraPos - position);
  var tangent = cross(toView, normal);
  if (dot(tangent, tangent) < 1e-6) { tangent = cross(vec3f(0.0, 1.0, 0.0), normal); }
  if (dot(tangent, tangent) < 1e-6) { tangent = vec3f(1.0, 0.0, 0.0); }
  let c0 = view.worldViewProj * vec4f(position, 1.0);
  let c1 = view.worldViewProj * vec4f(position + normalize(tangent) * radius, 1.0);
  let span = length((c1.xy / c1.w - c0.xy / c0.w) * 0.5 * extent);
  if (!(span >= 1.0)) { return ShortRange(1.0, normal); }
  let rotation = spUnit(packPixel(pixel) ^ (probeFrame.probes.w * 2654435761u)) * 6.28318530718;
  var occlusion = 0.0;
  var bent = vec3f(0.0);
  var samples = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let angle = rotation + f32(k) * 1.57079632679;
    let direction = vec2f(cos(angle), sin(angle));
    for (var s = 1u; s <= 6u; s++) {
      let offset = direction * span * (f32(s) - 0.5) / 6.0;
      let q = vec2i(vec2f(pixel) + vec2f(0.5) + offset);
      if (any(q < vec2i(0)) || any(q >= vec2i(extentSize()))) { continue; }
      let z = textureLoad(gbufferDepth, q, 0);
      if (!validDepth(z)) { continue; }
      let v = worldPosition(vec2u(q), z) - position;
      let len = length(v);
      samples += 1.0;
      if (len <= 1e-5 || len >= radius) { continue; }
      let h = max(dot(normal, v / len) - 0.1, 0.0) * (1.0 - (len * len) / (radius * radius));
      occlusion += h;
      bent += v / len * h;
    }
  }
  if (samples == 0.0) { return ShortRange(1.0, normal); }
  let ao = clamp(1.0 - 2.0 * occlusion / samples, 0.0, 1.0);
  let bentNormal = normalize(normal - bent / samples);
  return ShortRange(ao, select(normal, bentNormal, dot(bentNormal, normal) > 0.0));
}

// One thread per pixel: blend the bilinear uniform probes and the tile's
// adaptive probes, sample D at the bent normal and apply short-range AO once.
@compute @workgroup_size(64) fn integrateScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  integratedOut[i] = vec4f(0.0);
  if (!gbufferMatches()) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!validDepth(z)) { return; }
  let position = worldPosition(pixel, z);
  let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let distance = length(view.cameraPos - position);
  let near = shortRange(pixel, position, normal);
  let tiles = tileCount();
  let g = uniformProbeGrid(vec2f(pixel) + vec2f(0.5), probeFrame.probes.w);
  let base = vec2u(min(floor(g), vec2f(max(tiles, vec2u(2u)) - vec2u(2u))));
  var source: array<ScreenProbe, 4>;
  for (var tap = 0u; tap < 4u; tap++) {
    let tile = min(base + vec2u(tap & 1u, tap >> 1u), tiles - vec2u(1u));
    source[tap] = probesIn[tile.y * tiles.x + tile.x];
  }
  let taps = uniformTaps(pixel, position, normal, distance, &source);
  var sum = vec3f(0.0);
  var total = 0.0;
  var incomplete = false;
  for (var tap = 0u; tap < 4u; tap++) {
    let w = taps.weights[tap];
    if (w > 1e-4) {
      if (probeVisibility(source[tap], position, normal) != 1.0) { continue; }
      let value = probeIrradianceAt(taps.probes[tap], near.bent);
      incomplete = incomplete || value.w == SUPPORT_INCOMPLETE;
      if (value.w == 1.0) { sum += value.xyz * w; total += w; }
    }
  }
  let ownTile = min(pixel / probeFrame.probes.z, tiles - vec2u(1u));
  let sub = min((pixel % probeFrame.probes.z) / max(probeFrame.probes.z / 2u, 1u), vec2u(1u));
  let adaptive = tileAdaptiveIn[(ownTile.y * tiles.x + ownTile.x) * 4u + (sub.x | (sub.y << 1u))];
  if (adaptive != SCREEN_PROBE_NONE && probeLive(adaptive)) {
    let w = probeAgreement(probesIn[adaptive], position, normal, distance);
    if (w > 1e-4 && probeVisibility(probesIn[adaptive], position, normal) == 1.0) {
      let value = probeIrradianceAt(adaptive, near.bent);
      incomplete = incomplete || value.w == SUPPORT_INCOMPLETE;
      if (value.w == 1.0) { sum += value.xyz * w; total += w; }
    }
  }
  if (incomplete) { return; }
  if (total > 1e-3) {
    integratedOut[i] = vec4f(sum / total * near.occlusion, 1.0);
    return;
  }
  // World fallback: the persistent Irradiance Field.
  let toView = view.cameraPos - position;
  let value = sampleIrradianceField(position, normal, toView / max(length(toView), 1e-8));
  if (value.w > 0.0) { integratedOut[i] = vec4f(value.xyz * near.occlusion, 1.0); }
}

fn packNormal(n: vec3f) -> u32 { return pack2x16snorm(spOctEncode(n)); }
fn unpackNormal(p: u32) -> vec3f { return spOctDecode(unpack2x16snorm(p)); }

// One thread per pixel: reproject last frame's accumulated irradiance and
// reject each bilinear tap on distance/normal disagreement, then normalize
// only supported taps (UE ScreenProbeTemporalReprojection).
@compute @workgroup_size(64) fn temporalScreenProbes(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  let current = integrated[i];
  historyOut[i] = vec4f(0.0);
  metaOut[i] = vec4u(0u);
  if (current.w != 1.0 || !gbufferMatches()) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let z = textureLoad(gbufferDepth, vec2i(pixel), 0);
  let position = worldPosition(pixel, z);
  let normal = loadStandardNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  var count = 1u;
  var value = current.xyz;
  if ((probeFrame.control.z & 2u) != 0u) {
    let clip = probeFrame.previousViewProj * vec4f(position, 1.0);
    let uv = clip.xy / max(clip.w, 1e-8) * vec2f(0.5, -0.5) + vec2f(0.5);
    if (clip.w > 0.0 && all(uv >= vec2f(0.0)) && all(uv < vec2f(1.0))) {
      let texel = uv * vec2f(extent) - vec2f(0.5);
      let base = vec2i(floor(texel));
      let fraction = fract(texel);
      let expected = length(probeFrame.previousCameraPos.xyz - position);
      var supported = 0.0;
      var history = vec3f(0.0);
      var frames = pixelHistoryCap();
      for (var tap = 0u; tap < 4u; tap++) {
        let offset = vec2u(tap & 1u, tap >> 1u);
        let previous = base + vec2i(offset);
        if (any(previous < vec2i(0)) || any(previous >= vec2i(extent))) { continue; }
        let weight = select(1.0 - fraction.x, fraction.x, offset.x == 1u) *
          select(1.0 - fraction.y, fraction.y, offset.y == 1u);
        if (weight <= 0.0) { continue; }
        let index = pixelIndex(vec2u(previous));
        let state = metaIn[index];
        let stored = bitcast<f32>(state.x);
        if (state.w != 1u || state.z == 0u || abs(stored - expected) > 0.02 * expected ||
            dot(unpackNormal(state.y), normal) <= 0.7071) { continue; }
        history += historyIn[index].xyz * weight;
        supported += weight;
        // A newly exposed tap cannot inherit an older neighbour's full age.
        frames = min(frames, state.z);
      }
      if (supported > 0.0) {
        count = min(frames + 1u, pixelHistoryCap());
        value = mix(history / supported, current.xyz, 1.0 / f32(count));
      }
    }
  }
  historyOut[i] = vec4f(value, 1.0);
  metaOut[i] = vec4u(bitcast<u32>(length(view.cameraPos - position)), packNormal(normal), count, 1u);
}

// After the composite: keep this frame's linear HDR scene for next frame's screen trace.
@compute @workgroup_size(64) fn copySceneHistory(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = spLinearId(gid, groups);
  let extent = extentSize();
  if (i >= extent.x * extent.y) { return; }
  if (any(textureDimensions(sceneColor) != extent)) { previousSceneOut[i] = vec2u(0u); return; }
  let color = textureLoad(sceneColor, vec2i(vec2u(i % extent.x, i / extent.x)), 0);
  let safe = select(vec3f(0.0), color.xyz, all(color.xyz >= vec3f(0.0)) && all(color.xyz < vec3f(65504.0)));
  previousSceneOut[i] = vec2u(pack2x16float(safe.xy), pack2x16float(vec2f(safe.z, 1.0)));
}
