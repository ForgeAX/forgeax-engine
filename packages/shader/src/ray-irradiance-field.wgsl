#define_import_path forgeax_ray::irradiance_field
#import forgeax_view::common::{View}
#import forgeax_pbr::ibl_shared::{importanceSampleGGX}
#import forgeax_pbr::gbuffer::{loadStandardGBufferNormalRoughness, loadStandardGBufferValid}
#import forgeax_scene_temporal::{unpackSceneTemporalV1}
#import forgeax_pbr::lighting_attenuation::{evalDistanceAttenuation, evalSpotAttenuation, decodeSpotDecay}
#import forgeax_ray::irradiance_field_sample::{sampleIrradianceField, irradianceFieldSpacing, sampleRadianceCacheAt, radianceCacheConeAngle}
#ifdef IRRADIANCE_FIELD_VISIBILITY
#import forgeax_ray::field_visibility::{fieldCanonicalValidateStride, fieldCanonicalSetReady}
#endif

// Must match packIrradianceFieldFrame() in render/raytracing/irradiance-field.ts.
struct FieldFrame { schedule: vec4u, cards: vec4u, atlas: vec4u, environment: vec4f, trace: vec4f, gather: vec4u, query: vec4u }
struct FieldLight { positionKind: vec4f, radiance: vec4f, directionRange: vec4f, cone: vec4f }
struct CardSurface { position: vec3f, mask: u32, normal: vec3f, valid: u32, albedo: vec4f, emission: vec4f }

// Unique group-0 bindings per entry point; each pipeline layout names only its own.
@group(0) @binding(0) var<uniform> fieldFrame: FieldFrame;
@group(0) @binding(1) var<uniform> fieldLights: array<FieldLight, 32>;
@group(0) @binding(2) var<storage, read> cardSurfaces: array<CardSurface>;
@group(0) @binding(3) var<storage, read_write> cardDirectOut: array<vec4f>;
@group(0) @binding(4) var<storage, read> cardDirect: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> cardLit: array<vec4f>;
@group(0) @binding(6) var gbufferDepth: texture_depth_2d;
@group(0) @binding(7) var gbufferNormal: texture_2d<u32>;
@group(0) @binding(8) var<uniform> view: View;
@group(0) @binding(9) var<storage, read_write> gathered: array<vec4f>;
@group(0) @binding(10) var<storage, read> gatheredIn: array<vec4f>;
@group(0) @binding(11) var<storage, read_write> upsampled: array<vec4f>;
// Lite reflections: per pixel trace ray and the specular radiance signal.
// Layout must match IRRADIANCE_FIELD_REFLECTION_RAY_BYTES in render/raytracing/irradiance-field.ts.
struct FieldReflectionRay { originWeight: vec4f, directionDistance: vec4f, fallback: vec4f }
@group(0) @binding(12) var<storage, read_write> reflectionRays: array<FieldReflectionRay>;
@group(0) @binding(13) var<storage, read_write> reflectionSignal: array<vec4f>;
// Lite reflection denoiser. Layout must match
// IRRADIANCE_FIELD_REFLECTION_HISTORY_BYTES in render/raytracing/irradiance-field.ts.
// radiance.w = accumulated frames, position.w = 1 for a valid receiver.
struct ReflectionHistory { radiance: vec4f, normalRoughness: vec4f, position: vec4f }
@group(0) @binding(14) var<storage, read> reflectionTraced: array<vec4f>;
@group(0) @binding(15) var<storage, read> reflectionPrevious: array<ReflectionHistory>;
@group(0) @binding(16) var<storage, read_write> reflectionHistory: array<ReflectionHistory>;
@group(0) @binding(17) var gbufferMotion: texture_2d<f32>;
@group(0) @binding(18) var<storage, read> reflectionAccumulated: array<ReflectionHistory>;
@group(0) @binding(19) var<storage, read_write> reflectionDenoised: array<vec4f>;
// The traced rays read back by the denoiser: fallback.w is the hit distance.
@group(0) @binding(20) var<storage, read> reflectionTracedRays: array<FieldReflectionRay>;

const INV_PI = 0.318309886183790671538;

fn fieldLinearId(gid: vec3u, groups: vec3u) -> u32 { return gid.x + gid.y * groups.x * 64u; }

// Budgeted tile i -> atlas texel, shared by every Card stage.
fn cardTexel(i: u32) -> u32 {
  let res = fieldFrame.atlas.y;
  let tile = (fieldFrame.cards.x + i / (res * res)) % fieldFrame.cards.z;
  let localTexel = i % (res * res);
  let tilesPerRow = fieldFrame.atlas.x / res;
  let pixel = vec2u((tile % tilesPerRow) * res + localTexel % res, (tile / tilesPerRow) * res + localTexel / res);
  return pixel.y * fieldFrame.atlas.x + pixel.x;
}

// Card direct lighting: Lambert over visible analytic lights plus emission.
// Visibility was resolved through the Global SDF by the card-surface stage.
@compute @workgroup_size(64) fn lightCards(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let res = fieldFrame.atlas.y;
  let i = fieldLinearId(gid, groups);
  if (i >= fieldFrame.cards.y * res * res) { return; }
  let texel = cardTexel(i);
  let s = cardSurfaces[texel];
  if (s.valid == 0u) { cardDirectOut[texel] = vec4f(0.0); return; }
  var irradiance = vec3f(0.0);
  for (var l = 0u; l < fieldFrame.cards.w; l++) {
    if ((s.mask & (1u << l)) == 0u) { continue; }
    let light = fieldLights[l];
    let kind = u32(light.positionKind.w);
    var incoming = normalize(-light.directionRange.xyz);
    var scale = 1.0;
    if (kind >= 2u) {
      let delta = light.positionKind.xyz - s.position;
      let distance = length(delta);
      incoming = delta / max(distance, 1e-8);
      scale = evalDistanceAttenuation(distance * distance, light.directionRange.w, light.radiance.w, 1e-4);
      if (kind == 3u) {
        scale = evalSpotAttenuation(light.positionKind.xyz, light.directionRange.xyz, s.position,
          light.cone.x, light.cone.y, light.directionRange.w, decodeSpotDecay(bitcast<u32>(light.radiance.w)));
      }
    }
    irradiance += light.radiance.xyz * (scale * max(dot(s.normal, incoming), 0.0));
  }
  cardDirectOut[texel] = vec4f(s.albedo.xyz * irradiance * INV_PI + s.emission.xyz, 1.0);
}

// Radiosity feedback: the field's previous result relights the Cards, so each
// submitted frame adds one diffuse bounce until hysteresis converges.
@compute @workgroup_size(64) fn radiateCards(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let res = fieldFrame.atlas.y;
  let i = fieldLinearId(gid, groups);
  if (i >= fieldFrame.cards.y * res * res) { return; }
  let texel = cardTexel(i);
  let s = cardSurfaces[texel];
  var radiance = cardDirect[texel].xyz;
  if (s.valid != 0u && (fieldFrame.atlas.w & 1u) != 0u) {
    let fieldValue = sampleIrradianceField(s.position, s.normal, vec3f(0.0));
    radiance += s.albedo.xyz * fieldValue.xyz * fieldValue.w;
  }
  cardLit[texel] = vec4f(radiance, f32(s.valid));
}

// Closed direct-only path. Preserve the feedback-off output, including alpha
// from the surface validity rather than the independent direct-light alpha.
@compute @workgroup_size(64) fn copyDirectCards(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let res = fieldFrame.atlas.y;
  let i = fieldLinearId(gid, groups);
  if (i >= fieldFrame.cards.y * res * res) { return; }
  let texel = cardTexel(i);
  cardLit[texel] = vec4f(cardDirect[texel].xyz, f32(cardSurfaces[texel].valid));
}

fn receiverPosition(pixel: vec2u, depth: f32, extent: vec2u) -> vec3f {
  let uv = (vec2f(pixel) + vec2f(0.5)) / vec2f(extent);
  let p = view.inverseViewProj * vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), depth, 1.0);
  return p.xyz / p.w;
}

// One receiver per gather texel. Half resolution reads the even full pixel.
#ifdef IRRADIANCE_FIELD_VISIBILITY
@compute @workgroup_size(64) fn gatherField(@builtin(global_invocation_id) gid: vec3u,
#else
@compute @workgroup_size(64) fn gatherBakedField(@builtin(global_invocation_id) gid: vec3u,
#endif
    @builtin(num_workgroups) groups: vec3u) {
  let i = fieldLinearId(gid, groups);
  let size = fieldFrame.gather.xy;
  if (i >= size.x * size.y) { return; }
  let extent = fieldFrame.gather.zw;
  let scale = select(1u, 2u, any(size != extent));
  let pixel = min(vec2u(i % size.x, i / size.x) * scale, extent - vec2u(1u));
  gathered[i] = vec4f(0.0);
  if (any(textureDimensions(gbufferDepth) != extent)) { return; }
  let depth = textureLoad(gbufferDepth, vec2i(pixel), 0);
  // Reverse-Z depth 1 is the valid near plane; depth 0 remains the clear value.
  if (!(depth > 0.0 && depth <= 1.0) || !loadStandardGBufferValid(gbufferNormal, vec2i(pixel))) { return; }
  let position = receiverPosition(pixel, depth, extent);
  let normal = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let toView = view.cameraPos - position;
  let value = sampleIrradianceField(position, normal, toView / max(length(toView), 1e-8));
  if (value.w < 0.0) { gathered[i] = value; return; }
  gathered[i] = select(vec4f(0.0), vec4f(value.xyz, 1.0), value.w > 0.0);
}

// Joint bilateral upsample from half resolution. Pixels with no compatible
// half-resolution neighbor sample the field directly instead of leaving holes.
#ifdef IRRADIANCE_FIELD_VISIBILITY
@compute @workgroup_size(64) fn upsampleField(@builtin(global_invocation_id) gid: vec3u,
#else
@compute @workgroup_size(64) fn upsampleBakedField(@builtin(global_invocation_id) gid: vec3u,
#endif
    @builtin(num_workgroups) groups: vec3u) {
  let i = fieldLinearId(gid, groups);
  let extent = fieldFrame.gather.zw;
  if (i >= extent.x * extent.y) { return; }
  upsampled[i] = vec4f(0.0);
  if (any(textureDimensions(gbufferDepth) != extent)) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let depth = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!(depth > 0.0 && depth <= 1.0) || !loadStandardGBufferValid(gbufferNormal, vec2i(pixel))) { return; }
  let position = receiverPosition(pixel, depth, extent);
  let normal = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel)).xyz;
  let size = fieldFrame.gather.xy;
  let spacing = irradianceFieldSpacing();
  let xy = clamp(vec2f(pixel) * 0.5, vec2f(0.0), vec2f(size - vec2u(1u)));
  let base = vec2u(min(floor(xy), vec2f(max(size, vec2u(2u)) - vec2u(2u))));
  let f = xy - vec2f(base);
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let g = min(base + offset, size - vec2u(1u));
    let value = gatheredIn[g.y * size.x + g.x];
    if (value.w == 0.0) { continue; }
    let source = min(g * 2u, extent - vec2u(1u));
    let sourceDepth = textureLoad(gbufferDepth, vec2i(source), 0);
    let sourcePosition = receiverPosition(source, sourceDepth, extent);
    if (!loadStandardGBufferValid(gbufferNormal, vec2i(source))) { continue; }
    let sourceNormal = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(source)).xyz;
    let axis = select(vec2f(1.0) - f, f, offset > vec2u(0u));
    let plane = abs(dot(sourcePosition - position, normal)) / (0.25 * spacing);
    let weight = axis.x * axis.y * exp(-plane * plane) * pow(max(dot(sourceNormal, normal), 0.0), 8.0);
    if (!(weight > 1e-4)) { continue; }
    if (value.w < 0.0) { return; }
    sum += value.xyz * weight;
    total += weight;
  }
  if (total > 0.0) { upsampled[i] = vec4f(sum / total, 1.0); return; }
  let toView = view.cameraPos - position;
  let value = sampleIrradianceField(position, normal, toView / max(length(toView), 1e-8));
  upsampled[i] = select(vec4f(0.0), vec4f(value.xyz, 1.0), value.w > 0.0);
}

// UE LumenCombineReflectionsAlpha: the traced share of the reflection signal.
fn reflectionTracedFraction(roughness: f32) -> f32 {
  let limit = bitcast<f32>(fieldFrame.query.z);
  let fade = max(bitcast<f32>(fieldFrame.query.w), 1e-3);
  return clamp((limit - roughness) / fade, 0.0, 1.0);
}

// UE LumenReflections GGXSamplingBias trims the extreme grazing GGX tail to
// suppress 1-spp fireflies without distorting the core specular lobe.
const REFLECTION_GGX_SAMPLING_BIAS = 0.1;

// Spatially blue Interleaved Gradient Noise + temporal R2 quasi-random sequence.
fn reflectionBlueSample(pixel: vec2u, frameIndex: u32, attempt: u32) -> vec2f {
  let p = vec2f(pixel);
  let spatial = vec2f(
    fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))),
    fract(52.9829189 * fract(dot(p + vec2f(17.0, 59.0), vec2f(0.06711056, 0.00583715)))),
  );
  let idx = f32((frameIndex * 4u + attempt) & 1023u);
  let r2 = fract(vec2f(0.7548776662, 0.5698402910) * idx);
  return fract(spatial + r2);
}

#ifdef IRRADIANCE_FIELD_VISIBILITY
var<workgroup> reflectionCanonicalValid: atomic<u32>;
#endif

// Lite reflections from the radiance cache (UE LumenReflectionsCombine split).
// Above maxRoughnessToTrace the cosine lobe around the Frostbite dominant
// direction gives E(R)/pi, the 'exact' lane's rough-specular quantity, read from
// the irradiance level. Below it the trace weight (UE LumenCombineReflectionsAlpha)
// goes to one Global SDF -> Card ray along the dominant direction whose miss keeps
// the radiance cache filtered over the GGX lobe cone. fieldFrame.query.zw carry
// the trace limit and fade length (f32 bits). The signal is radiance only; the
// composite applies the split-sum response.
#ifdef IRRADIANCE_FIELD_VISIBILITY
@compute @workgroup_size(64) fn generateFieldReflections(@builtin(global_invocation_id) gid: vec3u,
    @builtin(local_invocation_index) lid: u32,
    @builtin(num_workgroups) groups: vec3u) {
  // Cooperatively validate canonical visibility source readiness once per
  // workgroup (64x less work than validating every row per pixel per corner).
  if (lid == 0u) { atomicStore(&reflectionCanonicalValid, 1u); }
  workgroupBarrier();
  if (!fieldCanonicalValidateStride(lid, 64u)) { atomicStore(&reflectionCanonicalValid, 0u); }
  workgroupBarrier();
  fieldCanonicalSetReady(atomicLoad(&reflectionCanonicalValid) != 0u);
#else
// Chebyshev-visibility reflection generator for hardware ray-query lanes: avoids
// per-pixel software interval-BVH visibility walks while preserving exact HWRT
// probe depth/variance occlusion and traced reflection rays.
@compute @workgroup_size(64) fn generateReflectionsChebyshev(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
#endif
  let i = fieldLinearId(gid, groups);
  let extent = fieldFrame.gather.zw;
  if (i >= extent.x * extent.y || i >= arrayLength(&reflectionSignal) ||
      i >= arrayLength(&reflectionRays)) { return; }
  reflectionRays[i] = FieldReflectionRay(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  reflectionSignal[i] = vec4f(0.0);
  if (any(textureDimensions(gbufferDepth) != extent)) { return; }
  let pixel = vec2u(i % extent.x, i / extent.x);
  let depth = textureLoad(gbufferDepth, vec2i(pixel), 0);
  if (!(depth > 0.0 && depth <= 1.0) || !loadStandardGBufferValid(gbufferNormal, vec2i(pixel))) { return; }
  let position = receiverPosition(pixel, depth, extent);
  let surface = loadStandardGBufferNormalRoughness(gbufferNormal, vec2i(pixel));
  let n = surface.xyz;
  let roughness = surface.w;
  let toView = view.cameraPos - position;
  let v = toView / max(length(toView), 1e-8);
  if (dot(v, n) <= 0.0) { return; }
  let alpha = max(roughness * roughness, 1e-4);
  let mirror = reflect(-v, n);
  let lerpFactor = (1.0 - alpha) * (sqrt(1.0 - alpha) + alpha);
  let dominant = normalize(mix(n, mirror, lerpFactor));
  let traced = reflectionTracedFraction(roughness);
  var rayDirection = dominant;
  if (traced > 0.0) {
    // One GGX lobe sample per pixel and frame (split-sum convention: the
    // response owns DFG, so the signal is the lobe-averaged radiance).
    for (var attempt = 0u; attempt < 4u; attempt++) {
      let u = reflectionBlueSample(pixel, fieldFrame.schedule.w, attempt);
      let biased = vec2f(u.x * (1.0 - REFLECTION_GGX_SAMPLING_BIAS), u.y);
      let l = reflect(-v, importanceSampleGGX(biased, n, roughness));
      if (dot(l, n) > 0.0) { rayDirection = l; break; }
    }
  }
  // Keep a single sampleRadianceCacheAt call site so GPU shader compilers do not
  // duplicate the inlined visibility marcher and stall PSO creation.
  var rough = vec3f(0.0);
  var fallback = vec3f(0.0);
  let firstQuery = select(1u, 0u, traced < 1.0);
  let lastQuery = select(0u, 1u, traced > 0.0);
  for (var queryPass = firstQuery; queryPass <= lastQuery; queryPass++) {
    let queryDirection = select(rayDirection, dominant, queryPass == 0u);
    let queryCone = select(radianceCacheConeAngle(roughness), 3.14159265, queryPass == 0u);
    let value = sampleRadianceCacheAt(position, n, v, queryDirection, queryCone);
    if (value.w < 0.0) { return; }
    if (queryPass == 0u) {
      rough = value.xyz * value.w * (1.0 - traced);
    } else {
      fallback = value.xyz * value.w;
    }
  }
  reflectionSignal[i] = vec4f(rough, 1.0);
  if (traced > 0.0) {
    reflectionRays[i] = FieldReflectionRay(vec4f(position + n * fieldFrame.trace.y, traced),
      vec4f(rayDirection, fieldFrame.trace.x), vec4f(fallback, 0.0));
  }
}

#ifdef IRRADIANCE_FIELD_VISIBILITY

const REFLECTION_MAX_HISTORY = 8.0;
// History clamp half-width in neighborhood standard deviations.
const REFLECTION_CLAMP_SIGMA = 1.5;

fn reflectionRgbToYCoCg(rgb: vec3f) -> vec3f {
  let y = 0.25 * rgb.r + 0.5 * rgb.g + 0.25 * rgb.b;
  let co = 0.5 * rgb.r - 0.5 * rgb.b;
  let cg = -0.25 * rgb.r + 0.5 * rgb.g - 0.25 * rgb.b;
  return vec3f(y, co, cg);
}

fn reflectionYCoCgToRgb(ycocg: vec3f) -> vec3f {
  let tmp = ycocg.x - ycocg.z;
  return vec3f(tmp + ycocg.y, ycocg.x + ycocg.z, tmp - ycocg.y);
}

// Hard admission shared by reprojection and the spatial filter: same plane,
// same orientation, same lobe. No weight floor may admit another surface.
fn sameReflector(position: vec3f, surface: vec4f, other: ReflectionHistory) -> bool {
  let tolerance = max(1e-3, 0.02 * length(view.cameraPos - position));
  return other.position.w == 1.0 && dot(other.normalRoughness.xyz, surface.xyz) > 0.9 &&
    abs(other.normalRoughness.w - surface.w) < 0.1 &&
    abs(dot(other.position.xyz - position, surface.xyz)) < tolerance;
}

fn sameReflectorSurface(position: vec3f, surface: vec4f, otherPosition: vec3f, otherSurface: vec4f) -> bool {
  let tolerance = max(1e-3, 0.02 * length(view.cameraPos - position));
  return dot(otherSurface.xyz, surface.xyz) > 0.9 &&
    abs(otherSurface.w - surface.w) < 0.1 &&
    abs(dot(otherPosition - position, surface.xyz)) < tolerance;
}

struct ReflectionHistoryTap {
  radiance: vec3f,
  age: f32,
  support: f32,
}

fn sampleReflectionHistoryAt(uv: vec2f, extent: vec2u, position: vec3f,
    surface: vec4f) -> ReflectionHistoryTap {
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) {
    return ReflectionHistoryTap(vec3f(0.0), 0.0, 0.0);
  }
  let coordinate = uv * vec2f(extent) - vec2f(0.5);
  let origin = vec2i(floor(coordinate));
  let f = fract(coordinate);
  var sum = vec3f(0.0);
  var ages = 0.0;
  var support = 0.0;
  for (var tap = 0u; tap < 4u; tap++) {
    let offset = vec2u(tap & 1u, tap >> 1u);
    let q = origin + vec2i(offset);
    if (any(q < vec2i(0)) || any(q >= vec2i(extent))) { continue; }
    let axis = select(vec2f(1.0) - f, f, offset > vec2u(0u));
    let w = axis.x * axis.y;
    if (!(w > 0.0)) { continue; }
    let old = reflectionPrevious[u32(q.y) * extent.x + u32(q.x)];
    if (!sameReflector(position, surface, old)) { continue; }
    sum += old.radiance.xyz * w;
    ages += old.radiance.w * w;
    support += w;
  }
  if (!(support > 0.0)) { return ReflectionHistoryTap(vec3f(0.0), 0.0, 0.0); }
  return ReflectionHistoryTap(sum / support, ages / support, support);
}
// Denoiser strength. Near-mirror lobes are sub-pixel: they keep the raw ray, like
// the exact lane. The cache column is deterministic, so only the traced share
// is accumulated and filtered.
fn reflectionLobeBlend(roughness: f32) -> f32 {
  return smoothstep(0.05, 0.15, roughness) * reflectionTracedFraction(roughness);
}

// Previous-frame uv of the reflected image (UE hit-distance reprojection): the
// virtual point lies hitDistance behind the receiver along the view ray, so a
// camera move shifts the reflection by its parallax rather than by the surface
// motion. A miss reprojects the view direction at infinity; an unresolved trace
// keeps the surface uv. Static reflectors and reflected scenes are assumed.
// The caller passes the closest neighborhood hit (UE ClosestHitDistance): one
// GGX sample per pixel makes a lone miss beside a reflected object reproject
// at infinity onto the object's stale image.
fn reflectionHistoryUv(position: vec3f, distance: f32, surfaceUv: vec2f) -> vec2f {
  if (distance == 0.0) { return surfaceUv; }
  let toView = position - view.cameraPos;
  let along = toView / max(length(toView), 1e-8);
  let virtualPoint = select(vec4f(position + along * distance, 1.0), vec4f(along, 0.0),
    distance < 0.0);
  let clip = view.temporalPreviousViewProj * virtualPoint;
  if (!(clip.w > 1e-6)) { return surfaceUv; }
  return clip.xy / clip.w * vec2f(0.5, -0.5) + vec2f(0.5);
}

// Temporal accumulation (UE LumenReflectionsTemporal): sample surface-motion
// and virtual-hit-distance history separately (never interpolating unrelated
// UVs), admit bilinear taps on the same reflector only, clamp admitted history
// against normal-gated 3x3 YCoCg neighborhood moments, and blend with a bounded
// running mean. Rejected pixels restart at one frame.
@compute @workgroup_size(64) fn accumulateFieldReflections(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = fieldLinearId(gid, groups);
  let extent = fieldFrame.gather.zw;
  let count = extent.x * extent.y;
  if (i >= count || i >= arrayLength(&reflectionHistory)) { return; }
  reflectionHistory[i] = ReflectionHistory(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  if (arrayLength(&reflectionTraced) < count || arrayLength(&reflectionPrevious) < count ||
      any(textureDimensions(gbufferDepth) != extent) ||
      any(textureDimensions(gbufferMotion) != extent)) { return; }
  let current = reflectionTraced[i];
  if (current.w != 1.0) { return; }
  let pixel = vec2i(i32(i % extent.x), i32(i / extent.x));
  let position = receiverPosition(vec2u(pixel), textureLoad(gbufferDepth, pixel, 0), extent);
  if (!loadStandardGBufferValid(gbufferNormal, pixel)) { return; }
  let surface = loadStandardGBufferNormalRoughness(gbufferNormal, pixel);
  var m1 = vec3f(0.0);
  var m2 = vec3f(0.0);
  var taps = 0.0;
  // Closest finite hit distance in the neighborhood; -1 when only misses.
  var closest = 0.0;
  let rays = arrayLength(&reflectionTracedRays) >= count;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let q = pixel + vec2i(x, y);
      if (any(q < vec2i(0)) || any(q >= vec2i(extent))) { continue; }
      let j = u32(q.y) * extent.x + u32(q.x);
      let isCenter = x == 0 && y == 0;
      var compatible = isCenter;
      if (!isCenter && loadStandardGBufferValid(gbufferNormal, q)) {
        let qDepth = textureLoad(gbufferDepth, q, 0);
        if (qDepth > 0.0 && qDepth <= 1.0) {
          let qPos = receiverPosition(vec2u(q), qDepth, extent);
          let qSurface = loadStandardGBufferNormalRoughness(gbufferNormal, q);
          compatible = sameReflectorSurface(position, surface, qPos, qSurface);
        }
      }
      if (!compatible) { continue; }
      if (rays) {
        let d = reflectionTracedRays[j].fallback.w;
        if (d > 0.0 && (closest <= 0.0 || d < closest)) { closest = d; }
        else if (d < 0.0 && closest == 0.0) { closest = -1.0; }
      }
      let s = reflectionTraced[j];
      if (s.w != 1.0) { continue; }
      let yc = reflectionRgbToYCoCg(s.xyz);
      m1 += yc;
      m2 += yc * yc;
      taps += 1.0;
    }
  }
  let mean = m1 / max(taps, 1.0);
  let sigma = sqrt(max(m2 / max(taps, 1.0) - mean * mean, vec3f(0.0)));
  var radiance = current.xyz;
  var age = 1.0;
  let temporal = unpackSceneTemporalV1(textureLoad(gbufferMotion, pixel, 0));
  if (temporal.motionValid && all(abs(temporal.motionUv) < vec2f(4.0))) {
    let surfaceUv = (vec2f(pixel) + vec2f(0.5)) / vec2f(extent) - temporal.motionUv;
    let tracedWeight = select(0.0, clamp(reflectionTracedRays[i].originWeight.w, 0.0, 1.0), rays);
    var surfaceTap = ReflectionHistoryTap(vec3f(0.0), 0.0, 0.0);
    var virtualTap = ReflectionHistoryTap(vec3f(0.0), 0.0, 0.0);
    if (tracedWeight < 1.0) {
      surfaceTap = sampleReflectionHistoryAt(surfaceUv, extent, position, surface);
    }
    if (tracedWeight > 0.0) {
      let virtualUv = reflectionHistoryUv(position, closest, surfaceUv);
      virtualTap = sampleReflectionHistoryAt(virtualUv, extent, position, surface);
      // Fall back to surface motion when virtual parallax steps off-screen or disoccludes.
      if (!(virtualTap.support > 0.0) && !(surfaceTap.support > 0.0)) {
        surfaceTap = sampleReflectionHistoryAt(surfaceUv, extent, position, surface);
      }
    }
    var historyRgb = vec3f(0.0);
    var historyAge = 0.0;
    var combinedWeight = 0.0;
    if (virtualTap.support > 0.0 && surfaceTap.support > 0.0) {
      historyRgb = mix(surfaceTap.radiance, virtualTap.radiance, tracedWeight);
      historyAge = mix(surfaceTap.age, virtualTap.age, tracedWeight);
      combinedWeight = 1.0;
    } else if (virtualTap.support > 0.0) {
      historyRgb = virtualTap.radiance;
      historyAge = virtualTap.age;
      combinedWeight = 1.0;
    } else if (surfaceTap.support > 0.0) {
      historyRgb = surfaceTap.radiance;
      historyAge = surfaceTap.age;
      combinedWeight = 1.0;
    }
    if (combinedWeight > 0.0) {
      let spread = sigma * REFLECTION_CLAMP_SIGMA;
      let clampedYCoCg = clamp(reflectionRgbToYCoCg(historyRgb), mean - spread, mean + spread);
      let history = max(reflectionYCoCgToRgb(clampedYCoCg), vec3f(0.0));
      let limit = mix(1.0, REFLECTION_MAX_HISTORY, reflectionLobeBlend(surface.w));
      let n = min(historyAge, limit - 1.0);
      radiance = mix(history, current.xyz, 1.0 / (n + 1.0));
      age = n + 1.0;
    }
  }
  reflectionHistory[i] = ReflectionHistory(vec4f(radiance, age), surface, vec4f(position, 1.0));
}

// Edge-stopping tent over the accumulated signal. Young history (disocclusion,
// first frames) widens the support; converged history keeps a 3x3 footprint.
@compute @workgroup_size(64) fn filterFieldReflections(@builtin(global_invocation_id) gid: vec3u,
    @builtin(num_workgroups) groups: vec3u) {
  let i = fieldLinearId(gid, groups);
  let extent = fieldFrame.gather.zw;
  let count = extent.x * extent.y;
  if (i >= count || i >= arrayLength(&reflectionDenoised)) { return; }
  reflectionDenoised[i] = vec4f(0.0);
  if (arrayLength(&reflectionAccumulated) < count) { return; }
  let center = reflectionAccumulated[i];
  if (center.position.w != 1.0) { return; }
  let pixel = vec2i(i32(i % extent.x), i32(i / extent.x));
  let radius = select(1, 2, center.radiance.w < 4.0);
  var sum = vec3f(0.0);
  var total = 0.0;
  for (var y = -radius; y <= radius; y++) {
    for (var x = -radius; x <= radius; x++) {
      let q = pixel + vec2i(x, y);
      if (any(q < vec2i(0)) || any(q >= vec2i(extent))) { continue; }
      let other = reflectionAccumulated[u32(q.y) * extent.x + u32(q.x)];
      if (!sameReflector(center.position.xyz, center.normalRoughness, other)) { continue; }
      let w = f32((radius + 1 - abs(x)) * (radius + 1 - abs(y)));
      sum += other.radiance.xyz * w;
      total += w;
    }
  }
  let filtered = select(center.radiance.xyz, sum / max(total, 1e-30), total > 0.0);
  reflectionDenoised[i] = vec4f(
    mix(center.radiance.xyz, filtered, reflectionLobeBlend(center.normalRoughness.w)), 1.0);
}
#endif
