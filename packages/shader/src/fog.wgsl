#define_import_path forgeax_view::fog
#import forgeax_view::common::{View}
#import forgeax_view::atmosphere::{view_atmosphere, view_solar_transmittance, view_distant_sky_light}

struct FogViewParams {
  color: vec3<f32>, density: f32,
  heightFalloff: f32, maxOpacity: f32,
}
struct FogRay { origin: vec3<f32>, direction: vec3<f32>, distance: f32, }
// Fog between the camera and one surface: out = in * transmittance + inscatter.
struct FogSample { inscatter: vec3<f32>, transmittance: f32, }

fn fogOpticalDepth(params: FogViewParams, ray: FogRay) -> f32 {
  let rho = params.density * exp(clamp(-params.heightFalloff * ray.origin.y, -60.0, 60.0));
  let t = clamp(params.heightFalloff * ray.direction.y * ray.distance, -60.0, 60.0);
  var integral = 1.0 - t * 0.5 + t * t / 6.0;
  if abs(t) >= 0.001 { integral = (1.0 - exp(-t)) / t; }
  return clamp(rho * ray.distance * integral, 0.0, 80.0);
}

// Every fog consumer (the opaque fog pass and each translucent writer) samples
// the View fog lanes at its own world position, so a translucent surface is
// fogged at its depth rather than inheriting the surface behind it.
// Zero density or opacity yields the identity sample.
fn height_fog_with_source(v: View, worldPos: vec3<f32>, source:vec3<f32>) -> FogSample {
  var origin = v.cameraPos;
  if v.temporalProjection.z > 0.5 {
    // Orthographic rays start on the camera plane along the view axis. Clip z
    // grows toward the camera under reversed-Z, so -grad(z) is forward.
    let forward = -normalize(vec3<f32>(v.worldViewProj[0].z, v.worldViewProj[1].z, v.worldViewProj[2].z));
    origin = worldPos - forward * dot(worldPos - v.cameraPos, forward);
  }
  let delta = worldPos - origin;
  let distance = length(delta);
  if distance < 0.00001 { return FogSample(vec3<f32>(0.0), 1.0); }
  let params = FogViewParams(v.fogColorDensity.xyz, v.fogColorDensity.w,
    v.fogHeightOpacity.x, v.fogHeightOpacity.y);
  let opacity = params.maxOpacity * (1.0 - exp(-fogOpticalDepth(params, FogRay(origin, delta / distance, distance))));
  return FogSample(source * opacity, 1.0 - opacity);
}

fn height_fog(v:View, worldPos:vec3<f32>)->FogSample {
  var source=v.fogColorDensity.xyz;
  if v.atmosphereControl.w>0.5 {
    // A fixed source preserves the analytic height integral. Ground solar
    // extinction is sampled once, independent of the segment midpoint.
    let ground=v.atmosphere.originRadius.xyz*1000.0+vec3<f32>(0.0,1.0,0.0);
    source+=view_distant_sky_light(v)+view_solar_transmittance(v,ground)*v.lightColor/(4.0*3.14159265359);
  }
  return height_fog_with_source(v,worldPos,source);
}

struct AtmosphereFogSample { inscatter:vec3<f32>, transmittance:vec3<f32>, }
fn view_fog(v:View, position:vec3<f32>)->AtmosphereFogSample {
  let local=height_fog(v,position);
  let air=view_atmosphere(v,position);
  return AtmosphereFogSample(local.inscatter+local.transmittance*air.luminance,local.transmittance*air.transmittance);
}

// Shared material programs serve opaque and blended draws. Blended draws bind
// the View copy whose fogHeightOpacity.z names their blend composition, so this
// one call fogs a translucent writer at its own depth; opaque draws read the
// unfogged slot (z = 0) because the opaque fog pass already covers them.
//   1 straight alpha (src-alpha, one-minus-src-alpha): color * T + inscatter
//   2 premultiplied (one, one-minus-src-alpha):        color * T + inscatter * alpha
//   3 additive (dst one):                              color * T
fn translucent_fog_transmission(v:View, worldPos:vec3<f32>, color:vec3<f32>, alpha:f32, backdrop:vec3<f32>, transmission:vec3<f32>)->vec3<f32>{
  let composition=u32(v.fogHeightOpacity.z+0.5);
  if composition==0u && all(transmission==vec3<f32>(0.0)) {return color;}
  let fog=view_fog(v,worldPos);
  let coverage=select(1.0,alpha,composition==2u);
  let inscatter=select((vec3<f32>(1.0)-transmission)*fog.inscatter*coverage,vec3<f32>(0.0),composition==3u);
  // Backdrop already includes the camera-to-surface medium. Reconstruct the
  // local term without dividing by small T; same-ray / weak-refraction model.
  return (color-backdrop)*fog.transmittance+backdrop+inscatter;
}
fn translucent_fog(v: View, worldPos: vec3<f32>, color: vec3<f32>, alpha: f32) -> vec3<f32> {
  return translucent_fog_transmission(v,worldPos,color,alpha,vec3<f32>(0.0),vec3<f32>(0.0));
}

// Clip-space producers (GPU particles) project on the GPU and carry only NDC.
fn ndc_world(v: View, ndc: vec3<f32>) -> vec3<f32> {
  let world = v.inverseViewProj * vec4<f32>(ndc, 1.0);
  return world.xyz / world.w;
}
