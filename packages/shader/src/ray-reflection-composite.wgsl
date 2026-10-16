#define_import_path forgeax_ray::reflection_composite
#import forgeax_view::common::{FullscreenOutput, fullscreen_triangle}
#import forgeax_pbr::gbuffer::{loadStandardNormalRoughness}

// Raw world radiance keeps its 80-byte accumulation ABI; the reconstructed
// signal is the shared 16-byte diffuse reconstruction output (w == 1 valid).
@group(0) @binding(0) var<storage, read> accumulation: array<vec4u>;
@group(0) @binding(1) var<storage, read> reconstructed: array<vec4u>;
@group(0) @binding(2) var depth: texture_depth_2d;
@group(0) @binding(3) var normal: texture_2d<u32>;
// Deferred split-sum response: DFG(F0, NoV, roughness) x material AO.
@group(0) @binding(4) var response: texture_2d<f32>;

struct ReflectionOutput {
  @location(0) scene: vec4f,
  @location(1) fallback: vec4f,
}

@vertex fn vs_ray_reflection(@builtin(vertex_index) index: u32) -> FullscreenOutput {
  return fullscreen_triangle(index);
}

fn rawRadiance(index: u32) -> vec4f {
  let base = index * 5u;
  if (accumulation[base].w == 0u || accumulation[base + 1u].w != 0u) { return vec4f(0); }
  return vec4f(bitcast<vec3f>(accumulation[base].xyz), 1.0);
}

// Specular indirect = world radiance x response. The same value is added to the
// reflection fallback so SSR composition replaces it by confidence instead of
// adding on top: c*ssr*resp + (1-c)*world*resp. IBL specular is off under GI.
fn shadeReflection(pixel: vec2i, radiance: vec4f) -> ReflectionOutput {
  let none = ReflectionOutput(vec4f(0), vec4f(0));
  let extent = textureDimensions(depth);
  if (any(textureDimensions(normal) != extent) || any(textureDimensions(response) != extent)) {
    return none;
  }
  let z = textureLoad(depth, pixel, 0);
  if (!(z > 0.0 && z <= 1.0) || radiance.w != 1.0) { return none; }
  if (!all(radiance.xyz >= vec3f(0)) || !all(radiance.xyz < vec3f(1e30))) { return none; }
  let specular = radiance.xyz * max(textureLoad(response, pixel, 0).rgb, vec3f(0));
  return ReflectionOutput(vec4f(specular, 0), vec4f(specular, 0));
}

@fragment fn fs_ray_reflection(in: FullscreenOutput) -> ReflectionOutput {
  let extent = textureDimensions(depth);
  if (arrayLength(&accumulation) != extent.x * extent.y * 5u) { return ReflectionOutput(vec4f(0), vec4f(0)); }
  let pixel = vec2u(in.position.xy);
  return shadeReflection(vec2i(pixel), rawRadiance(pixel.y * extent.x + pixel.x));
}

// Near-mirror receivers keep the raw dedicated ray (sub-pixel lobe, no blur);
// glossy and rough receivers use the denoised signal.
@fragment fn fs_ray_reflection_reconstructed(in: FullscreenOutput) -> ReflectionOutput {
  let extent = textureDimensions(depth);
  if (arrayLength(&accumulation) != extent.x * extent.y * 5u ||
      arrayLength(&reconstructed) != extent.x * extent.y) {
    return ReflectionOutput(vec4f(0), vec4f(0));
  }
  let pixel = vec2u(in.position.xy);
  let index = pixel.y * extent.x + pixel.x;
  let raw = rawRadiance(index);
  let filtered = bitcast<vec4f>(reconstructed[index]);
  let roughness = loadStandardNormalRoughness(normal, vec2i(pixel)).w;
  let rawWeight = 1.0 - smoothstep(0.05, 0.15, roughness);
  var radiance = filtered;
  if (rawWeight >= 1.0 || filtered.w != 1.0) {
    radiance = raw;
  } else if (rawWeight > 0.0 && raw.w == 1.0) {
    radiance = vec4f(mix(filtered.xyz, raw.xyz, rawWeight), 1.0);
  }
  return shadeReflection(vec2i(pixel), radiance);
}

// Irradiance-field and screen-probe lanes: the radiance-cache reflection signal
// (16 bytes per pixel, w == 1 valid) bound as `reconstructed`.
@fragment fn fs_ray_reflection_field(in: FullscreenOutput) -> ReflectionOutput {
  let extent = textureDimensions(depth);
  if (arrayLength(&reconstructed) != extent.x * extent.y) {
    return ReflectionOutput(vec4f(0), vec4f(0));
  }
  let pixel = vec2u(in.position.xy);
  return shadeReflection(vec2i(pixel), bitcast<vec4f>(reconstructed[pixel.y * extent.x + pixel.x]));
}
