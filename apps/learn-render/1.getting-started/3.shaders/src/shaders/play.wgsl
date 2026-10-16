// @forgeax/app-learn-render-1-getting-started-3-shaders -- play.wgsl
//
// LearnOpenGL section 1.3 -> forgeax mapping reference shader. LO 1.3
// teaches a uniform-driven fragment colour pulse via the GLSL
// `uniform float ourColor` slot (`shaders.cpp` + `shader.fs`); this
// WGSL file is the forgeax equivalent reference, kept alongside
// `index.ts` so AI users grep one directory and find both the engine
// driver code and the LO -> WGSL mapping side by side (charter F1
// limited context + P1 progressive disclosure).
//
// Pipeline shape (charter P5 producer / consumer split):
//   - The engine RenderSystem internally consumes
//     `packages/shader/src/unlit.wgsl` for any entity registered with
//     `MaterialAsset.shadingModel: 'unlit'`. The pipeline switch lives
//     inside the engine; AI users do not bind shaders manually.
//   - This file documents the LO 1.3 fragment uniform play idiom in
//     WGSL form so the AI user can read the shader stage logic next
//     to the unlit MaterialAsset registration in `index.ts`. It is
//     `?raw` imported from `index.ts` (as `playShaderSrc`) and held
//     by reference (`void playShaderSrc;`) -- the side-effect import
//     keeps the WGSL artefact in the rolldown graph so any future
//     `forgeaxShader` plugin wiring on this app's `vite.config.ts`
//     fires the transform on it without touching `index.ts`.
//   - The `pulse` uniform value is the same scalar `index.ts` feeds
//     into `Math.sin(time)` to drive the unlit MaterialAsset
//     `baseColor` update each frame; reading both files together
//     gives the AI user the LO 1.3 mapping in one glance.
//
// charter F2 (text > image): the WGSL source is the primary signal
// for the LO 1.3 -> forgeax shader mapping; pixel-parity baseline
// (round-1-shaders.png in forgeax-engine-assets/) is verification
// only, not a source-of-truth artefact.

struct ViewUniforms {
  worldViewProj : mat4x4<f32>,
};

struct MaterialUniforms {
  baseColor : vec4<f32>,
  // `pulse` is the time-driven sin scalar (LO 1.3 `uniform float
  // ourColor` equivalent). The CPU side updates it every frame; the
  // fragment stage modulates the unlit baseColor by it. Range nominal
  // [0, 1]; values outside the unit interval are clamped at the
  // rasteriser implicitly through the framebuffer format.
  pulse : f32,
};

@group(0) @binding(0) var<uniform> view : ViewUniforms;
@group(1) @binding(0) var<uniform> material : MaterialUniforms;

struct VsIn  {
  @location(0) pos    : vec3<f32>,
  @location(1) normal : vec3<f32>,
};

struct VsOut {
  @builtin(position) clip : vec4<f32>,
};

@vertex
fn vs_main(in : VsIn) -> VsOut {
  var out : VsOut;
  out.clip = view.worldViewProj * vec4<f32>(in.pos, 1.0);
  return out;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
  // LO 1.3 fragment uniform play: scale the unlit baseColor by the
  // time-driven pulse uniform every frame. AI users observe the
  // animated colour cycle in the demo by reading `index.ts`'s
  // per-frame `Math.sin(time)` write into the unlit MaterialAsset
  // baseColor; this WGSL fragment is the documentation companion.
  return vec4<f32>(material.baseColor.rgb * material.pulse, material.baseColor.a);
}
