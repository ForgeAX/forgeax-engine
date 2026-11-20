#define_import_path forgeax_pbr::gbuffer_output
#import forgeax_pbr::gbuffer::{encodeStandardGBufferNormal, encodeStandardReceiverNormal, encodeStandardReflectance, STANDARD_GBUFFER_NO_RECEIVE_BIT, encodeCompactGBuffer, standardSubsurfaceActive}

// SceneColor owns emissive/opacity from the geometry pass onward. Five packed
// surface attachments retain receiver channels and the bounded subsurface profile.
struct GBufferOutput {
  @location(0) scene_color : vec4<f32>,
  @location(1) normal_roughness : vec2<u32>,
  @location(2) dielectric_specular : u32,
  @location(3) albedo_metallic : u32,
  @location(4) lighting_context : vec2<u32>,
  @location(5) receiver_geometry : vec2<u32>,
#ifdef VISIBLE_SURFACE_AVAILABLE
  // Frame row, draw-local primitive, packed geometric normal, coverage flags.
  @location(6) visible_surface : vec4<u32>,
  @location(7) scene_temporal : vec4<f32>,
#else
  // Optional attachment: the same shaded surface publishes temporal-v1.
  @location(6) scene_temporal : vec4<f32>,
#endif
};

fn encodeStandardReceiverContext(reflection : u32, probeRow : u32, receiveShadows : bool) -> u32 {
  return (reflection << 24u) | select(STANDARD_GBUFFER_NO_RECEIVE_BIT, 0u, receiveShadows) | probeRow;
}

fn encodeStandardSubsurfaceRadius(subsurface : vec4<f32>) -> u32 {
  // Use explicit UNORM rounding for both source and native WebGPU backends.
  let bytes = vec4<u32>(floor(vec4<f32>(0.5) + 255.0 *
    clamp(vec4<f32>(subsurface.rgb / 12.0, subsurface.a), vec4<f32>(0.0), vec4<f32>(1.0))));
  return bytes.x | (bytes.y << 8u) | (bytes.z << 16u) | (bytes.w << 24u);
}

fn compactSubsurfaceCustomData(subsurface : vec4<f32>, profiles : array<vec4<u32>, 4>) -> u32 {
  let encoded = encodeStandardSubsurfaceRadius(subsurface);
  if (!standardSubsurfaceActive(encoded)) { return 0u; }
  let radius = encoded & 0x00ffffffu;
  for (var index = 0u; index < 16u; index += 1u) {
    if (profiles[index >> 2u][index & 3u] == radius) {
      // UE non-Substrate Subsurface Profile: R = profile ID, G/B = 0, A = weight.
      return (encoded & 0xff000000u) | (index + 1u);
    }
  }
  return 0u;
}

fn encodeStandardGBuffer(normal : vec3<f32>, receiverNormal : vec3<f32>, roughness : f32, albedo : vec3<f32>,
  metallic : f32, dielectricSpecular : vec4<f32>, occlusion : f32, emissive : vec3<f32>,
  opacity : f32, reflection : u32, probeRow : u32, receiveShadows : bool, receiverChannels : u32, subsurface : vec4<f32>, useDirectDfgLut : bool) -> GBufferOutput {
  var output : GBufferOutput;
  output.scene_color = vec4<f32>(emissive, opacity);
  output.receiver_geometry = vec2<u32>(encodeStandardReceiverNormal(receiverNormal), receiverChannels);
  output.normal_roughness = encodeStandardGBufferNormal(normal, roughness, occlusion, useDirectDfgLut);
  // Retain the dielectric response independently: recovering it from mixed
  // quantized F0 becomes ill-conditioned as metalness approaches one.
  output.dielectric_specular = encodeStandardReflectance(dielectricSpecular.rgb, dielectricSpecular.a);
  output.albedo_metallic = encodeStandardReflectance(albedo, metallic);
  let subsurfaceProfile = encodeStandardSubsurfaceRadius(subsurface);
  output.lighting_context = vec2<u32>(encodeStandardReceiverContext(reflection, probeRow, receiveShadows), subsurfaceProfile);
  output.scene_temporal = vec4<f32>(0.0, 0.0, -1.0, 1.0);
  return output;
}

// The compact entry writes Default GBuffer A-D for every admitted shading model.
struct CompactGBufferOutput {
  @location(0) scene_color : vec4<f32>,
  @location(1) a : u32,
  @location(2) b : u32,
  @location(3) c : u32,
  @location(4) d : u32,
  // Optional receiver target: channels, surface context and geometric receiver.
  @location(5) receiver : vec4<u32>,
  @location(6) visible_surface : vec4<u32>,
};

struct StandardGBufferPassOutput {
  full : GBufferOutput,
  compact : CompactGBufferOutput,
};

fn encodeCompactStandardGBuffer(normal : vec3<f32>, roughness : f32, baseColor : vec3<f32>,
  metallic : f32, dielectricF0 : f32, ao : f32, emissive : vec3<f32>, opacity : f32, receiver : vec4<u32>, customData : u32, objectFlags : u32) -> CompactGBufferOutput {
  let words = encodeCompactGBuffer(normal, metallic, dielectricF0, roughness, baseColor, ao, customData != 0u, objectFlags);
  return CompactGBufferOutput(vec4<f32>(emissive, opacity), words.x, words.y, words.z, customData, receiver, vec4<u32>(0u));
}
