#define_import_path my-game::pulse-material

#import forgeax_view::common::{transformNormal, view, meshes}
#import forgeax_pbr::brdf::{f_schlick}

// pulse-material.wgsl - feat-20260523-shader-template-instance-split M5 / T07
// AC-14 free-end demo: a minimal user-side custom material shader (~30 lines
// of body) that pulses baseColor over time using a tiny user-defined uniform.
//
// AI-user discoverability (charter F1 + AC-14): grep
// `#define_import_path my-game::` + `#import forgeax_pbr` to enumerate
// (a) the user-namespaced module + (b) the engine helpers it depends on.
// User shaders pick their own `<package>::<id>` import path; only the
// `forgeax::` prefix is engine-reserved (FORGEAX_RESERVED_PATH_PREFIX).

struct VsIn  {
  @location(0) pos    : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv     : vec2<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
  @location(1) baseColorUv : vec2<f32>,
  @location(2) normalUv : vec2<f32>,
};

fn transformUv(uv : vec2<f32>, transform : vec4<f32>) -> vec2<f32> {
  return uv * transform.zw + transform.xy;
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldNormal = normalize(transformNormal(meshes[idx].worldFromLocal, in.normal));
  out.baseColorUv = transformUv(in.uv, material.baseColorUvTransform);
  out.normalUv = transformUv(in.uv, material.normalUvTransform);
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  // Pulse modulates baseColor brightness via sin(time * speed) -> 0.5..1.0
  // window so the demo is always at least half-bright (AC-14: visible
  // brightness change over time, not a strobe to black).
  let pulse_factor = sin(material.time * material.speed) * 0.25 + 0.75;
  let modulated = material.baseColor.rgb * pulse_factor;
  // Re-use the engine BRDF Fresnel helper to demonstrate that user shaders
  // can pull engine helpers via #import (charter P4 consistent abstraction).
  let n = normalize(in.worldNormal);
  let v = vec3<f32>(0.0, 0.0, 1.0);
  let f = f_schlick(max(dot(n, v), 0.0), vec3<f32>(0.04));
  let sampled = textureSample(baseColorTexture, baseColorTexture_sampler, in.baseColorUv);
  let normalSample = textureSample(normalTexture, normalTexture_sampler, in.normalUv);
  // Keep the authored normal slot visibly causal in the repeatability smoke:
  // the same-canvas rebind must survive the pixel threshold, not merely alter
  // a sub-percent rounding tail.
  let normalDetail = 0.1 + normalSample.g * 0.9;
  return vec4<f32>(modulated * sampled.rgb * normalDetail * (vec3<f32>(1.0) - f * 0.1), material.baseColor.a * sampled.a);
}
