#define_import_path forgeax_environment::background
#import forgeax_view::common::{FullscreenOutput, View, fullscreen_triangle, clampLinearHdr}
#import forgeax_atmosphere::optics::{atmosphere_solar_transmittance, atmosphere_integrate}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_view_ray, atmosphere_sky_uv}

@group(0) @binding(0) var sky: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var<uniform> view: View;
@group(0) @binding(3) var transmittance: texture_2d<f32>;
@group(0) @binding(4) var multiple: texture_2d<f32>;

@vertex
fn atmosphere_background_vs(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
  var output=fullscreen_triangle(vertexIndex); output.position.z=0.0; return output;
}
@fragment
fn atmosphere_background_fs(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let ray=atmosphere_view_ray(view,input.uv);
  let origin=atmosphere_observer(view.atmosphere,ray.origin);
  let sun=normalize(-view.lightDir);
  let uv=atmosphere_sky_uv(view.atmosphere,origin,sun,ray.direction);
  var radiance=textureSampleLevel(sky,filtering,uv,0.0).rgb*view.lightColor;
  // Orthographic rays have distinct origins; orbit views avoid a ground-view LUT.
  if view.temporalProjection.z>0.5 || length(origin)>=view.atmosphere.originRadius.w+view.atmosphere.geometry.x || view.atmosphereControl.x>0.0 {
    radiance=atmosphere_integrate(view.atmosphere,origin,ray.direction,1e7,sun,view.lightColor,transmittance,multiple,filtering,u32(max(64.0,view.atmosphereControl.x)),1.0).luminance;
  }
  let radius=view.atmosphereControl.y;
  if radius>0.0 {
    let angle=acos(clamp(dot(ray.direction,sun),-1.0,1.0));
    let edge=1.0-smoothstep(radius-max(fwidth(angle),1e-6),radius+max(fwidth(angle),1e-6),angle);
    let solidAngle=4.0*3.14159265359*pow(sin(radius*0.5),2.0);
    radiance+=view.lightColor*atmosphere_solar_transmittance(view.atmosphere,origin,ray.direction,transmittance,filtering)*edge/max(solidAngle,1e-12);
  }
  return vec4<f32>(clampLinearHdr(radiance),1.0);
}
