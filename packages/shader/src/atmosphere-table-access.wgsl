#define_import_path forgeax_atmosphere::table_access

// Utility tables and storage materials use the ordinary sampled LUTs. A
// clustered uniform material reads the same half-float facts in Cluster's
// GPU-owned footer, without consuming another material texture binding.
#ifdef STORAGE_BUFFER_AVAILABLE
fn atmosphere_table_dimensions(lut: texture_2d<f32>, table: u32) -> vec2<u32> {
  return textureDimensions(lut);
}
fn atmosphere_table_sample(lut: texture_2d<f32>, filtering: sampler, uv: vec2<f32>, table: u32) -> vec3<f32> {
  return textureSampleLevel(lut,filtering,uv,0.0).rgb;
}
#else
#ifdef CLUSTER_FORWARD_AVAILABLE
fn atmosphere_table_dimensions(lut: texture_2d<u32>, table: u32) -> vec2<u32> {
  if table==0u {return vec2<u32>(256u,64u);}
  if table==1u {return vec2<u32>(32u,32u);}
  return vec2<u32>(1u);
}
fn atmosphere_table_load(lut: texture_2d<u32>, point: vec2<i32>, table: u32) -> vec3<f32> {
  let size=atmosphere_table_dimensions(lut,table);
  let pixel=vec2<u32>(clamp(point,vec2<i32>(0),vec2<i32>(size)-1));
  var first=0u;
  if table==1u {first=16384u;}
  if table==2u {first=17408u;}
  let index=first+pixel.y*size.x+pixel.x;
  let extent=textureDimensions(lut);
  let position=vec2<i32>(i32(index%extent.x),i32(extent.y-50u+index/extent.x));
  return bitcast<vec4<f32>>(textureLoad(lut,position,0)).rgb;
}
fn atmosphere_table_sample(lut: texture_2d<u32>, filtering: sampler, uv: vec2<f32>, table: u32) -> vec3<f32> {
  let point=uv*vec2<f32>(atmosphere_table_dimensions(lut,table))-0.5;
  let lower=vec2<i32>(floor(point)); let weight=fract(point);
  return mix(
    mix(atmosphere_table_load(lut,lower,table),atmosphere_table_load(lut,lower+vec2<i32>(1,0),table),weight.x),
    mix(atmosphere_table_load(lut,lower+vec2<i32>(0,1),table),atmosphere_table_load(lut,lower+vec2<i32>(1,1),table),weight.x),weight.y);
}
#else
fn atmosphere_table_dimensions(lut: texture_2d<f32>, table: u32) -> vec2<u32> {
  return textureDimensions(lut);
}
fn atmosphere_table_sample(lut: texture_2d<f32>, filtering: sampler, uv: vec2<f32>, table: u32) -> vec3<f32> {
  return textureSampleLevel(lut,filtering,uv,0.0).rgb;
}
#endif
#endif
