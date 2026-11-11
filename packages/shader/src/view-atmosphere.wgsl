#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View}
#import forgeax_cloud::layer::{cloud_direct_solar_factor}
#import forgeax_atmosphere::optics::{AtmosphereTransport, atmosphere_position, atmosphere_solar_transmittance, atmosphere_sun_luminance}
#import forgeax_cloud::layer::{cloudShadowSampler}
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster_texture_data::{cluster_data_texture}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_sample_packed}
#import forgeax_atmosphere::table_access::{atmosphere_table_sample}
#endif
#endif
#ifdef ATMOSPHERE_AVAILABLE
#import forgeax_view::common::{atmosphereTransmittance, atmosphereMultiple, atmosphereAerialLuminance, atmosphereAerialTransmittance, atmosphereDistantSkyLight}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_sample}
#endif

fn view_atmosphere(v: View, position: vec3<f32>) -> AtmosphereTransport {
#ifdef ATMOSPHERE_AVAILABLE
  return atmosphere_aerial_sample(v,position,atmosphereTransmittance,atmosphereMultiple,atmosphereAerialLuminance,atmosphereAerialTransmittance,cloudShadowSampler);
#else
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
  return atmosphere_aerial_sample_packed(v,position,cluster_data_texture,cloudShadowSampler);
#endif
#endif
  return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
#endif
}
fn view_solar_transmittance(v: View, position: vec3<f32>) -> vec3<f32> {
#ifdef ATMOSPHERE_AVAILABLE
  if v.atmosphereControl.w>0.5 {
    return atmosphere_solar_transmittance(v.atmosphere,atmosphere_position(v.atmosphere,position),normalize(-v.lightDir),atmosphereTransmittance,cloudShadowSampler);
  }
#endif
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
  if v.atmosphereControl.w>0.5 {
    return atmosphere_solar_transmittance(v.atmosphere,atmosphere_position(v.atmosphere,position),normalize(-v.lightDir),cluster_data_texture,cloudShadowSampler);
  }
#endif
#endif
  return vec3<f32>(1.0);
}

fn view_apply_direct_solar(v:View, radiance:vec3<f32>, position:vec3<f32>)->vec3<f32>{
#ifdef LEAN_LIGHTING
  // LEAN_LIGHTING frames have no atmosphere source and no live cloud shadow
  // (absent, low sun or zero range), where both factors are exactly one.
  return radiance;
#else
  return radiance*view_solar_transmittance(v,position)*cloud_direct_solar_factor(position,v.cloudShadowOrigin.xyz,v.cloudShadowRight.xyz,v.cloudShadowUp.xyz,v.cloudShadowProjection);
#endif
}

fn view_distant_sky_light(v:View)->vec3<f32>{
#ifdef ATMOSPHERE_AVAILABLE
  if v.atmosphereControl.w>0.5 { return textureLoad(atmosphereDistantSkyLight,vec2<i32>(0),0).rgb*atmosphere_sun_luminance(v.lightColor); }
#endif
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
  if v.atmosphereControl.w>0.5 {return atmosphere_table_sample(cluster_data_texture,cloudShadowSampler,vec2<f32>(0.5),2u).rgb*atmosphere_sun_luminance(v.lightColor);}
#endif
#endif
  return vec3<f32>(0.0);
}
