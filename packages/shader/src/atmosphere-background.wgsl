#define_import_path forgeax_environment::background
#import forgeax_view::common::{AtmosphereMedium, FullscreenOutput, View, fullscreen_triangle, clampLinearHdr}
#import forgeax_atmosphere::optics::{ATMOSPHERE_PI, atmosphere_sun_luminance, atmosphere_solar_transmittance, atmosphere_integrate, atmosphere_sphere, atmosphere_transmittance_uv, atmosphere_sub_uv}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_view_ray, atmosphere_sky_uv}

@group(0) @binding(0) var sky: texture_2d<f32>;
@group(0) @binding(1) var filtering: sampler;
@group(0) @binding(2) var<uniform> view: View;
@group(0) @binding(3) var transmittance: texture_2d<f32>;
@group(0) @binding(4) var multiple: texture_2d<f32>;

// Transmittance from p to the top of the atmosphere along an upward ray.
fn atmosphere_lut_transmittance(m:AtmosphereMedium, p:vec3<f32>, direction:vec3<f32>)->vec3<f32>{
  let uv=atmosphere_transmittance_uv(m,p,direction);
  return textureSampleLevel(transmittance,filtering,atmosphere_sub_uv(uv,textureDimensions(transmittance)),0.0).rgb;
}
// A ray that ends on the virtual ground sees it as a Lambertian surface of
// albedo `ground.rgb` lit by the attenuated sun, the same ground term the
// multiple-scattering table integrates. Sky irradiance on the ground is not included.
fn atmosphere_ground_radiance(m:AtmosphereMedium, origin:vec3<f32>, direction:vec3<f32>, sun:vec3<f32>, light:vec3<f32>)->vec3<f32>{
  let hit=atmosphere_sphere(origin,direction,m.originRadius.w);
  if hit.x<0.0 {return vec3<f32>(0.0);}
  let up=normalize(origin+direction*hit.x);
  let surface=up*(m.originRadius.w+0.001);
  // Ratio of two upward transmittances: observer-to-ground segment, RGB.
  let path=min(atmosphere_lut_transmittance(m,surface,-direction)/max(atmosphere_lut_transmittance(m,origin,-direction),vec3<f32>(1e-6)),vec3<f32>(1.0));
  let solar=atmosphere_solar_transmittance(m,surface,sun,transmittance,filtering);
  return path*light*solar*m.ground.rgb*max(dot(up,sun),0.0)/ATMOSPHERE_PI;
}

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
  let uv=atmosphere_sky_uv(view.atmosphere,origin,sun,ray.direction);
  // Sky and virtual ground scatter the sun's luminance; the disc keeps its colour.
  let skyLight=atmosphere_sun_luminance(view.lightColor);
  var radiance=textureSampleLevel(sky,filtering,uv,0.0).rgb*skyLight;
  // Orthographic rays have distinct origins; orbit views avoid a ground-view LUT.
  if view.temporalProjection.z>0.5 || length(origin)>=view.atmosphere.originRadius.w+view.atmosphere.geometry.x || view.atmosphereControl.x>0.0 {
    radiance=atmosphere_integrate(view.atmosphere,origin,ray.direction,1e7,sun,skyLight,transmittance,multiple,filtering,u32(max(64.0,view.atmosphereControl.x)),1.0).luminance;
  }
  radiance+=atmosphere_ground_radiance(view.atmosphere,origin,ray.direction,sun,skyLight);
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
