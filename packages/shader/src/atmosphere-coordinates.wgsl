#define_import_path forgeax_atmosphere::coordinates
#import forgeax_view::common::{View, AtmosphereMedium}
#import forgeax_atmosphere::optics::{ATMOSPHERE_PI, atmosphere_position}

struct AtmosphereRay { origin: vec3<f32>, direction: vec3<f32>, };
fn atmosphere_view_ray(v: View, uv: vec2<f32>) -> AtmosphereRay {
  let ndc=vec2<f32>(uv.x*2.0-1.0,1.0-uv.y*2.0);
  let near4=v.inverseViewProj*vec4<f32>(ndc,1.0,1.0);
  let far4=v.inverseViewProj*vec4<f32>(ndc,0.0,1.0);
  let near=near4.xyz/near4.w;
  // A short near-to-middle segment loses direction precision at orbital
  // coordinates. Keep the far endpoint homogeneous (also valid at infinity).
  let direction=normalize(far4.xyz-near*far4.w);
  let origin=select(v.cameraPos,near-direction*v.temporalProjection.x,v.temporalProjection.z>0.5);
  return AtmosphereRay(origin,direction);
}
fn atmosphere_observer(m: AtmosphereMedium, worldPosition: vec3<f32>) -> vec3<f32> {
  let p=atmosphere_position(m,worldPosition);
  let radius=length(p);
  return select(vec3<f32>(0.0,m.originRadius.w+0.001,0.0),p/max(radius,0.0001)*max(radius,m.originRadius.w+0.001),radius>0.0001);
}
fn atmosphere_sky_basis(p: vec3<f32>, sun: vec3<f32>) -> mat3x3<f32> {
  let up=normalize(p);
  let projected=sun-up*dot(sun,up);
  var x=projected;
  if dot(x,x)<0.000001 { x=cross(select(vec3<f32>(0.0,1.0,0.0),vec3<f32>(1.0,0.0,0.0),abs(up.y)>0.9),up); }
  x=normalize(x);
  return mat3x3<f32>(x,up,cross(x,up));
}
fn atmosphere_horizon_angle(m: AtmosphereMedium, p: vec3<f32>) -> f32 {
  return 0.5*ATMOSPHERE_PI+acos(clamp(m.originRadius.w/length(p),0.0,1.0));
}
fn atmosphere_sky_direction(m: AtmosphereMedium, p: vec3<f32>, sun: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let horizon=atmosphere_horizon_angle(m,p);
  var angle=pow(uv.y*2.0,2.0)*horizon;
  if uv.y>=0.5 { angle=horizon+(1.0-pow(2.0*(1.0-uv.y),2.0))*(ATMOSPHERE_PI-horizon); }
  let phi=(uv.x*2.0-1.0)*ATMOSPHERE_PI;
  return atmosphere_sky_basis(p,sun)*vec3<f32>(sin(angle)*cos(phi),cos(angle),sin(angle)*sin(phi));
}
fn atmosphere_sky_uv(m: AtmosphereMedium, p: vec3<f32>, sun: vec3<f32>, direction: vec3<f32>) -> vec2<f32> {
  let local=transpose(atmosphere_sky_basis(p,sun))*direction;
  let angle=acos(clamp(local.y,-1.0,1.0));
  let horizon=atmosphere_horizon_angle(m,p);
  var y=0.5*sqrt(angle/max(horizon,0.0001));
  if angle>=horizon { y=1.0-0.5*sqrt(max((ATMOSPHERE_PI-angle)/(ATMOSPHERE_PI-horizon),0.0)); }
  return vec2<f32>(atan2(local.z,local.x)/(2.0*ATMOSPHERE_PI)+0.5,y);
}
