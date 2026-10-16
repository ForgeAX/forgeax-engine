#define_import_path forgeax_pbr::gbuffer

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
  return decodeStandardNormalRoughness(textureLoad(source, pixel, 0).r);
}

// Receiver geometry has its own codec: oct X12/Y11, direct DFG bit23,
// directional terrain layer base bits24..31. Shading normals remain X12/Y12.
const STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT : u32 = 0x800000u;

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

// Lighting context: reflection environment << 24 | no-receive bit 23 | probe row.
const STANDARD_GBUFFER_NO_RECEIVE_BIT : u32 = 0x800000u;
const STANDARD_GBUFFER_PROBE_ROW_MASK : u32 = 0x7fffffu;
