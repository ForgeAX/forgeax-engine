#define_import_path forgeax_atmosphere::luts
#import forgeax_view::common::{View}
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
  let m=parameters.atmosphere;
  let ray=atmosphere_transmittance_ray(m,uv);
  let origin=vec3<f32>(0.0,ray.x,0.0);
  let direction=vec3<f32>(sqrt(max(1.0-ray.y*ray.y,0.0)),ray.y,0.0);
  let top=atmosphere_sphere(origin,direction,m.originRadius.w+m.geometry.x);
  let step=max(top.y,0.0)/128.0;
  var opticalDepth=vec3<f32>(0.0);
  for(var i=0u;i<128u;i+=1u) { opticalDepth+=atmosphere_medium(m,origin+direction*((f32(i)+0.5)*step)).extinction*step; }
  textureStore(output2d,vec2<i32>(id.xy),vec4<f32>(exp(-opticalDepth),1.0));
}

@compute @workgroup_size(8,8)
fn atmosphere_multiple_scattering(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output2d);
  if any(id.xy>=size) { return; }
  let uv=vec2<f32>(id.xy)/vec2<f32>(size-1u);
  let m=parameters.atmosphere;
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
  textureStore(output2d,vec2<i32>(id.xy),vec4<f32>(luminance*series,1.0));
}

@compute @workgroup_size(8,8)
fn atmosphere_sky_view(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output2d);
  if any(id.xy>=size) { return; }
  let v=parameters; let m=v.atmosphere;
  let origin=atmosphere_observer(m,v.cameraPos);
  let sun=normalize(-v.lightDir);
  let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(size);
  let direction=atmosphere_sky_direction(m,origin,sun,uv);
  let ray=atmosphere_integrate(m,origin,direction,1e7,sun,vec3<f32>(1.0),transmittance,multiple,filtering,64u,1.0);
  textureStore(output2d,vec2<i32>(id.xy),vec4<f32>(ray.luminance,dot(ray.transmittance,vec3<f32>(1.0/3.0))));
}

@compute @workgroup_size(4,4,4)
fn atmosphere_aerial_perspective(@builtin(global_invocation_id) id: vec3<u32>) {
  let size=textureDimensions(output3d);
  if any(id>=size) { return; }
  let v=parameters; let m=v.atmosphere;
  let uv=(vec2<f32>(id.xy)+0.5)/vec2<f32>(size.xy);
  let cameraRay=atmosphere_view_ray(v,uv);
  let origin=atmosphere_observer(m,cameraRay.origin);
  let w=(f32(id.z)+0.5)/f32(size.z);
  let distance=m.geometry.z+v.atmosphereControl.z*w*w;
  var unitLight=v; unitLight.lightColor=vec3<f32>(1.0);
  let ray=atmosphere_aerial_integrate(unitLight,origin,cameraRay.direction,distance,transmittance,multiple,filtering,64u);
  textureStore(output3d,vec3<i32>(id),vec4<f32>(ray.luminance,1.0));
  textureStore(outputTransmittance,vec3<i32>(id),vec4<f32>(ray.transmittance,1.0));
}

// Radiance tables store unit white illuminance responses to keep RGBA16F
// finite under high lux. Consumers apply the snapshot solar RGB exactly once.
// UE distant skylight: uniform spherical average with isotropic phases, fixed
// ground-reference altitude; independent of the display and capture cameras.
var<workgroup> distantSamples: array<vec3<f32>,64>;
@compute @workgroup_size(64)
fn atmosphere_distant_sky_light(@builtin(local_invocation_index) i:u32) {
  let v=parameters; let m=v.atmosphere;
  let origin=vec3<f32>(0.0,m.originRadius.w+0.001,0.0);
  let z=1.0-2.0*(f32(i)+0.5)/64.0;
  let phi=f32(i)*2.39996322973;
  let r=sqrt(max(1.0-z*z,0.0));
  let direction=vec3<f32>(r*cos(phi),z,r*sin(phi));
  distantSamples[i]=atmosphere_integrate_phases(m,origin,direction,1e7,normalize(-v.lightDir),vec3<f32>(1.0),transmittance,multiple,filtering,64u,1.0,vec2<f32>(1.0/(4.0*3.14159265359))).luminance/64.0;
  workgroupBarrier();
  if i==0u {
    var light=vec3<f32>(0.0);
    for(var sample=0u;sample<64u;sample+=1u){light+=distantSamples[sample];}
    textureStore(output2d,vec2<i32>(0),vec4<f32>(light,1.0));
  }
}
