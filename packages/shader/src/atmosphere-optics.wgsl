#define_import_path forgeax_atmosphere::optics

// SI authoring is converted once to km / inverse km in the host projection.
// RGB linear radiance throughout; exposure belongs to the output transform.
#import forgeax_view::common::{AtmosphereMedium}
#import forgeax_atmosphere::visibility::{atmosphere_scene_visibility}

struct AtmosphereOpticalSample {
  extinction: vec3<f32>,
  rayleigh: vec3<f32>,
  mie: vec3<f32>,
};
struct AtmosphereTransport {
  luminance: vec3<f32>,
  transmittance: vec3<f32>,
};
const ATMOSPHERE_PI: f32 = 3.141592653589793;

fn atmosphere_position(m: AtmosphereMedium, worldPosition: vec3<f32>) -> vec3<f32> {
  return worldPosition * 0.001 - m.originRadius.xyz + vec3<f32>(0.0, m.originRadius.w, 0.0);
}
fn atmosphere_height(m: AtmosphereMedium, p: vec3<f32>) -> f32 {
  return max(length(p) - m.originRadius.w, 0.0);
}
fn atmosphere_medium(m: AtmosphereMedium, p: vec3<f32>) -> AtmosphereOpticalSample {
  let h = atmosphere_height(m, p);
  let r = m.rayleigh.rgb * exp(-h / m.rayleigh.w);
  let densityM = exp(-h / m.mie.z);
  let s = vec3<f32>(m.mie.x * densityM);
  let a = m.absorption.rgb * max(0.0, 1.0 - abs(h - m.absorption.w) / m.ground.w);
  return AtmosphereOpticalSample(r + s + vec3<f32>(m.mie.y * densityM) + a, r, s);
}
fn atmosphere_sphere(p: vec3<f32>, direction: vec3<f32>, radius: f32) -> vec2<f32> {
  let b = dot(p, direction);
  let lengthP = length(p);
  let c = (lengthP - radius) * (lengthP + radius);
  let discriminant = b * b - c;
  if discriminant < 0.0 { return vec2<f32>(-1.0); }
  let root = sqrt(discriminant);
  return vec2<f32>(-b - root, -b + root);
}
// Clip to the spherical atmosphere, the virtual ground and the finite endpoint.
fn atmosphere_interval(m: AtmosphereMedium, p: vec3<f32>, d: vec3<f32>, distance: f32) -> vec2<f32> {
  let top = atmosphere_sphere(p, d, m.originRadius.w + m.geometry.x);
  if top.y <= 0.0 { return vec2<f32>(0.0); }
  let start = max(top.x, 0.0);
  var end = min(top.y, distance);
  let ground = atmosphere_sphere(p, d, m.originRadius.w);
  if ground.x >= 0.0 { end = min(end, ground.x); }
  return vec2<f32>(start, max(start, end));
}
fn atmosphere_planet_visibility(m: AtmosphereMedium, p: vec3<f32>, sun: vec3<f32>) -> f32 {
  let ground = atmosphere_sphere(p, sun, m.originRadius.w);
  return select(1.0, 0.0, ground.x > 0.00001);
}
fn atmosphere_rayleigh_phase(mu: f32) -> f32 {
  return 3.0 * (1.0 + mu * mu) / (16.0 * ATMOSPHERE_PI);
}
fn atmosphere_mie_phase(mu: f32, g: f32) -> f32 {
  return (1.0 - g * g) / (4.0 * ATMOSPHERE_PI * pow(max(1.0 + g*g - 2.0*g*mu, 0.0001), 1.5));
}
// Stable integral of exp(-sigma*s), including the zero-extinction limit.
fn atmosphere_segment(extinction: vec3<f32>, distance: f32) -> vec3<f32> {
  let x = extinction * distance;
  let regular = (vec3<f32>(1.0) - exp(-x)) / max(extinction, vec3<f32>(1e-20));
  return select(regular, distance * (vec3<f32>(1.0) - x * 0.5 + x*x / 6.0), x < vec3<f32>(0.001));
}
fn atmosphere_sub_uv(uv: vec2<f32>, size: vec2<u32>) -> vec2<f32> {
  return (vec2<f32>(0.5) + clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0)) * (vec2<f32>(size) - 1.0)) / vec2<f32>(size);
}
// Distance-to-top mapping concentrates transmittance samples around the horizon.
fn atmosphere_transmittance_uv(m: AtmosphereMedium, p: vec3<f32>, direction: vec3<f32>) -> vec2<f32> {
  let bottom = m.originRadius.w;
  let top = bottom + m.geometry.x;
  let radius = clamp(length(p), bottom, top);
  let mu = dot(p, direction) / max(length(p), 0.0001);
  let H = sqrt((top-bottom)*(top+bottom));
  let rho = sqrt(max((radius-bottom)*(radius+bottom), 0.0));
  let distance = max(-radius*mu + sqrt(max(radius*radius*mu*mu + (top-radius)*(top+radius), 0.0)), 0.0);
  let minimum = top-radius;
  let maximum = rho+H;
  return vec2<f32>((distance-minimum)/max(maximum-minimum, 0.00001), rho/H);
}
fn atmosphere_transmittance_ray(m: AtmosphereMedium, uv: vec2<f32>) -> vec2<f32> {
  let bottom=m.originRadius.w;
  let top=bottom+m.geometry.x;
  let H=sqrt((top-bottom)*(top+bottom));
  let rho=H*uv.y;
  let radius=sqrt(rho*rho+bottom*bottom);
  let distance=mix(top-radius,rho+H,uv.x);
  let mu=select(1.0, ((top-radius)*(top+radius)-distance*distance)/max(2.0*radius*distance,1e-8), distance>0.00001);
  return vec2<f32>(radius,clamp(mu,-1.0,1.0));
}
fn atmosphere_solar_transmittance(m: AtmosphereMedium, p: vec3<f32>, sun: vec3<f32>, lut: texture_2d<f32>, filtering: sampler) -> vec3<f32> {
  if atmosphere_planet_visibility(m,p,sun)<0.5 { return vec3<f32>(0.0); }
  var position=p;
  let top=m.originRadius.w+m.geometry.x;
  if length(position)>top {
    let interval=atmosphere_sphere(position,sun,top);
    if interval.x<0.0 { return vec3<f32>(1.0); }
    position += sun*interval.x;
  }
  let uv=atmosphere_transmittance_uv(m,position,sun);
  return textureSampleLevel(lut,filtering,atmosphere_sub_uv(uv,textureDimensions(lut)),0.0).rgb;
}
fn atmosphere_multi_source(m: AtmosphereMedium, p: vec3<f32>, sun: vec3<f32>, lut: texture_2d<f32>, filtering: sampler) -> vec3<f32> {
  let mu=dot(normalize(p),sun);
  let uv=vec2<f32>(mu*0.5+0.5,atmosphere_height(m,p)/m.geometry.x);
  return textureSampleLevel(lut,filtering,atmosphere_sub_uv(uv,textureDimensions(lut)),0.0).rgb*m.geometry.y;
}
// Sky View, AP, capture and direct reference all use this finite-segment kernel.
fn atmosphere_integrate_phases(m: AtmosphereMedium, origin: vec3<f32>, direction: vec3<f32>, distance: f32, sun: vec3<f32>, irradiance: vec3<f32>, transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler, sampleCount: u32, opticalScale: f32, phases: vec2<f32>) -> AtmosphereTransport {
  let interval=atmosphere_interval(m,origin,direction,distance);
  var result=AtmosphereTransport(vec3<f32>(0.0),vec3<f32>(1.0));
  let count=max(sampleCount,1u);
  let length=interval.y-interval.x;
  let phaseR=phases.x;
  let phaseM=phases.y;
  for(var i=0u;i<count;i+=1u) {
    let begin=pow(f32(i)/f32(count),2.0)*length;
    let end=pow(f32(i+1u)/f32(count),2.0)*length;
    let step=end-begin;
    let p=origin+direction*(interval.x+(begin+end)*0.5);
    let medium=atmosphere_medium(m,p);
    let solar=atmosphere_solar_transmittance(m,p,sun,transmittance,filtering)*atmosphere_scene_visibility(m,p);
    let multi=atmosphere_multi_source(m,p,sun,multiple,filtering);
    let source=irradiance*(solar*(medium.rayleigh*phaseR+medium.mie*phaseM)+multi*(medium.rayleigh+medium.mie));
    result.luminance += result.transmittance*source*atmosphere_segment(medium.extinction,step*opticalScale);
    result.transmittance *= exp(-medium.extinction*step*opticalScale);
  }
  return result;
}

fn atmosphere_integrate(m: AtmosphereMedium, origin: vec3<f32>, direction: vec3<f32>, distance: f32, sun: vec3<f32>, irradiance: vec3<f32>, transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler, sampleCount: u32, opticalScale: f32) -> AtmosphereTransport {
  let mu=dot(direction,sun);
  return atmosphere_integrate_phases(m,origin,direction,distance,sun,irradiance,transmittance,multiple,filtering,sampleCount,opticalScale,vec2<f32>(atmosphere_rayleigh_phase(mu),atmosphere_mie_phase(mu,m.mie.w)));
}
