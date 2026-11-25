// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_foam_field
#import forgeax::water_surface_fields::{waterField, waterEncoded, waterSrgbTarget}

struct FoamTargets {
  @location(0) field: f32,
  @location(1) foam: vec4<f32>,
}

@fragment
fn foamField(@builtin(position) position: vec4<f32>) -> FoamTargets {
  let uv = floor(position.xy) / 2048.0;
  let warp = vec2<f32>(waterField(uv, 0.0, 7523u, 3u, 4u), waterField(uv, 0.375, 9733u, 3u, 4u)) - 0.5;
  let warped = waterField(uv + warp * 0.25, 0.0, 11587u, 7u, 6u);
  let detail = waterField(uv + warp * 0.4, 0.25, 12101u, 4u, 48u) - 0.5;
  let value = clamp(pow(warped, 0.6) * 0.85 + (1.0 - abs(warped * 2.0 - 1.0)) * 0.15 + detail * 0.5, 0.0, 1.0);
  let encoded = waterEncoded(vec4<f32>(value * 255.0), vec4<f32>(170.74158), vec4<f32>(30.5106548),
    vec4<f32>(176.87, 176.88, 176.87, 255.0), vec4<f32>(40.48, 40.48, 40.48, 0.0));
  return FoamTargets(value, waterSrgbTarget(encoded));
}
