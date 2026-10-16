#define_import_path forgeax_ray::diffuse_composite
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, decodeStandardReflectance}
#import forgeax_pbr::ibl_shared::{standardDiffuseWeight}

// The caller provides one coherent raster frame and its unit-receiver D.
// Accumulation retains its existing 80-byte mean/count/error/auxiliary ABI.
@group(0) @binding(0) var<storage, read> accumulation: array<vec4u>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var normal: texture_2d<u32>;
@group(0) @binding(3) var albedoMetallic: texture_2d<u32>;
@group(0) @binding(4) var f0Occlusion: texture_2d<u32>;
@group(0) @binding(5) var<uniform> view: View;

@vertex fn vs_ray_diffuse(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}

// Add only the diffuse indirect contribution. Alpha zero preserves scene
// coverage under additive blending. Invalid transport remains inspectable in
// accumulation; it cannot be promoted to a valid sky sample by this consumer.
fn shadeDiffuse(in: FullscreenOutput, d: vec3f) -> vec4f {
  let extent = textureDimensions(depth);
  let pixel = vec2i(in.position.xy);
  if (any(textureDimensions(normal) != extent) ||
      any(textureDimensions(albedoMetallic) != extent) ||
      any(textureDimensions(f0Occlusion) != extent)) { return vec4f(0); }
  let z = textureLoad(depth, pixel, 0);
  if (!(z > 0.0 && z <= 1.0)) { return vec4f(0); }
  if (!all(d >= vec3f(0)) || !all(d < vec3f(1e30))) { return vec4f(0); }
  let uv = in.position.xy / vec2f(extent);
  let p = view.inverseViewProj * vec4f(uv * vec2f(2,-2) + vec2f(-1,1), z, 1);
  let position = p.xyz / p.w;
  if (!all(abs(position) < vec3f(1e30))) { return vec4f(0); }
  let outgoing = view.cameraPos - position;
  if (!(dot(outgoing, outgoing) > 0.0)) { return vec4f(0); }
  let n = loadStandardNormalRoughness(normal, pixel);
  let albedo = decodeStandardReflectance(textureLoad(albedoMetallic, pixel, 0).r);
  let response = decodeStandardReflectance(textureLoad(f0Occlusion, pixel, 0).r);
  let weight = standardDiffuseWeight(max(dot(n.xyz, normalize(outgoing)), 0.0),
    response.rgb, n.w, albedo.a);
  // Material AO belongs only to this indirect term. The raster scene target
  // is never sampled or multiplied; emission and direct lighting survive.
  return vec4f(weight * d * albedo.rgb * response.a, 0);
}

@fragment fn fs_ray_diffuse(in: FullscreenOutput) -> @location(0) vec4f {
  let extent = textureDimensions(depth);
  if (arrayLength(&accumulation) != extent.x * extent.y * 5u) { return vec4f(0); }
  let pixel = vec2u(in.position.xy);
  let base = (pixel.y * extent.x + pixel.x) * 5u;
  if (accumulation[base].w == 0u || accumulation[base + 1u].w != 0u) { return vec4f(0); }
  return shadeDiffuse(in, bitcast<vec3f>(accumulation[base].xyz));
}

@fragment fn fs_ray_diffuse_reconstructed(in: FullscreenOutput) -> @location(0) vec4f {
  let extent = textureDimensions(depth);
  if (arrayLength(&accumulation) != extent.x * extent.y) { return vec4f(0); }
  let pixel = vec2u(in.position.xy);
  let value = bitcast<vec4f>(accumulation[pixel.y * extent.x + pixel.x]);
  if (value.w != 1.0) { return vec4f(0); }
  return shadeDiffuse(in, value.xyz);
}
