#define_import_path forgeax_pbr::gbuffer_output
#import forgeax_pbr::gbuffer::{encodeStandardNormalRoughness, encodeStandardReceiverNormal, encodeStandardReflectance, STANDARD_GBUFFER_NO_RECEIVE_BIT, STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT}

// SceneColor owns emissive/opacity from the geometry pass onward. Five packed
// surface attachments retain receiver channels and the bounded subsurface profile.
struct GBufferOutput {
  @location(0) scene_color : vec4<f32>,
  @location(1) normal_roughness : u32,
  @location(2) f0_occlusion : vec2<u32>,
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

fn encodeStandardGBuffer(normal : vec3<f32>, receiverNormal : vec3<f32>, roughness : f32, albedo : vec3<f32>,
  metallic : f32, f0 : vec3<f32>, dielectricSpecular : vec4<f32>, occlusion : f32, emissive : vec3<f32>,
  opacity : f32, reflection : u32, probeRow : u32, receiveShadows : bool, receiverChannels : u32, subsurface : vec4<f32>, useDirectDfgLut : bool) -> GBufferOutput {
  var output : GBufferOutput;
  output.scene_color = vec4<f32>(emissive, opacity);
  output.receiver_geometry = vec2<u32>(encodeStandardReceiverNormal(receiverNormal)
    | select(0u, STANDARD_GBUFFER_DIRECT_DFG_LUT_BIT, useDirectDfgLut), receiverChannels);
  output.normal_roughness = encodeStandardNormalRoughness(normal, roughness);
  // Retain the dielectric response independently: recovering it from mixed
  // quantized F0 becomes ill-conditioned as metalness approaches one.
  output.f0_occlusion = vec2<u32>(encodeStandardReflectance(f0, occlusion),
    encodeStandardReflectance(dielectricSpecular.rgb, dielectricSpecular.a));
  output.albedo_metallic = encodeStandardReflectance(albedo, metallic);
  // WGSL pack4x8unorm semantics, expressed with integer lanes: the actual
  // dynamic builtin produced zero profiles on the retained Dawn/Metal frame.
  let subsurfaceBytes = vec4<u32>(floor(vec4<f32>(0.5) + 255.0 *
    clamp(vec4<f32>(subsurface.rgb / 12.0, subsurface.a), vec4<f32>(0.0), vec4<f32>(1.0))));
  let subsurfaceProfile = subsurfaceBytes.x | (subsurfaceBytes.y << 8u) |
    (subsurfaceBytes.z << 16u) | (subsurfaceBytes.w << 24u);
  output.lighting_context = vec2<u32>((reflection << 24u) | select(STANDARD_GBUFFER_NO_RECEIVE_BIT, 0u, receiveShadows) | probeRow,
    subsurfaceProfile);
  output.scene_temporal = vec4<f32>(0.0, 0.0, -1.0, 1.0);
  return output;
}
