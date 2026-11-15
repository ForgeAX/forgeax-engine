#define_import_path forgeax_cloud::aerial
#import forgeax_view::common::{View}
#import forgeax_view::fog::{view_fog, height_fog_with_source}

// These separate functions keep the atmosphere textures out of the static
// resource closure of the no-atmosphere entry point.
fn cloud_height_transport(v: View, position: vec3f, cloud: vec4f) -> vec4f {
  if all(cloud == vec4f(0.0, 0.0, 0.0, 1.0)) { return cloud; }
  let fog = height_fog_with_source(v, position, v.fogColorDensity.xyz);
  return vec4f(fog.transmittance * cloud.rgb + (1.0 - cloud.a) * fog.inscatter, cloud.a);
}

fn cloud_aerial_transport(v: View, position: vec3f, cloud: vec4f) -> vec4f {
  if all(cloud == vec4f(0.0, 0.0, 0.0, 1.0)) { return cloud; }
  let fog = view_fog(v, position);
  return vec4f(fog.transmittance * cloud.rgb + (1.0 - cloud.a) * fog.inscatter, cloud.a);
}
