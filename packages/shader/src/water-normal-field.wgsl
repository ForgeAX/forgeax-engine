// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_normal_field
#import forgeax::water_surface_fields::{waterField}

@fragment
fn normalField(@builtin(position) position: vec4<f32>) -> @location(0) f32 {
  let uv = floor(position.xy) / 1024.0;
  let warp = vec2<f32>(waterField(uv, 0.0, 1847u, 3u, 4u), waterField(uv, 0.375, 2161u, 3u, 4u)) - 0.5;
  return waterField(uv + warp * 0.12, 0.25, 2689u, 3u, 5u);
}
