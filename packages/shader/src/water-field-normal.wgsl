// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_field_normal
#import forgeax::water_surface_fields::{waterEncodedNormal}

struct NormalParameters {
  mean: vec2<f32>,
  deviation: vec2<f32>,
  center: vec2<f32>,
  spread: vec2<f32>,
  strength: f32,
  _padding: vec2<f32>,
}
@group(0) @binding(0) var<uniform> params: NormalParameters;
@group(0) @binding(1) var sourceField: texture_2d<f32>;

fn quantizeNormal(xy: vec2<f32>) -> vec2<f32> {
  return floor(clamp(xy, vec2<f32>(0.0), vec2<f32>(255.0)) + 0.5) / 127.5 - 1.0;
}

@fragment
fn fieldNormal(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let raw = waterEncodedNormal(sourceField, vec2<i32>(position.xy), params.strength).xy * 255.0;
  var xy = quantizeNormal(params.center + (raw - params.mean) * (params.spread / params.deviation));
  let squared = dot(xy, xy);
  if squared > 1.0 {
    let scale = (1.0 - sqrt(2.0) / 255.0) * inverseSqrt(squared);
    xy = quantizeNormal((0.5 + 0.5 * xy * scale) * 255.0);
  }
  let z = sqrt(max(0.0, 1.0 - dot(xy, xy)));
  return vec4<f32>(0.5 + 0.5 * vec3<f32>(xy, z), 1.0);
}
