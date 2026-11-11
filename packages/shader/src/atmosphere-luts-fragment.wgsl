#define_import_path forgeax_atmosphere::luts_fragment
#import forgeax_view::common::{View, FullscreenOutput, fullscreen_triangle}
#import forgeax_atmosphere::table_kernels::{atmosphere_transmittance_texel, atmosphere_multiple_scattering_texel, atmosphere_sky_view_texel, atmosphere_aerial_texel, atmosphere_distant_sky_sample}

@group(0) @binding(0) var<uniform> parameters: View;
@group(0) @binding(1) var transmittance: texture_2d<f32>;
@group(0) @binding(2) var multiple: texture_2d<f32>;
@group(0) @binding(3) var filtering: sampler;
@group(0) @binding(4) var distant: texture_2d<f32>;

@vertex
fn atmosphere_tables_vs(@builtin(vertex_index) i: u32) -> FullscreenOutput {
  return fullscreen_triangle(i);
}
@fragment
fn atmosphere_transmittance_fragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return atmosphere_transmittance_texel(parameters.atmosphere, (p.xy-0.5)/vec2<f32>(255.0,63.0));
}
@fragment
fn atmosphere_multiple_scattering_fragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return atmosphere_multiple_scattering_texel(parameters.atmosphere, (p.xy-0.5)/31.0, transmittance, filtering);
}
@fragment
fn atmosphere_sky_view_fragment(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
  return atmosphere_sky_view_texel(parameters, p.xy/vec2<f32>(192.0,208.0), transmittance, multiple, filtering);
}

@fragment
fn atmosphere_distant_sky_light_fragment()->@location(0) vec4<f32> {
  var light=vec3<f32>(0.0);
  for(var i=0u;i<64u;i+=1u){light+=atmosphere_distant_sky_sample(parameters,i,transmittance,multiple,filtering);}
  return vec4<f32>(light,1.0);
}
// The viewport covers only the disjoint footer. Its normalized interpolation
// addresses that local rectangle; builtin position would include its origin.
@fragment
fn atmosphere_packed_medium_fragment(input:FullscreenOutput)->@location(0) vec4<u32> {
  let point=vec2<u32>(input.uv*vec2<f32>(1024.0,18.0));let index=point.y*1024u+point.x;
  var value=vec4<f32>(0.0);
  if index<16384u {value=textureLoad(transmittance,vec2<i32>(i32(index%256u),i32(index/256u)),0);}
  else if index<17408u {let i=index-16384u;value=textureLoad(multiple,vec2<i32>(i32(i%32u),i32(i/32u)),0);}
  else if index==17408u {value=textureLoad(distant,vec2<i32>(0),0);}
  return bitcast<vec4<u32>>(value);
}
@fragment
fn atmosphere_packed_aerial_fragment(input:FullscreenOutput)->@location(0) vec4<u32> {
  let point=vec2<u32>(input.uv*vec2<f32>(1024.0,32.0));
  let id=vec3<u32>(point.x%32u,point.x/32u,point.y);
  let ray=atmosphere_aerial_texel(parameters,id,vec3<u32>(32u),transmittance,multiple,filtering);
  return vec4<u32>(pack2x16float(ray.luminance.rg),pack2x16float(vec2<f32>(ray.luminance.b,ray.transmittance.r)),pack2x16float(ray.transmittance.gb),0u);
}
