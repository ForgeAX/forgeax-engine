#define_import_path forgeax_view::skybox

// @forgeax/engine-shader - skybox.wgsl
// (feat-20260531-skybox-env-background / M3 / w13).
//
// Skybox fullscreen pass: vertex stage imports the SSOT fullscreen_triangle()
// from forgeax_view::common (same single-large-triangle pattern as tonemap +
// fxaa); fragment stage reconstructs world-space view direction from the
// screen-space UV + inverseViewProj (View UBO, w3), samples the cubemap
// texture, and writes HDR colour to the hdrColor rgba16float render target
// (plan-strategy D-2/D-7).
//
// Y-negation: the equirect-to-cube render passes used during cubemap upload
// follow the WebGL/OpenGL convention (Y-up in world space maps to V=0 at
// the bottom of the cubemap face). WebGPU's texture coordinate origin is
// top-left (V=0 at the top), so sampled directions must negate Y to match
// the same convention used by ibl-sampling.wgsl (plan-strategy R-4, D-7).
//
// Bindings (group 0):
//   @binding(0) cubemap       : texture_cube<f32>    // skybox environment map
//   @binding(1) cubemapSampler : sampler             // linear filter + clamp-to-edge
//   @binding(2) view          : View (UBO)           // carries inverseViewProj (w3)
//   @binding(3) rotation      : SkyboxRotation (UBO)

#import forgeax_view::common::FullscreenOutput
#import forgeax_view::common::View
#import forgeax_view::common::fullscreen_triangle
#import forgeax_pbr::ibl_shared::{inverseRotateEnvironment}

@group(0) @binding(0) var cubemap       : texture_cube<f32>;
@group(0) @binding(1) var cubemapSampler : sampler;
@group(0) @binding(2) var<uniform> view : View;

struct SkyboxRotation {
  rotation: vec4<f32>,
};

@group(0) @binding(3) var<uniform> environment : SkyboxRotation;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index : u32) -> FullscreenOutput {
  return fullscreen_triangle(vertex_index);
}

// Reconstruct world-space view direction from screen UV + inverseViewProj.
// clipPos.xy derived from screen-space UV, clipPos.w = 1, apply
// inverseViewProj to get world-space direction. Negate Y to match the
// IBL cubemap Y convention (ibl-sampling.wgsl:30,47).
//
// bug-20260608-skybox-cubemaps-upside-down: ndc.y must UNDO the V-flip
// `fullscreen_triangle()` bakes in (`v = 1 - (y + 1) * 0.5`, common.wgsl:204);
// the prior `uv.y * 2 - 1` produced the OPPOSITE sign of the actual NDC.y at
// each fragment, so `inverseViewProj * ndc` returned the world ray for the
// MIRRORED screen position, and the final `-dir.y` (kept for the IBL bake
// convention) ended up rendering the skybox upside-down. Reverse the V-flip
// here with `1.0 - uv.y * 2.0`; see skybox-direction.test.ts.
//
// The unprojected NDC sample is a world POINT, so the ray is that point minus
// the camera position. Under Reverse-Z, depth 0.5 lies just past the near
// plane; normalizing the point alone collapsed every fragment of a camera away
// from the origin onto one direction (a flat skybox).
fn skyboxDirection(uv : vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let worldPoint = view.inverseViewProj * ndc;
  let dir = normalize(worldPoint.xyz / worldPoint.w - view.cameraPos);
  let rotated = inverseRotateEnvironment(dir, environment.rotation);
  return vec3<f32>(rotated.x, -rotated.y, rotated.z);
}

@fragment
fn skybox_fs(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let dir = skyboxDirection(in.uv);
  let color = textureSample(cubemap, cubemapSampler, dir).rgb;
  return vec4<f32>(color, 1.0);
}
