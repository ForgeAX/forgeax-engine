#define_import_path forgeax_atmosphere::sampling
#import forgeax_view::common::{View}
#import forgeax_atmosphere::optics::{AtmosphereTransport, atmosphere_integrate, atmosphere_sun_luminance}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_view_ray}

// AP Start skips a physical prefix. Distance scale changes optical thickness,
// not the endpoint, so geometry and the spherical medium stay in world space.
fn atmosphere_aerial_integrate(v: View, origin: vec3<f32>, direction: vec3<f32>, distance: f32, transmittance:
#ifdef STORAGE_BUFFER_AVAILABLE
texture_2d<f32>
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
texture_2d<u32>
#else
texture_2d<f32>
#endif
#endif
, multiple:
#ifdef STORAGE_BUFFER_AVAILABLE
texture_2d<f32>
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
texture_2d<u32>
#else
texture_2d<f32>
#endif
#endif
, filtering: sampler, count: u32) -> AtmosphereTransport {
  let start=v.atmosphere.geometry.z;
  if distance<=start || v.atmosphere.geometry.w<=0.0 {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  return atmosphere_integrate(v.atmosphere,origin+direction*start,direction,distance-start,normalize(-v.lightDir),atmosphere_sun_luminance(v.lightColor),transmittance,multiple,filtering,count,v.atmosphere.geometry.w);
}

struct AtmosphereAerialCoordinate {
  origin: vec3<f32>,
  direction: vec3<f32>,
  coordinate: vec3<f32>,
  distance: f32,
  nearWeight: f32,
  exactWeight: f32,
};

// One geometry authority serves native 3D filtering and packed trilinear reads.
fn atmosphere_aerial_coordinate(v:View, worldPosition:vec3<f32>, slices:f32)->AtmosphereAerialCoordinate {
  let clip=v.worldViewProj*vec4<f32>(worldPosition,1.0);
  let uv=clip.xy/clip.w*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5);
  let ray=atmosphere_view_ray(v,uv);
  let distance=length(worldPosition-ray.origin)*0.001;
  let start=v.atmosphere.geometry.z;
  let origin=atmosphere_observer(v.atmosphere,ray.origin);
  let range=v.atmosphereControl.z;
  let first=start+range*pow(0.5/slices,2.0);
  let last=start+range*pow(1.0-0.5/slices,2.0);
  let inside=all(uv>=vec2<f32>(0.0)) && all(uv<=vec2<f32>(1.0));
  var exactWeight=0.0;
  if distance>last {exactWeight=smoothstep(last,start+range,distance);}
  if v.atmosphereControl.x>0.0 || v.temporalProjection.z>0.5 || length(origin)>=v.atmosphere.originRadius.w+v.atmosphere.geometry.x || !inside || distance>=start+range {exactWeight=1.0;}
  return AtmosphereAerialCoordinate(origin,ray.direction,vec3<f32>(uv,sqrt(max((distance-start)/range,0.0))),distance,min(1.0,(distance-start)/(first-start)),exactWeight);
}
fn atmosphere_aerial_finish(v:View, point:AtmosphereAerialCoordinate, sampled:AtmosphereTransport, exact:AtmosphereTransport)->AtmosphereTransport {
  let luminance=sampled.luminance*atmosphere_sun_luminance(v.lightColor)*point.nearWeight;
  let transmittance=mix(vec3<f32>(1.0),sampled.transmittance,point.nearWeight);
  return AtmosphereTransport(mix(luminance,exact.luminance,point.exactWeight),mix(transmittance,exact.transmittance,point.exactWeight));
}
fn atmosphere_aerial_sample(v:View, worldPosition:vec3<f32>, transmittance:
#ifdef STORAGE_BUFFER_AVAILABLE
texture_2d<f32>
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
texture_2d<u32>
#else
texture_2d<f32>
#endif
#endif
, multiple:
#ifdef STORAGE_BUFFER_AVAILABLE
texture_2d<f32>
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
texture_2d<u32>
#else
texture_2d<f32>
#endif
#endif
, luminance:texture_3d<f32>, extinction:texture_3d<f32>, filtering:sampler)->AtmosphereTransport {
  if v.atmosphereControl.w<0.5 {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  let point=atmosphere_aerial_coordinate(v,worldPosition,f32(textureDimensions(luminance).z));
  if point.distance<=v.atmosphere.geometry.z {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  var exact=AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
  if point.exactWeight>0.0 {exact=atmosphere_aerial_integrate(v,point.origin,point.direction,point.distance,transmittance,multiple,filtering,u32(max(64.0,v.atmosphereControl.x)));}
  if point.exactWeight>=1.0 {return exact;}
  let sampled=AtmosphereTransport(textureSampleLevel(luminance,filtering,point.coordinate,0.0).rgb,textureSampleLevel(extinction,filtering,point.coordinate,0.0).rgb);
  return atmosphere_aerial_finish(v,point,sampled,exact);
}

fn atmosphere_packed_aerial_load(lut:texture_2d<u32>, point:vec3<i32>)->AtmosphereTransport {
  let p=vec3<u32>(clamp(point,vec3<i32>(0),vec3<i32>(31)));
  let word=textureLoad(lut,vec2<i32>(i32(p.y*32u+p.x),i32(textureDimensions(lut).y-32u+p.z)),0);
  let rg=unpack2x16float(word.x);let br=unpack2x16float(word.y);let gb=unpack2x16float(word.z);
  return AtmosphereTransport(vec3<f32>(rg,br.x),vec3<f32>(br.y,gb));
}
fn atmosphere_packed_aerial_mix(a:AtmosphereTransport,b:AtmosphereTransport,weight:f32)->AtmosphereTransport {
  return AtmosphereTransport(mix(a.luminance,b.luminance,weight),mix(a.transmittance,b.transmittance,weight));
}
fn atmosphere_packed_aerial_sample(lut:texture_2d<u32>, coordinate:vec3<f32>)->AtmosphereTransport {
  let position=coordinate*32.0-0.5;let p=vec3<i32>(floor(position));let w=fract(position);
  let a=atmosphere_packed_aerial_mix(atmosphere_packed_aerial_load(lut,p),atmosphere_packed_aerial_load(lut,p+vec3<i32>(1,0,0)),w.x);
  let b=atmosphere_packed_aerial_mix(atmosphere_packed_aerial_load(lut,p+vec3<i32>(0,1,0)),atmosphere_packed_aerial_load(lut,p+vec3<i32>(1,1,0)),w.x);
  let c=atmosphere_packed_aerial_mix(atmosphere_packed_aerial_load(lut,p+vec3<i32>(0,0,1)),atmosphere_packed_aerial_load(lut,p+vec3<i32>(1,0,1)),w.x);
  let d=atmosphere_packed_aerial_mix(atmosphere_packed_aerial_load(lut,p+vec3<i32>(0,1,1)),atmosphere_packed_aerial_load(lut,p+vec3<i32>(1,1,1)),w.x);
  return atmosphere_packed_aerial_mix(atmosphere_packed_aerial_mix(a,b,w.y),atmosphere_packed_aerial_mix(c,d,w.y),w.z);
}
fn atmosphere_aerial_sample_packed_tables(v:View, worldPosition:vec3<f32>, transmittance:
#ifdef STORAGE_BUFFER_AVAILABLE
texture_2d<f32>
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
texture_2d<u32>
#else
texture_2d<f32>
#endif
#endif
, multiple:
#ifdef STORAGE_BUFFER_AVAILABLE
texture_2d<f32>
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
texture_2d<u32>
#else
texture_2d<f32>
#endif
#endif
, lut:texture_2d<u32>, filtering:sampler)->AtmosphereTransport {
  if v.atmosphereControl.w<0.5 {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  let point=atmosphere_aerial_coordinate(v,worldPosition,32.0);
  if point.distance<=v.atmosphere.geometry.z {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  var exact=AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
  if point.exactWeight>0.0 {exact=atmosphere_aerial_integrate(v,point.origin,point.direction,point.distance,transmittance,multiple,filtering,u32(max(64.0,v.atmosphereControl.x)));}
  if point.exactWeight>=1.0 {return exact;}
  return atmosphere_aerial_finish(v,point,atmosphere_packed_aerial_sample(lut,point.coordinate),exact);
}

#ifndef STORAGE_BUFFER_AVAILABLE
#ifdef CLUSTER_FORWARD_AVAILABLE
fn atmosphere_aerial_sample_packed(v:View,worldPosition:vec3<f32>,lut:texture_2d<u32>,filtering:sampler)->AtmosphereTransport {
  return atmosphere_aerial_sample_packed_tables(v,worldPosition,lut,lut,lut,filtering);
}
#endif
#endif
