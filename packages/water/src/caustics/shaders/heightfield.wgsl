#define_import_path forgeax_water::caustics::heightfield
#import forgeax_material::parameters::{heightField}

fn waterHeight(p: vec2<f32>) -> f32 {
  // Load physical FP32 heights before interpolation. Packed UNORM channels lose
  // precision through hardware filtering, especially across the zero crossing.
  let size = vec2<i32>(textureDimensions(heightField));
  let texel = clamp(p * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(size) - 0.5;
  let base = vec2<i32>(floor(texel));
  let f = fract(texel);
  let a = clamp(base, vec2<i32>(0), size - 1);
  let b = clamp(base + 1, vec2<i32>(0), size - 1);
  let h00 = textureLoad(heightField, a, 0).r;
  let h10 = textureLoad(heightField, vec2<i32>(b.x, a.y), 0).r;
  let h01 = textureLoad(heightField, vec2<i32>(a.x, b.y), 0).r;
  let h11 = textureLoad(heightField, b, 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
fn waterNormal(p: vec2<f32>) -> vec3<f32> {
  let step = 2.0 / f32(textureDimensions(heightField).x);
  let dx = waterHeight(p + vec2<f32>(step, 0.0)) - waterHeight(p - vec2<f32>(step, 0.0));
  let dz = waterHeight(p + vec2<f32>(0.0, step)) - waterHeight(p - vec2<f32>(0.0, step));
  return normalize(vec3<f32>(-dx, 2.0 * step, -dz));
}
