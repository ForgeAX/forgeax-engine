#define_import_path bevy::shader_material_2d

#import forgeax_view::common::{view, meshes}

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
}

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
}

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let sampled = textureSample(baseColorTexture, baseColorTexture_sampler, in.uv);
  let alpha = sampled.a * material.baseColor.a;
  if (alpha < 0.5) {
    discard;
  }
  return vec4<f32>(sampled.rgb * material.baseColor.rgb, 1.0);
}
