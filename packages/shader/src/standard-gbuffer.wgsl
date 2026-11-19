#define_import_path forgeax_pbr::gbuffer

// Selected by the native PSO, not an additional source-template variant.
// Forward surface-normal-v1 remains 0; full Deferred GBuffer-v2 is 1.
@id(64003) override standardSceneNormalLayout : u32 = 0u;
const STANDARD_GBUFFER_VALID_BIT : u32 = 0x40000000u;
const STANDARD_GBUFFER_V2_DIRECT_DFG_BIT : u32 = 0x80000000u;

fn encodeStandardGBufferNormal(normal : vec3<f32>, roughness : f32, occlusion : f32, directDfg : bool) -> vec2<u32> {
  let xyz = vec3<u32>(round(clamp(normalize(normal) * 0.5 + 0.5, vec3<f32>(0.0), vec3<f32>(1.0)) * 1023.0));
  let scalars = vec2<u32>(round(clamp(vec2<f32>(roughness, occlusion), vec2<f32>(0.0), vec2<f32>(1.0)) * 255.0));
  return vec2<u32>(xyz.x | (xyz.y << 10u) | (xyz.z << 20u) | STANDARD_GBUFFER_VALID_BIT |
    select(0u, STANDARD_GBUFFER_V2_DIRECT_DFG_BIT, directDfg), scalars.x | (scalars.y << 8u));
}

fn decodeStandardGBufferNormal(packed : vec2<u32>) -> vec4<f32> {
  let xyz = vec3<f32>(f32(packed.x & 1023u), f32((packed.x >> 10u) & 1023u), f32((packed.x >> 20u) & 1023u)) * (2.0 / 1023.0) - 1.0;
  return vec4<f32>(normalize(xyz), f32(packed.y & 255u) / 255.0);
}

fn standardGBufferValid(packed : vec2<u32>) -> bool {
  return (packed.x & STANDARD_GBUFFER_VALID_BIT) != 0u;
}

fn standardGBufferOcclusion(packed : vec2<u32>) -> f32 {
  return f32((packed.y >> 8u) & 255u) / 255.0;
}

fn loadStandardGBufferNormalRoughness(source : texture_2d<u32>, pixel : vec2<i32>) -> vec4<f32> {
  return decodeStandardGBufferNormal(textureLoad(source, pixel, 0).rg);
}

fn loadStandardGBufferValid(source : texture_2d<u32>, pixel : vec2<i32>) -> bool {
  return standardGBufferValid(textureLoad(source, pixel, 0).rg);
}

fn loadStandardSceneSurfaceValid(source : texture_2d<u32>, pixel : vec2<i32>) -> bool {
  return standardSceneNormalLayout == 0u || (standardSceneNormalLayout == 1u && standardGBufferValid(textureLoad(source, pixel, 0).rg));
}

fn encodeStandardNormalRoughness(normal : vec3<f32>, roughness : f32) -> u32 {
  let n = normalize(normal);
  var oct = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    oct = (1.0 - abs(oct.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), oct >= vec2<f32>(0.0));
  }
  let uv = vec2<u32>(round(clamp(oct * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * 4095.0));
  return uv.x | (uv.y << 12u) | (u32(round(clamp(roughness, 0.0, 1.0) * 255.0)) << 24u);
}

// Normal and roughness are decoded together, never filtered as packed bits.
fn decodeStandardNormalRoughness(packed : u32) -> vec4<f32> {
  let oct = vec2<f32>(f32(packed & 4095u), f32((packed >> 12u) & 4095u)) * (2.0 / 4095.0) - 1.0;
  var normal = vec3<f32>(oct, 1.0 - abs(oct.x) - abs(oct.y));
  let fold = max(-normal.z, 0.0);
  normal = vec3<f32>(normal.xy + select(vec2<f32>(fold), vec2<f32>(-fold), normal.xy >= vec2<f32>(0.0)), normal.z);
  return vec4<f32>(normalize(normal), f32(packed >> 24u) / 255.0);
}

fn loadStandardNormalRoughness(source : texture_2d<u32>, pixel : vec2<i32>) -> vec4<f32> {
  let packed = textureLoad(source, pixel, 0).rg;
  if (standardSceneNormalLayout == 1u) { return decodeStandardGBufferNormal(packed); }
  return decodeStandardNormalRoughness(packed.x);
}

// Receiver geometry has its own codec: oct X12/Y11, reserved bit23,
// directional terrain layer base bits24..31. Shading normals remain X12/Y12.

fn encodeStandardReceiverNormal(normal : vec3<f32>) -> u32 {
  let n = normalize(normal);
  var oct = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.z < 0.0) {
    oct = (1.0 - abs(oct.yx)) * select(vec2<f32>(-1.0), vec2<f32>(1.0), oct >= vec2<f32>(0.0));
  }
  let uv = vec2<u32>(round(clamp(oct * 0.5 + 0.5, vec2<f32>(0.0), vec2<f32>(1.0)) * vec2<f32>(4095.0, 2047.0)));
  return uv.x | (uv.y << 12u);
}

fn decodeStandardReceiverNormal(packed : u32) -> vec3<f32> {
  let oct = vec2<f32>(f32(packed & 4095u), f32((packed >> 12u) & 2047u)) * vec2<f32>(2.0 / 4095.0, 2.0 / 2047.0) - 1.0;
  var normal = vec3<f32>(oct, 1.0 - abs(oct.x) - abs(oct.y));
  let fold = max(-normal.z, 0.0);
  normal = vec3<f32>(normal.xy + select(vec2<f32>(fold), vec2<f32>(-fold), normal.xy >= vec2<f32>(0.0)), normal.z);
  return normalize(normal);
}

// Allocate more UNORM codes to dark reflectance, as with UE's encoded base
// color. Alpha is an independent linear material scalar.
fn encodeStandardReflectance(rgb : vec3<f32>, alpha : f32) -> u32 {
  return pack4x8unorm(vec4<f32>(sqrt(clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0))), alpha));
}

fn decodeStandardReflectance(packed : u32) -> vec4<f32> {
  let value = unpack4x8unorm(packed);
  return vec4<f32>(value.rgb * value.rgb, value.a);
}

struct StandardGBufferReflectance {
  response : vec4<f32>,
  dielectricSpecular : vec4<f32>,
};

// Reconstruct the mixed response in the stable forward direction. The
// dielectric F0/F90 remain independent, even when metalness reaches one.
// Roughness/AO accompany the packed normal; no mixed F0 is stored.
fn decodeStandardGBufferReflectance(albedoMetallic : vec4<f32>, packed : u32, normal : vec2<u32>) -> StandardGBufferReflectance {
  let dielectric = decodeStandardReflectance(packed);
  let mixed = mix(dielectric.rgb, albedoMetallic.rgb, albedoMetallic.a);
  return StandardGBufferReflectance(vec4<f32>(mixed, standardGBufferOcclusion(normal)), dielectric);
}

// Lighting context: reflection environment << 24 | no-receive bit 23 | probe row.
const STANDARD_GBUFFER_NO_RECEIVE_BIT : u32 = 0x800000u;
const STANDARD_GBUFFER_PROBE_ROW_MASK : u32 = 0x7fffffu;
