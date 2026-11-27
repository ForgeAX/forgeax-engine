// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_tiling_texture
#import forgeax::water_surface_fields::{waterField, waterEncoded, waterEncodedNormal}

@group(0) @binding(0) var sourceField: texture_2d<f32>;

@fragment
fn tilingNormal(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let uv = floor(position.xy) / 1024.0;
  let xy = waterEncodedNormal(sourceField, vec2<i32>(position.xy), 7.0).xy;
  let channels = vec4<f32>(xy, waterField(uv, 0.25, 2833u, 4u, 12u), waterField(uv, 0.75, 2953u, 4u, 24u)) * 255.0;
  return waterEncoded(channels,
    vec4<f32>(127.500084, 127.500195, 123.420074, 127.031374),
    vec4<f32>(3.22792383, 3.25599249, 32.8950927, 35.4944129),
    vec4<f32>(128.0, 128.5, 62.0, 160.7), vec4<f32>(64.0, 74.0, 62.0, 44.72));
}
