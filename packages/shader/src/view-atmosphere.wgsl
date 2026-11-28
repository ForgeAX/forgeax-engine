#define_import_path forgeax_view::atmosphere
#import forgeax_view::common::{View, view_atmosphere_aerial_enabled, view_atmosphere_light_enabled, view_atmosphere_ue5}
#import forgeax_cloud::layer::{cloud_direct_solar_factor}
#import forgeax_atmosphere::optics::{AtmosphereTransport, atmosphere_position, atmosphere_solar_transmittance, atmosphere_sun_luminance, atmosphere_ground_solar_transmittance}
#import forgeax_cloud::layer::{viewLinearSampler}
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
#import forgeax_standard::cluster_texture_data::{cluster_data_texture}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_sample_packed}
#import forgeax_atmosphere::table_access::{atmosphere_table_sample}
#endif
#endif
#ifdef ATMOSPHERE_AVAILABLE
#import forgeax_view::common::{atmosphereTransmittance, atmosphereMultiple, atmosphereAerialLuminance, atmosphereAerialTransmittance, atmosphereDistantSkyLight, atmosphereDistantSkyBuffer}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_sample}
#endif

fn view_atmosphere(v: View, position: vec3<f32>) -> AtmosphereTransport {
#ifdef ATMOSPHERE_AVAILABLE
  return atmosphere_aerial_sample(v,position,atmosphereTransmittance,atmosphereMultiple,atmosphereAerialLuminance,atmosphereAerialTransmittance,viewLinearSampler);
#else
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
  return atmosphere_aerial_sample_packed(v,position,cluster_data_texture,viewLinearSampler);
#endif
#endif
  return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
#endif
}
fn view_solar_transmittance(v: View, position: vec3<f32>) -> vec3<f32> {
#ifdef ATMOSPHERE_AVAILABLE
  if view_atmosphere_aerial_enabled(v) {
    return atmosphere_solar_transmittance(v.atmosphere,atmosphere_position(v.atmosphere,position),normalize(-v.lightDir),atmosphereTransmittance,viewLinearSampler);
  }
#endif
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
  if view_atmosphere_aerial_enabled(v) {
    return atmosphere_solar_transmittance(v.atmosphere,atmosphere_position(v.atmosphere,position),normalize(-v.lightDir),cluster_data_texture,viewLinearSampler);
  }
#endif
#endif
  return vec3<f32>(1.0);
}

fn view_apply_direct_solar(v:View, radiance:vec3<f32>, position:vec3<f32>)->vec3<f32>{
#ifdef LEAN_LIGHTING
  // The lean route admits CPU ground solar and has no active cloud shadow.
  return radiance*select(vec3<f32>(1.0),v.groundSolar.rgb,v.groundSolar.w==1.0);
#else
  var solar=v.groundSolar.rgb;
  if v.groundSolar.w!=1.0 {solar=view_solar_transmittance(v,position);}
  return radiance*solar*cloud_direct_solar_factor(position,v.cloudShadowOrigin,v.cloudShadowRight.xyz,v.cloudShadowUp.xyz,v.cloudShadowProjection);
#endif
}

fn view_ground_solar_transmittance(v: View) -> vec3<f32> {
  if v.groundSolar.w > 0.0 { return v.groundSolar.rgb; }
#ifdef ATMOSPHERE_AVAILABLE
  if view_atmosphere_light_enabled(v) {
    return atmosphere_ground_solar_transmittance(v.atmosphere,normalize(-v.lightDir),atmosphereTransmittance,viewLinearSampler);
  }
#endif
  return vec3<f32>(1.0);
}

fn view_apply_ground_direct_solar(v: View, radiance: vec3<f32>, position: vec3<f32>) -> vec3<f32> {
  return radiance * view_ground_solar_transmittance(v)
    * cloud_direct_solar_factor(position,v.cloudShadowOrigin,v.cloudShadowRight.xyz,v.cloudShadowUp.xyz,v.cloudShadowProjection);
}

fn view_distant_sky_light(v:View)->vec3<f32>{
#ifdef ATMOSPHERE_AVAILABLE
  if view_atmosphere_ue5(v) { return atmosphereDistantSkyBuffer.rgb; }
  if view_atmosphere_aerial_enabled(v) { return textureLoad(atmosphereDistantSkyLight,vec2<i32>(0),0).rgb*atmosphere_sun_luminance(v.lightColor); }
#endif
#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
  if view_atmosphere_aerial_enabled(v) {return atmosphere_table_sample(cluster_data_texture,viewLinearSampler,vec2<f32>(0.5),2u).rgb*atmosphere_sun_luminance(v.lightColor);}
#endif
#endif
  return vec3<f32>(0.0);
}
