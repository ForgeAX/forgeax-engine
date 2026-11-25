#import forgeax_pbr::gbuffer::{decodeStandardReflectance, encodeStandardReflectance, decodeStandardGBufferNormal, encodeStandardGBufferNormal, standardGBufferValid, standardGBufferOcclusion, STANDARD_GBUFFER_V2_DIRECT_DFG_BIT, STANDARD_GBUFFER_SCREEN_TRACE_MASK, compactGBufferLit, decodeCompactBaseColor, encodeCompactBaseColor}

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
  @location(0) normal : vec2<u32>,
  @location(1) albedo : u32,
  @location(2) f0 : u32,
};
fn composeNormalRoughness(base: vec4<f32>, normal: vec4<f32>, roughness: vec4<f32>) -> vec4<f32> {
  let normalSum = normal.xyz + base.xyz * (1.0 - normal.a);
  var finalNormal = base.xyz;
  if (dot(normalSum, normalSum) > 0.000001) { finalNormal = normalize(normalSum); }
  return vec4<f32>(finalNormal, roughness.r + base.w * (1.0 - roughness.a));
}

@fragment
fn fs_main(@builtin(position) pixel : vec4<f32>) -> DecalSurfaceOutput {
  let coord = vec2<i32>(pixel.xy);
  let normalBits = textureLoad(originalNormal, coord, 0).rg;
  let albedoBits = textureLoad(originalAlbedo, coord, 0).r;
  let f0Bits = textureLoad(originalF0, coord, 0).r;
  if (!standardGBufferValid(normalBits)) { return DecalSurfaceOutput(normalBits, albedoBits, f0Bits); }
  let color = textureLoad(decalColor, coord, 0);
  let normal = textureLoad(decalNormal, coord, 0);
  let roughness = textureLoad(decalRoughness, coord, 0);
  if (color.a == 0.0 && normal.a == 0.0 && roughness.a == 0.0) {
    return DecalSurfaceOutput(normalBits, albedoBits, f0Bits);
  }
  let baseNormal = decodeStandardGBufferNormal(normalBits);
  let baseColor = decodeStandardReflectance(albedoBits);
  let finalColor = color.rgb + baseColor.rgb * (1.0 - color.a);
  let finalNormal = composeNormalRoughness(baseNormal, normal, roughness);
  // Preserve the receiver's metallic fraction and dielectric reflectance.
  var composed = encodeStandardGBufferNormal(finalNormal.xyz, finalNormal.w, standardGBufferOcclusion(normalBits),
    (normalBits.x & STANDARD_GBUFFER_V2_DIRECT_DFG_BIT) != 0u);
  composed.y |= normalBits.y & STANDARD_GBUFFER_SCREEN_TRACE_MASK;
  return DecalSurfaceOutput(composed, encodeStandardReflectance(finalColor, baseColor.a), f0Bits);
}

struct DefaultDecalSurfaceOutput {
  @location(0) normal : u32,
  @location(1) baseColor : u32,
  @location(2) material : u32,
};

@fragment
fn fs_default_gbuffer(@builtin(position) pixel : vec4<f32>) -> DefaultDecalSurfaceOutput {
  let coord = vec2<i32>(pixel.xy);
  let a = textureLoad(originalNormal, coord, 0).r;
  let b = textureLoad(originalF0, coord, 0).r;
  let c = textureLoad(originalAlbedo, coord, 0).r;
  var output = DefaultDecalSurfaceOutput(a, c, b);
  if (!compactGBufferLit(b)) { return output; }
  let normal = textureLoad(decalNormal, coord, 0);
  let roughness = textureLoad(decalRoughness, coord, 0);
  if (normal.a > 0.0 || roughness.a > 0.0) {
    let source = decodeStandardGBufferNormal(vec2<u32>(a, (b >> 16u) & 255u));
    let composed = composeNormalRoughness(source, normal, roughness);
    if (normal.a > 0.0) {
      let encoded = encodeStandardGBufferNormal(composed.xyz, 0.0, 0.0, false).x;
      output.normal = (a & 0xc0000000u) | (encoded & 0x3fffffffu);
    }
    if (roughness.a > 0.0) {
      let encoded = u32(round(clamp(composed.w, 0.0, 1.0) * 255.0));
      output.material = (b & 0xff00ffffu) | (encoded << 16u);
    }
  }
  let color = textureLoad(decalColor, coord, 0);
  if (color.a > 0.0) {
    let baseColor = decodeCompactBaseColor(unpack4x8unorm(c).rgb);
    let encoded = encodeCompactBaseColor(color.rgb + baseColor * (1.0 - color.a), 0.0);
    output.baseColor = (c & 0xff000000u) | (encoded & 0x00ffffffu);
  }
  return output;
}
