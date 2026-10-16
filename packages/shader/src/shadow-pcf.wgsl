#define_import_path forgeax_pbr::shadow_pcf

// @forgeax/engine-shader - shadow-pcf.wgsl
// feat-20260612-point-light-shadows-urp-hdrp M2 / T-M2-1 (plan-strategy D-4).
//
// Shared PCF (percentage-closer filtering) for directional and point-light
// shadow sampling. Single SSOT for the 2D slope-scaled bias formula and 9-tap
// 3x3 kernel-offset table. Directional shadows (2D) and point-light shadows
// (cube_array) each have their own wrapper function; point receivers bias in
// world space before depth reconstruction (evalPointShadowed).
//
// Exports:
//   - PCF_OFFSETS: const array<vec2<i32>, 9> — 3x3 kernel offset table
//   - sample_shadow_2d(...) -> f32 — directional 2D 9-tap software PCF
//   - sample_shadow_cube_hw2x2(...) -> f32 — point cube hardware 2x2 PCF
//
// Bias formula (D-1 directional convention -- normalBias is the slope
// coefficient, depthBias the floor; feat-20260621 m3-t5 rename):
//   bias = max(normalBias * (1.0 - dot(N, L)), depthBias / 1000.0)
//
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
// Hardware 2x2 PCF only: 2D texel offsets from PCF_OFFSETS have no direct 3D
// cubemap mapping (no UV parameterization across face seams). A previous
// 9-tap loop using the same cubemap direction every iteration was algorithmic
// dead code — every iteration returned the same `lit` value, so 9-tap = 1-tap
// (Reviewer F-2). This single call lets the GPU's silicon-level 2x2 PCF
// resolve the local neighborhood within each face natively. Matches Bevy's
// HARDWARE_2X2 path (research L0.6) and README §AC-11 default. Software 9-tap
// on cubemaps requires face-basis vector offsets and is OOS-3 here.

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

fn sample_shadow_2d_vogel(
  shadowMap: texture_depth_2d_array,
  shadowSampler: sampler_comparison,
  uv: vec2<f32>,
  layer: i32,
  texel: vec2<f32>,
  depthRef: f32,
  planeGradient: vec2<f32>,
  pixel: vec2<f32>,
) -> f32 {
  let noise = fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
  let angle = noise * 6.28318530718;
  let rotation = vec2<f32>(cos(angle), sin(angle));
  var lit = 0.0;
  for (var i = 0u; i < 5u; i++) {
    let point = SHADOW_VOGEL_OFFSETS[i];
    let offset = vec2<f32>(point.x * rotation.x - point.y * rotation.y,
      point.x * rotation.y + point.y * rotation.x);
    let sampleUv = clamp(uv + offset * texel.x, texel, vec2<f32>(1.0) - texel);
    let sampleDepth = depthRef + dot(planeGradient, (sampleUv - uv) / texel);
    lit += textureSampleCompareLevel(shadowMap, shadowSampler, sampleUv, layer, sampleDepth);
  }
  return lit * 0.2;
}
