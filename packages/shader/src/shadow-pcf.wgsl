#define_import_path forgeax_pbr::shadow_pcf

// Shared comparison sampling for directional, Spot and Point shadows.
// Default directional/punctual filtering uses five rotated Vogel taps.
// Punctual width 1 uses one hardware comparison; width 5 doubles the radius.
// Legacy 2D grid helpers below remain available to volume/cascade callers.
// Receiver bias and cascade admission belong to those callers.
// Return: 1.0 = fully lit, 0.0 = fully shadowed.

// === Directional PCSS sampling primitives ====================================
//
// These functions deliberately accept tile bounds and a layer from their
// caller. They own
// only integer addressing, raw depth, comparison sampling, and the shared
// receiver-bias equation; cascade selection, profile selection, blocker
// averaging, penumbra sizing, and cascade blending remain Directional policy.

fn shadow_clamp_texel_to_tile(
  texel      : vec2<i32>,
  tileOrigin : vec2<i32>,
  tileSize   : vec2<i32>,
  inset      : i32,
) -> vec2<i32> {
  let tileMin = tileOrigin + vec2<i32>(inset);
  let tileMax = tileOrigin + max(vec2<i32>(inset), tileSize - vec2<i32>(1 + inset));
  return min(tileMax, max(tileMin, texel));
}

fn shadow_load_raw_depth(
  shadowMap : texture_depth_2d_array,
  texel     : vec2<i32>,
  layer     : i32,
) -> f32 {
  return textureLoad(shadowMap, texel, layer, 0);
}

fn shadow_sample_compare(
  shadowMap    : texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  uv           : vec2<f32>,
  layer        : i32,
  depthRef     : f32,
) -> f32 {
  return textureSampleCompareLevel(shadowMap, shadowSampler, uv, layer, depthRef);
}

fn shadow_biased_receiver_depth(
  receiverDepth : f32,
  normalBias    : f32,
  depthBias     : f32,
  nDotL         : f32,
) -> f32 {
  return receiverDepth + max(normalBias * (1.0 - nDotL), depthBias);
}

// 3x3 integer offset table for PCF kernel (9 taps).
// Extracted from lighting-directional.wgsl inline loop (T-M2-4);
// `sample_shadow_2d` walks all 9 taps; `sample_shadow_cube_hw2x2` does NOT
// use this table (cubemap sampling has no UV parameterization across face
// seams — see Round-2 F-2 finding).
const PCF_OFFSETS = array<vec2<i32>, 9>(
  vec2<i32>(-1, -1), vec2<i32>( 0, -1), vec2<i32>( 1, -1),
  vec2<i32>(-1,  0), vec2<i32>( 0,  0), vec2<i32>( 1,  0),
  vec2<i32>(-1,  1), vec2<i32>( 0,  1), vec2<i32>( 1,  1),
);

// === 2D directional-shadow wrapper ============================================
//
// `shadowMap` is a layered depth array and `layer` selects one shadow view.
// `uv` is the [0,1]^2 projected light-clip coordinate within that layer.
// `texel` is 1.0 / textureDimensions(shadowMap, 0) precomputed by the caller.
// Taps are clamped one texel inside the layer, so a PCF footprint never
// depends on sampler edge behavior.
//
// The caller must perform the OOB gate `uv in [0,1] && depthRef in [0,1]` before
// calling this function; OOB returns fully lit (1.0) upstream.

fn sample_shadow_2d(
  shadowMap    : texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  uv           : vec2<f32>,
  layer        : i32,
  texel        : vec2<f32>,
  depthRef     : f32,
  normalBias   : f32,
  depthBias    : f32,
  nDotL        : f32,
) -> f32 {
  return sample_shadow_2d_kernel(
    shadowMap, shadowSampler, uv, layer, texel, depthRef, normalBias, depthBias, nDotL, 3.0,
  );
}

fn sample_shadow_2d_kernel(
  shadowMap    : texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  uv           : vec2<f32>,
  layer        : i32,
  texel        : vec2<f32>,
  depthRef     : f32,
  normalBias   : f32,
  depthBias    : f32,
  nDotL        : f32,
  kernelSize   : f32,
) -> f32 {
  // feat-20260621-merge-directionallightshadow-into-directionallight M3 / m3-t5:
  // param names aligned to the D-1 directional convention -- the slope
  // coefficient is `normalBias` (scales the 1 - dot(N,L) term) and the floor is
  // `depthBias`. Pure formal-parameter rename: the two names are swapped in BOTH
  // the signature and the formula, so each positional argument keeps its prior
  // role and all call sites are unaffected. The /1000.0 floor scaling is the
  // existing point-light convention and is preserved.
  let bias = max(normalBias * (1.0 - nDotL), depthBias / 1000.0);
  let adjustedDepth = depthRef + bias;

  let halfWidth = clamp((i32(round(kernelSize)) - 1) / 2, 0, 2);
  // Variable odd-kernel PCF. textureSampleCompareLevel returns 1.0 when
  // adjustedDepth > sampledDepth.
  let tileLo = texel;
  let tileHi = vec2<f32>(1.0) - texel;
  var blocked = 0.0;
  var samples = 0.0;
  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      if (abs(x) <= halfWidth && abs(y) <= halfWidth) {
        let offsetUv = clamp(uv + vec2<f32>(f32(x), f32(y)) * texel, tileLo, tileHi);
        let lit = textureSampleCompareLevel(shadowMap, shadowSampler, offsetUv, layer, adjustedDepth);
        blocked = blocked + (1.0 - lit);
        samples = samples + 1.0;
      }
    }
  }
  return 1.0 - blocked / max(samples, 1.0);
}

// === Cube point-light-shadow wrapper =========================================
//
// `shadowAtlas` is @group(0) @binding(5) texture_depth_cube_array.
// `shadowSampler` is @group(0) @binding(4) sampler_comparison (shared with
// directional shadows — same sampler type, no dimension distinction).
// `lightLocal` is the raw light-to-fragment direction vector in the cubemap's
// coordinate system. evalPointShadowed and buildPointShadowMatrices share the
// CubeCamera face directions and clip-space-X reflection convention.
// `layer` is the cube_array layer index (i32; 0..3 for 4 shadow-casting
// point lights; sentinel -1 must be gated upstream — this function assumes
// a valid layer).
// `depthRef` is the reconstructed [0,1] NDC depth of the already-biased
// receiver (largest-axis projection, Bevy fetch_point_shadow pattern).
//
// The width-1 branch uses one native 2x2 comparison. Wider Point filters
// below perturb the direction in its tangent plane before each comparison.

fn sample_shadow_cube_hw2x2(
  shadowAtlas   : texture_depth_cube_array,
  shadowSampler : sampler_comparison,
  lightLocal    : vec3<f32>,
  layer         : i32,
  depthRef      : f32,
) -> f32 {
  // Single textureSampleCompareLevel call: the comparison sampler resolves a
  // 2x2 PCF neighborhood at the silicon level; clamp-to-edge address mode
  // handles face-boundary texel fetches. Returns 1.0 = fully lit, 0.0 = fully
  // shadowed. Point receiver bias is applied in world space by the caller:
  // the cube depth is hyperbolic, so a normalized-depth offset would erase
  // every shadow beyond a few near-plane multiples.
  return textureSampleCompareLevel(shadowAtlas, shadowSampler, lightLocal, layer, depthRef);
}

// Three.js r184 PCF: five Vogel disk samples, radius one shadow texel,
// rotated per receiver pixel with interleaved gradient noise. The fixed disk
// owns the sample geometry; only its pixel-dependent rotation is evaluated.
const SHADOW_VOGEL_OFFSETS = array<vec2<f32>, 5>(
  vec2<f32>(0.3162277660, 0.0000000000),
  vec2<f32>(-0.4038735677, 0.3699812715),
  vec2<f32>(0.0618193228, -0.7043992982),
  vec2<f32>(0.5090564736, 0.6639740256),
  vec2<f32>(-0.9341812369, -0.1652435071),
);

fn shadow_vogel_rotation(pixel: vec2<f32>) -> vec2<f32> {
  let noise = fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
  let angle = noise * 6.28318530718;
  return vec2<f32>(cos(angle), sin(angle));
}

// Point and Spot use the same five-sample default as Three r184 WebGPU.
// Width remains an author footprint, independent of the number of comparisons.
fn sample_shadow_2d_punctual(
  shadowMap: texture_depth_2d_array, shadowSampler: sampler_comparison,
  uv: vec2<f32>, layer: i32, texel: vec2<f32>, depthRef: f32,
  kernelSize: f32, pixel: vec2<f32>, extent: vec2<f32>,
) -> f32 {
  let radius = max(0.0, (kernelSize - 1.0) * 0.5);
  if (radius == 0.0) {
    let edge = vec2<f32>(0.5) / vec2<f32>(textureDimensions(shadowMap));
    return textureSampleCompareLevel(shadowMap, shadowSampler, clamp(uv, edge, extent - edge), layer, depthRef);
  }
  return sample_shadow_2d_vogel(shadowMap, shadowSampler, uv, layer,
    texel * radius, depthRef, vec2<f32>(0.0), pixel, extent);
}

fn sample_shadow_cube_vogel(
  shadowAtlas: texture_depth_cube_array, shadowSampler: sampler_comparison,
  lightLocal: vec3<f32>, layer: i32, depthRef: f32,
  kernelSize: f32, pixel: vec2<f32>,
) -> f32 {
  let radius = max(0.0, (kernelSize - 1.0) * 0.5);
  if (radius == 0.0) {
    return sample_shadow_cube_hw2x2(shadowAtlas, shadowSampler, lightLocal, layer, depthRef);
  }
  let direction = normalize(lightLocal);
  let tangent = normalize(cross(direction,
    select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), abs(direction.x) > abs(direction.z))));
  let bitangent = cross(direction, tangent);
  let texel = radius / f32(textureDimensions(shadowAtlas).x);
  let rotation = shadow_vogel_rotation(pixel);
  var lit = 0.0;
  for (var i = 0u; i < 5u; i++) {
    let point = SHADOW_VOGEL_OFFSETS[i];
    let offset = vec2<f32>(point.x * rotation.x - point.y * rotation.y,
      point.x * rotation.y + point.y * rotation.x);
    lit += textureSampleCompareLevel(shadowAtlas, shadowSampler,
      direction + (tangent * offset.x + bitangent * offset.y) * texel, layer, depthRef);
  }
  return lit * 0.2;
}

fn sample_shadow_2d_vogel(
  shadowMap: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  uv: vec2<f32>,
  layer: i32,
  texel: vec2<f32>,
  depthRef: f32,
  planeGradient: vec2<f32>,
  pixel: vec2<f32>,
  extent: vec2<f32>,
) -> f32 {
  if (any(texel <= vec2<f32>(0.0))) {
    let edge = vec2<f32>(0.5) / vec2<f32>(textureDimensions(shadowMap));
    return textureSampleCompareLevel(shadowMap, shadowSampler, clamp(uv, edge, extent - edge), layer, depthRef);
  }
  let rotation = shadow_vogel_rotation(pixel);
  var lit = 0.0;
  for (var i = 0u; i < 5u; i++) {
    let point = SHADOW_VOGEL_OFFSETS[i];
    let offset = vec2<f32>(point.x * rotation.x - point.y * rotation.y,
      point.x * rotation.y + point.y * rotation.x);
    // Match Three's unclamped Vogel footprint. Clamp only the position used
    // by receiver-plane correction to the comparison sampler's edge texel.
    let physicalTexel = vec2<f32>(1.0) / vec2<f32>(textureDimensions(shadowMap));
    let sampleUv = clamp(uv + offset * texel, physicalTexel * 0.5, extent - physicalTexel * 0.5);
    let receiverUv = clamp(sampleUv, 0.5 * texel, vec2<f32>(1.0) - 0.5 * texel);
    let sampleDepth = depthRef + dot(planeGradient, (receiverUv - uv) / texel);
    lit += textureSampleCompareLevel(shadowMap, shadowSampler, sampleUv, layer, sampleDepth);
  }
  return lit * 0.2;
}

// Sampling at the texel center gives one unfiltered comparison without mixing
// raw depth loads with comparison sampling in the same shader.
fn sample_shadow_2d_nearest(shadowMap: texture_depth_2d_array, shadowSampler: sampler_comparison,
  uv: vec2<f32>, layer: i32, depthRef: f32, extent: vec2<f32>) -> f32 {
  let dimensions = vec2<f32>(textureDimensions(shadowMap));
  let pixel = clamp(floor(uv * dimensions), vec2<f32>(0.0), dimensions * extent - vec2<f32>(1.0));
  return textureSampleCompareLevel(shadowMap, shadowSampler, (pixel + vec2<f32>(0.5)) / dimensions, layer, depthRef);
}

// Separable r184 PCFSoft weights: nine bilinear contributions on a 4x4 grid.
fn sample_shadow_2d_soft(shadowMap: texture_depth_2d_array, shadowSampler: sampler_comparison,
  uv: vec2<f32>, layer: i32, texel: vec2<f32>, depthRef: f32, extent: vec2<f32>) -> f32 {
  let phase = fract(uv / texel + vec2<f32>(0.5));
  let base = uv - phase * texel;
  let wx = vec4<f32>(1.0 - phase.x, 1.0, 1.0, phase.x);
  let wy = vec4<f32>(1.0 - phase.y, 1.0, 1.0, phase.y);
  var sum = 0.0;
  for (var y = 0u; y < 4u; y++) {
    for (var x = 0u; x < 4u; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler,
        clamp(base + (vec2<f32>(f32(x), f32(y)) - vec2<f32>(1.0)) * texel, texel * 0.5, extent - texel * 0.5), layer, depthRef) * wx[x] * wy[y];
    }
  }
  return sum / 9.0;
}

// The extended lighting layout supplies an RG16F array of filtered moments.
#ifdef EXTENDED_LIGHTING_AVAILABLE
#import forgeax_view::common::{shadowMoments, spotModifierSampler}
#endif
fn sample_shadow_variance(uv : vec2<f32>, layer : i32, reversedDepth : f32, extent : vec2<f32>) -> f32 {
#ifdef EXTENDED_LIGHTING_AVAILABLE
  let edge = vec2<f32>(0.5) / vec2<f32>(textureDimensions(shadowMoments));
  let distribution = textureSampleLevel(shadowMoments, spotModifierSampler, clamp(uv, edge, extent - edge), layer, 0.0).rg;
  let depth = 1.0 - reversedDepth;
  if (depth <= distribution.x) { return 1.0; }
  let variance = max(0.0000001, distribution.y * distribution.y);
  let delta = depth - distribution.x;
  return clamp((variance / (variance + delta * delta) - 0.3) / 0.65, 0.0, 1.0);
#else
  return 1.0;
#endif
}
