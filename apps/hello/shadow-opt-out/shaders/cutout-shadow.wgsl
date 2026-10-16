#define_import_path shadow_opt_out::cutout_shadow

// apps/hello/shadow-opt-out/shaders/cutout-shadow.wgsl
// feat-20260609-pipeline-driven-pass-selector-shadowcaster-via-mat T-018
// AC-17 cutout shadow shader: alpha-test discard in fragment stage so the
// shadow map produces a cutout pattern instead of a solid silhouette.
// AI users register this via ShaderRegistry.registerMaterialShader and
// reference it in a MaterialPassDescriptor with name='ShadowCaster' and
// tags={LightMode:'ShadowCaster'}.

#import forgeax_view::common::{View, Mesh, InstanceData, ShadowCasterCascade, view, shadowCasterCascade, meshes, instances}

// The shadow depth pass binds a position-only vertex buffer (12-float
// stride, @location(0) only — see pipeline-builder.ts shadow-caster branch),
// so VsInput must declare only @location(0). A normal input would force a
// vertex-layout mismatch against the depth pass's buffer layout.
struct VsInput {
  @location(0) position : vec3<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) worldPos   : vec3<f32>,
};

fn _cascadeLightViewProj(layer : u32) -> mat4x4<f32> {
  switch (layer) {
    case 0u: { return view.lightViewProj_A; }
    case 1u: { return view.lightViewProj_B; }
    case 2u: { return view.lightViewProj_C; }
    default: { return view.lightViewProj_D; }
  }
}

@vertex
fn vs_main(in : VsInput, @builtin(instance_index) idx : u32) -> VsOut {
  let worldPos = meshes[0].worldFromLocal * instances[idx].localFromInstance * vec4<f32>(in.position, 1.0);
  var out : VsOut;
  // Per-cascade lightViewProj selection mirrors the built-in
  // shadow_caster.wgsl so the cutout shadow is correct for cascadeCount > 1
  // (the shadow pass writes the active cascade index into binding 7 before
  // each cascade's encoder submit).
  out.clip = _cascadeLightViewProj(shadowCasterCascade.index) * worldPos;
  out.worldPos = worldPos.xyz;
  return out;
}

// Cutout pattern: discard fragments whose world-space X falls inside a
// vertical grid of holes (every 0.5 units along X, hole width 0.15).
// World-space Z modulo 0.5 also creates holes along the Z axis.
// Result: a checkerboard-cutout shadow on the cube surface.
@fragment
fn fs_main(in : VsOut) -> @builtin(frag_depth) f32 {
  let hole_x = abs((in.worldPos.x + 0.25) % 1.0 - 0.5) < 0.15;
  let hole_z = abs((in.worldPos.z + 0.25) % 1.0 - 0.5) < 0.15;
  if (hole_x && hole_z) {
    discard;
  }
  return in.clip.z / in.clip.w;
}