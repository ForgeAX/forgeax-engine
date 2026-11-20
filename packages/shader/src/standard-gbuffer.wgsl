#define_import_path forgeax_pbr::gbuffer

// Selected by the native PSO, not an additional source-template variant.
// Forward is 0, full Deferred is 1, and Default GBuffer A is 2.
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

fn usesDefaultGBuffer() -> bool {
  return standardSceneNormalLayout == 2u;
}

fn loadStandardSceneSurfaceValid(source : texture_2d<u32>, pixel : vec2<i32>) -> bool {
  if (standardSceneNormalLayout == 0u) { return true; }
  let packed = textureLoad(source, pixel, 0).rg;
  if (standardSceneNormalLayout == 2u) {
    // A normalized XYZ10 vector cannot encode to the cleared zero word.
    return packed.x != 0u;
  }
  return standardSceneNormalLayout == 1u && standardGBufferValid(packed);
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
  if (standardSceneNormalLayout == 1u || standardSceneNormalLayout == 2u) {
    return decodeStandardGBufferNormal(packed);
  }
  return decodeStandardNormalRoughness(packed.x);
}

fn loadStandardSceneNormal(source : texture_2d<u32>, pixel : vec2<i32>) -> vec3<f32> {
  if (standardSceneNormalLayout == 2u) {
    // Default GBuffer stores roughness separately in B.
    return decodeStandardGBufferNormal(vec2<u32>(textureLoad(source, pixel, 0).r, 0u)).xyz;
  }
  return loadStandardNormalRoughness(source, pixel).xyz;
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

fn projectDeferredReceiverChannels(raw : u32, mapping : u32) -> u32 {
  let indices = vec3<u32>(mapping, mapping >> 5u, mapping >> 10u) & vec3<u32>(31u);
  let channels = (vec3<u32>(raw) >> indices) & vec3<u32>(1u);
  let maskLimit = (1u << ((mapping >> 15u) & 3u)) - 1u;
  return (channels.x | (channels.y << 1u) | (channels.z << 2u)) & maskLimit;
}
// UE 5.8.1 desktop legacy Default Lit with dynamic lighting and no velocity MRT.
// R32Uint retains the logical channel widths without increasing WebGPU MRT cost.
const COMPACT_DEFAULT_LIT : u32 = 1u;
const COMPACT_SUBSURFACE_PROFILE : u32 = 5u;
const COMPACT_SKIP_PRECOMPUTED_SHADOW : u32 = 32u;
const COMPACT_SKIP_VELOCITY : u32 = 128u;

fn encodeCompactGBuffer(normal : vec3<f32>, metallic : f32, dielectricF0 : f32,
  roughness : f32, baseColor : vec3<f32>, ao : f32, hasCustomData : bool, objectFlags : u32) -> vec3<u32> {
  let a = (encodeStandardGBufferNormal(normal, 0.0, 0.0, false).x & 0x3fffffffu) | (objectFlags << 30u);
  let model = select(COMPACT_DEFAULT_LIT, COMPACT_SUBSURFACE_PROFILE, hasCustomData);
  let modelAndMask = model | COMPACT_SKIP_PRECOMPUTED_SHADOW | COMPACT_SKIP_VELOCITY;
  let b = pack4x8unorm(vec4<f32>(metallic, dielectricF0 / 0.08, roughness, f32(modelAndMask) / 255.0));
  return vec3<u32>(a, b, encodeCompactBaseColor(baseColor, ao));
}

fn encodeCompactBaseColor(baseColor : vec3<f32>, ao : f32) -> u32 {
  let linear = clamp(baseColor, vec3<f32>(0.0), vec3<f32>(1.0));
  let srgb = select(1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - 0.055,
    linear * 12.92, linear <= vec3<f32>(0.0031308));
  return pack4x8unorm(vec4<f32>(srgb, ao));
}

fn compactGBufferLit(word : u32) -> bool {
  let model = (word >> 24u) & 15u;
  return model == COMPACT_DEFAULT_LIT || model == COMPACT_SUBSURFACE_PROFILE;
}

fn compactGBufferSubsurface(word : u32) -> bool {
  return ((word >> 24u) & 15u) == COMPACT_SUBSURFACE_PROFILE;
}

fn decodeCompactBaseColor(srgb : vec3<f32>) -> vec3<f32> {
  return select(pow((srgb + 0.055) / 1.055, vec3<f32>(2.4)),
    srgb / 12.92, srgb <= vec3<f32>(0.04045));
}

fn loadCompactGBufferRoughness(context : texture_2d<u32>, pixel : vec2<i32>) -> f32 {
  return f32((textureLoad(context, pixel, 0).r >> 16u) & 255u) / 255.0;
}

// The RGB bytes identify the quantized radius tuple. Weight stays per pixel.
fn standardSubsurfaceActive(profile : u32) -> bool {
  return (profile & 0x00ffffffu) != 0u && (profile >> 24u) != 0u;
}
