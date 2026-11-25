// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_impulse_field
#import forgeax::water_surface_fields::{waterField}

struct ImpulseField {
  @location(0) noise: vec4<f32>,
  @location(1) average: f32,
};

@fragment
fn impulseField(@builtin(position) position: vec4<f32>) -> ImpulseField {
  let uv = floor(position.xy) / 256.0;
  let field = waterField(uv, 0.0, 13217u, 5u, 6u);
  let source = clamp(0.5 + (field - 0.5) * 1.8, 0.0, 1.0) * 255.0;
  // Moments of the original deterministic 256x256 field before byte quantization.
  let encoded = floor(clamp(120.89 + (source - 132.93755733184102) * (60.8 / 65.12800675176172), 0.0, 255.0) + 0.5);
  let linear = pow(pow(encoded / 255.0, 2.2), 1.2);
  return ImpulseField(vec4<f32>(vec3<f32>(linear), 1.0), linear);
}
