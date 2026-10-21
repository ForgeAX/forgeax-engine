#define_import_path forgeax_pbr::lighting_directional

// @forgeax/engine-shader - lighting-directional.wgsl
// (feat-20260523-shader-template-instance-split M5 / T02;
//  feat-20260613-csm-cascaded-shadow-maps-unique-shadow-path M5 / w18 rewrite).
//
// Directional-light evaluator extracted from pbr.wgsl. Cook-Torrance
// (D_GGX + V_Smith + F_Schlick) microfacet specular + Lambertian diffuse,
// modulated by a slope-scaled-bias 3x3 PCF shadow lookup against the
// host's layered CSM shadow map (LearnOpenGL 3.1.3 PCF model + Bevy-style
// cascaded shadow maps).
//
// Cascade selection (feat-20260613 AC-03 / AC-06 / AC-10):
//   1. Pick layer in 0..cascadeCount-1 based on viewZ vs splitPlanes[i].
//      The same code path covers a 1-layer config (single tile) and a
//      4-layer config (Bevy default) -- AC-03 forbids any single-cascade
//      fallback branch.
//   2. Project worldPos through the matching lightViewProj. The host emits
//      pure clip-space matrices (orthoProj * lightView); each cascade owns
//      one full layer of the depth array, so NDC maps straight to layer UV.
//   3. textureSampleCompareLevel against shadowMap layer `layer` with a
//      slope-scaled bias (LO 3.1.3) and 3x3 PCF tap kernel.
//   4. When cascadeBlend > 0 and the fragment lies near the cascade
//      boundary, mix(shadow_curr, shadow_next, t) where t walks 0->1
//      across a band of width splitPlanes[layer] * cascadeBlend.
//
// feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-2 (plan-strategy D-4):
// 9-tap PCF taps come from shared sample_shadow_2d in forgeax_pbr::shadow_pcf.
// Bias formula and 9-tap kernel are byte-equivalent to the prior inline
// version (research L1.5 lines 47-81); the shared core is the single SSOT
// for directional + point-light PCF.
//
// Pulls View + shadowMap from forgeax_view::common -- the helper inherits
// the group(0) binding namespace from the host material shader (every
// consumer already imports forgeax_view::common). Shadow PCF taps use
// textureSampleCompareLevel against the comparison sampler so the path
// is portable across WebGPU + GLES.
//
// Exports:
//   - evalDirectional(...) -> vec3<f32>  (Cook-Torrance + CSM shadow mod)
//   - evalDirectionalNoShadow(...) -> vec3<f32>  (Cook-Torrance, no shadow;
//     sprite-lit M1' / w3 D-1; also the inner brdf body of evalDirectional)
//   - evalDirectionalShadowFactor(...) -> f32 (one reusable CSM sample for
//     layered BRDFs such as base + clearcoat)

#import forgeax_view::common::{view, shadowMap, shadowSampler}
#import forgeax_pbr::brdf::{standardOpaqueBrdf}
#import forgeax_pbr::shadow_pcf::{sample_shadow_2d_nearest, sample_shadow_2d, sample_shadow_2d_vogel, sample_shadow_2d_soft, sample_shadow_variance}
#ifdef DIRECTIONAL_PCSS_AVAILABLE
#import forgeax_pbr::shadow_pcf::{shadow_clamp_texel_to_tile, shadow_load_raw_depth, shadow_sample_compare}
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
const PCSS_DISK_OFFSETS : array<vec2<f32>, 32> = array<vec2<f32>, 32>(
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

fn _directionalReceiverDepthBias(layer : u32, normal : vec3<f32>, l : vec3<f32>, radius : f32) -> f32 {
  if (view.splitPlanes[0].w > 0.5) { return view.depthBias; }
  let nDotL = dot(normal, l);
  let depthSpan = view.splitPlanes[layer].z;
  // Every front-facing receiver needs its filter footprint, including grazing
  // angles. A fixed cosine cutoff creates a discontinuity in self-shadowing.
  if (!(nDotL > 0.0 && depthSpan > 0.0)) {
    return view.depthBias;
  }
  let matrix = _cascadeLightViewProj(layer);
  let right = normalize(vec3<f32>(matrix[0].x, matrix[1].x, matrix[2].x));
  let up = normalize(vec3<f32>(matrix[0].y, matrix[1].y, matrix[2].y));
  let footprint = view.splitPlanes[layer].y * radius * (abs(dot(normal, right)) + abs(dot(normal, up)));
  // The authored world normal offset already separates the receiver plane.
  // Add only the missing footprint coverage, in this cascade's depth units.
  let missingCoverage = max(0.0, footprint - view.normalBias);
  if (!(missingCoverage > 0.0)) {
    return view.depthBias;
  }
  // Receiver depths are nonnegative and stored depths are at most one. The
  // sampler uses strict greater, so bound total bias by the next f32 above
  // one, after adding the authored floor. This preserves zero/negative floors
  // and every comparison while making an overflowed positive bias finite.
  return min(1.00000011920928955078125, view.depthBias + missingCoverage / nDotL / depthSpan);
}

// Receiver-plane depth gradient (Isidoro 2006): normalized light depth change
// per shadow texel along +u / +v on the receiver's tangent plane. PCF taps
// compare against the plane depth at their own offset, so the receiver depth
// bias only covers one texel of bilinear footprint instead of the whole
// kernel radius. Zero where the plane is not a valid lit receiver.
fn _directionalReceiverPlaneGradient(layer : u32, normal : vec3<f32>, l : vec3<f32>) -> vec2<f32> {
  if (view.splitPlanes[0].w > 0.5) { return vec2<f32>(0.0); }
  if (!(dot(normal, l) > 0.01)) {
    return vec2<f32>(0.0);
  }
  let matrix = _cascadeLightViewProj(layer);
  let row0 = vec3<f32>(matrix[0].x, matrix[1].x, matrix[2].x);
  let row1 = vec3<f32>(matrix[0].y, matrix[1].y, matrix[2].y);
  let row2 = vec3<f32>(matrix[0].z, matrix[1].z, matrix[2].z);
  let sx = length(row0);
  let sy = length(row1);
  let sz = length(row2);
  let nz = dot(row2, normal) / sz;
  if (!(abs(nz) > 0.01 && sx > 0.0 && sy > 0.0)) {
    return vec2<f32>(0.0);
  }
  let texels = vec2<f32>(textureDimensions(shadowMap, 0));
  // Clip x grows with +u and clip y with -v; one texel spans 2 / size in clip.
  let dzdx = -(dot(row0, normal) / sx) * sz / (nz * sx);
  let dzdy = -(dot(row1, normal) / sy) * sz / (nz * sy);
  return vec2<f32>(dzdx * 2.0 / texels.x, -dzdy * 2.0 / texels.y);
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
  let planeCorrected = dot(normal, l) > 0.01;
  // Raw and comparison samples land at exact texel centers. Compare the
  // receiver plane at each center, without biasing past thin blockers by the
  // full search radius. Retain bounded footprint bias at grazing degeneracy.
  let biasedDepth = projCoords.z + select(
    _directionalReceiverDepthBias(layer, normal, l, rawRadius + 1.0), view.depthBias, planeCorrected);
  var blockerDepth = 0.0;
  var blockerCount = 0u;
  if (profile == 4u) {
    for (var i = 0u; i < PCSS_MEDIUM_RAW_TAPS; i = i + 1u) {
      let rawUv = _pcssProjectedSample(shadowMapSize, baseTexel, _pcssDiskPoint(i, angle, rawRadius));
      let rawTexel = vec2<i32>(rawUv * vec2<f32>(shadowMapSize) - vec2<f32>(0.5));
      let rawDepth = shadow_load_raw_depth(shadowMap, rawTexel, i32(layer));
      let correctedDepth = rawDepth - dot(planeGradient, (rawUv - tileUv) * vec2<f32>(shadowMapSize));
      if (rawDepth > 0.0 && rawDepth <= 1.0 && correctedDepth > biasedDepth) {
        blockerDepth = blockerDepth + correctedDepth;
        blockerCount = blockerCount + 1u;
      }
    }
  } else {
    for (var i = 0u; i < PCSS_HIGH_RAW_TAPS; i = i + 1u) {
      let rawUv = _pcssProjectedSample(shadowMapSize, baseTexel, _pcssDiskPoint(i, angle, rawRadius));
      let rawTexel = vec2<i32>(rawUv * vec2<f32>(shadowMapSize) - vec2<f32>(0.5));
      let rawDepth = shadow_load_raw_depth(shadowMap, rawTexel, i32(layer));
      let correctedDepth = rawDepth - dot(planeGradient, (rawUv - tileUv) * vec2<f32>(shadowMapSize));
      if (rawDepth > 0.0 && rawDepth <= 1.0 && correctedDepth > biasedDepth) {
        blockerDepth = blockerDepth + correctedDepth;
        blockerCount = blockerCount + 1u;
      }
    }
  }
  if (blockerCount == 0u) {
    return 1.0;
  }

  let averageBlockerDepth = blockerDepth / f32(blockerCount);
  let lightDepthWorldSpan = max(view.splitPlanes[layer].z, 0.0);
  let worldUnitsPerTexel = max(view.splitPlanes[layer].y, 0.0);
  if (!(lightDepthWorldSpan > 0.0 && worldUnitsPerTexel > 0.0 && view.directionalShadowFilter.y >= 0.0 && view.directionalShadowFilter.z >= 0.0)) {
    return 1.0;
  }
  let worldDistance = max(0.0, averageBlockerDepth - biasedDepth) * lightDepthWorldSpan;
  let penumbraTexels = clamp(
    worldDistance * tan(view.directionalShadowFilter.y) / worldUnitsPerTexel,
    0.0,
    view.directionalShadowFilter.z,
  );
  let compareRadius = max(0.5, penumbraTexels);
  let compareDepth = projCoords.z + select(
    _directionalReceiverDepthBias(layer, normal, l, compareRadius + 1.5), view.depthBias, planeCorrected);
  var litSum = 0.0;
  if (profile == 4u) {
    for (var i = 0u; i < PCSS_MEDIUM_COMPARE_TAPS; i = i + 1u) {
      let compareUv = _pcssProjectedSample(shadowMapSize, baseTexel, _pcssDiskPoint(i, angle, compareRadius));
      let tapDepth = compareDepth + dot(planeGradient, (compareUv - tileUv) * vec2<f32>(shadowMapSize));
      litSum = litSum + shadow_sample_compare(shadowMap, shadowSampler, compareUv, i32(layer), tapDepth);
    }
    return litSum / f32(PCSS_MEDIUM_COMPARE_TAPS);
  }
  for (var i = 0u; i < PCSS_HIGH_COMPARE_TAPS; i = i + 1u) {
    let compareUv = _pcssProjectedSample(shadowMapSize, baseTexel, _pcssDiskPoint(i, angle, compareRadius));
    let tapDepth = compareDepth + dot(planeGradient, (compareUv - tileUv) * vec2<f32>(shadowMapSize));
    litSum = litSum + shadow_sample_compare(shadowMap, shadowSampler, compareUv, i32(layer), tapDepth);
  }
  return litSum / f32(PCSS_HIGH_COMPARE_TAPS);
}
#endif

// Sample the cascade's shadow layer with the LO 3.1.3 slope-scaled bias +
// dynamic PCF kernel (driven by the directional filter profile,
// MAX_PCF_HALF=2), against the lightViewProj for the chosen cascade.
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
  let filterProfile = clamp(u32(round(view.directionalShadowFilter.x)), 1u, 8u);
  #ifdef DIRECTIONAL_PCSS_AVAILABLE
  if (filterProfile == 4u || filterProfile == 5u) {
    return _samplePcssForCascade(worldPos, layer, normal, l, filterProfile);
  }
  #endif
  let kernel = select(select(3u, 5u, filterProfile == 3u), 1u, filterProfile == 1u);
  // Integer PCF offsets retain this bilinear phase. Bound only the actual
  // distance to its four texel centers, rather than a full texel everywhere.
  let phase = fract(uv * texelDims - vec2<f32>(0.5));
  let reach = max(phase, vec2<f32>(1.0) - phase);
  let footprintRadius = select(max(reach.x, reach.y), 1.0, filterProfile == 6u);
  let adjustedDepth = currentDepth + _directionalReceiverDepthBias(layer, normal, l, footprintRadius);
  let planeGradient = _directionalReceiverPlaneGradient(layer, normal, l);
  if (filterProfile == 8u) {
    return sample_shadow_variance(uv, shadowLayer, adjustedDepth, viewportScale);
  }
  if (filterProfile == 7u) {
    return sample_shadow_2d_soft(shadowMap, shadowSampler, uv, shadowLayer, texel, adjustedDepth, viewportScale);
  }
  if (filterProfile == 6u) {
    return sample_shadow_2d_vogel(shadowMap, shadowSampler, uv, shadowLayer,
      texel * vec2<f32>(1.0, 1.0 / aspect) * max(1.0 + view.splitPlanes[2].w, 0.0), adjustedDepth, planeGradient, pixel, viewportScale);
  }
  if (kernel == 1u) {
    if (view.splitPlanes[0].w > 0.5) {
      return sample_shadow_2d_nearest(shadowMap, shadowSampler, uv, shadowLayer, adjustedDepth, viewportScale);
    }
    let lit = textureSampleCompareLevel(shadowMap, shadowSampler, clamp(uv, tileLo, tileHi), shadowLayer, adjustedDepth);
    return lit;
  }

  var blocked = 0.0;
  if (kernel == 3u) {
    // Each tap compares its own receiver-plane depth. Combining bilinear
    // weights before these nonlinear comparisons changes shadow coverage.
    for (var x = -1; x <= 1; x++) {
      for (var y = -1; y <= 1; y++) {
        let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * texel, tileLo, tileHi);
        let tapDepth = adjustedDepth + dot(planeGradient, (offsetUv - uv) / texel);
        let lit = textureSampleCompareLevel(shadowMap, shadowSampler, offsetUv, shadowLayer, tapDepth);
        blocked = blocked + (1.0 - lit);
      }
    }
    return 1.0 - blocked / 9.0;
  }

  for (var x = -i32(MAX_PCF_HALF); x <= i32(MAX_PCF_HALF); x++) {
    for (var y = -i32(MAX_PCF_HALF); y <= i32(MAX_PCF_HALF); y++) {
      let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * texel, tileLo, tileHi);
      let tapDepth = adjustedDepth + dot(planeGradient, (offsetUv - uv) / texel);
      let lit = textureSampleCompareLevel(shadowMap, shadowSampler, offsetUv, shadowLayer, tapDepth);
      blocked = blocked + (1.0 - lit);
    }
  }
  return 1.0 - blocked / 25.0;
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
  let halfVector = viewDir + l;
  let halfVectorLengthSquared = max(dot(halfVector, halfVector), 1e-8);
  let h = halfVector * inverseSqrt(halfVectorLengthSquared);
  let signedNDotL = dot(normal, l);
  let nDotL = max(signedNDotL, 0.0);
  let nDotV = max(dot(normal, viewDir), 1e-5);
  let nDotH = max(dot(normal, h), 0.0);
  let vDotH = max(dot(viewDir, h), 0.0);
  let brdf = standardOpaqueBrdf(baseColor, metallic, alphaSq, F0, nDotV, nDotL, nDotH, vDotH,
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
  let layer = _pickCascadeLayer(viewDepth, count);
  // normalBias is a world-space distance, independent of cascade depth span.
  let receiverPosition = worldPos + normal * view.normalBias;
  let shadowCurr = _sampleShadowForCascade(receiverPosition, layer, normal, l, layerBase, pixel);

  var shadow = shadowCurr;
  if (view.cascadeBlend > 0.0 && layer + 1u < count) {
    let spCurr = view.splitPlanes[layer].x;
    let blendWidth = spCurr * view.cascadeBlend;
    if (blendWidth > 0.0) {
      let dist = spCurr - viewDepth;
      let t = clamp(1.0 - dist / blendWidth, 0.0, 1.0);
      if (t > 0.0) {
        let shadowNext = _sampleShadowForCascade(receiverPosition, layer + 1u, normal, l, layerBase, pixel);
        shadow = mix(shadowCurr, shadowNext, t);
      }
    }
  }
  return mix(1.0, shadow, 1.0 - view.splitPlanes[1].w);
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
  let current = _sampleShadowForCascade(worldPos, layer, vec3<f32>(0.0), lightDirection, 0u);
  if (view.cascadeBlend <= 0.0 || layer + 1u >= count) {
    return current;
  }
  let blendWidth = view.splitPlanes[layer].x * view.cascadeBlend;
  if (blendWidth <= 0.0) {
    return current;
  }
  let blend = clamp(1.0 - (view.splitPlanes[layer].x - viewDepth) / blendWidth, 0.0, 1.0);
  let next = _sampleShadowForCascade(worldPos, layer + 1u, vec3<f32>(0.0), lightDirection, 0u);
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
