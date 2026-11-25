// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_field_blur
#import forgeax::water_surface_fields::{waterFieldAt}

struct BlurParameters {
  radius: u32,
  _blurPad: u32,
  _padding: vec2<u32>,
}
@group(0) @binding(0) var<uniform> params: BlurParameters;
@group(0) @binding(1) var sourceField: texture_2d<f32>;

@fragment
fn blur(@builtin(position) position: vec4<f32>) -> @location(0) f32 {
  // A transposed pass followed by the same pass filters both axes of a square field.
  let p = vec2<i32>(position.yx);
  let radius = i32(params.radius);
  var sum = 0.0;
  for (var x = -radius; x <= radius; x += 1) {
    sum += waterFieldAt(sourceField, p + vec2<i32>(x, 0));
  }
  return sum / f32(2 * radius + 1);
}
