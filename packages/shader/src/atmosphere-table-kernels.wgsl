#define_import_path forgeax_atmosphere::table_kernels
#import forgeax_view::common::{View, AtmosphereMedium}
#import forgeax_atmosphere::optics::{ATMOSPHERE_PI, atmosphere_medium, atmosphere_interval, atmosphere_sphere, atmosphere_segment, atmosphere_transmittance_ray, atmosphere_solar_transmittance, atmosphere_integrate, atmosphere_integrate_phases, atmosphere_integrate_with_sampling, atmosphere_rayleigh_phase, atmosphere_mie_phase, AtmosphereTransport}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_sky_direction, atmosphere_view_ray, atmosphere_ue5_sky_direction}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_integrate}

fn atmosphere_transmittance_texel(m: AtmosphereMedium, uv: vec2<f32>) -> vec4<f32> {
  return atmosphere_transmittance_steps(m, uv, 128u, 0.5);
}

fn atmosphere_transmittance_steps(m: AtmosphereMedium, uv: vec2f, count: u32, offset: f32) -> vec4f {
  let ray=atmosphere_transmittance_ray(m,uv);
  let origin=vec3<f32>(0.0,ray.x,0.0);
  let direction=vec3<f32>(sqrt(max(1.0-ray.y*ray.y,0.0)),ray.y,0.0);
  let top=atmosphere_sphere(origin,direction,m.originRadius.w+m.geometry.x);
  let step=max(top.y,0.0) / f32(count);
  var opticalDepth=vec3<f32>(0.0);
  for(var i=0u;i<count;i+=1u) { opticalDepth+=atmosphere_medium(m,origin+direction*((f32(i) + offset) * step)).extinction*step; }
  return vec4<f32>(exp(-opticalDepth),1.0);
}

fn atmosphere_multiple_scattering_texel(m: AtmosphereMedium, uv: vec2<f32>, transmittance: texture_2d<f32>, filtering: sampler) -> vec4<f32> {
  let origin=vec3<f32>(0.0,m.originRadius.w+max(0.001,uv.y*m.geometry.x),0.0);
  let mu=uv.x*2.0-1.0;
  let sun=vec3<f32>(sqrt(max(1.0-mu*mu,0.0)),mu,0.0);
  var luminance=vec3<f32>(0.0); var feedback=vec3<f32>(0.0);
  // Uniform sphere quadrature: table generation is amortized over medium changes.
  for(var angle=0u;angle<64u;angle+=1u) {
    let y=1.0-2.0*(f32(angle)+0.5)/64.0;
    let phi=f32(angle)*2.39996322973;
    let direction=vec3<f32>(sqrt(1.0-y*y)*cos(phi),y,sqrt(1.0-y*y)*sin(phi));
    let interval=atmosphere_interval(m,origin,direction,1e7);
    let step=(interval.y-interval.x)/32.0;
    var throughput=vec3<f32>(1.0);
    var rayLight=vec3<f32>(0.0); var rayFeedback=vec3<f32>(0.0);
    for(var i=0u;i<32u;i+=1u) {
      let p=origin+direction*(interval.x+(f32(i)+0.5)*step);
      let medium=atmosphere_medium(m,p);
      let scattering=medium.rayleigh+medium.mie;
      let weighted=throughput*atmosphere_segment(medium.extinction,step);
      rayLight+=weighted*scattering*atmosphere_solar_transmittance(m,p,sun,transmittance,filtering)/(4.0*ATMOSPHERE_PI);
      rayFeedback+=weighted*scattering;
      throughput*=exp(-medium.extinction*step);
    }
    let hit=origin+direction*interval.y;
    if length(hit)<=m.originRadius.w+0.005 {
      rayLight+=throughput*m.ground.rgb*max(dot(normalize(hit),sun),0.0)*atmosphere_solar_transmittance(m,normalize(hit)*(m.originRadius.w+0.001),sun,transmittance,filtering)/ATMOSPHERE_PI;
    }
    luminance+=rayLight/64.0;
    feedback+=rayFeedback/64.0;
  }
  let r=clamp(feedback,vec3<f32>(0.0),vec3<f32>(1.0));
  let series=vec3<f32>(1.0)+r+r*r+r*r*r+r*r*r*r;
  return vec4<f32>(luminance*series,1.0);
}

fn atmosphere_sky_view_texel(v: View, uv: vec2<f32>, transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler) -> vec4<f32> {
  let m=v.atmosphere;
  let origin=atmosphere_observer(m,v.cameraPos);
  let sun=normalize(-v.lightDir);
  let direction=atmosphere_sky_direction(m,origin,sun,uv);
  let ray=atmosphere_integrate(m,origin,direction,1e7,sun,vec3<f32>(1.0),transmittance,multiple,filtering,64u,1.0);
  return vec4<f32>(ray.luminance,dot(ray.transmittance,vec3<f32>(1.0/3.0)));
}

// One unit-white optical result per quadratic AP slice, independent of storage.
fn atmosphere_aerial_texel(v:View, id:vec3<u32>, size:vec3<u32>, transmittance:texture_2d<f32>, multiple:texture_2d<f32>, filtering:sampler, samples:u32)->AtmosphereTransport {
  let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(size.xy);
  let cameraRay=atmosphere_view_ray(v,uv);
  let origin=atmosphere_observer(v.atmosphere,cameraRay.origin);
  let w=(f32(id.z)+0.5)/f32(size.z);
  let distance=v.atmosphere.geometry.z+v.atmosphereControl.z*w*w;
  var unitLight=v;unitLight.lightColor=vec3<f32>(1.0);
  return atmosphere_aerial_integrate(unitLight,origin,cameraRay.direction,distance,transmittance,multiple,filtering,samples);
}
// Both the cooperative reduction and raster average retain this exact cohort.
fn atmosphere_distant_sky_sample(v:View, i:u32, transmittance:texture_2d<f32>, multiple:texture_2d<f32>, filtering:sampler)->vec3<f32> {
  let m=v.atmosphere;let origin=vec3<f32>(0.0,m.originRadius.w+0.001,0.0);
  let z=1.0-2.0*(f32(i)+0.5)/64.0;let phi=f32(i)*2.39996322973;
  let r=sqrt(max(1.0-z*z,0.0));let direction=vec3<f32>(r*cos(phi),z,r*sin(phi));
  return atmosphere_integrate_phases(m,origin,direction,1e7,normalize(-v.lightDir),vec3<f32>(1.0),transmittance,multiple,filtering,64u,1.0,vec2<f32>(1.0/(4.0*3.14159265359))).luminance/64.0;
}

fn atmosphere_ue5_multiple_texel(m: AtmosphereMedium, uv: vec2f,
  transmittance: texture_2d<f32>, filtering: sampler) -> vec4f {
  let origin = vec3f(0.0, m.originRadius.w + uv.y * m.geometry.x, 0.0);
  let mu = uv.x * 2.0 - 1.0;
  let sun = vec3f(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
  var luminance = vec3f(0.0);
  var feedback = vec3f(0.0);
  for (var ray = 0u; ray < 2u; ray += 1u) {
    let direction = vec3f(0.0, select(1.0, -1.0, ray == 1u), 0.0);
    let interval = atmosphere_interval(m, origin, direction, 1e7);
    let step = max(0.0, interval.y - interval.x) / 15.0;
    var throughput = vec3f(1.0);
    for (var i = 0u; i < 15u; i += 1u) {
      let p = origin + direction * (interval.x + (f32(i) + 0.3) * step);
      let medium = atmosphere_medium(m, p);
      let scattering = medium.rayleigh + medium.mie;
      let weighted = throughput * atmosphere_segment(medium.extinction, step) * scattering;
      luminance += 0.5 * weighted * atmosphere_solar_transmittance(m, p, sun, transmittance, filtering) / (4.0 * ATMOSPHERE_PI);
      feedback += 0.5 * weighted;
      throughput *= exp(-medium.extinction * step);
    }
    let hit = origin + direction * interval.y;
    if length(hit) <= m.originRadius.w + 0.005 {
      let normal = normalize(hit);
      luminance += 0.5 * throughput * m.ground.rgb * max(dot(normal, sun), 0.0)
        * atmosphere_solar_transmittance(m, normal * (m.originRadius.w + 0.001), sun, transmittance, filtering) / ATMOSPHERE_PI;
    }
  }
  let r2 = feedback * feedback;
  return vec4f(luminance * (vec3f(1.0) + feedback + r2 + feedback * r2 + r2 * r2) * m.geometry.y, 0.0);
}

fn atmosphere_ue5_sky_texel(v: View, uv: vec2f, size: vec2f,
  transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler) -> vec4f {
  let origin = atmosphere_observer(v.atmosphere, v.cameraPos);
  let sun = normalize(-v.lightDir);
  let direction = atmosphere_ue5_sky_direction(v.atmosphere, origin, sun, uv, size);
  let interval = atmosphere_interval(v.atmosphere, origin, direction, 1e7);
  let count = u32(mix(4.0, 32.0, clamp((interval.y - interval.x) / 150.0, 0.0, 1.0)));
  var medium = v.atmosphere;
  medium.geometry.y = 1.0;
  let ray = atmosphere_integrate(medium, origin, direction, 1e7, sun,
    v.lightColor, transmittance, multiple, filtering, count, 1.0);
  return vec4f(ray.luminance, 0.0);
}

fn atmosphere_ue5_distant_sky_ray(v: View, index: u32,
  transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler) -> vec3f {
  let origin = vec3f(0.0, v.atmosphere.originRadius.w + 6.0, 0.0);
  let vertical = 1.0 - 2.0 * (f32(index) + 0.5) / 64.0;
  let phi = f32(index) * 2.39996322973;
  let radius = sqrt(max(0.0, 1.0 - vertical * vertical));
  let direction = vec3f(radius * cos(phi), vertical, radius * sin(phi));
  let sun = normalize(-v.lightDir);
  // The distant-sky integration uses an isotropic phase for both terms.
  let phases = vec2f(1.0 / (4.0 * ATMOSPHERE_PI));
  var medium = v.atmosphere;
  medium.geometry.y = 1.0;
  return atmosphere_integrate_with_sampling(medium, origin, direction, 1e7, sun,
    v.lightColor, transmittance, multiple, filtering, 10u, 1.0, phases, false).luminance;
}

fn atmosphere_ue5_aerial_texel(v: View, id: vec3u, size: vec3u,
  transmittance: texture_2d<f32>, multiple: texture_2d<f32>, filtering: sampler) -> vec4f {
  let ray = atmosphere_view_ray(v, (vec2f(id.xy) + 0.5) / vec2f(size.xy));
  var medium = v.atmosphere;
  medium.geometry.y = 1.0;
  var camera = atmosphere_observer(medium, ray.origin);
  let bottom = medium.originRadius.w;
  let start = medium.geometry.z;
  let w = (f32(id.z) + 0.5) / f32(size.z);
  var lengthKm = 96.0 * w * w;
  var direction = ray.direction;
  var origin = camera + direction * start;
  var endpoint = origin + direction * lengthKm;
  let ground = atmosphere_sphere(camera, direction, bottom).x;
  let belowHorizon = ground > 0.0 && lengthKm + start > ground;
  let underground = length(endpoint) < bottom;
  if belowHorizon || underground {
    camera += normalize(camera) * 0.02;
    let surface = normalize(endpoint) * bottom;
    if belowHorizon && dot(normalize(camera - surface), normalize(surface)) < 0.0001 {
      let midpoint = (normalize(camera) * bottom + surface) * 0.5;
      endpoint = camera + 2.0 * (normalize(midpoint) * bottom - camera);
    } else if underground {
      endpoint = surface;
    }
    direction = normalize(endpoint - camera);
    origin = camera + direction * start;
    lengthKm = max(0.0, dot(endpoint - origin, direction));
  }
  let sun = normalize(-v.lightDir);
  let cosine = dot(sun, direction);
  let phases = vec2f(atmosphere_rayleigh_phase(cosine), atmosphere_mie_phase(cosine, medium.mie.w));
  let transport = atmosphere_integrate_with_sampling(medium, origin, direction, lengthKm,
    sun, v.lightColor, transmittance, multiple, filtering, (id.z + 1u) * 2u, medium.geometry.w,
    phases, false);
  return vec4f(transport.luminance, dot(transport.transmittance, vec3f(1.0 / 3.0)));
}
