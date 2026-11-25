// SPDX-License-Identifier: Apache-2.0
#define_import_path forgeax::water_volume_noise

fn volumeHash(p: vec3<u32>, seed: u32) -> f32 {
  var value = (p.x * 1597334677u) ^ (p.y * 3812015801u) ^ (p.z * 958689923u) ^ seed;
  value = (value ^ (value >> 16u)) * 2246822507u;
  value = (value ^ (value >> 13u)) * 3266489909u;
  return f32(value ^ (value >> 16u)) * (1.0 / 4294967295.0);
}

fn volumeNoiseLayer(uv: vec3<f32>, period: u32, seed: u32) -> f32 {
  let p = uv * f32(period);
  let grid = vec3<u32>(floor(p));
  let low = grid % vec3<u32>(period);
  let high = (grid + 1u) % vec3<u32>(period);
  let t = fract(p);
  let fade = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  let lowerA = mix(volumeHash(vec3<u32>(low.x, low.y, low.z), seed), volumeHash(vec3<u32>(high.x, low.y, low.z), seed), fade.x);
  let lowerB = mix(volumeHash(vec3<u32>(low.x, high.y, low.z), seed), volumeHash(vec3<u32>(high.x, high.y, low.z), seed), fade.x);
  let upperA = mix(volumeHash(vec3<u32>(low.x, low.y, high.z), seed), volumeHash(vec3<u32>(high.x, low.y, high.z), seed), fade.x);
  let upperB = mix(volumeHash(vec3<u32>(low.x, high.y, high.z), seed), volumeHash(vec3<u32>(high.x, high.y, high.z), seed), fade.x);
  return mix(mix(lowerA, lowerB, fade.y), mix(upperA, upperB, fade.y), fade.z);
}

fn volumeValue(position: vec3<u32>, extent: vec3<u32>) -> f32 {
  let uv = vec3<f32>(position) / vec3<f32>(extent);
  let field = (volumeNoiseLayer(uv, 16u, 15331u)
             + volumeNoiseLayer(uv, 32u, 16344u) * 0.5
             + volumeNoiseLayer(uv, 64u, 17357u) * 0.25) / 1.75;
  // Apply the previous 128-cubed field's moments after its first UNORM8 quantization.
  let encoded = floor(clamp(field, 0.0, 1.0) * 255.0 + 0.5);
  return (226.41 + (encoded - 126.89311075210571) * (11.63 / 33.00256372655223)) / 255.0;
}
