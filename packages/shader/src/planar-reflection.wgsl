#define_import_path forgeax_pbr::planar_reflection

struct PlanarReflectionUniform {
  viewProjection : mat4x4<f32>,
  plane : vec4<f32>,
  // Active capture, distortion radius, sampled mip count.
  capture : vec4<f32>,
  // Distance scale and bias, angle cosine scale and bias.
  receiverFade : vec4<f32>,
};

// Returns premultiplied radiance and capture coverage for environment blending.
fn samplePlanarReflection(planar : PlanarReflectionUniform, reflection : texture_2d<f32>,
  linearSampler : sampler, position : vec3<f32>, normal : vec3<f32>, toEye : vec3<f32>,
  roughness : f32) -> vec4<f32> {
  if (planar.capture.x == 0.0) { return vec4<f32>(0.0); }
  let distance = abs(dot(planar.plane, vec4<f32>(position, 1.0)));
  let distanceFade = 1.0 - clamp(distance * planar.receiverFade.x + planar.receiverFade.y, 0.0, 1.0);
  let angleFade = clamp(dot(normal, planar.plane.xyz) * planar.receiverFade.z + planar.receiverFade.w, 0.0, 1.0);
  let mipped = planar.capture.z > 1.0;
  let roughnessFade = select(1.0 - clamp((roughness - 0.2) * 10.0, 0.0, 1.0), 1.0, mipped);
  let weight = distanceFade * angleFade * roughnessFade;
  if (weight <= 0.0) { return vec4<f32>(0.0); }

  let clip = planar.viewProjection * vec4<f32>(position, 1.0);
  if (clip.w <= 0.0) { return vec4<f32>(0.0); }
  let uv = clip.xy / clip.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return vec4<f32>(0.0); }

  // Approximate the intersection by projecting the reflected ray at the
  // authored sphere radius, in the capture's mirrored camera space.
  var lookup = uv;
  if (planar.capture.y > 0.0) {
    let probe = planar.viewProjection *
      vec4<f32>(position + reflect(-toEye, normal) * planar.capture.y, 1.0);
    if (probe.w > 0.0) {
      lookup = probe.xy / probe.w * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5);
    }
  }
  let lod = clamp(roughness, 0.0, 1.0) * (planar.capture.z - 1.0);
  let reflected = textureSampleLevel(reflection, linearSampler, clamp(lookup, vec2<f32>(0.0), vec2<f32>(1.0)), lod);
  return vec4<f32>(reflected.rgb, clamp(reflected.a, 0.0, 1.0)) * weight;
}
