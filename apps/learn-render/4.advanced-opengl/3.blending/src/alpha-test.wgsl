#define_import_path learn_render::alpha_test

#pragma variant_axis WEBGL2_COMPAT
#pragma variant_axis STORAGE_BUFFER_AVAILABLE

#import forgeax_view::common::{View, Mesh, view, meshes}

// alpha-test.wgsl - LearnOpenGL section 4.3 blending demo.
//
// Minimal alpha-test material shader: the same unlit transform +
// baseColor texture path, with a fragment-stage discard when the
// sampled alpha falls below 0.1 (AC-12: discards fully transparent
// fragments, mimicking the LO 4.3 grass/vegetation pattern).
//
// Bindings mirror unlit.wgsl byte-for-byte (D-4 shared 0-6 layout)
// so the PBR pipeline factory can build this pipeline from the same
// BindGroupLayout templates as the engine-shipped unlit path.

struct VsIn {
  @location(0) pos     : vec3<f32>,
  @location(1) normal  : vec3<f32>,
  @location(2) uv      : vec2<f32>,
  @location(3) tangent : vec4<f32>,
};
struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

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
#ifdef WEBGL2_COMPAT
  // wgpu GLES/WebGL2 needs an explicit LOD for this filtered sample. The
  // shared shader manifest compiles both branches; the runtime selects this
  // one from the backend capability while WebGPU keeps implicit derivatives.
  let texSample = textureSampleLevel(baseColorTexture, baseColorTexture_sampler, in.uv, 0.0);
#else
  let texSample = textureSample(baseColorTexture, baseColorTexture_sampler, in.uv);
#endif
  let alpha = material.baseColor.a * texSample.a;
  if (alpha < 0.1) {
    discard;
  }
  return vec4<f32>(material.baseColor.rgb * texSample.rgb, alpha);
}
