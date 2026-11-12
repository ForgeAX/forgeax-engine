#define_import_path forgeax_atmosphere::luts
#import forgeax_view::common::{View}
#import forgeax_atmosphere::table_kernels::{atmosphere_transmittance_texel, atmosphere_multiple_scattering_texel, atmosphere_sky_view_texel, atmosphere_aerial_texel, atmosphere_distant_sky_sample}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_integrate}
#import forgeax_atmosphere::optics::{ATMOSPHERE_PI, atmosphere_medium, atmosphere_interval, atmosphere_sphere, atmosphere_segment, atmosphere_transmittance_ray, atmosphere_solar_transmittance, atmosphere_integrate, atmosphere_integrate_phases}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_view_ray, atmosphere_sky_direction}

@group(0) @binding(0) var<uniform> parameters: View;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var multiple: texture_2d<f32>;
@group(0) @binding(3) var filtering: sampler;
@group(0) @binding(4) var output2d: texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var output3d: texture_storage_3d<rgba16float,write>;
@group(0) @binding(6) var outputTransmittance: texture_storage_3d<rgba16float,write>;

@compute @workgroup_size(8,8)
fn atmosphere_transmittance(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output2d);
  if any(id.xy>=size) { return; }
  let uv=vec2<f32>(id.xy)/vec2<f32>(size-1u);
  textureStore(output2d,vec2<i32>(id.xy),atmosphere_transmittance_texel(parameters.atmosphere, uv));
}

@compute @workgroup_size(8,8)
fn atmosphere_multiple_scattering(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output2d);
  if any(id.xy>=size) { return; }
  let uv=vec2<f32>(id.xy)/vec2<f32>(size-1u);
  textureStore(output2d,vec2<i32>(id.xy),atmosphere_multiple_scattering_texel(parameters.atmosphere, uv, transmittance, filtering));
}

@compute @workgroup_size(8,8)
fn atmosphere_sky_view(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output2d);
  if any(id.xy>=size) { return; }
  let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(size);
  textureStore(output2d,vec2<i32>(id.xy),atmosphere_sky_view_texel(parameters, uv, transmittance, multiple, filtering));
}

@compute @workgroup_size(4,4,4)
fn atmosphere_aerial_perspective(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output3d);
  if any(id>=size) { return; }
  let ray=atmosphere_aerial_texel(parameters,id,size,transmittance,multiple,filtering);
  textureStore(output3d,vec3<i32>(id),vec4<f32>(ray.luminance,1.0));
  textureStore(outputTransmittance,vec3<i32>(id),vec4<f32>(ray.transmittance,1.0));
}

// Radiance tables store unit white illuminance responses to keep RGBA16F
// finite under high lux. Consumers apply the sun's luminance exactly once
// (atmosphere_sun_luminance), so an authored sun tint never greys the sky.
// UE distant skylight: uniform spherical average with isotropic phases, fixed
// ground-reference altitude; independent of the display and capture cameras.
var<workgroup> distantSamples: array<vec3<f32>,64>;
@compute @workgroup_size(64)
fn atmosphere_distant_sky_light(@builtin(local_invocation_index) i:u32) {
  distantSamples[i]=atmosphere_distant_sky_sample(parameters,i,transmittance,multiple,filtering);
  workgroupBarrier();
  if i==0u {
    var light=vec3<f32>(0.0);
    for(var sample=0u;sample<64u;sample+=1u){light+=distantSamples[sample];}
    textureStore(output2d,vec2<i32>(0),vec4<f32>(light,1.0));
  }
}
