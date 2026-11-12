#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, encodeStandardNormalRoughness, decodeStandardReflectance, encodeStandardReflectance}

@group(0) @binding(0) var originalNormal : texture_2d<u32>;
@group(0) @binding(1) var originalAlbedo : texture_2d<u32>;
@group(0) @binding(2) var originalF0 : texture_2d<u32>;
@group(0) @binding(3) var decalColor : texture_2d<f32>;
@group(0) @binding(4) var decalNormal : texture_2d<f32>;
@group(0) @binding(5) var decalRoughness : texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vertex : u32) -> @builtin(position) vec4<f32> {
  let corners = array<vec2<f32>, 3>(vec2<f32>(-1,-1), vec2<f32>(3,-1), vec2<f32>(-1,3));
  return vec4<f32>(corners[vertex], 0, 1);
}
struct DecalSurfaceOutput {
  @location(0) normal : u32,
  @location(1) albedo : u32,
  @location(2) f0 : vec2<u32>,
};
fn composeNormalRoughness(base: vec4<f32>, normal: vec4<f32>, roughness: vec4<f32>) -> vec4<f32> {
  let normalSum = normal.xyz + base.xyz * (1.0 - normal.a);
  var finalNormal = base.xyz;
  if (dot(normalSum, normalSum) > 0.000001) { finalNormal = normalize(normalSum); }
  return vec4<f32>(finalNormal, roughness.r + base.w * (1.0 - roughness.a));
}

@fragment
fn fs_normal(@builtin(position) pixel: vec4<f32>) -> @location(0) u32 {
  let coord = vec2<i32>(pixel.xy);
  let normalBits = textureLoad(originalNormal, coord, 0).r;
  let normal = textureLoad(decalNormal, coord, 0);
  let roughness = textureLoad(decalRoughness, coord, 0);
  if (normal.a == 0.0 && roughness.a == 0.0) { return normalBits; }
  let composed = composeNormalRoughness(loadStandardNormalRoughness(originalNormal, coord), normal, roughness);
  return encodeStandardNormalRoughness(composed.xyz, composed.w);
}

@fragment
fn fs_main(@builtin(position) pixel : vec4<f32>) -> DecalSurfaceOutput {
  let coord = vec2<i32>(pixel.xy);
  let normalBits = textureLoad(originalNormal, coord, 0).r;
  let albedoBits = textureLoad(originalAlbedo, coord, 0).r;
  let f0Bits = textureLoad(originalF0, coord, 0).rg;
  let color = textureLoad(decalColor, coord, 0);
  let normal = textureLoad(decalNormal, coord, 0);
  let roughness = textureLoad(decalRoughness, coord, 0);
  if (color.a == 0.0 && normal.a == 0.0 && roughness.a == 0.0) {
    return DecalSurfaceOutput(normalBits, albedoBits, f0Bits);
  }
  let baseNormal = loadStandardNormalRoughness(originalNormal, coord);
  let baseColor = decodeStandardReflectance(albedoBits);
  let baseF0 = decodeStandardReflectance(f0Bits.x);
  let finalColor = color.rgb + baseColor.rgb * (1.0 - color.a);
  let finalNormal = composeNormalRoughness(baseNormal, normal, roughness);
  // Preserve the receiver's metallic fraction and dielectric reflectance.
  let finalF0 = baseF0.rgb + (finalColor - baseColor.rgb) * baseColor.a;
  return DecalSurfaceOutput(encodeStandardNormalRoughness(finalNormal.xyz, finalNormal.w),
    encodeStandardReflectance(finalColor, baseColor.a), vec2<u32>(encodeStandardReflectance(finalF0, baseF0.a), f0Bits.y));
}
