#define_import_path forgeax_view::tone_mapping

// Shared Three r184 tone curves. Inputs are explicit; this module owns no GPU bindings.
#import forgeax_view::output_encoding::{clampToOutputGamut}

const TONEMAP_LUMINANCE_EPSILON : f32 = 1e-5;

fn tonemapReinhardExtended(color : vec3<f32>, whitePoint : f32) -> vec3<f32> {
  let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let lw_sq = whitePoint * whitePoint;
  let luma_prime = (luma * (1.0 + luma / lw_sq)) / (1.0 + luma);
  let scale = luma_prime / max(luma, TONEMAP_LUMINANCE_EPSILON);
  return color * scale;
}

// Linear LDR is bounded by the output gamut: a Display-P3 output keeps
// P3-authored colours that lie outside Rec.709 instead of clipping them here.
fn toneMapLinearLdr(color : vec3<f32>, outputGamut : u32) -> vec3<f32> {
  return clampToOutputGamut(color, outputGamut);
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

fn mapTone(sample : vec3<f32>, exposure : f32, whitePoint : f32, mode : u32, outputGamut : u32) -> vec3<f32> {
  let exposed : vec3<f32> = sample * exposure;
  var mapped : vec3<f32>;
  switch (mode) {
    case 1u: { mapped = tonemapReinhardExtended(exposed, whitePoint); }
    case 2u: { mapped = toneMapLinearLdr(exposed, outputGamut); }
    case 3u: { mapped = tonemapCineon(exposed); }
    case 4u: { mapped = tonemapAcesFilmic(exposed); }
    case 5u: { mapped = tonemapAgx(exposed); }
    case 6u: { mapped = tonemapNeutral(exposed); }
    case 7u: { mapped = tonemapReinhard(exposed); }
    // Mode 0 uses the explicit linear HDR to linear LDR identity/clamp.
    default: { mapped = toneMapLinearLdr(sample, outputGamut); }
  }
  return mapped;
}

