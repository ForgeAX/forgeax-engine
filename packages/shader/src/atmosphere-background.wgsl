#define_import_path forgeax_environment::background
#import forgeax_view::common::{FullscreenOutput, View, fullscreen_triangle, clampLinearHdr, view_atmosphere_ue5}
#import forgeax_atmosphere::optics::{atmosphere_sun_luminance, atmosphere_solar_transmittance, atmosphere_integrate}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_view_ray, atmosphere_sky_uv, atmosphere_ue5_sky_uv}

@group(0) @binding(0) var sky: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var<uniform> view: View;
@group(0) @binding(3) var transmittance: texture_2d<f32>;
@group(0) @binding(4) var multiple: texture_2d<f32>;

// The visible disc spreads the sun illuminance over its solid angle, which at
// the default 0.004675 rad radius is about 1.45e4 x lightColor. Its radiance is
// bounded at SUN_DISC_PEAK x lightColor: still far above the sky, so the disc
// reads as the brightest thing on screen, but finite enough that bloom and
// temporal filters do not smear it over the frame. Larger discs (1/solidAngle
// below the bound) keep the energy-conserving value.
const SUN_DISC_PEAK : f32 = 100.0;

@vertex
fn atmosphere_background_vs(@builtin(vertex_index) vertexIndex: u32) -> FullscreenOutput {
  var output=fullscreen_triangle(vertexIndex); output.position.z=0.0; return output;
}
@fragment
fn atmosphere_background_fs(input: FullscreenOutput) -> @location(0) vec4<f32> {
  let ray=atmosphere_view_ray(view,input.uv);
  let origin=atmosphere_observer(view.atmosphere,ray.origin);
  let sun=normalize(-view.lightDir);
  let ue5 = view_atmosphere_ue5(view);
  var uv = atmosphere_sky_uv(view.atmosphere, origin, sun, ray.direction);
  if ue5 {
    uv = atmosphere_ue5_sky_uv(view.atmosphere, origin, sun, ray.direction, vec2f(textureDimensions(sky)));
  }
  // Display air radiance only, as in Unreal's Ground=false sky integration.
  // Ground albedo feeds multiple scattering; visible terrain is scene geometry.
  let skyLight=atmosphere_sun_luminance(view.lightColor);
  var radiance = textureSampleLevel(sky, filtering, uv, 0.0).rgb * select(skyLight, vec3f(1.0), ue5);
  // Orthographic rays have distinct origins; orbit views avoid a ground-view LUT.
  if view.temporalProjection.z>0.5 || length(origin)>=view.atmosphere.originRadius.w+view.atmosphere.geometry.x || view.atmosphereControl.x>0.0 {
    var medium = view.atmosphere;
    if ue5 { medium.geometry.y = 1.0; }
    radiance=atmosphere_integrate(medium,origin,ray.direction,1e7,sun,select(skyLight, view.lightColor, ue5),transmittance,multiple,filtering,u32(max(64.0,view.atmosphereControl.x)),1.0).luminance;
  }
  let radius=view.atmosphereControl.y;
  if radius>0.0 {
    let angle=acos(clamp(dot(ray.direction,sun),-1.0,1.0));
    let edge=1.0-smoothstep(radius-max(fwidth(angle),1e-6),radius+max(fwidth(angle),1e-6),angle);
    let solidAngle=4.0*3.14159265359*pow(sin(radius*0.5),2.0);
    let peak=min(1.0/max(solidAngle,1e-12),SUN_DISC_PEAK);
    radiance+=view.lightColor*atmosphere_solar_transmittance(view.atmosphere,origin,ray.direction,transmittance,filtering)*edge*peak;
  }
  return vec4<f32>(clampLinearHdr(radiance),1.0);
}
