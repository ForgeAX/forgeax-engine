// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_impulse_mip

@group(0) @binding(0) var previous: texture_2d<f32>;

struct ImpulseMip {
  @location(0) noise: vec4<f32>,
  @location(1) average: f32,
};

@fragment
fn impulseMip(@builtin(position) position: vec4<f32>) -> ImpulseMip {
  let mask = vec2<i32>(textureDimensions(previous)) - 1;
  let origin = vec2<i32>(position.xy) * 2;
  // Exact float weights from the existing impulse brush's symmetric eight taps.
  let weights = array<f32, 8>(
    -0.029629630968, -0.118518523872, 0.166666626930, 0.481481403112,
     0.481481403112, 0.166666626930, -0.118518523872, -0.029629630968,
  );
  var sharpened = 0.0;
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      let tap = (origin + vec2<i32>(x - 3, y - 3)) & mask;
      sharpened += textureLoad(previous, tap, 0).r * weights[x] * weights[y];
    }
  }
  let average = 0.25 * (
    textureLoad(previous, origin, 0).r +
    textureLoad(previous, origin + vec2<i32>(1, 0), 0).r +
    textureLoad(previous, origin + vec2<i32>(0, 1), 0).r +
    textureLoad(previous, origin + vec2<i32>(1, 1), 0).r
  );
  return ImpulseMip(vec4<f32>(vec3<f32>(clamp(sharpened, 0.0, 1.0)), 1.0), average);
}
