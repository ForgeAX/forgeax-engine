#define_import_path layered_fixture::layered_target

#import forgeax_view::common::{View, Mesh, view, meshes}

// Samples one depth slice of a 3D RenderTarget or one layer of a 2D-array
// RenderTarget. The generated material-parameters module supplies the
// `volumeTexture` texture_3d, `layerTexture` texture_2d_array, their samplers,
// and the `material` uniform.

struct VsIn {
  @location(0) pos : vec3<f32>,
  @location(1) normal : vec3<f32>,
  @location(2) uv : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  var out : VsOut;
  out.clip = view.worldViewProj * meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  out.uv = in.uv;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  let volume = textureSample(
    volumeTexture,
    volumeTexture_sampler,
    vec3<f32>(in.uv, material.slice),
  );
  let layered = textureSample(
    layerTexture,
    layerTexture_sampler,
    in.uv,
    i32(material.layer + 0.5),
  );
  return select(volume, layered, material.mode > 0.5);
}
