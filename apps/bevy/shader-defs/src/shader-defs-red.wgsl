#define_import_path bevy::shader_defs_red
#import forgeax_view::common::{transformNormal, view, meshes}
#import forgeax_pbr::brdf::{f_schlick}

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
}

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
  @location(1) uv : vec2<f32>,
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldNormal = normalize(transformNormal(meshes[idx].worldFromLocal, in.normal));
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let pulse_factor = sin(material.time * material.speed) * 0.0 + 1.0;
  let n = normalize(in.worldNormal);
  let v = vec3<f32>(0.0, 0.0, 1.0);
  let f = f_schlick(max(dot(n, v), 0.0), vec3<f32>(0.04));
  let sampled = textureSample(baseColorTexture, baseColorTexture_sampler, in.uv);
  let source_color = vec4<f32>(material.baseColor.rgb * pulse_factor * sampled.rgb * (vec3<f32>(1.0) - f * 0.1), material.baseColor.a * sampled.a);
  return mix(source_color, vec4<f32>(1.0, 0.05, 0.05, 1.0), 1.0);
}
