#define_import_path learn_render::depth_viz

#import forgeax_view::common::{View, Mesh, view, meshes}

// depth-viz.wgsl - LearnOpenGL section 4.1 depth visualization demo.
//
// Custom material shader that visualizes the depth buffer: the fragment
// stage reads @builtin(position).z (Reverse-Z depth), reconstructs
// view-space distance, and outputs a grayscale value
// where near=dark, far=light.
//
// The LO 4.1 distance visualization uses the Engine's Reverse-Z convention:
//   z_linear = near / (depth + (1 - depth) * near / far)
//   output = z_linear / far  (maps to approx [0, 1] for grayscale)
//
// near=0.1, far=100.0 (hardcoded to match LO 4.1 projection).
//
// Bindings: @group(1) binding(0) material uniform (unused in this shader
// but structurally occupied by the engine material BindGroupLayout 0-6
// layout); the fragment shader only reads @builtin(position).z and
// outputs vec4<f32> gray.

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
  let depth = in.clip.z;
  let near = 0.1;
  let far = 100.0;
  let linear = near / (depth + (1.0 - depth) * (near / far));
  let gray = linear / far;
  return vec4<f32>(gray, gray, gray, 1.0);
}
