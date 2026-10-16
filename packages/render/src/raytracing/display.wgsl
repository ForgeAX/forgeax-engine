#define_import_path forgeax_ray::display
#import forgeax_view::tonemap::{tonemapReinhard}
#import forgeax_view::output_encoding::{OUTPUT_GAMUT_SRGB, encodeOutput}

struct Pixel { direct: vec4f, gather: vec4f, response: vec4f, beauty: vec4f, state: vec4u }
struct Settings { resolution: u32, mode: u32, exposure: f32, pad: u32 }
@group(0) @binding(0) var<storage,read> pixels: array<Pixel>;
@group(0) @binding(1) var<uniform> settings: Settings;
@vertex fn vs_display(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs_display(@builtin(position) p:vec4f)->@location(0) vec4f {
 let pixel=pixels[u32(p.y)*settings.resolution+u32(p.x)];
 var color=pixel.beauty.xyz;
 switch settings.mode {
  case 0u: {color=pixel.beauty.xyz-pixel.response.xyz*pixel.gather.xyz;}
  case 2u: {color=pixel.response.xyz*pixel.gather.xyz;}
  case 3u: {
   if(pixel.state.x==0u){return vec4f(0.04,0.04,0.04,1);}
   if(pixel.state.x==1u){return vec4f(0.1,0.65,0.3,1);}
   return vec4f(1,0,0.7,1);
  }
  // The independent PT accumulation's first vec4 is RGB mean + u32 sample count.
  case 4u: {color=pixel.direct.xyz;}
  default: {}
 }
 return encodeOutput(tonemapReinhard(max(color,vec3f(0))*settings.exposure),1,OUTPUT_GAMUT_SRGB);
}
