#define_import_path forgeax_material::fragment_output

#import forgeax_view::tone_mapping::{mapTone}
#import forgeax_view::output_encoding::{encodeOutput}

// Optional authored output contract: tone mode, exposure, encode flag, output gamut.
// Data materials use (0, 1, 0, 0). No tone mapping leaves HDR values unbounded;
// the destination attachment, rather than an intermediate shader clamp, owns storage.
fn applyFragmentOutput(color : vec4<f32>, control : vec4<f32>) -> vec4<f32> {
  var rgb = color.rgb;
  if (control.x > 0.0) {
    rgb = mapTone(rgb, control.y, 1.0, u32(control.x), u32(control.w));
  }
  if (control.z > 0.0) {
    return encodeOutput(rgb, color.a, u32(control.w));
  }
  return vec4<f32>(rgb, color.a);
}
