#define_import_path forgeax_pbr::ibl_equirect_to_cube

// @forgeax/engine-shader - ibl-equirect-to-cube.wgsl
// (feat-20260520-skylight-ibl-cubemap M3 / t43).
//
// Equirectangular HDRI -> cubemap projection pass.
// Per LearnOpenGL §6.2.1: render a unit cube from each of the 6 face views,
// fragment shader maps the world-space direction to equirect UV and samples
// the input HDRI texture.
//
// @group(0) = per-face viewProj uniform.
// @group(1) = equirect texture_2d + sampler. NOTE: this is the ONLY ibl-*
//             module that binds a texture_2d at @group(1); the irradiance /
//             prefilter modules bind texture_cube at the same slot, which
//             is why the round-1 single-file design collided.
//
// Entries:
//   - cubemap_vs        (shared VS used by irradiance + prefilter as well;
//                        each module redeclares its own copy because WGSL
//                        modules cannot cross-import entry points)
//   - equirectToCube_fs

#import forgeax_pbr::ibl_shared::{sampleSphericalMap}

struct CubemapVsIn {
  @location(0) pos: vec3<f32>,
};
struct CubemapVsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
};

struct CubemapFaceUniforms {
  viewProj: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> faceUniforms: CubemapFaceUniforms;

@group(1) @binding(0) var equirectTexture: texture_2d<f32>;
@group(1) @binding(1) var equirectSamplerS: sampler;

@vertex
fn cubemap_vs(in0: CubemapVsIn) -> CubemapVsOut {
  var out: CubemapVsOut;
  out.clip = faceUniforms.viewProj * vec4<f32>(in0.pos, 1.0);
  out.worldPos = in0.pos;
  return out;
}

@fragment
fn equirectToCube_fs(in0: CubemapVsOut) -> @location(0) vec4<f32> {
  let dir = normalize(in0.worldPos);
  let uv = sampleSphericalMap(dir);
  let color = textureSample(equirectTexture, equirectSamplerS, uv);
  return vec4<f32>(color.rgb, 1.0);
}
