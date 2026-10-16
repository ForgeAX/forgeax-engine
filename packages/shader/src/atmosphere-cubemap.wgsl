#define_import_path forgeax_environment::cubemap
#import forgeax_view::common::{View, clampLinearHdr}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_sky_uv}

struct AtmosphereCubeVsIn {
  // xy is clip-space; z is a one-based cube-face tag supplied by the
  // producer's six fullscreen triangles.
  @location(0) faceVertex: vec3<f32>,
};

struct AtmosphereCubeVsOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) direction: vec3<f32>,
};

@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var sky: texture_2d<f32>;
@group(0) @binding(3) var filtering: sampler;

@vertex
fn atmosphere_cubemap_vs(input: AtmosphereCubeVsIn) -> AtmosphereCubeVsOut {
  var output: AtmosphereCubeVsOut;
  let face = u32(input.faceVertex.z) - 1u;
  let x = input.faceVertex.x;
  let y = input.faceVertex.y;
  output.clip = vec4<f32>(x, y, 0.5, 1.0);
  switch face {
    case 0u: { output.direction = vec3<f32>(1.0, -y, -x); }
    case 1u: { output.direction = vec3<f32>(-1.0, -y, x); }
    // Cube consumers negate Y for the shared OpenGL-authored convention.
    // Clip-space Y is also inverted by the attachment viewport. The four
    // side faces already compose both transforms through `-y`; the Y-axis
    // faces must encode their world sign and Z orientation explicitly.
    case 2u: { output.direction = vec3<f32>(x, -1.0, -y); }
    case 3u: { output.direction = vec3<f32>(x, 1.0, y); }
    case 4u: { output.direction = vec3<f32>(x, -y, 1.0); }
    default: { output.direction = vec3<f32>(-x, -y, -1.0); }
  }
  return output;
}

@fragment
fn atmosphere_cubemap_fs(input: AtmosphereCubeVsOut) -> @location(0) vec4<f32> {
  let origin=atmosphere_observer(view.atmosphere,view.cameraPos);
  let uv=atmosphere_sky_uv(view.atmosphere,origin,normalize(-view.lightDir),normalize(input.direction));
  return vec4<f32>(clampLinearHdr(textureSampleLevel(sky,filtering,uv,0.0).rgb*view.lightColor),1.0);
}
