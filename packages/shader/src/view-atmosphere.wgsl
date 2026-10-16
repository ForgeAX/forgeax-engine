#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View}
#import forgeax_cloud::layer::{cloud_direct_solar_factor}
#import forgeax_atmosphere::optics::{AtmosphereTransport, atmosphere_position, atmosphere_solar_transmittance}
#ifdef ATMOSPHERE_AVAILABLE
#import forgeax_cloud::layer::{cloudShadowSampler}
#import forgeax_view::common::{atmosphereTransmittance, atmosphereMultiple, atmosphereAerialLuminance, atmosphereAerialTransmittance, atmosphereDistantSkyLight}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_sample}
#endif

fn view_atmosphere(v: View, position: vec3<f32>) -> AtmosphereTransport {
#ifdef ATMOSPHERE_AVAILABLE
  return atmosphere_aerial_sample(v,position,atmosphereTransmittance,atmosphereMultiple,atmosphereAerialLuminance,atmosphereAerialTransmittance,cloudShadowSampler);
#else
  return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
#endif
}
fn view_solar_transmittance(v: View, position: vec3<f32>) -> vec3<f32> {
#ifdef ATMOSPHERE_AVAILABLE
  if v.atmosphereControl.w>0.5 {
    return atmosphere_solar_transmittance(v.atmosphere,atmosphere_position(v.atmosphere,position),normalize(-v.lightDir),atmosphereTransmittance,cloudShadowSampler);
  }
#endif
  return vec3<f32>(1.0);
}

fn view_apply_direct_solar(v:View, radiance:vec3<f32>, position:vec3<f32>)->vec3<f32>{
  return radiance*view_solar_transmittance(v,position)*cloud_direct_solar_factor(position,v.cloudShadowOrigin.xyz,v.cloudShadowRight.xyz,v.cloudShadowUp.xyz,v.cloudShadowProjection);
}

fn view_distant_sky_light(v:View)->vec3<f32>{
#ifdef ATMOSPHERE_AVAILABLE
  if v.atmosphereControl.w>0.5 { return textureLoad(atmosphereDistantSkyLight,vec2<i32>(0),0).rgb*v.lightColor; }
#endif
  return vec3<f32>(0.0);
}
