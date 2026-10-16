#define_import_path forgeax_standard::subsurface_diffusion
#import forgeax_pbr::gbuffer::{decodeStandardNormalRoughness}

@group(0) @binding(0) var diffuse : texture_2d<f32>;
@group(0) @binding(1) var profiles : texture_2d<u32>;
@group(0) @binding(2) var normals : texture_2d<u32>;
@group(0) @binding(3) var depth : texture_depth_2d;
struct DiffusionParams {
  projection : vec4<f32>, // near, far, orthographic, support in sigma units
  scale : vec4<f32>, // internal/presentation x and y, band origin and height
};
@group(0) @binding(4) var<uniform> params : DiffusionParams;
@group(0) @binding(5) var delta : texture_storage_2d<rgba32float, write>;
@group(0) @binding(6) var composedDelta : texture_2d<f32>;

// 8x8 output with a 12-pixel halo. Array strides use exactly 32 KiB:
// 1024 * (16 RGB + 4 profile + 4 normal + 4 distance) + 256 * 16 horizontal.
var<workgroup> colors : array<vec3<f32>, 1024>;
var<workgroup> profileRows : array<u32, 1024>;
var<workgroup> normalRows : array<u32, 1024>;
var<workgroup> distances : array<f32, 1024>;
var<workgroup> horizontal : array<vec3<f32>, 256>;

fn distanceFromDepth(d : f32) -> f32 {
  let n = params.projection.x;
  let f = params.projection.y;
  return select(n / max(d + (1.0 - d) * n / f, 1e-7), f - d * (f - n), params.projection.z > 0.5);
}
fn inside(pixel : vec2<i32>, dims : vec2<i32>) -> bool {
  return all(pixel >= vec2<i32>(0)) && all(pixel < dims);
}
fn accepted(centre : u32, neighbour : u32) -> bool {
  let profile = profileRows[centre];
  let sampleProfile = profileRows[neighbour];
  let distance = distances[centre];
  let sampleDistance = distances[neighbour];
  if (sampleDistance > 0.0 && sampleProfile >> 24u > 0u && (sampleProfile & 0xffffffu) == (profile & 0xffffffu)) {
    let normal = decodeStandardNormalRoughness(normalRows[centre]).xyz;
    let sampleNormal = decodeStandardNormalRoughness(normalRows[neighbour]).xyz;
    if (dot(normal, sampleNormal) >= 0.8 && abs(sampleDistance - distance) <= max(0.001, 0.01 * distance)) {
      return true;
    }
  }
  return false;
}
fn gaussianWeight(offset : f32, radius : vec3<f32>) -> vec3<f32> {
  let safeRadius = max(radius, vec3<f32>(0.0001));
  // Match the frozen discrete support after the authored radius's quantization.
  // Low keeps contiguous integer taps and truncates at two sigma instead of
  // omitting odd pixels, which aliases impulses into a checkerboard.
  let support = floor(radius * params.projection.w / 3.0 + vec3<f32>(0.0001));
  return select(vec3<f32>(0.0), exp(-4.5 * offset * offset / (safeRadius * safeRadius)), vec3<f32>(offset) <= support);
}
fn filterHorizontal(centre : u32, pixel : vec2<i32>, dims : vec2<i32>) -> vec3<f32> {
  let base = colors[centre];
  let profile = profileRows[centre];
  if ((profile >> 24u) == 0u || (profile & 0xffffffu) == 0u || distances[centre] == 0.0) { return base; }
  let radius = unpack4x8unorm(profile).rgb * 12.0 * params.scale.x;
  var sum = base;
  var denominator = vec3<f32>(1.0);
  for (var offset = 1; offset <= 12; offset += 1) {
    let weight = gaussianWeight(f32(offset), radius);
    if (all(weight == vec3<f32>(0.0))) { break; }
    for (var sign = -1; sign <= 1; sign += 2) {
      let neighbour = u32(i32(centre) + offset * sign);
      var sampleColor = base;
      if (inside(pixel + vec2<i32>(offset * sign, 0), dims)) {
        if (accepted(centre, neighbour)) { sampleColor = colors[neighbour]; }
      }
      sum += sampleColor * weight;
      denominator += weight;
    }
  }
  return sum / denominator;
}
fn filterVertical(centre : u32, horizontalIndex : u32, pixel : vec2<i32>, dims : vec2<i32>) -> vec3<f32> {
  let base = horizontal[horizontalIndex];
  let profile = profileRows[centre];
  if ((profile >> 24u) == 0u || (profile & 0xffffffu) == 0u || distances[centre] == 0.0) { return base; }
  let radius = unpack4x8unorm(profile).rgb * 12.0 * params.scale.y;
  var sum = base;
  var denominator = vec3<f32>(1.0);
  for (var offset = 1; offset <= 12; offset += 1) {
    let weight = gaussianWeight(f32(offset), radius);
    if (all(weight == vec3<f32>(0.0))) { break; }
    for (var sign = -1; sign <= 1; sign += 2) {
      let neighbour = u32(i32(centre) + offset * sign * 32);
      var sampleColor = base;
      if (inside(pixel + vec2<i32>(0, offset * sign), dims)) {
        if (accepted(centre, neighbour)) { sampleColor = horizontal[u32(i32(horizontalIndex) + offset * sign * 8)]; }
      }
      sum += sampleColor * weight;
      denominator += weight;
    }
  }
  return sum / denominator;
}
@compute @workgroup_size(8, 8)
fn cs_subsurface(@builtin(workgroup_id) group : vec3<u32>, @builtin(local_invocation_index) local : u32) {
  let dims = vec2<i32>(textureDimensions(diffuse));
  let bandOrigin = vec2<i32>(0, i32(params.scale.z));
  let origin = vec2<i32>(group.xy) * 8 + bandOrigin - vec2<i32>(12);
  for (var index = local; index < 1024u; index += 64u) {
    let pixel = origin + vec2<i32>(i32(index % 32u), i32(index / 32u));
    colors[index] = vec3<f32>(0.0);
    profileRows[index] = 0u;
    normalRows[index] = 0u;
    distances[index] = 0.0;
    if (inside(pixel, dims)) {
      colors[index] = textureLoad(diffuse, pixel, 0).rgb;
      profileRows[index] = textureLoad(profiles, pixel, 0).g;
      normalRows[index] = textureLoad(normals, pixel, 0).r;
      let d = textureLoad(depth, pixel, 0);
      if (d > 0.0) { distances[index] = distanceFromDepth(d); }
    }
  }
  workgroupBarrier();
  for (var index = local; index < 256u; index += 64u) {
    let tileX = index % 8u + 12u;
    let tileY = index / 8u;
    let pixel = origin + vec2<i32>(i32(tileX), i32(tileY));
    horizontal[index] = filterHorizontal(tileY * 32u + tileX, pixel, dims);
  }
  workgroupBarrier();
  let x = local % 8u;
  let y = local / 8u;
  let localPixel = vec2<i32>(group.xy) * 8 + vec2<i32>(i32(x), i32(y));
  let pixel = localPixel + bandOrigin;
  if (!inside(pixel, dims) || localPixel.y >= i32(params.scale.w)) { return; }
  let centre = (y + 12u) * 32u + x + 12u;
  let strength = unpack4x8unorm(profileRows[centre]).a;
  if (strength == 0.0) {
    textureStore(delta, localPixel, vec4<f32>(0.0));
    return;
  }
  let filtered = filterVertical(centre, (y + 12u) * 8u + x, pixel, dims);
  textureStore(delta, localPixel, vec4<f32>((filtered - colors[centre]) * strength, 0.0));
}

@vertex
fn vs_subsurface(@builtin(vertex_index) index : u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(select(-1.0, 3.0, index == 1u), select(-1.0, 3.0, index == 2u), 0.0, 1.0);
}

@fragment
fn fs_subsurface(@builtin(position) position : vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy) - vec2<i32>(0, i32(params.scale.z));
  return textureLoad(composedDelta, pixel, 0);
}
