#define_import_path forgeax_ray::diffuse_composite
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness, decodeStandardReflectance}
#import forgeax_pbr::ibl_shared::{standardDiffuseWeight}
#import forgeax_pbr::ibl_sampling::{environmentMultiScattering}

// The caller provides one coherent raster frame and its unit-receiver D.
// Accumulation retains its existing 80-byte mean/count/error/auxiliary ABI.
@group(0) @binding(0) var<storage, read> accumulation: array<vec4u>;
@group(0) @binding(1) var depth: texture_depth_2d;
@group(0) @binding(2) var normal: texture_2d<u32>;
@group(0) @binding(3) var albedoMetallic: texture_2d<u32>;
@group(0) @binding(4) var f0Occlusion: texture_2d<u32>;
@group(0) @binding(5) var<uniform> view: View;
// Bound only by the reflection-enabled entries. RGB already includes material AO;
// alpha transports missing GGX energy from the same DFG lookup as the specular lane.
@group(0) @binding(6) var reflectionResponse: texture_2d<f32>;

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

fn rawIrradiance(in: FullscreenOutput) -> vec4f {
  let extent = textureDimensions(depth);
  if (arrayLength(&accumulation) != extent.x * extent.y * 5u) { return vec4f(0); }
  let pixel = vec2u(in.position.xy);
  let base = (pixel.y * extent.x + pixel.x) * 5u;
  if (accumulation[base].w == 0u || accumulation[base + 1u].w != 0u) { return vec4f(0); }
  return vec4f(bitcast<vec3f>(accumulation[base].xyz), 1.0);
}

fn reconstructedIrradiance(in: FullscreenOutput) -> vec4f {
  let extent = textureDimensions(depth);
  if (arrayLength(&accumulation) != extent.x * extent.y) { return vec4f(0); }
  let pixel = vec2u(in.position.xy);
  let value = bitcast<vec4f>(accumulation[pixel.y * extent.x + pixel.x]);
  if (value.w != 1.0) { return vec4f(0); }
  return value;
}

fn shadeIrradiance(in: FullscreenOutput, d: vec4f) -> vec4f {
  if (d.w != 1.0) { return vec4f(0); }
  return shadeDiffuse(in, d.xyz);
}

fn shadeReflectionIrradiance(in: FullscreenOutput, d: vec4f) -> vec4f {
  if (d.w != 1.0 || !all(d.xyz >= vec3f(0)) || !all(d.xyz < vec3f(1e30))) { return vec4f(0); }
  let pixel = vec2i(in.position.xy);
  let z = textureLoad(depth, pixel, 0);
  if (!(z > 0.0 && z <= 1.0)) { return vec4f(0); }
  let material = decodeStandardReflectance(textureLoad(f0Occlusion, pixel, 0).r);
  let albedo = decodeStandardReflectance(textureLoad(albedoMetallic, pixel, 0).r);
  let response = textureLoad(reflectionResponse, pixel, 0);
  // Inter-microfacet bounces follow cosine-weighted GI, independently of the
  // directional reflection signal. SSR can replace the latter without losing this.
  let multi = environmentMultiScattering(response.rgb, response.a, material.rgb);
  let diffuse = max(vec3f(0), vec3f(material.a) - response.rgb - multi) * (1.0 - albedo.a);
  return vec4f(d.xyz * (diffuse * albedo.rgb + multi), 0);
}

@fragment fn fs_ray_diffuse(in: FullscreenOutput) -> @location(0) vec4f {
  return shadeIrradiance(in, rawIrradiance(in));
}
@fragment fn fs_ray_diffuse_reconstructed(in: FullscreenOutput) -> @location(0) vec4f {
  return shadeIrradiance(in, reconstructedIrradiance(in));
}
@fragment fn fs_ray_diffuse_reflections(in: FullscreenOutput) -> @location(0) vec4f {
  return shadeReflectionIrradiance(in, rawIrradiance(in));
}
@fragment fn fs_ray_diffuse_reconstructed_reflections(in: FullscreenOutput) -> @location(0) vec4f {
  return shadeReflectionIrradiance(in, reconstructedIrradiance(in));
}
