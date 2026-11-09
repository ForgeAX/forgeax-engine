#define_import_path forgeax_pbr::lighting_directional

// Directional BRDF and layered CSM receiver. Native CSM shares a bounded
// caster-depth budget with authored normal offsets, then compares the receiver
// plane toward the light at individual filter texels. Constant-bias profiles
// retain their authored comparison and kernel contract. Shadow comparisons use
// native point loads where available and a portable comparison fallback.

#import forgeax_view::common::{view, shadowMap, shadowSampler, shadowCasterCascade, directionalShadowCasterBias}
#import forgeax_pbr::brdf::{standardOpaqueBrdfEnergy, halfVectorTerms, directLightingAlpha, sunDiscSpecularTerms}
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d_nearest, sample_shadow_2d, sample_shadow_2d_vogel, sample_shadow_2d_soft, sample_shadow_variance, shadow_vogel_rotation, SHADOW_VOGEL_OFFSETS, shadow_sample_compare}
#ifdef DIRECTIONAL_PCSS_AVAILABLE
#import forgeax_pbr::shadow_pcf::{shadow_clamp_texel_to_tile, shadow_load_raw_depth}
#endif

// feat-20260621-learn-render-5-3-production-shadow-demos M0 / AC-14:
// compile-time upper bound on the PCF half-extent so the WGSL tap loops keep
// a constant trip count (no dynamic loop bounds / shader variants). half=2
// covers the PCF1/3/5 profiles -> {1,9,25} taps; the profile carrier selects
// the runtime radius while keeping the receiver variant-free.
const MAX_PCF_HALF : u32 = 2u;

#ifdef DIRECTIONAL_PCSS_AVAILABLE
const PCSS_MEDIUM_RAW_TAPS : u32 = 8u;
const PCSS_MEDIUM_COMPARE_TAPS : u32 = 16u;
const PCSS_HIGH_RAW_TAPS : u32 = 16u;
const PCSS_HIGH_COMPARE_TAPS : u32 = 32u;

// Cascade-local disk points are fixed, bounded, and shared by raw and compare
// phases. A rotation derived from the integer receiver texel and cascade keeps
// the pattern stable without a temporal input.
// One invocation-owned table keeps tap indexing addressable across native calls.
// The shader only reads these fixed disk points.
var<private> PCSS_DISK_OFFSETS : array<vec2<f32>, 32> = array<vec2<f32>, 32>(
  vec2<f32>(-0.326, -0.945), vec2<f32>(0.236, -0.873), vec2<f32>(0.891, -0.404), vec2<f32>(-0.761, -0.581),
  vec2<f32>(0.612, 0.146), vec2<f32>(-0.148, 0.514), vec2<f32>(-0.527, -0.109), vec2<f32>(0.074, 0.911),
  vec2<f32>(-0.944, 0.238), vec2<f32>(0.444, -0.736), vec2<f32>(0.707, 0.641), vec2<f32>(-0.184, -0.342),
  vec2<f32>(0.318, 0.382), vec2<f32>(-0.638, 0.526), vec2<f32>(0.955, -0.083), vec2<f32>(-0.401, 0.816),
  vec2<f32>(-0.083, -0.632), vec2<f32>(0.539, -0.262), vec2<f32>(-0.735, -0.168), vec2<f32>(0.162, 0.719),
  vec2<f32>(-0.841, 0.003), vec2<f32>(0.791, 0.332), vec2<f32>(-0.291, -0.791), vec2<f32>(0.021, -0.224),
  vec2<f32>(0.386, 0.799), vec2<f32>(-0.558, 0.134), vec2<f32>(0.638, -0.555), vec2<f32>(-0.189, 0.957),
  vec2<f32>(-0.977, -0.117), vec2<f32>(0.271, 0.589), vec2<f32>(0.819, -0.719), vec2<f32>(-0.472, -0.409),
);
#endif

// Direct multiscatter is owned by forgeax_pbr::brdf. Keep directional
// lighting as a consumer of that shared function so its LUT and energy
// compensation cannot diverge from punctual and cluster lighting.
// Pick the cascade layer for a positive view-space depth -- walks
// splitPlanes in order, returns the first split the depth falls below. Last
// layer (count - 1) catches everything beyond splits[count-2]. cascadeCount=1
// returns 0 unconditionally without a special branch (count - 1u == 0
// short-circuits the loop trip count).
//
// NOTE the sign: the vertex stage emits `viewZ = -clipPos.w` (NEGATIVE in
// front of the camera -- the deliberate convention the cluster Z-slice path
// also relies on), but `pssmSplit` host-side produces POSITIVE view-space
// split depths. The caller therefore passes `viewDepth = -viewZ` so this
// comparison is positive-vs-positive. Comparing the raw negative viewZ against
// positive splits collapsed every visible fragment to layer 0 (its near slab),
// projecting far geometry out of the tile -> shadowFactor always 1.0 (no
// occlusion). (downstream template integration #1.)
fn _pickCascadeLayer(viewDepth : f32, count : u32) -> u32 {
  var layer : u32 = count - 1u;
  for (var i : u32 = 0u; i < count - 1u; i = i + 1u) {
    let sp = view.splitPlanes[i].x;
    if (viewDepth < sp) {
      layer = i;
      break;
    }
  }
  return layer;
}

// Look up the lightViewProj matrix for layer index. View UBO carries 4
// distinct fields (lightViewProj_A..D); WGSL has no addressable mat4
// array on a uniform, so a manual switch keeps the path uniform.
fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

fn _directionalReceiverDepthBias(layer : u32, normal : vec3<f32>, l : vec3<f32>) -> f32 {
  let cosine = abs(dot(normal, l));
  let span = view.splitPlanes[layer].z;
  if (shadowCasterCascade.clampNear == 0u || view.splitPlanes[0].w > 0.5 || !(cosine > 0.0 && span > 0.0 && view.normalBias > 0.0)) {
    return view.depthBias;
  }
  // The authored normal offset and automatic caster separation share a budget.
  // Compensate their overlap for surfaces; volumes have no normal offset.
  let casterBias = directionalShadowCasterBias(cosine, view.splitPlanes[layer].y, span);
  let normalSeparation = view.normalBias / cosine / span;
  return view.depthBias - min(casterBias, normalSeparation);
}

// Receiver-plane depth gradient (Isidoro 2006): normalized light depth change
// per shadow texel along +u / +v on the receiver's tangent plane. PCF taps
// correct individual texel references toward the light. The projected-plane
// denominator is bounded at grazing angles, following UE directional PCSS.
// Zero where the plane is not a valid lit receiver.
fn _directionalReceiverPlaneGradient(layer : u32, normal : vec3<f32>, l : vec3<f32>) -> vec2<f32> {
  if (view.splitPlanes[0].w > 0.5 || !(dot(normal, l) > 0.0)) { return vec2<f32>(0.0); }
  let matrix = _cascadeLightViewProj(layer);
  let row0 = vec3<f32>(matrix[0].x, matrix[1].x, matrix[2].x);
  let row1 = vec3<f32>(matrix[0].y, matrix[1].y, matrix[2].y);
  let row2 = vec3<f32>(matrix[0].z, matrix[1].z, matrix[2].z);
  let sx = length(row0);
  let sy = length(row1);
  let sz = length(row2);
  if (!(sx > 0.0 && sy > 0.0 && sz > 0.0)) { return vec2<f32>(0.0); }
  let nz = dot(row2, normal) / sz;
  let numerator = vec2<f32>(-2.0 * dot(row0, normal) * sz / (sx * sx), 2.0 * dot(row1, normal) * sz / (sy * sy));
  let denominator = max(abs(nz), length(vec3<f32>(numerator, nz)) * 0.0872665);
  if (!(denominator > 0.0)) { return vec2<f32>(0.0); }
  return numerator * sign(nz) / denominator / vec2<f32>(textureDimensions(shadowMap));
}

#ifdef DIRECTIONAL_PCSS_AVAILABLE
fn _pcssDiskRotation(texel : vec2<i32>, layer : u32) -> f32 {
  let hash = u32(texel.x) * 1664525u + u32(texel.y) * 1013904223u + (layer + 1u) * 374761393u;
  return f32(hash % 6283u) * 0.001;
}

fn _pcssDiskPoint(index : u32, angle : f32, radius : f32) -> vec2<f32> {
  let point = PCSS_DISK_OFFSETS[index];
  let cs = cos(angle);
  let sn = sin(angle);
  return vec2<f32>(point.x * cs - point.y * sn, point.x * sn + point.y * cs) * radius;
}

fn _pcssProjectedSample(
  shadowMapSize : vec2<u32>,
  baseTexel     : vec2<i32>,
  offset        : vec2<f32>,
) -> vec2<f32> {
  let texel = shadow_clamp_texel_to_tile(
    baseTexel + vec2<i32>(round(offset)),
    vec2<i32>(0),
    vec2<i32>(shadowMapSize),
    1,
  );
  return (vec2<f32>(texel) + vec2<f32>(0.5)) / vec2<f32>(shadowMapSize);
}

fn _samplePcssForCascade(
  worldPos : vec3<f32>,
  layer    : u32,
  normal   : vec3<f32>,
  l        : vec3<f32>,
  profile  : u32,
) -> f32 {
  let lightClip = _cascadeLightViewProj(layer) * vec4<f32>(worldPos, 1.0);
  if (!(lightClip.w > 0.0 || lightClip.w < 0.0)) {
    return 1.0;
  }
  let projCoords = lightClip.xyz / lightClip.w;
  let tileUv = vec2<f32>(projCoords.x * 0.5 + 0.5, -projCoords.y * 0.5 + 0.5);
  if (!(tileUv.x >= 0.0 && tileUv.x <= 1.0 && tileUv.y >= 0.0 && tileUv.y <= 1.0 && projCoords.z >= 0.0 && projCoords.z <= 1.0)) {
    return 1.0;
  }
  let nDotL = dot(normal, l);
  if (!(nDotL >= -1.0 && nDotL <= 1.0)) {
    return 1.0;
  }
  let shadowMapSize = textureDimensions(shadowMap, 0);
  let baseTexel = vec2<i32>(floor(tileUv * vec2<f32>(shadowMapSize)));
  let angle = _pcssDiskRotation(baseTexel, layer);
  let rawRadius = select(2.0, 3.0, profile == 5u);
  let planeGradient = _directionalReceiverPlaneGradient(layer, normal, l);
  // Raw and comparison samples land at exact texel centers. Compare the
  // receiver plane at each center, without biasing past thin blockers by the
  // full search radius. The shared caster budget covers grazing degeneracy.
  let biasedDepth = projCoords.z + _directionalReceiverDepthBias(layer, normal, l);
  var blockerDepth = 0.0;
  var blockerCount = 0u;
  // Each phase shares the disk addressing call site. The second phase starts
  // only after all blockers have been accumulated, preserving tap order.
  let rawTaps = select(PCSS_MEDIUM_RAW_TAPS, PCSS_HIGH_RAW_TAPS, profile == 5u);
  let compareTaps = select(PCSS_MEDIUM_COMPARE_TAPS, PCSS_HIGH_COMPARE_TAPS, profile == 5u);
  var compareRadius = 0.5;
  let compareDepth = projCoords.z + _directionalReceiverDepthBias(layer, normal, l);
  var litSum = 0.0;
  for (var sample = 0u; sample < rawTaps + compareTaps; sample++) {
    if (sample == rawTaps) {
      if (blockerCount == 0u) { return 1.0; }
      let averageBlockerDepth = blockerDepth / f32(blockerCount);
      let lightDepthWorldSpan = max(view.splitPlanes[layer].z, 0.0);
      let worldUnitsPerTexel = max(view.splitPlanes[layer].y, 0.0);
      if (!(lightDepthWorldSpan > 0.0 && worldUnitsPerTexel > 0.0 && view.directionalShadowFilter.y >= 0.0 && view.directionalShadowFilter.z >= 0.0)) { return 1.0; }
      let worldDistance = max(0.0, averageBlockerDepth - biasedDepth) * lightDepthWorldSpan;
      let penumbraTexels = clamp(worldDistance * tan(view.directionalShadowFilter.y) / worldUnitsPerTexel, 0.0, view.directionalShadowFilter.z);
      compareRadius = max(0.5, penumbraTexels);
    }
    let raw = sample < rawTaps;
    let index = select(sample - rawTaps, sample, raw);
    let radius = select(compareRadius, rawRadius, raw);
    let sampleUv = _pcssProjectedSample(shadowMapSize, baseTexel, _pcssDiskPoint(index, angle, radius));
    if (raw) {
      let rawTexel = vec2<i32>(sampleUv * vec2<f32>(shadowMapSize) - vec2<f32>(0.5));
      let rawDepth = shadow_load_raw_depth(shadowMap, rawTexel, i32(layer));
      let correctedDepth = rawDepth - max(0.0, dot(planeGradient, (sampleUv - tileUv) * vec2<f32>(shadowMapSize)));
      if (rawDepth > 0.0 && rawDepth <= 1.0 && correctedDepth > biasedDepth) {
        blockerDepth = blockerDepth + correctedDepth;
        blockerCount = blockerCount + 1u;
      }
    } else {
      let tapDepth = max(0.0, compareDepth + max(0.0, dot(planeGradient, (sampleUv - tileUv) * vec2<f32>(shadowMapSize))));
      litSum = litSum + shadow_sample_compare(shadowMap, shadowSampler, sampleUv, i32(layer), tapDepth);
    }
  }
  return litSum / f32(compareTaps);
}
#endif

fn _directionalPointCompare(center: vec2<f32>, layer: i32, origin: vec2<f32>, depth: f32, gradient: vec2<f32>) -> f32 {
  let size = vec2<f32>(textureDimensions(shadowMap));
  let reference = max(0.0, depth + max(0.0, dot(gradient, (center - origin) * size)));
#ifdef DIRECTIONAL_PCSS_AVAILABLE
  // This capability already permits raw depth reads beside comparison sampling.
  // Four point loads avoid four bilinear hardware comparisons for one footprint.
  let stored = textureLoad(shadowMap, vec2<i32>(center * size), layer, 0);
  return select(0.0, 1.0, reference > stored);
#else
  return shadow_sample_compare(shadowMap, shadowSampler, center, layer, reference);
#endif
}

fn _directionalPlaneCompare(uv: vec2<f32>, layer: i32, originUv: vec2<f32>, depth: f32, gradient: vec2<f32>, extent: vec2<f32>) -> f32 {
  if (view.splitPlanes[0].w > 0.5) { return shadow_sample_compare(shadowMap, shadowSampler, uv, layer, depth); }
  let size = vec2<f32>(textureDimensions(shadowMap));
  let position = uv * size - vec2<f32>(0.5);
  let base = floor(position);
  let phase = fract(position);
  let lo = clamp(base, vec2<f32>(0.0), size * extent - vec2<f32>(1.0));
  let hi = clamp(base + vec2<f32>(1.0), vec2<f32>(0.0), size * extent - vec2<f32>(1.0));
#ifdef DIRECTIONAL_PCSS_AVAILABLE
  // Expand the four point reads once and compute the plane references together.
  // This preserves bilinear coverage without nested per-fragment tap loops.
  let stored = vec4<f32>(
    textureLoad(shadowMap, vec2<i32>(lo), layer, 0),
    textureLoad(shadowMap, vec2<i32>(vec2<f32>(hi.x, lo.y)), layer, 0),
    textureLoad(shadowMap, vec2<i32>(vec2<f32>(lo.x, hi.y)), layer, 0),
    textureLoad(shadowMap, vec2<i32>(hi), layer, 0));
  let x = vec4<f32>(lo.x, hi.x, lo.x, hi.x) + vec4<f32>(0.5);
  let y = vec4<f32>(lo.y, lo.y, hi.y, hi.y) + vec4<f32>(0.5);
  let plane = gradient.x * (x - vec4<f32>(originUv.x * size.x)) + gradient.y * (y - vec4<f32>(originUv.y * size.y));
  let reference = max(vec4<f32>(0.0), vec4<f32>(depth) + max(vec4<f32>(0.0), plane));
  let lit = select(vec4<f32>(0.0), vec4<f32>(1.0), reference > stored);
  let weights = vec4<f32>((1.0 - phase.x) * (1.0 - phase.y), phase.x * (1.0 - phase.y), (1.0 - phase.x) * phase.y, phase.x * phase.y);
  return dot(lit, weights);
#else
  let a = _directionalPointCompare((lo + vec2<f32>(0.5)) / size, layer, originUv, depth, gradient);
  let b = _directionalPointCompare((vec2<f32>(hi.x, lo.y) + vec2<f32>(0.5)) / size, layer, originUv, depth, gradient);
  let c = _directionalPointCompare((vec2<f32>(lo.x, hi.y) + vec2<f32>(0.5)) / size, layer, originUv, depth, gradient);
  let d = _directionalPointCompare((hi + vec2<f32>(0.5)) / size, layer, originUv, depth, gradient);
  return mix(mix(a, b, phase.x), mix(c, d, phase.x), phase.y);
#endif
}

fn _directionalVogel(uv: vec2<f32>, layer: i32, depth: f32, gradient: vec2<f32>, pixel: vec2<f32>, extent: vec2<f32>, radius: vec2<f32>) -> f32 {
  let size = vec2<f32>(textureDimensions(shadowMap));
  let rotation = shadow_vogel_rotation(pixel);
  var lit = 0.0;
  for (var i = 0u; i < 5u; i++) {
    let point = SHADOW_VOGEL_OFFSETS[i];
    let offset = vec2<f32>(point.x * rotation.x - point.y * rotation.y, point.x * rotation.y + point.y * rotation.x);
    let sampleUv = clamp(uv + offset * radius, vec2<f32>(0.5) / size, extent - vec2<f32>(0.5) / size);
    lit += _directionalPlaneCompare(sampleUv, layer, uv, depth, gradient, extent);
  }
  return lit * 0.2;
}

fn _directionalSoft(uv: vec2<f32>, layer: i32, depth: f32, gradient: vec2<f32>, extent: vec2<f32>) -> f32 {
  let texel = vec2<f32>(1.0) / vec2<f32>(textureDimensions(shadowMap));
  let phase = fract(uv / texel + vec2<f32>(0.5));
  let base = uv - phase * texel;
  let wx = vec4<f32>(1.0 - phase.x, 1.0, 1.0, phase.x);
  let wy = vec4<f32>(1.0 - phase.y, 1.0, 1.0, phase.y);
  var sum = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      let center = clamp(base + (vec2<f32>(f32(x), f32(y)) - vec2<f32>(1.0)) * texel, texel * 0.5, extent - texel * 0.5);
      sum += _directionalPointCompare(center, layer, uv, depth, gradient) * wx[x] * wy[y];
    }
  }
  return sum / 9.0;
}

// Project into one cascade and apply its authored filter profile. Native
// comparison profiles share per-texel receiver-plane correction.
fn _sampleShadowForCascade(
  worldPos : vec3<f32>,
  layer    : u32,
  normal   : vec3<f32>,
  l        : vec3<f32>,
  layerBase : u32,
  pixel : vec2<f32>,
) -> f32 {
  let lvp = _cascadeLightViewProj(layer);
  let lightClip = lvp * vec4<f32>(worldPos, 1.0);
  let projCoords = lightClip.xyz / lightClip.w;
  let tileUv = vec2<f32>(projCoords.x * 0.5 + 0.5, -projCoords.y * 0.5 + 0.5);
  let aspect = select(1.0, view.splitPlanes[3].w, view.splitPlanes[3].w > 0.0);
  let viewportScale = vec2<f32>(min(1.0, aspect), min(1.0, 1.0 / aspect));
  let uv = tileUv * viewportScale;
  let shadowLayer = i32(layer + layerBase);
  let currentDepth = projCoords.z;
  // NaN-safe bounds: relational < and > do not reject NaN (NaN < 0 is
  // false), so a zero / degenerate lightViewProj matrix that produces
  // 0/0 = NaN would slip through. Use x >= 0 && x <= 1 instead -- NaN
  // makes the conjunction false and the early-return fires (shadow=1.0).
  // Matches the main-line pattern that survived the transform-hierarchy
  // dawn regression test (AC-08 parent-move pixel-diff on main).
  if (!(tileUv.x >= 0.0 && tileUv.x <= 1.0 && tileUv.y >= 0.0 && tileUv.y <= 1.0 && currentDepth >= 0.0 && currentDepth <= 1.0)) {
    return 1.0;
  }
  let texelDims = vec2<f32>(textureDimensions(shadowMap, 0));
  let texel = vec2<f32>(1.0 / texelDims.x, 1.0 / texelDims.y);
  // Keep every tap one texel inside the layer so edge taps repeat the edge
  // depth instead of relying on sampler clamping (AC-07, bug-20260619).
  let tileLo = texel;
  let tileHi = vec2<f32>(1.0) - texel;
  // PCF1/3/5 profiles 1/2/3 retain their existing receiver. PCSS profiles 4/5
  // use the bounded three-stage receiver below without a material or variant
  // axis; the carrier y/z lanes provide angular radius and penumbra limit.
#ifdef DIRECTIONAL_SHADOW_SIMPLE
  // Source-level specialization: the frame has exactly one cascade, no cascade
  // blend and the Vogel PCF profile. Every other profile (PCSS, kernel,
  // variance, soft) is absent from the compiled fragment; a runtime branch or a
  // pipeline override that never fires still costs registers in Metal codegen.
  let simpleDepth = currentDepth + _directionalReceiverDepthBias(layer, normal, l);
  let simpleGradient = _directionalReceiverPlaneGradient(layer, normal, l);
  let simpleRadius = texel * vec2<f32>(1.0, 1.0 / aspect) * max(1.0 + view.splitPlanes[2].w, 0.0);
  return _directionalVogel(uv, shadowLayer, simpleDepth, simpleGradient, pixel, viewportScale, simpleRadius);
#else
  let filterProfile = clamp(u32(round(view.directionalShadowFilter.x)), 1u, 8u);
  #ifdef DIRECTIONAL_PCSS_AVAILABLE
  if (filterProfile == 4u || filterProfile == 5u) {
    return _samplePcssForCascade(worldPos, layer, normal, l, filterProfile);
  }
  #endif
  let kernel = select(select(3u, 5u, filterProfile == 3u), 1u, filterProfile == 1u);
  let adjustedDepth = currentDepth + _directionalReceiverDepthBias(layer, normal, l);
  let planeGradient = _directionalReceiverPlaneGradient(layer, normal, l);
  if (filterProfile == 8u) {
    return sample_shadow_variance(uv, shadowLayer, adjustedDepth, viewportScale, view.splitPlanes[0].w > 0.5);
  }
  if (filterProfile == 7u && view.splitPlanes[0].w < 0.5) {
    return _directionalSoft(uv, shadowLayer, adjustedDepth, planeGradient, viewportScale);
  }
  if (filterProfile == 7u) {
    return sample_shadow_2d_soft(shadowMap, shadowSampler, uv, shadowLayer, texel, adjustedDepth, viewportScale);
  }
  if (filterProfile == 6u && view.splitPlanes[0].w < 0.5) {
    return _directionalVogel(uv, shadowLayer, adjustedDepth, planeGradient, pixel, viewportScale, texel * vec2<f32>(1.0, 1.0 / aspect) * max(1.0 + view.splitPlanes[2].w, 0.0));
  }
  if (filterProfile == 6u) {
    return sample_shadow_2d_vogel(shadowMap, shadowSampler, uv, shadowLayer,
      texel * vec2<f32>(1.0, 1.0 / aspect) * max(1.0 + view.splitPlanes[2].w, 0.0), adjustedDepth, planeGradient, pixel, viewportScale);
  }
  if (kernel == 1u) {
    if (view.splitPlanes[0].w > 0.5) {
      return sample_shadow_2d_nearest(shadowMap, shadowSampler, uv, shadowLayer, adjustedDepth, viewportScale);
    }
    let lit = _directionalPlaneCompare(clamp(uv, tileLo, tileHi), shadowLayer, uv, adjustedDepth, planeGradient, viewportScale);
    return lit;
  }

  // Native quality changes sample density; the authored radius owns softness.
  // Explicit constant-bias cameras retain their original integer kernels.
  let spacing = select(1.0, max(1.0 + view.splitPlanes[2].w, 0.0) / (f32(kernel - 1u) * 0.5), view.splitPlanes[0].w < 0.5);
  let sampleStep = texel * spacing;
  var blocked = 0.0;
  if (kernel == 3u) {
    // Each tap compares its own receiver-plane depth. Combining bilinear
    // weights before these nonlinear comparisons changes shadow coverage.
    for (var x = -1; x <= 1; x++) {
      for (var y = -1; y <= 1; y++) {
        let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * sampleStep, tileLo, tileHi);
        let lit = _directionalPlaneCompare(offsetUv, shadowLayer, uv, adjustedDepth, planeGradient, viewportScale);
        blocked = blocked + (1.0 - lit);
      }
    }
    return 1.0 - blocked / 9.0;
  }

  for (var x = -i32(MAX_PCF_HALF); x <= i32(MAX_PCF_HALF); x++) {
    for (var y = -i32(MAX_PCF_HALF); y <= i32(MAX_PCF_HALF); y++) {
      let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * sampleStep, tileLo, tileHi);
      let lit = _directionalPlaneCompare(offsetUv, shadowLayer, uv, adjustedDepth, planeGradient, viewportScale);
      blocked = blocked + (1.0 - lit);
    }
  }
  return 1.0 - blocked / 25.0;
#endif
}

// `evalDirectionalNoShadow` evaluates the GGX direct-lighting term for the
// single directional light carried in `view.lightDir / view.lightColor`
// WITHOUT applying any shadow factor — pure Cook-Torrance (D_GGX + V_Smith
// + F_Schlick) microfacet specular + Lambertian diffuse, returned scaled
// by `lightColor * nDotL`.
//
// feat-20260624-sprite-lit-shading-model-pure-2d-lighting M1' / w3 (D-1):
// extracted from evalDirectional so the brdf body matches the
// `evalPoint` / `evalSpot` pattern (no shadow tap inside the brdf
// function — caller multiplies the shadow factor afterwards). Industry
// alignment: Bevy / glTF Sample Renderer / Three.js all keep their
// directional brdf shadow-free; forgeax was the outlier with
// `_sampleShadowForCascade` hard-coded inside the body. Sprite-lit and
// future per-light variants get a clean shadow-free reuse target while
// mesh PBR keeps calling the wrapping `evalDirectional` (mathematically
// equivalent — see plan-strategy R-3D-mesh-PBR-output-shift).
//
// @internal — exported for sprite-lit re-use inside the engine; external
// material shaders should keep calling `evalDirectional` for backward
// compat with the cascaded-shadow pipeline.
fn evalDirectionalNoShadow(
  normal     : vec3<f32>,
  viewDir    : vec3<f32>,
  baseColor  : vec3<f32>,
  metallic   : f32,
  alphaSq    : f32,
  F0         : vec3<f32>,
  transmission : vec3<f32>,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  let l = normalize(-view.lightDir);
  let signedNDotL = dot(normal, l);
  let nDotL = max(signedNDotL, 0.0);
  let signedNDotV = dot(normal, viewDir);
  let nDotV = max(signedNDotV, 1e-5);
  // Unreal's View.MinRoughness: direct lighting only (SceneView.cpp:2921).
  let directAlpha = directLightingAlpha(alphaSq);
  // Unreal BRDF.ush:24-31 N.H / V.H from dot products; with a sun disc
  // (view.sunSourceRadius = sin(half angle) > 0) SphereMaxNoH and
  // EnergyNormalization replace them (BRDF.ush:63-137, ShadingModels.ush:122-160).
  // sunSourceRadius = 0 takes the point-light branch and is bit-identical to it.
  var nDotH : f32;
  var vDotH : f32;
  var dEnergy = 1.0;
  if (view.sunSourceRadius > 0.0) {
    let disc = sunDiscSpecularTerms(signedNDotL, signedNDotV, dot(viewDir, l), view.sunSourceRadius, directAlpha);
    nDotH = disc.x;
    vDotH = disc.y;
    dEnergy = disc.z;
  } else {
    let halfTerms = halfVectorTerms(signedNDotL, signedNDotV, dot(viewDir, l));
    nDotH = halfTerms.x;
    vDotH = halfTerms.y;
  }
  let brdf = standardOpaqueBrdfEnergy(baseColor, metallic, directAlpha, F0, nDotV, nDotL, nDotH, vDotH, dEnergy,
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );
  let transmitted = transmission * (max(-signedNDotL, 0.0) / 3.14159265);
  return brdf * view.lightColor * nDotL + transmitted * view.lightColor;
}

// Surface callers supply the actual receiver plane normal, independently of
// their BRDF normal. Volume receivers use the separate normal-free path.
fn evalDirectionalShadowFactorAtPixel(
  normal   : vec3<f32>,
  worldPos : vec3<f32>,
  viewZ    : f32,
  layerBase : u32,
  pixel : vec2<f32>,
) -> f32 {
  // `cascadeCount == 0` is the host-side sentinel for DirectionalLight
  // `castShadow:false`.  A non-shadow-casting light must stay fully lit: the
  // fallback depth view and zeroed light matrices only satisfy the bind-group
  // shape and are not a valid CSM sample.  Do this before the count clamp so
  // the disabled path cannot accidentally project through cascade zero.
  if (view.cascadeCount < 1.0) {
    return 1.0;
  }
  let l = normalize(-view.lightDir);
  let count = u32(max(view.cascadeCount, 1.0));
  let viewDepth = -viewZ;
  // `pssmSplit` stores the authored shadowDistance in the last active split.
  // Geometry beyond that distance is intentionally unshadowed; reject it
  // before cascade projection, shadow dimension queries, and the PCF loop.
  if (viewDepth > view.splitPlanes[count - 1u].x) {
    return 1.0;
  }
#ifdef DIRECTIONAL_SHADOW_SIMPLE
  let simpleShadow = _sampleShadowForCascade(worldPos + normal * view.normalBias, 0u, normal, l, layerBase, pixel);
  return mix(1.0, simpleShadow, 1.0 - view.splitPlanes[1].w);
#else
  let layer = _pickCascadeLayer(viewDepth, count);
  // normalBias is a world-space distance, independent of cascade depth span.
  let receiverPosition = worldPos + normal * view.normalBias;
  var blend = 0.0;
  if (view.cascadeBlend > 0.0 && layer + 1u < count) {
    let spCurr = view.splitPlanes[layer].x;
    let blendWidth = spCurr * view.cascadeBlend;
    if (blendWidth > 0.0) {
      let dist = spCurr - viewDepth;
      blend = clamp(1.0 - dist / blendWidth, 0.0, 1.0);
    }
  }
  // Keep one native filter call site. Duplicating the complete receiver for
  // cascade blending can crash Metal code generation in composed medium shaders.
  // The uniform bound still samples only the current and, when needed, next layer.
  let sampleCount = select(1u, 2u, blend > 0.0);
  var shadow = 1.0;
  for (var sample = 0u; sample < sampleCount; sample++) {
    let value = _sampleShadowForCascade(receiverPosition, layer + sample, normal, l, layerBase, pixel);
    if (sample == 0u) {
      shadow = value;
    } else {
      shadow = mix(shadow, value, blend);
    }
  }
  return mix(1.0, shadow, 1.0 - view.splitPlanes[1].w);
#endif
}

// Volume receivers are samples in a medium, not surfaces. They therefore use
// the same cascade selection, layer selection, PCF, and shadow-distance SSOT
// but only the bounded constant receiver bias; a ray direction is never
// treated as a geometric normal for normalBias.
fn evalDirectionalVolumeShadowFactor(
  worldPos : vec3<f32>,
  viewDepth : f32,
) -> f32 {
  if (view.cascadeCount < 1.0 || viewDepth > view.splitPlanes[u32(max(view.cascadeCount, 1.0)) - 1u].x) {
    return 1.0;
  }
  let count = u32(max(view.cascadeCount, 1.0));
  let layer = _pickCascadeLayer(viewDepth, count);
  let lightDirection = normalize(-view.lightDir);
  let current = _sampleShadowForCascade(worldPos, layer, vec3<f32>(0.0), lightDirection, 0u, vec2<f32>(0.0));
  if (view.cascadeBlend <= 0.0 || layer + 1u >= count) {
    return current;
  }
  let blendWidth = view.splitPlanes[layer].x * view.cascadeBlend;
  if (blendWidth <= 0.0) {
    return current;
  }
  let blend = clamp(1.0 - (view.splitPlanes[layer].x - viewDepth) / blendWidth, 0.0, 1.0);
  let next = _sampleShadowForCascade(worldPos, layer + 1u, vec3<f32>(0.0), lightDirection, 0u, vec2<f32>(0.0));
  return mix(current, next, blend);
}

// `evalDirectional` evaluates the GGX direct-lighting term for the single
// directional light carried in `view.lightDir / view.lightColor`. CSM
// pathway: pick cascade layer from viewZ + splitPlanes, sample that layer
// via the matching lightViewProj, optionally blend with the next
// cascade across a `cascadeBlend`-wide boundary band.
//
// feat-20260624 M1' / w3 (D-1): body now delegates the brdf math to
// `evalDirectionalNoShadow` and multiplies the cascade shadow factor at
// the call site (mirrors `evalPoint` / `evalSpot` shape). Output is
// mathematically equivalent to the pre-refactor inline form — mesh PBR
// pixel-parity bench is the regression guard (w8).
// Preserve the coordinate-free public helper for custom receivers. Built-in
// raster receivers supply framebuffer coordinates to the shared pixel path.
fn evalDirectionalShadowFactor(normal: vec3<f32>, worldPos: vec3<f32>,
  viewZ: f32, layerBase: u32) -> f32 {
  return evalDirectionalShadowFactorAtPixel(normal, worldPos, viewZ, layerBase, worldPos.xy);
}

fn evalDirectional(
  normal     : vec3<f32>,
  viewDir    : vec3<f32>,
  baseColor  : vec3<f32>,
  metallic   : f32,
  alphaSq    : f32,
  F0         : vec3<f32>,
  worldPos   : vec3<f32>,
  viewZ      : f32,
  useDirectDfgLut: bool,
#ifdef DIRECT_DFG_LUT_AVAILABLE
  directDfgLut: texture_2d<f32>, directDfgSampler: sampler,
#endif
) -> vec3<f32> {
  // No-shadow brdf body (factored out — same expression as the prior
  // inline form, multiplied by shadow factor below). Reuse keeps the
  // mesh PBR output byte-equivalent and gives sprite-lit a shared
  // shadow-free entry point.
  let lit = evalDirectionalNoShadow(normal, viewDir, baseColor, metallic, alphaSq, F0, vec3<f32>(0.0),
    useDirectDfgLut,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );

  // Cascade selection + layer sampling (AC-03 / AC-05 / AC-06 / AC-10).
  // feat-20260613-csm-cascaded-shadow-maps M5 / w18: uses inline 9-tap PCF
  // inside `_sampleShadowForCascade` rather than the shared sample_shadow_2d
  // (forgeax_pbr::shadow_pcf used by point-light) — the cascade dispatch
  // wraps the kernel per-tile so the shared core's `(uv, currentDepth)`
  // entry shape doesn't fit (it expects pre-projected light-space coords;
  // CSM derives them per-cascade after dispatch). F-J-1 future-tracks the
  // dedup once `forgeax_view::cascade` lands as its own module (post-#387).
  return lit * evalDirectionalShadowFactor(normal, worldPos, viewZ, 0u);
}
