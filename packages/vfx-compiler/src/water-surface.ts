/** Managed, producer-backed water data interface. No particle state crosses to CPU. */
export const WATER_SURFACE_RUNTIME_WGSL = `
struct VfxWaterConfig {
  camera_base_count:vec4<f32>,
  hull_rect:vec4<f32>,
  falloff:vec4<f32>,
  cascades:array<vec4<f32>,4>,
}
struct VfxWaterSample {height:f32,normal:vec3<f32>,velocity:vec3<f32>}
@group(0) @binding(22) var forgeax_vfx_water_displacement:texture_2d_array<f32>;
@group(0) @binding(23) var forgeax_vfx_water_hull:texture_2d<f32>;
@group(0) @binding(24) var<uniform> forgeax_vfx_water_config:VfxWaterConfig;
fn forgeax_vfx_water_fft(uv:vec2<f32>,layer:i32)->vec4<f32>{
 let size=vec2<i32>(textureDimensions(forgeax_vfx_water_displacement));
 let at=fract(uv)*vec2<f32>(size)-.5;let pixel=vec2<i32>(floor(at));let f=fract(at);
 let a=((pixel%size)+size)%size;let b=((pixel+vec2<i32>(1,0))%size+size)%size;
 let c=((pixel+vec2<i32>(0,1))%size+size)%size;let d=((pixel+vec2<i32>(1))%size+size)%size;
 return mix(mix(textureLoad(forgeax_vfx_water_displacement,a,layer,0),textureLoad(forgeax_vfx_water_displacement,b,layer,0),f.x),mix(textureLoad(forgeax_vfx_water_displacement,c,layer,0),textureLoad(forgeax_vfx_water_displacement,d,layer,0),f.x),f.y);
}
fn forgeax_vfx_water_wave(at:vec2<f32>)->vec4<f32>{
 let rect=forgeax_vfx_water_config.hull_rect;let uv=(at-rect.xy)*rect.z;let edge=min(uv,1.0-uv);let border=min(edge.x,edge.y);
 if(rect.w<=0.0||border<=0.0){return vec4<f32>(0);}
 let size=vec2<i32>(textureDimensions(forgeax_vfx_water_hull));let pixel=uv*vec2<f32>(size)-.5;let base=vec2<i32>(floor(pixel));let f=fract(pixel);
 let a=clamp(base,vec2<i32>(0),size-1);let b=clamp(base+vec2<i32>(1,0),vec2<i32>(0),size-1);let c=clamp(base+vec2<i32>(0,1),vec2<i32>(0),size-1);let d=clamp(base+vec2<i32>(1),vec2<i32>(0),size-1);
 return mix(mix(textureLoad(forgeax_vfx_water_hull,a,0),textureLoad(forgeax_vfx_water_hull,b,0),f.x),mix(textureLoad(forgeax_vfx_water_hull,c,0),textureLoad(forgeax_vfx_water_hull,d,0),f.x),f.y)*rect.w*smoothstep(0.0,.08,border);
}
fn forgeax_vfx_water_displace(at:vec2<f32>)->vec3<f32>{
 var value=vec3<f32>(0);let cfg=forgeax_vfx_water_config;
 for(var layer=0u;layer<min(u32(cfg.camera_base_count.w),4u);layer++){let c=cfg.cascades[layer];value+=forgeax_vfx_water_fft(at*c.xy,i32(layer)).xyz*c.z;}
 return value*min(exp(-(length(at-cfg.camera_base_count.xy)-cfg.falloff.x)*cfg.falloff.y),1.0);
}
fn forgeax_vfx_water_height(at:vec2<f32>)->f32{
 var origin=at;for(var i=0u;i<4u;i++){origin=at-forgeax_vfx_water_displace(origin).xz;}
 return forgeax_vfx_water_config.camera_base_count.z+forgeax_vfx_water_displace(origin).y+forgeax_vfx_water_wave(at).r;
}
fn vfx_water_sample(world:vec3<f32>)->VfxWaterSample{
 let p=world.xz;let eps=max(forgeax_vfx_water_config.falloff.z,.001);
 let normal=normalize(vec3<f32>(forgeax_vfx_water_height(p-vec2<f32>(eps,0))-forgeax_vfx_water_height(p+vec2<f32>(eps,0)),2.0*eps,forgeax_vfx_water_height(p-vec2<f32>(0,eps))-forgeax_vfx_water_height(p+vec2<f32>(0,eps))));
 return VfxWaterSample(forgeax_vfx_water_height(p),normal,vec3<f32>(0,forgeax_vfx_water_wave(p).a*forgeax_vfx_water_config.falloff.w,0));
}
`;
