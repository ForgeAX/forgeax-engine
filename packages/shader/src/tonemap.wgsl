#define_import_path forgeax_view::tonemap

// @forgeax/engine-shader - Three r184 Output Transform module.
//
// The public modes and formulas are the Three.js r184 oracle. The numeric
// values are the binding contract mirrored by TONEMAP_SHADER_MODE in tonemap.ts.
// `reinhard-extended` remains Forgeax's existing luminance-domain curve; the
// distinct `reinhard` mode is Three's per-channel Reinhard curve.

#import forgeax_view::common::{FullscreenOutput, ditherUnorm8, fullscreen_triangle}
#import forgeax_view::output_encoding::{clampToOutputGamut, encodeOutput}

const TONEMAP_LUMINANCE_EPSILON : f32 = 1e-5;

// 32-byte layout mirrored by TONEMAP_PARAMS_LAYOUT in tonemap.ts.
struct TonemapParams {
  exposure   : f32,
  whitePoint : f32,
  mode       : u32,
  ditherEnabled : f32,
  // OUTPUT_GAMUT_* written by the renderer at record time.
  outputGamut : u32,
  padA : u32,
  // Actual destination view extent, including its selected mip.
  outputSize : vec2<f32>,
};

@group(1) @binding(0) var hdr  : texture_2d<f32>;
@group(1) @binding(1) var samp : sampler;
@group(1) @binding(2) var<uniform> params : TonemapParams;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

fn tonemapReinhardExtended(color : vec3<f32>) -> vec3<f32> {
  let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let lw_sq = params.whitePoint * params.whitePoint;
  let luma_prime = (luma * (1.0 + luma / lw_sq)) / (1.0 + luma);
  let scale = luma_prime / max(luma, TONEMAP_LUMINANCE_EPSILON);
  return color * scale;
}

// Linear LDR is bounded by the output gamut: a Display-P3 output keeps
// P3-authored colours that lie outside Rec.709 instead of clipping them here.
fn toneMapLinearLdr(color : vec3<f32>) -> vec3<f32> {
  return clampToOutputGamut(color, params.outputGamut);
}

fn tonemapReinhard(color : vec3<f32>) -> vec3<f32> {
  return clamp(color / (color + vec3<f32>(1.0)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemapCineon(color : vec3<f32>) -> vec3<f32> {
  let x = max(color - vec3<f32>(0.004), vec3<f32>(0.0));
  let a = x * (6.2 * x + vec3<f32>(0.5));
  let b = x * (6.2 * x + vec3<f32>(1.7)) + vec3<f32>(0.06);
  return pow(a / b, vec3<f32>(2.2));
}

fn acesInput(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(0.59719, 0.35458, 0.04823), color),
    dot(vec3<f32>(0.07600, 0.90834, 0.01566), color),
    dot(vec3<f32>(0.02840, 0.13383, 0.83777), color),
  );
}

fn acesOutput(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(1.60475, -0.53108, -0.07367), color),
    dot(vec3<f32>(-0.10208, 1.10813, -0.00605), color),
    dot(vec3<f32>(-0.00327, -0.07276, 1.07602), color),
  );
}

fn tonemapAcesFilmic(color : vec3<f32>) -> vec3<f32> {
  let input = acesInput(color / vec3<f32>(0.6));
  let a = input * (input + vec3<f32>(0.0245786)) - vec3<f32>(0.000090537);
  let b = input * ((input + vec3<f32>(0.4329510)) * vec3<f32>(0.983729)) + vec3<f32>(0.238081);
  return clamp(acesOutput(a / b), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn rec2020FromSrgb(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(0.6274, 0.3293, 0.0433), color),
    dot(vec3<f32>(0.0691, 0.9195, 0.0113), color),
    dot(vec3<f32>(0.0164, 0.0880, 0.8956), color),
  );
}

fn srgbFromRec2020(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(1.6605, -0.5876, -0.0728), color),
    dot(vec3<f32>(-0.1246, 1.1329, -0.0083), color),
    dot(vec3<f32>(-0.0182, -0.1006, 1.1187), color),
  );
}

fn agxContrastApprox(x : vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2
    - 40.14 * x4 * x
    + 31.96 * x4
    - 6.868 * x2 * x
    + 0.4298 * x2
    + 0.1191 * x
    - vec3<f32>(0.00232);
}

fn agxInset(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(0.856627153315983, 0.0951212405381588, 0.0482516061458583), color),
    dot(vec3<f32>(0.137318972929847, 0.761241990602591, 0.101439036467562), color),
    dot(vec3<f32>(0.11189821299995, 0.0767994186031903, 0.811302368396859), color),
  );
}

fn agxOutset(color : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(vec3<f32>(1.1271005818144368, -0.11060664309660323, -0.016493938717834573), color),
    dot(vec3<f32>(-0.1413297634984383, 1.157823702216272, -0.016493938717834257), color),
    dot(vec3<f32>(-0.14132976349843826, -0.11060664309660294, 1.2519364065950405), color),
  );
}

fn tonemapAgx(color : vec3<f32>) -> vec3<f32> {
  let min_ev = -12.47393;
  let max_ev = 4.026069;
  let rec2020 = agxInset(rec2020FromSrgb(color));
  let log_color = log2(max(rec2020, vec3<f32>(1e-10)));
  let normalized = clamp(
    (log_color - vec3<f32>(min_ev)) / vec3<f32>(max_ev - min_ev),
    vec3<f32>(0.0),
    vec3<f32>(1.0),
  );
  let contrasted = agxContrastApprox(normalized);
  let encoded = pow(max(agxOutset(contrasted), vec3<f32>(0.0)), vec3<f32>(2.2));
  return clamp(srgbFromRec2020(encoded), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn tonemapNeutral(color : vec3<f32>) -> vec3<f32> {
  let start_compression = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var compressed = color - vec3<f32>(offset);
  let peak = max(compressed.r, max(compressed.g, compressed.b));
  if (peak < start_compression) {
    return compressed;
  }
  let d = 1.0 - start_compression;
  let new_peak = 1.0 - d * d / (peak + d - start_compression);
  compressed *= new_peak / peak;
  let g = 1.0 - 1.0 / (desaturation * (peak - new_peak) + 1.0);
  return mix(compressed, vec3<f32>(new_peak), g);
}

fn mapTonemap(sample : vec3<f32>) -> vec3<f32> {
  let exposed : vec3<f32> = sample * params.exposure;
  var mapped : vec3<f32>;
  switch (params.mode) {
    case 1u: { mapped = tonemapReinhardExtended(exposed); }
    case 2u: { mapped = toneMapLinearLdr(exposed); }
    case 3u: { mapped = tonemapCineon(exposed); }
    case 4u: { mapped = tonemapAcesFilmic(exposed); }
    case 5u: { mapped = tonemapAgx(exposed); }
    case 6u: { mapped = tonemapNeutral(exposed); }
    case 7u: { mapped = tonemapReinhard(exposed); }
    // Mode 0 uses the explicit linear HDR to linear LDR identity/clamp.
    default: { mapped = toneMapLinearLdr(sample); }
  }
  return mapped;
}

fn encodeFinal(linearColor : vec3<f32>, alpha : f32, position : vec4<f32>) -> vec4<f32> {
  let encoded = encodeOutput(linearColor, alpha, params.outputGamut);
  let outputRgb = select(
    encoded.rgb,
    ditherUnorm8(encoded.rgb, position.xy),
    params.ditherEnabled > 0.5,
  );
  return vec4<f32>(outputRgb, encoded.a);
}

fn sampleOutputSource(position : vec2<f32>) -> vec4<f32> {
  // Equal grids have exact texel correspondence, including binary16 endpoints.
  if all(vec2<f32>(textureDimensions(hdr)) == params.outputSize) {
    return textureLoad(hdr, vec2<i32>(position), 0);
  }
  return textureSample(hdr, samp, position / params.outputSize);
}

@fragment
fn fs_main(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // Combined path: tone mapping and the one output encoding happen together.
  let source = sampleOutputSource(in.position.xy);
  return encodeFinal(mapTonemap(source.rgb), source.a, in.position);
}

@fragment
fn fs_tone_only(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // LUT-enabled path stops at linear LDR so the LUT never samples encoded data.
  let source = sampleOutputSource(in.position.xy);
  return vec4<f32>(mapTonemap(source.rgb), source.a);
}

@fragment
fn fs_encode_only(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // The final writer consumes linear LDR after LUT and optional FXAA.
  let source = sampleOutputSource(in.position.xy);
  return encodeFinal(source.rgb, source.a, in.position);
}

@fragment
fn fs_present(in : FullscreenOutput) -> @location(0) vec4<f32> {
  // Receipt capture retains the encoded endpoint when the surface is not copyable.
  return sampleOutputSource(in.position.xy);
}
