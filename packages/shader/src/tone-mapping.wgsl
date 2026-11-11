#define_import_path forgeax_view::tone_mapping

// Shared Three r184 tone curves plus Unreal Filmic. Inputs are explicit; this module owns no GPU bindings.
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

// Unreal Filmic with the engine's default post-process settings: slope 0.88, toe 0.55,
// shoulder 0.26, black clip 0, white clip 0.04, blue correction 0.6, expand gamut 1.
const UE_FILM_SLOPE : f32 = 0.88;
const UE_FILM_TOE : f32 = 0.55;
const UE_FILM_SHOULDER : f32 = 0.26;
const UE_FILM_BLACK_CLIP : f32 = 0.0;
const UE_FILM_WHITE_CLIP : f32 = 0.04;
const UE_BLUE_CORRECTION : f32 = 0.6;
const UE_EXPAND_GAMUT : f32 = 1.0;
const AP1_RGB2Y : vec3<f32> = vec3<f32>(0.2722287168, 0.6740817658, 0.0536895174);

fn mul3(r0 : vec3<f32>, r1 : vec3<f32>, r2 : vec3<f32>, c : vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(r0, c), dot(r1, c), dot(r2, c));
}

fn ap1FromSrgb(c : vec3<f32>) -> vec3<f32> {
  return mul3(
    vec3<f32>(0.6130974024, 0.3395231461, 0.0473794514),
    vec3<f32>(0.0701937225, 0.9163538791, 0.0134523986),
    vec3<f32>(0.0206155929, 0.1095697729, 0.8698146341),
    c,
  );
}

fn srgbFromAp1(c : vec3<f32>) -> vec3<f32> {
  return mul3(
    vec3<f32>(1.7050509926, -0.6217921205, -0.0832588722),
    vec3<f32>(-0.1302564175, 1.1408047365, -0.0105483190),
    vec3<f32>(-0.0240033568, -0.1289689761, 1.1529723328),
    c,
  );
}

fn ap0FromAp1(c : vec3<f32>) -> vec3<f32> {
  return mul3(
    vec3<f32>(0.6954522414, 0.1406786965, 0.1638690622),
    vec3<f32>(0.0447945634, 0.8596711185, 0.0955343182),
    vec3<f32>(-0.0055258826, 0.0040252103, 1.0015006723),
    c,
  );
}

fn ap1FromAp0(c : vec3<f32>) -> vec3<f32> {
  return mul3(
    vec3<f32>(1.4514393161, -0.2365107469, -0.2149285693),
    vec3<f32>(-0.0765537734, 1.1762296998, -0.0996759264),
    vec3<f32>(0.0083161484, -0.0060324498, 0.9977163014),
    c,
  );
}

// Pushes bright saturated colours from Rec.709 towards a gamut between P3 and AP1.
fn ueExpandGamut(ap1 : vec3<f32>) -> vec3<f32> {
  let luma = dot(ap1, AP1_RGB2Y);
  let chroma = select(vec3<f32>(1.0), ap1 / luma, luma > 0.0);
  let chromaDistSq = dot(chroma - vec3<f32>(1.0), chroma - vec3<f32>(1.0));
  let amount = (1.0 - exp2(-4.0 * chromaDistSq)) * (1.0 - exp2(-4.0 * UE_EXPAND_GAMUT * luma * luma));
  let expanded = mul3(
    vec3<f32>(1.3704123718, -0.3292921877, -0.0636831194),
    vec3<f32>(-0.0834334917, 1.0970927480, -0.0108613795),
    vec3<f32>(-0.0257933209, -0.0986257988, 1.2036949526),
    ap1,
  );
  return mix(ap1, expanded, amount);
}

fn acesSaturation(c : vec3<f32>) -> f32 {
  let lo = min(c.r, min(c.g, c.b));
  let hi = max(c.r, max(c.g, c.b));
  return (max(hi, 1e-10) - max(lo, 1e-10)) / max(hi, 1e-2);
}

fn acesYc(c : vec3<f32>) -> f32 {
  let chroma = sqrt(max(c.b * (c.b - c.g) + c.g * (c.g - c.r) + c.r * (c.r - c.b), 0.0));
  return (c.r + c.g + c.b + 1.75 * chroma) / 3.0;
}

fn acesSigmoidShaper(x : f32) -> f32 {
  let t = max(1.0 - abs(0.5 * x), 0.0);
  return 0.5 * (1.0 + sign(x) * (1.0 - t * t));
}

fn acesGlowGain(yc : f32, gain : f32, mid : f32) -> f32 {
  if (yc <= 2.0 / 3.0 * mid) {
    return gain;
  }
  if (yc >= 2.0 * mid) {
    return 0.0;
  }
  return gain * (mid / yc - 0.5);
}

fn acesHue(c : vec3<f32>) -> f32 {
  if (c.r == c.g && c.g == c.b) {
    return 0.0;
  }
  let hue = degrees(atan2(sqrt(3.0) * (c.g - c.b), 2.0 * c.r - c.g - c.b));
  return select(hue, hue + 360.0, hue < 0.0);
}

fn log10v(x : vec3<f32>) -> vec3<f32> {
  return log2(x) * 0.30102999566;
}

// Filmic curve on AP1 input; returns non-negative AP1.
fn ueFilmToneMap(colorAp1 : vec3<f32>) -> vec3<f32> {
  var ap0 = ap0FromAp1(colorAp1);

  // ACES RRT glow module.
  let saturation = acesSaturation(ap0);
  let s = acesSigmoidShaper((saturation - 0.4) / 0.2);
  ap0 *= 1.0 + acesGlowGain(acesYc(ap0), 0.05 * s, 0.08);

  // ACES RRT red modifier.
  var centeredHue = acesHue(ap0);
  if (centeredHue > 180.0) {
    centeredHue -= 360.0;
  }
  let hueWeight = smoothstep(0.0, 1.0, 1.0 - abs(2.0 * centeredHue / 135.0));
  ap0.r += hueWeight * hueWeight * saturation * (0.03 - ap0.r) * (1.0 - 0.82);

  var working = max(ap1FromAp0(ap0), vec3<f32>(0.0));
  working = mix(vec3<f32>(dot(working, AP1_RGB2Y)), working, 0.96);

  let toeScale = 1.0 + UE_FILM_BLACK_CLIP - UE_FILM_TOE;
  let shoulderScale = 1.0 + UE_FILM_WHITE_CLIP - UE_FILM_SHOULDER;
  let inMatch = 0.18;
  let outMatch = 0.18;
  var toeMatch : f32;
  if (UE_FILM_TOE > 0.8) {
    toeMatch = (1.0 - UE_FILM_TOE - outMatch) / UE_FILM_SLOPE + log2(inMatch) * 0.30102999566;
  } else {
    let bt = (outMatch + UE_FILM_BLACK_CLIP) / toeScale - 1.0;
    toeMatch = log2(inMatch) * 0.30102999566 - 0.5 * log((1.0 + bt) / (1.0 - bt)) * (toeScale / UE_FILM_SLOPE);
  }
  let straightMatch = (1.0 - UE_FILM_TOE) / UE_FILM_SLOPE - toeMatch;
  let shoulderMatch = UE_FILM_SHOULDER / UE_FILM_SLOPE - straightMatch;

  let logColor = log10v(max(working, vec3<f32>(1e-10)));
  let straightColor = UE_FILM_SLOPE * (logColor + vec3<f32>(straightMatch));
  var toeColor = vec3<f32>(-UE_FILM_BLACK_CLIP)
    + (2.0 * toeScale) / (vec3<f32>(1.0) + exp((-2.0 * UE_FILM_SLOPE / toeScale) * (logColor - vec3<f32>(toeMatch))));
  var shoulderColor = vec3<f32>(1.0 + UE_FILM_WHITE_CLIP)
    - (2.0 * shoulderScale) / (vec3<f32>(1.0) + exp((2.0 * UE_FILM_SLOPE / shoulderScale) * (logColor - vec3<f32>(shoulderMatch))));
  toeColor = select(straightColor, toeColor, logColor < vec3<f32>(toeMatch));
  shoulderColor = select(straightColor, shoulderColor, logColor > vec3<f32>(shoulderMatch));

  var t = clamp((logColor - vec3<f32>(toeMatch)) / (shoulderMatch - toeMatch), vec3<f32>(0.0), vec3<f32>(1.0));
  if (shoulderMatch < toeMatch) {
    t = vec3<f32>(1.0) - t;
  }
  t = (vec3<f32>(3.0) - 2.0 * t) * t * t;
  var tone = mix(toeColor, shoulderColor, t);
  tone = mix(vec3<f32>(dot(tone, AP1_RGB2Y)), tone, 0.93);
  return max(tone, vec3<f32>(0.0));
}

fn tonemapUeFilmic(color : vec3<f32>) -> vec3<f32> {
  var ap1 = ueExpandGamut(ap1FromSrgb(color));
  let blue = mul3(
    vec3<f32>(0.9386393778, 0.0, 0.0613606221),
    vec3<f32>(0.0, 0.8307941330, 0.1692058671),
    vec3<f32>(0.0, 0.0, 1.0),
    ap1,
  );
  ap1 = mix(ap1, blue, UE_BLUE_CORRECTION);
  ap1 = ueFilmToneMap(ap1);
  let unblue = mul3(
    vec3<f32>(1.0653748755, 0.0000014467, -0.0653710053),
    vec3<f32>(-0.0000003456, 1.2036635245, -0.2036677199),
    vec3<f32>(0.0000000198, 0.0000000212, 0.9999996001),
    ap1,
  );
  ap1 = mix(ap1, unblue, UE_BLUE_CORRECTION);
  return clamp(srgbFromAp1(ap1), vec3<f32>(0.0), vec3<f32>(1.0));
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
    case 8u: { mapped = tonemapUeFilmic(exposed); }
    // Mode 0 uses the explicit linear HDR to linear LDR identity/clamp.
    default: { mapped = toneMapLinearLdr(sample, outputGamut); }
  }
  return mapped;
}

