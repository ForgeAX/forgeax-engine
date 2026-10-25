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
#import forgeax_view::tone_mapping::{mapTone}
#import forgeax_view::output_encoding::{encodeOutput}

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

// GradientSky: a procedural background sharing the View binding above. The
// scene entry writes HDR radiance into the skybox pass (tone-mapped later);
// the display entry runs after output encoding and fills only the transparent
// coverage the scene left (blend one-minus-dst-alpha, one), as a CSS page
// colour behind the canvas would, so the authored colour is the shown colour.
// 128-byte layout mirrored by GRADIENT_SKY_PARAMS_BYTES (gradient-sky-pass.ts).
struct GradientSkyParams {
  zenith   : vec4<f32>, // rgb, w = exponent
  horizon  : vec4<f32>, // rgb, w = fogBlend (elevation sine; 0 never fogs the sky)
  ground   : vec4<f32>, // rgb, w = fog opacity at the horizon (0 without an active Fog)
  sun      : vec4<f32>, // xyz unit direction toward the sun, w = angular radius (0 = no disc)
  disc     : vec4<f32>, // rgb disc colour in the entry's domain (drawn over fog)
  glow     : vec4<f32>, // rgb glow chroma, w = glow strength
  fogColor : vec4<f32>, // rgb scene-linear Fog colour
  output   : vec4<f32>, // exposure, whitePoint, tone mode, output gamut
};

@group(0) @binding(4) var<uniform> gradientSky : GradientSkyParams;

fn gradientSkyRay(uv : vec2<f32>) -> vec3<f32> {
  let ndc = vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  let worldPoint = view.inverseViewProj * ndc;
  return normalize(worldPoint.xyz / worldPoint.w - view.cameraPos);
}

// Three.js gradient dome: mix(horizon, zenith, pow(max(h, 0), exponent)); the
// same law mirrored below the horizon toward the ground colour.
fn gradientSkyBase(h : f32) -> vec3<f32> {
  let t = pow(min(abs(h), 1.0), gradientSky.zenith.w);
  let toward = select(gradientSky.ground.rgb, gradientSky.zenith.rgb, h >= 0.0);
  return mix(gradientSky.horizon.rgb, toward, t);
}

fn gradientSkyColor(dir : vec3<f32>, fog : vec3<f32>) -> vec3<f32> {
  var color = gradientSkyBase(dir.y);
  let radius = gradientSky.sun.w;
  var angle = 4.0;
  if (radius > 0.0) {
    angle = acos(clamp(dot(dir, gradientSky.sun.xyz), -1.0, 1.0));
    color = mix(color, gradientSky.glow.rgb, min(gradientSky.glow.w * exp(-angle / (radius * 8.0)), 1.0));
  }
  // Fog covers the sky and glow at and below the horizon and fades out by fogBlend.
  let blend = gradientSky.horizon.w;
  if (blend > 0.0) {
    color = mix(color, fog, gradientSky.ground.w * (1.0 - smoothstep(0.0, blend, dir.y)));
  }
  // The disc shines through the haze but sets behind the horizon.
  if (radius > 0.0) {
    let disc = (1.0 - smoothstep(radius * 0.85, radius, angle)) * smoothstep(-0.002, 0.002, dir.y);
    color = mix(color, gradientSky.disc.rgb, disc);
  }
  return color;
}

@fragment
fn gradient_sky_fs(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let dir = gradientSkyRay(in.uv);
  return vec4<f32>(gradientSkyColor(dir, gradientSky.fogColor.rgb), 1.0);
}

@fragment
fn gradient_sky_display_fs(in : FullscreenOutput) -> @location(0) vec4<f32> {
  let dir = gradientSkyRay(in.uv);
  let out = gradientSky.output;
  // Distant geometry shows the Fog colour through the camera's tone curve; the
  // fogged horizon uses the same displayed colour so the two meet seamlessly.
  let fog = mapTone(gradientSky.fogColor.rgb, out.x, out.y, u32(out.z), u32(out.w));
  let color = clamp(gradientSkyColor(dir, fog), vec3<f32>(0.0), vec3<f32>(1.0));
  return encodeOutput(color, 1.0, u32(out.w));
}
