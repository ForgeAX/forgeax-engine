#define_import_path forgeax_atmosphere::table_kernels
#import forgeax_view::common::{View, AtmosphereMedium}
#import forgeax_atmosphere::optics::{ATMOSPHERE_PI, atmosphere_medium, atmosphere_interval, atmosphere_sphere, atmosphere_segment, atmosphere_transmittance_ray, atmosphere_solar_transmittance, atmosphere_integrate, atmosphere_integrate_phases, AtmosphereTransport}
#import forgeax_atmosphere::coordinates::{atmosphere_observer, atmosphere_sky_direction, atmosphere_view_ray}
#import forgeax_atmosphere::sampling::{atmosphere_aerial_integrate}

fn atmosphere_transmittance_texel(m: AtmosphereMedium, uv: vec2<f32>) -> vec4<f32> {
  let ray=atmosphere_transmittance_ray(m,uv);
  let origin=vec3<f32>(0.0,ray.x,0.0);
  let direction=vec3<f32>(sqrt(max(1.0-ray.y*ray.y,0.0)),ray.y,0.0);
  let top=atmosphere_sphere(origin,direction,m.originRadius.w+m.geometry.x);
  let step=max(top.y,0.0)/128.0;
  var opticalDepth=vec3<f32>(0.0);
  for(var i=0u;i<128u;i+=1u) { opticalDepth+=atmosphere_medium(m,origin+direction*((f32(i)+0.5)*step)).extinction*step; }
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
fn atmosphere_aerial_texel(v:View, id:vec3<u32>, size:vec3<u32>, transmittance:texture_2d<f32>, multiple:texture_2d<f32>, filtering:sampler)->AtmosphereTransport {
  let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(size.xy);
  let cameraRay=atmosphere_view_ray(v,uv);
  let origin=atmosphere_observer(v.atmosphere,cameraRay.origin);
  let w=(f32(id.z)+0.5)/f32(size.z);
  let distance=v.atmosphere.geometry.z+v.atmosphereControl.z*w*w;
  var unitLight=v;unitLight.lightColor=vec3<f32>(1.0);
  return atmosphere_aerial_integrate(unitLight,origin,cameraRay.direction,distance,transmittance,multiple,filtering,64u);
}
// Both the cooperative reduction and raster average retain this exact cohort.
fn atmosphere_distant_sky_sample(v:View, i:u32, transmittance:texture_2d<f32>, multiple:texture_2d<f32>, filtering:sampler)->vec3<f32> {
  let m=v.atmosphere;let origin=vec3<f32>(0.0,m.originRadius.w+0.001,0.0);
  let z=1.0-2.0*(f32(i)+0.5)/64.0;let phi=f32(i)*2.39996322973;
  let r=sqrt(max(1.0-z*z,0.0));let direction=vec3<f32>(r*cos(phi),z,r*sin(phi));
  return atmosphere_integrate_phases(m,origin,direction,1e7,normalize(-v.lightDir),vec3<f32>(1.0),transmittance,multiple,filtering,64u,1.0,vec2<f32>(1.0/(4.0*3.14159265359))).luminance/64.0;
}
