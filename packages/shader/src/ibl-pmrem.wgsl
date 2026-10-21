#define_import_path forgeax_pbr::pmrem

// CubeUV layout and perceptual roughness mapping follow Three.js r184.
// Six additional 16x16 levels retain angular resolution for broad lobes.
// Logical mip numbers run from log2(base face size) down to -2.
fn pmremFace(direction: vec3<f32>) -> u32 {
  let a = abs(direction);
  if (a.x > a.z && a.x > a.y) { return select(3u, 0u, direction.x > 0.0); }
  if (a.z >= a.x && a.z > a.y) { return select(5u, 2u, direction.z > 0.0); }
  return select(4u, 1u, direction.y > 0.0);
}

fn pmremFaceUv(d: vec3<f32>, face: u32) -> vec2<f32> {
  var p = vec2<f32>(d.x, d.y) / abs(d.z);
  switch face {
    case 0u: { p = vec2<f32>(d.z, d.y) / abs(d.x); }
    case 1u: { p = -d.xz / abs(d.y); }
    case 2u: { p = vec2<f32>(-d.x, d.y) / abs(d.z); }
    case 3u: { p = vec2<f32>(-d.z, d.y) / abs(d.x); }
    case 4u: { p = vec2<f32>(-d.x, d.z) / abs(d.y); }
    default: {}
  }
  return p * 0.5 + vec2<f32>(0.5);
}

fn pmremDirection(uv: vec2<f32>, face: u32) -> vec3<f32> {
  let p = uv * 2.0 - vec2<f32>(1.0);
  switch face {
    case 0u: { return vec3<f32>(1.0, p.y, p.x); }
    case 1u: { return vec3<f32>(-p.x, 1.0, -p.y); }
    case 2u: { return vec3<f32>(-p.x, p.y, 1.0); }
    case 3u: { return vec3<f32>(-1.0, p.y, -p.x); }
    case 4u: { return vec3<f32>(-p.x, -1.0, p.y); }
    default: { return vec3<f32>(p.x, p.y, -1.0); }
  }
}

fn pmremLevelOrigin(baseSize: f32, mip: f32) -> vec2<f32> {
  let size = exp2(max(mip, 4.0));
  return vec2<f32>(max(4.0 - mip, 0.0) * 48.0, 4.0 * (baseSize - size));
}

fn samplePmremLevel(map: texture_2d<f32>, mapSampler: sampler, direction: vec3<f32>, mip: f32) -> vec3<f32> {
  let dimensions = vec2<f32>(textureDimensions(map, 0));
  // Solid Skylights use a single white texel with the same binding contract.
  if (dimensions.y == 1.0) { return textureLoad(map, vec2<i32>(0), 0).rgb; }
  let size = exp2(max(mip, 4.0));
  let face = pmremFace(direction);
  let tile = vec2<f32>(f32(face % 3u), f32(face / 3u)) * size;
  let pixel = pmremLevelOrigin(dimensions.y * 0.25, mip) + tile
    + pmremFaceUv(direction, face) * (size - 2.0) + vec2<f32>(1.0);
  return textureSampleLevel(map, mapSampler, pixel / dimensions, 0.0).rgb;
}

fn pmremRoughnessToMip(roughness: f32) -> f32 {
  if (roughness >= 0.8) { return (1.0 - roughness) * 5.0 - 2.0; }
  if (roughness >= 0.4) { return (0.8 - roughness) * 7.5 - 1.0; }
  if (roughness >= 0.305) { return (0.4 - roughness) / 0.095 + 2.0; }
  if (roughness >= 0.21) { return (0.305 - roughness) / 0.095 + 3.0; }
  return -2.0 * log2(max(1.16 * roughness, 1e-6));
}

fn samplePmrem(map: texture_2d<f32>, mapSampler: sampler, direction: vec3<f32>, roughness: f32) -> vec3<f32> {
  let maxMip = log2(max(f32(textureDimensions(map, 0).y) * 0.25, 1.0));
  let mip = clamp(pmremRoughnessToMip(roughness), -2.0, maxMip);
  let level = floor(mip);
  let first = samplePmremLevel(map, mapSampler, direction, level);
  if (fract(mip) == 0.0) { return first; }
  return mix(first, samplePmremLevel(map, mapSampler, direction, level + 1.0), fract(mip));
}
