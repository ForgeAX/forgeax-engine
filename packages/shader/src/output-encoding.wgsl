#define_import_path forgeax_view::output_encoding

// The single explicit output encoding owner for raw surface writes.
#import forgeax_view::common::{linearToSrgbOetf}

// BEGIN GENERATED output-gamut (bun scripts/forgeax/generate-output-gamut-wgsl.ts; SSOT @forgeax/engine-math color.RGB_PRIMARIES)
const OUTPUT_GAMUT_SRGB : u32 = 0u;
const OUTPUT_GAMUT_DISPLAY_P3 : u32 = 1u;
const LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 : mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(0.822461963, 0.0331941992, 0.0170826316),
  vec3<f32>(0.177538037, 0.966805816, 0.0723974407),
  vec3<f32>(0.0, 0.0, 0.910519958),
);
const LINEAR_DISPLAY_P3_TO_LINEAR_SRGB : mat3x3<f32> = mat3x3<f32>(
  vec3<f32>(1.22494018, -0.0420569554, -0.0196375549),
  vec3<f32>(-0.224940181, 1.04205692, -0.0786360428),
  vec3<f32>(0.0, 0.0, 1.09827363),
);
// END GENERATED output-gamut

// Linear Rec.709 working colour -> linear output-gamut colour.
fn toOutputGamut(linearSrgb : vec3<f32>, gamut : u32) -> vec3<f32> {
  if (gamut == OUTPUT_GAMUT_DISPLAY_P3) {
    return LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 * linearSrgb;
  }
  return linearSrgb;
}

// Linear-LDR bound in the output gamut, expressed back in linear Rec.709.
// A Display-P3 output keeps wide-gamut (negative Rec.709) components that fit
// inside P3; each output-gamut channel is clipped to [0, 1] independently.
fn clampToOutputGamut(linearSrgb : vec3<f32>, gamut : u32) -> vec3<f32> {
  if (gamut == OUTPUT_GAMUT_DISPLAY_P3) {
    let p3 = clamp(LINEAR_SRGB_TO_LINEAR_DISPLAY_P3 * linearSrgb, vec3<f32>(0.0), vec3<f32>(1.0));
    return LINEAR_DISPLAY_P3_TO_LINEAR_SRGB * p3;
  }
  return clamp(linearSrgb, vec3<f32>(0.0), vec3<f32>(1.0));
}

// Convert linear-LDR Rec.709 RGB once into the output gamut, apply the sRGB
// transfer curve (shared by sRGB and Display P3) and preserve alpha exactly.
// Out-of-gamut channels clip per channel: negatives through the OETF floor,
// values above one at the 8-bit surface store.
fn encodeOutput(linearColor : vec3<f32>, alpha : f32, gamut : u32) -> vec4<f32> {
  let encoded = linearToSrgbOetf(toOutputGamut(linearColor, gamut));
  return vec4<f32>(encoded, alpha);
}
