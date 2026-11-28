#define_import_path forgeax_environment::cubemap
#import forgeax_view::common::{View, clampLinearHdr, view_atmosphere_ue5}
#import forgeax_atmosphere::optics::{atmosphere_sun_luminance, atmosphere_integrate}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_sky_uv, atmosphere_ue5_sky_uv}

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
  let sun = normalize(-view.lightDir);
  let direction = normalize(input.direction);
  if view_atmosphere_ue5(view) {
    let uv = atmosphere_ue5_sky_uv(view.atmosphere, origin, sun, direction, vec2f(textureDimensions(sky)));
    return vec4f(clampLinearHdr(textureSampleLevel(sky, filtering, uv, 0.0).rgb), 1.0);
  }
  let uv = atmosphere_sky_uv(view.atmosphere, origin, sun, direction);
  return vec4<f32>(clampLinearHdr(textureSampleLevel(sky,filtering,uv,0.0).rgb*atmosphere_sun_luminance(view.lightColor)),1.0);
}

@group(0) @binding(4) var transmittance: texture_2d<f32>;
@group(0) @binding(5) var multiple: texture_2d<f32>;

@fragment
fn atmosphere_cubemap_ue5_fs(input: AtmosphereCubeVsOut) -> @location(0) vec4f {
  let origin = atmosphere_observer(view.atmosphere, view.cameraPos);
  var medium = view.atmosphere;
  medium.geometry.y = 1.0;
  let ray = atmosphere_integrate(medium, origin, normalize(input.direction), 1e7,
    normalize(-view.lightDir), view.lightColor, transmittance, multiple, filtering, 32u, 1.0);
  return vec4f(clampLinearHdr(ray.luminance), 1.0);
}
