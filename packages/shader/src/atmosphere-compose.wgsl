#define_import_path forgeax_atmosphere::compose
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle, clampLinearHdr}
#import forgeax_view::fog::{FogSample, height_fog_with_source}
#import forgeax_atmosphere::optics::{AtmosphereTransport, atmosphere_interval, atmosphere_solar_transmittance, atmosphere_sun_luminance}
#import forgeax_atmosphere::coordinates::{atmosphere_view_ray, atmosphere_observer}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_sample, atmosphere_aerial_sample_packed_tables}
@group(0) @binding(0) var<uniform> v:View;
@group(0) @binding(1) var depth:texture_depth_2d;
@group(0) @binding(2) var transmittance:texture_2d<f32>;
@group(0) @binding(3) var multiple:texture_2d<f32>;
@group(0) @binding(4) var luminance:texture_3d<f32>;
@group(0) @binding(5) var extinction:texture_3d<f32>;
@group(0) @binding(6) var distant:texture_2d<f32>;
@group(0) @binding(7) var filtering:sampler;
@group(0) @binding(8) var packed:texture_2d<u32>;
@vertex fn atmosphere_compose_vs(@builtin(vertex_index) id:u32)->FullscreenOutput{return fullscreen_triangle(id);}
struct AtmosphereSurface {world:vec3<f32>, depth:f32,}
fn atmosphere_surface(input:FullscreenOutput)->AtmosphereSurface{
  let z=textureLoad(depth,vec2<i32>(input.position.xy),0);
  // Background pixels (reverse-Z depth 0) take height fog at the view ray's
  // atmosphere exit, as distant fog. Their aerial transport stays the
  // identity: the sky already carries its own atmosphere radiance.
  let ray=atmosphere_view_ray(v,input.uv);
  let origin=atmosphere_observer(v.atmosphere,ray.origin);
  var world=ray.origin+ray.direction*atmosphere_interval(v.atmosphere,origin,ray.direction,1e7).y*1000.0;
  if z>0.0 {
    let projected=v.inverseViewProj*vec4<f32>(input.uv*vec2<f32>(2.0,-2.0)+vec2<f32>(-1.0,1.0),z,1.0);
    world=projected.xyz/projected.w;
  }
  return AtmosphereSurface(world,z);
}
fn atmosphere_combine(world:vec3<f32>,depth:f32,air:AtmosphereTransport)->AtmosphereTransport {
  if v.fogHeightOpacity.y==0.0 {return air;}
  let ground=vec3<f32>(0.0,v.atmosphere.originRadius.w+0.001,0.0);
  let solar=atmosphere_solar_transmittance(v.atmosphere,ground,normalize(-v.lightDir),transmittance,filtering);
  var fog=height_fog_with_source(v,world,v.fogColorDensity.rgb+textureLoad(distant,vec2<i32>(0),0).rgb*atmosphere_sun_luminance(v.lightColor)+v.lightColor*solar/(4.0*3.14159265359));
  // Fog.skyOpacity scales the fog opacity on background pixels only; 1 keeps
  // the physical distant fog, 0 leaves the sky exactly unfogged.
  if depth<=0.0 && v.fogSky.x<1.0 {
    let s=clamp(v.fogSky.x,0.0,1.0);
    fog=FogSample(fog.inscatter*s,1.0-(1.0-fog.transmittance)*s);
  }
  return AtmosphereTransport(fog.inscatter+fog.transmittance*air.luminance,fog.transmittance*air.transmittance);
}
fn transport(input:FullscreenOutput)->AtmosphereTransport {
  let surface=atmosphere_surface(input);
  var air=AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
  if surface.depth>0.0 {air=atmosphere_aerial_sample(v,surface.world,transmittance,multiple,luminance,extinction,filtering);}
  return atmosphere_combine(surface.world,surface.depth,air);
}
fn transport_packed(input:FullscreenOutput)->AtmosphereTransport {
  let surface=atmosphere_surface(input);
  var air=AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
  if surface.depth>0.0 {air=atmosphere_aerial_sample_packed_tables(v,surface.world,transmittance,multiple,packed,filtering);}
  return atmosphere_combine(surface.world,surface.depth,air);
}
// Two draws in one attachment pass implement RGB destination attenuation without
// a scene-color copy or optional dual-source blending. Coverage is preserved.
@fragment fn atmosphere_extinction_fs(input:FullscreenOutput)->@location(0) vec4<f32>{return vec4<f32>(transport(input).transmittance,1.0);}
@fragment fn atmosphere_inscatter_fs(input:FullscreenOutput)->@location(0) vec4<f32>{return vec4<f32>(clampLinearHdr(transport(input).luminance),0.0);}
@fragment fn atmosphere_packed_extinction_fs(input:FullscreenOutput)->@location(0) vec4<f32>{return vec4<f32>(transport_packed(input).transmittance,1.0);}
@fragment fn atmosphere_packed_inscatter_fs(input:FullscreenOutput)->@location(0) vec4<f32>{return vec4<f32>(clampLinearHdr(transport_packed(input).luminance),0.0);}
