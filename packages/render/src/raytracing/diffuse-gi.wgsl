#define_import_path forgeax_ray::diffuse_gi
#import forgeax_material::ray_abi::{RayMaterialSurface}
#import forgeax_pbr::ray_bsdf::{rayBasis, rayBsdfValue, sampleRayBsdf}
#import forgeax_pbr::lighting_attenuation::{evalDistanceAttenuation, evalSpotAttenuation}
#pragma sdf_traversal
#pragma card_lookup

struct Light { positionKind: vec4f, radiance: vec4f, directionRange: vec4f, cone: vec4f }
struct SurfaceLighting { seed: vec4f, rho: vec4f, radiance: vec4f, state: vec4u }
struct ProbeSample { radianceDistance: vec4f, state: vec4u }
// D and reference D are unit-reflectance E/pi. Beauty applies visible Rd once.
struct Pixel { direct: vec4f, gather: vec4f, response: vec4f, beauty: vec4f, state: vec4u }
struct Settings {
 environment: vec4f, probeOrigin: vec4f, probeCounts: vec4u, scene: vec4u,
 view: vec4u, bias: vec4f, inverseViewProjection: mat4x4f, eye: vec4f,
}
#ifdef DIRECT_DFG_LUT_AVAILABLE
@group(0) @binding(19) var directDfgLut: texture_2d<f32>;
@group(0) @binding(20) var directDfgSampler: sampler;
// Preserve the filtering contract through the shared BRDF texture parameters.
fn directDfgTextureFilteringWitness() {
  let sample = textureSample(directDfgLut, directDfgSampler, vec2<f32>(0.0));
}
#endif
@group(0) @binding(0) var<storage,read> instances: array<Instance>;
@group(0) @binding(1) var<storage,read> fields: array<u32>;
@group(0) @binding(2) var<storage,read> cards: array<Card>;
@group(0) @binding(3) var<storage,read> lights: array<Light>;
@group(0) @binding(4) var<storage,read> previous: array<SurfaceLighting>;
@group(0) @binding(5) var<storage,read_write> next: array<SurfaceLighting>;
@group(0) @binding(6) var<storage,read_write> probes: array<ProbeSample>;
@group(0) @binding(7) var<storage,read_write> pixels: array<Pixel>;
@group(0) @binding(8) var<uniform> settings: Settings;
@group(0) @binding(9) var albedo: texture_2d<f32>;
@group(0) @binding(10) var normal: texture_2d<f32>;
@group(0) @binding(11) var emission: texture_2d<f32>;
@group(0) @binding(12) var f0: texture_2d<f32>;
@group(0) @binding(13) var viewAlbedo: texture_2d<f32>;
@group(0) @binding(14) var viewNormal: texture_2d<f32>;
@group(0) @binding(15) var viewEmission: texture_2d<f32>;
@group(0) @binding(16) var viewF0: texture_2d<f32>;
@group(0) @binding(17) var cardDepth: texture_depth_2d;
@group(0) @binding(18) var viewDepth: texture_depth_2d;

fn radical(i: u32) -> f32 { return f32(reverseBits(i)) * 2.3283064365386963e-10; }
fn cosine(i:u32,count:u32) -> vec3f {
 let r=sqrt((f32(i)+0.5)/f32(count)); let phi=6.28318530718*radical(i);
 return vec3f(r*cos(phi),r*sin(phi),sqrt(1.0-r*r));
}
fn sphere(i:u32,count:u32) -> vec3f {
 // Antipodal equal-area Fibonacci samples: full support and exact constant preservation.
 let j=i/2u;let z=(f32(j)+0.5)/f32(count/2u);let phi=f32(j)*2.39996322973;
 let r=sqrt(1.0-z*z);return vec3f(r*cos(phi),r*sin(phi),z)*select(1.0,-1.0,i%2u==1u);
}
fn material(a:vec4f,n:vec4f,e:vec4f,f:vec4f)->RayMaterialSurface {
 let packed = u32(f.w);
 return RayMaterialSurface(vec4f(a.xyz,1),vec4f(decodeCardNormal(n.xy),a.w),e,vec4f(f.xyz,1),vec4u(packed & 3u,0,(packed >> 2u) & 1u,0),vec4f(decodeCardNormal(n.zw),0));
}
fn surfaceAt(p:vec2i)->RayMaterialSurface {
 return material(textureLoad(albedo,p,0),textureLoad(normal,p,0),textureLoad(emission,p,0),textureLoad(f0,p,0));
}
fn positionAt(pixel:vec2u,resolution:u32,depth:f32,projection:Card)->vec3f {
 let uv=(vec2f(pixel)+vec2f(0.5))/f32(resolution);
 return projection.origin.xyz+projection.u.xyz*(uv.x*projection.u.w)+projection.v.xyz*(uv.y*projection.v.w)-projection.n.xyz*(depth*projection.n.w);
}
fn cardPixel(index:u32)->vec2u {return vec2u(index%(textureDimensions(f0).x),index/(textureDimensions(f0).x));}
fn cardPosition(index:u32)->vec3f {
 let p=cardPixel(index);let tile=p/settings.scene.z;let projection=cards[tile.y*(textureDimensions(f0).x/settings.scene.z)+tile.x];
 return positionAt(p%settings.scene.z,settings.scene.z,textureLoad(cardDepth,vec2i(p),0),projection);
}
fn trace(origin:vec3f,direction:vec3f,distance:f32)->SdfHit {
 return traceSdf(Ray(origin,0.0,direction,distance,vec4u(255u,0,0,0)),settings.scene.x,256u,true);
}
fn outgoing(hit:SdfHit)->vec4f {
 if(hit.state.x==0u){return vec4f(settings.environment.xyz,1);}
 if(hit.state.x!=1u){return vec4f(0);}
 let lookup=lookupSdfCard(hit,settings.scene.y,settings.scene.z);
 if(lookup.state.x!=1u){return vec4f(0);}
 var radiance=vec3f(0);var complete=1.0;
 for(var tap=0u;tap<4u;tap++){
  let weight=lookup.weights[tap];if(weight<=0.0){continue;}
  let lighting=previous[lookup.texels[tap]];
  radiance+=lighting.radiance.xyz*weight;complete=min(complete,select(0.0,1.0,lighting.state.x==1u));
 }
 return vec4f(radiance,complete);
}
fn gather(position:vec3f,n:vec3f,ng:vec3f)->vec4f {
 var sum=vec3f(0);var complete=1.0;let basis=rayBasis(n);
 for(var i=0u;i<settings.probeCounts.w;i++){
  let direction=basis*cosine(i,settings.probeCounts.w);
  if(dot(ng,direction)<=0.0){continue;}
  let sample=outgoing(trace(position+ng*settings.bias.x,direction,settings.environment.w));
  sum+=sample.xyz;complete=min(complete,sample.w);
 }
 return vec4f(sum/f32(settings.probeCounts.w),complete);
}
fn cacheReflectance(s:RayMaterialSurface)->vec3f {
 // Deterministic cosine outgoing / cosine+GGX incoming quadrature of the shared BSDF.
 let basis=rayBasis(s.normalRoughness.xyz);var rho=vec3f(0);
 for(var o=0u;o<16u;o++){
  let wo=basis*cosine(o,16u);
  for(var i=0u;i<128u;i++){
   let random=vec3f((f32(i)+0.5)/128.0,radical(i),fract(radical(i/2u)+f32(o)*0.61803398875));
   let sample=sampleRayBsdf(s,wo,random,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );rho+=sample.weight;
  }
 }
 return rho/(16.0*128.0);
}
fn analytic(position:vec3f,s:RayMaterialSurface,wo:vec3f,rho:vec3f,proxy:bool)->vec4f {
 var result=vec3f(0);var complete=1.0;let n=s.normalRoughness.xyz;
 for(var i=0u;i<settings.scene.w;i++){
  let l=lights[i];var direction=-l.directionRange.xyz;var distance=settings.environment.w;var attenuation=1.0;
  if(l.positionKind.w!=1.0){let delta=l.positionKind.xyz-position;distance=length(delta);direction=delta/max(distance,1e-10);attenuation=evalDistanceAttenuation(distance*distance,l.directionRange.w,l.radiance.w,1e-4);
   if(l.positionKind.w==3.0){attenuation=evalSpotAttenuation(l.positionKind.xyz,l.directionRange.xyz,position,l.cone.x,l.cone.y,l.directionRange.w);}}
  let nl=max(dot(n,direction),0.0);if(nl==0.0 || dot(s.geometricNormal.xyz,direction)<=0.0 || attenuation==0.0){continue;}
  let shadowOrigin=position+s.geometricNormal.xyz*settings.bias.x;
  var shadowDirection=direction;var shadowDistance=distance;
  if(l.positionKind.w!=1.0){let delta=l.positionKind.xyz-shadowOrigin;shadowDistance=length(delta);shadowDirection=delta/max(shadowDistance,1e-10);}
  // Starting inside a known closed solid proves shadow occlusion; it is not missing data.
  let shadow=trace(shadowOrigin,shadowDirection,max(0.0,shadowDistance-1e-4));
  if(shadow.state.x==0u){
   var brdf=rayBsdfValue(s,wo,direction,
#ifdef DIRECT_DFG_LUT_AVAILABLE
    directDfgLut, directDfgSampler,
#endif
  );if(proxy){brdf=rho/3.14159265359;}
   result+=brdf*l.radiance.xyz*(nl*attenuation);
  }else if(shadow.state.x!=1u && shadow.state.x!=2u){complete=0.0;}
 }
 return vec4f(result,complete);
}
@compute @workgroup_size(64) fn seed(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&next)){return;}
 let s=surfaceAt(vec2i(cardPixel(id.x)));var result=SurfaceLighting(vec4f(0),vec4f(0),vec4f(0),vec4u(0));
 if(s.status.x==1u){
  let rho=cacheReflectance(s);let direct=analytic(cardPosition(id.x),s,s.normalRoughness.xyz,rho,true);
  result=SurfaceLighting(vec4f(s.emissionMetallic.xyz+direct.xyz,1),vec4f(rho,0),vec4f(s.emissionMetallic.xyz+direct.xyz,1),vec4u(select(2u,1u,direct.w==1.0),0,0,0));
  if(any(rho<vec3f(0)) || any(rho>vec3f(1.02))){result.state.x=3u;}
 }else if(s.status.x!=0u){result.state.x=3u;}
 next[id.x]=result;
}
@compute @workgroup_size(64) fn feedback(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&next)){return;}var result=previous[id.x];
 if(result.state.x==1u){let s=surfaceAt(vec2i(cardPixel(id.x)));let d=gather(cardPosition(id.x),s.normalRoughness.xyz,s.geometricNormal.xyz);
  result.radiance=vec4f(result.seed.xyz+result.rho.xyz*d.xyz,1);result.state.x=select(2u,1u,d.w==1.0);result.state.y+=1u;}
 next[id.x]=result;
}
fn probePosition(i:u32)->vec3f {
 let c=settings.probeCounts.xyz;let p=vec3u(i%c.x,(i/c.x)%c.y,i/(c.x*c.y));
 return settings.probeOrigin.xyz+vec3f(p)*settings.probeOrigin.w;
}
@compute @workgroup_size(64) fn traceProbes(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&probes)){return;}
 let count=settings.probeCounts.w;let hit=trace(probePosition(id.x/count),sphere(id.x%count,count),settings.environment.w);
 let value=outgoing(hit);var provenance=0u;
 if(hit.state.x==1u){let lookup=lookupSdfCard(hit,settings.scene.y,settings.scene.z);provenance=lookup.state.x;if(lookup.state.x==1u){provenance+=select(0u,16u,value.w==1.0);}}
 probes[id.x]=ProbeSample(vec4f(value.xyz,hit.metrics.x),vec4u(select(2u,1u,value.w==1.0),hit.state.x,hit.state.y,provenance));
}
fn fieldGather(position:vec3f,n:vec3f,ng:vec3f)->vec4f {
 let origin=position+ng*settings.bias.x;let q=(origin-settings.probeOrigin.xyz)/settings.probeOrigin.w;
 if(any(q<vec3f(0))||any(q>vec3f(settings.probeCounts.xyz-vec3u(1u)))){return vec4f(0);}
 let cell=min(vec3u(floor(q)),settings.probeCounts.xyz-vec3u(2u));let f=q-vec3f(cell);
 var sum=vec3f(0);var support=0.0;var complete=1.0;
 for(var corner=0u;corner<8u;corner++){
  let offset=vec3u(corner&1u,(corner>>1u)&1u,(corner>>2u)&1u);let axisWeight=select(vec3f(1)-f,f,offset>vec3u(0));
  var weight=axisWeight.x*axisWeight.y*axisWeight.z;if(weight<=1e-6){continue;}
  let p=cell+offset;let index=(p.z*settings.probeCounts.y+p.y)*settings.probeCounts.x+p.x;
  let delta=probePosition(index)-origin;let distance=length(delta);let direction=delta/max(distance,1e-10);
  // Strict local segment test supplements approximate depth moments. No nonzero leak floor.
  if(distance>1e-5){let visibility=trace(origin,direction,max(0.0,distance-1e-4));
   if(visibility.state.x==1u){continue;}if(visibility.state.x!=0u){complete=0.0;continue;}}
  var irradiance=vec3f(0);var cosineWeight=0.0;var depthWeight=0.0;var moments=vec2f(0);var valid=true;
  for(var i=0u;i<settings.probeCounts.w;i++){
   let sample=probes[index*settings.probeCounts.w+i];let d=sphere(i,settings.probeCounts.w);
   valid=valid && sample.state.x==1u;let cosineWeightSample=select(0.0,max(dot(n,d),0.0),dot(ng,d)>0.0);
   irradiance+=sample.radianceDistance.xyz*cosineWeightSample;cosineWeight+=max(dot(n,d),0.0);
   let w=pow(max(dot(-direction,d),0.0),16.0);let depth=sample.radianceDistance.w;
   moments+=vec2f(depth,depth*depth)*w;depthWeight+=w;
  }
  if(!valid){complete=0.0;continue;}
  moments/=max(depthWeight,1e-20);let variance=abs(moments.y-moments.x*moments.x);
  if(distance>moments.x){let excess=distance-moments.x;let v=variance/max(variance+excess*excess,1e-20);weight*=v*v*v;}
  sum+=irradiance/max(cosineWeight,1e-20)*weight;support+=weight;
 }
 return vec4f(sum/max(support,1e-20),select(0.0,1.0,support>1e-5 && complete==1.0));
}
fn shadePixel(index:u32,useField:bool)->Pixel {
 let pixel=vec2u(index%settings.view.x,index/settings.view.x);let p=vec2i(pixel);
 let a=textureLoad(viewAlbedo,p,0);let n=textureLoad(viewNormal,p,0);let e=textureLoad(viewEmission,p,0);let f=textureLoad(viewF0,p,0);
 var result=Pixel(vec4f(0),vec4f(0),vec4f(0),vec4f(settings.environment.xyz,1),vec4u(0));
 let validity=u32(f.w)&3u;
 if(validity==0u){return result;}if(validity!=1u){result.state.x=3u;return result;}
 let s=material(a,n,e,f);
 let uv=(vec2f(pixel)+vec2f(0.5))/f32(settings.view.x);
 let world=settings.inverseViewProjection*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,textureLoad(viewDepth,p,0),1.0);
 let position=world.xyz/world.w;
 var wo=settings.eye.xyz;if(settings.eye.w==1.0){wo=normalize(settings.eye.xyz-position);}
 let direct=analytic(position,s,wo,vec3f(0),false);
 var d=vec4f(0);var fieldUsed=false;
 if(useField){d=fieldGather(position,s.normalRoughness.xyz,s.geometricNormal.xyz);fieldUsed=d.w==1.0;}
 // An unavailable cache is a request for local tracing, never a black lighting value.
 // The local gather still preserves missing SDF/card/material status.
 if(!fieldUsed){d=gather(position,s.normalRoughness.xyz,s.geometricNormal.xyz);}
 let nv=max(dot(s.normalRoughness.xyz,wo),0.0);let fresnel=f.xyz+(vec3f(1)-f.xyz)*pow(1.0-nv,5.0);
 let rd=a.xyz*(1.0-e.w)*(vec3f(1)-fresnel);
 result.direct=direct;result.gather=d;result.response=vec4f(rd,1);result.beauty=vec4f(e.xyz+direct.xyz+rd*d.xyz,1);
 result.state=vec4u(select(2u,1u,d.w==1.0 && direct.w==1.0),select(0u,1u,fieldUsed),settings.view.z,0);
 return result;
}
@compute @workgroup_size(64) fn gatherField(@builtin(global_invocation_id) id:vec3u){
 if(id.x<arrayLength(&pixels)){pixels[id.x]=shadePixel(id.x,true);}
}
@compute @workgroup_size(64) fn gatherReference(@builtin(global_invocation_id) id:vec3u){
 if(id.x<arrayLength(&pixels)){pixels[id.x]=shadePixel(id.x,false);}
}
