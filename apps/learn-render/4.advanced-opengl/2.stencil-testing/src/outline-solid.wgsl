#define_import_path learn_render::outline_solid

#import forgeax_view::common::{View, Mesh, view, meshes}

// outline-solid.wgsl - LearnOpenGL section 4.2 stencil outline demo.
//
// Minimal unlit material shader that outputs a constant solid color from
// a uniform parameter. No texture sampling, no lighting -- the fragment
// stage directly returns `material.baseColor`.
//
// Used by the outline pass in 4.2 stencil-testing: the scale-1.1 cube
// entities apply this shader, and the stencil test (compare='not-equal',
// ref=1) isolates the single-color outline band.
//
// LO original: 2.stencil_single_color.fs outputs constant (0.04, 0.28, 0.26, 1.0).
//
// Bindings: @group(1) binding(0) material uniform carries baseColor.
// Bindings 1-6 (textures/samplers) are declared for engine pipeline
// layout compatibility but unused in this shader body.

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
};

@vertex
fn vs_main(in : VsIn, @builtin(instance_index) idx : u32) -> VsOut {
  let world = meshes[idx].worldFromLocal * vec4<f32>(in.pos, 1.0);
  var out : VsOut;
  out.clip = view.worldViewProj * world;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4<f32> {
  return material.baseColor;
}
