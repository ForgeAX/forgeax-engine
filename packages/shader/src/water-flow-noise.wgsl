// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_flow_noise
#import forgeax::water_surface_fields::{waterField, waterEncoded}

@fragment
fn flowNoise(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let field = waterField(floor(position.xy) / 64.0, 0.0, 10949u, 3u, 6u);
  return waterEncoded(vec4<f32>(field * 255.0), vec4<f32>(120.016013), vec4<f32>(39.7494853),
    vec4<f32>(142.35, 142.35, 142.35, 255.0), vec4<f32>(29.61, 29.61, 29.61, 0.0));
}
