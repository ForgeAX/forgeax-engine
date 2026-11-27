// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_surface_fields
#import forgeax::water_volume_noise::{volumeNoiseLayer}

fn waterField(point: vec2<f32>, slice: f32, seed: u32, octaves: u32, start: u32) -> f32 {
  let uv = vec3<f32>(fract(point), slice);
  var sum = 0.0;
  var weight = 0.0;
  var amplitude = 1.0;
  for (var octave = 0u; octave < octaves; octave += 1u) {
    sum += amplitude * volumeNoiseLayer(uv, start << octave, seed + octave * 1013u);
    weight += amplitude;
    amplitude *= 0.5;
  }
  return sum / weight;
}

fn waterEncoded(value: vec4<f32>, mean: vec4<f32>, deviation: vec4<f32>, center: vec4<f32>, spread: vec4<f32>) -> vec4<f32> {
  return floor(clamp(center + (value - mean) * (spread / deviation), vec4<f32>(0.0), vec4<f32>(255.0)) + vec4<f32>(0.5)) / 255.0;
}

// The previous Pack stored calibrated sRGB bytes. Render targets encode linear RGB.
fn waterSrgbTarget(encoded: vec4<f32>) -> vec4<f32> {
  let linear = select(
    encoded.rgb / 12.92,
    pow((encoded.rgb + 0.055) / 1.055, vec3<f32>(2.4)),
    encoded.rgb > vec3<f32>(0.04045),
  );
  return vec4<f32>(linear, encoded.a);
}

fn waterFieldAt(field: texture_2d<f32>, coordinate: vec2<i32>) -> f32 {
  let extent = vec2<i32>(textureDimensions(field));
  return textureLoad(field, (coordinate + extent) % extent, 0).r;
}

fn waterEncodedNormal(field: texture_2d<f32>, p: vec2<i32>, strength: f32) -> vec3<f32> {
  let dx = (waterFieldAt(field, p + vec2<i32>(1, 0)) - waterFieldAt(field, p - vec2<i32>(1, 0))) * strength;
  let dy = (waterFieldAt(field, p + vec2<i32>(0, 1)) - waterFieldAt(field, p - vec2<i32>(0, 1))) * strength;
  return 0.5 + 0.5 * normalize(vec3<f32>(-dx, -dy, 1.0));
}
