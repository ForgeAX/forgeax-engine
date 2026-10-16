#define_import_path learn_render::6_4_cube_reflection

#import forgeax_view::common::{transformNormal, View, Mesh, view, meshes}

// The material deliberately samples the CubeCamera product directly.  The
// generated material-parameters module supplies both the
// `cubeTexture` texture_cube binding and the `baseColor` uniform; this shader
// owns no parallel group-1 binding declarations.

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldNormal : vec3<f32>,
  @location(1) worldPos : vec3<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  out.worldNormal = normalize(transformNormal(meshes[idx].worldFromLocal, in.normal));
  out.worldPos = world.xyz;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let normal = normalize(in.worldNormal);
  let viewDirection = normalize(view.cameraPos - in.worldPos);
  let reflectedDirection = reflect(-viewDirection, normal);
  let sampled = textureSample(cubeTexture, cubeTexture_sampler, reflectedDirection);
  return vec4<f32>(sampled.rgb * material.baseColor.rgb, material.baseColor.a);
}
