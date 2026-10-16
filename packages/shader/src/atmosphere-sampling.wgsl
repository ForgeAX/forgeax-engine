#define_import_path forgeax_atmosphere::sampling
#import forgeax_view::common::{View}
#import forgeax_atmosphere::optics::{AtmosphereTransport, atmosphere_integrate}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_view_ray}

// AP Start skips a physical prefix. Distance scale changes optical thickness,
// not the endpoint, so geometry and the spherical medium stay in world space.
fn atmosphere_aerial_integrate(v: View, origin: vec3<f32>, direction: vec3<f32>, distance: f32, transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler, count: u32) -> AtmosphereTransport {
  let start=v.atmosphere.geometry.z;
  if distance<=start || v.atmosphere.geometry.w<=0.0 {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  return atmosphere_integrate(v.atmosphere,origin+direction*start,direction,distance-start,normalize(-v.lightDir),v.lightColor,transmittance,multiple,filtering,count,v.atmosphere.geometry.w);
}

fn atmosphere_aerial_sample(v:View, worldPosition:vec3<f32>, transmittance:texture_2d<f32>, multiple:texture_2d<f32>, luminance:texture_3d<f32>, extinction:texture_3d<f32>, filtering:sampler)->AtmosphereTransport {
  if v.atmosphereControl.w<0.5 {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  let clip=v.worldViewProj*vec4<f32>(worldPosition,1.0);
  let uv=clip.xy/clip.w*vec2<f32>(0.5,-0.5)+vec2<f32>(0.5);
  let ray=atmosphere_view_ray(v,uv);
  let distance=length(worldPosition-ray.origin)*0.001;
  let start=v.atmosphere.geometry.z;
  if distance<=start {return AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));}
  let origin=atmosphere_observer(v.atmosphere,ray.origin);
  let range=v.atmosphereControl.z;
  let slices=f32(textureDimensions(luminance).z);
  let first=start+range*pow(0.5/slices,2.0);
  let last=start+range*pow(1.0-0.5/slices,2.0);
  let inside=all(uv>=vec2<f32>(0.0)) && all(uv<=vec2<f32>(1.0));
  if v.atmosphereControl.x>0.0 || v.temporalProjection.z>0.5 || length(origin)>=v.atmosphere.originRadius.w+v.atmosphere.geometry.x || !inside || distance>=start+range {
    return atmosphere_aerial_integrate(v,origin,ray.direction,distance,transmittance,multiple,filtering,u32(max(64.0,v.atmosphereControl.x)));
  }
  let coordinate=vec3<f32>(uv,sqrt(max((distance-start)/range,0.0)));
  var result=AtmosphereTransport(textureSampleLevel(luminance,filtering,coordinate,0.0).rgb*v.lightColor,textureSampleLevel(extinction,filtering,coordinate,0.0).rgb);
  if distance<first {
    let weight=(distance-start)/(first-start);
    result.luminance*=weight;result.transmittance=mix(vec3<f32>(1.0),result.transmittance,weight);
  }
  // Blend from the final stored center to the finite LUT endpoint. Clamping
  // alone would freeze extinction beyond the last slice and draw a seam.
  if distance>last {
    let exact=atmosphere_aerial_integrate(v,origin,ray.direction,distance,transmittance,multiple,filtering,64u);
    let weight=smoothstep(last,start+range,distance);
    result.luminance=mix(result.luminance,exact.luminance,weight);
    result.transmittance=mix(result.transmittance,exact.transmittance,weight);
  }
  return result;
}
