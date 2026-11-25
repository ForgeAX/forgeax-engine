// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_river_field
#import forgeax::water_surface_fields::{waterField, waterEncoded, waterSrgbTarget}

struct RiverTargets {
  @location(0) field: f32,
  @location(1) diffuse: vec4<f32>,
}

@fragment
fn riverField(@builtin(position) position: vec4<f32>) -> RiverTargets {
  let uv = floor(position.xy) / 512.0;
  let bend = waterField(uv, 0.0, 3469u, 3u, 4u) - 0.5;
  let field = waterField(uv + bend * vec2<f32>(0.15, 0.1), 0.25, 4513u, 3u, 16u);
  let detail = pow(waterField(uv + bend * vec2<f32>(0.2, 0.1), 0.25, 4513u, 4u, 72u), 2.5);
  let encoded = waterEncoded(vec4<f32>(detail * 255.0), vec4<f32>(52.4044832), vec4<f32>(33.8478942),
    vec4<f32>(135.08, 141.96, 138.52, 71.71), vec4<f32>(26.4, 27.27, 30.66, 48.66));
  return RiverTargets(field, waterSrgbTarget(encoded));
}
