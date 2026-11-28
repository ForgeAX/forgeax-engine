import { GlobalSdfQueryStatus } from './global-sdf-query';

export const CARD_RADIOSITY_LINK_MODEL = 3;
export const CARD_RADIOSITY_FINITE_WGSL = `
fn cardRadiosityFinite(value:f32)->bool{return (bitcast<u32>(value)&0x7fffffffu)<0x7f800000u;}
`;

/** Geometry-only links are rebuilt with an updated Card page, after capture is
 * current. Unknown and blocked are distinct; only a known clear segment mixes
 * radiance. These are biased rendering segments, not exact unshifted contacts. */
export const CARD_RADIOSITY_LINK_BINDINGS_WGSL = `
@group(0) @binding(5) var<storage,read> pages:array<u32>;
@group(0) @binding(6) var<storage,read> surfaces:array<CardSurface>;
@group(0) @binding(7) var<storage,read> origins:array<CardProbeOrigin>;
@group(0) @binding(8) var<storage,read_write> links:array<vec4u>;
@group(0) @binding(9) var<uniform> frame:Frame;
@group(0) @binding(10) var<uniform> radiosity:CardRadiosityFrame;
@group(0) @binding(11) var normal:texture_2d<f32>;
`;

export const CARD_GEOMETRIC_NORMAL_WGSL = `
fn cardGeometricNormal(p:vec2f)->vec3f {var n=vec3f(p,1.0-abs(p.x)-abs(p.y));let t=max(-n.z,0.0);n.x+=select(t,-t,n.x>=0.0);n.y+=select(t,-t,n.y>=0.0);return normalize(n);}
`;

/** Shared buffer: atlas texels, then probe-neighbour rows, then page stamps.
 * Stamps use the existing source invalidation/epoch authority, not a new clock. */
export const CARD_RADIOSITY_LINK_LAYOUT_WGSL = `
fn cardLinkProbeBase()->u32{return radiosity.atlas.y/cardProbeCount()*radiosity.atlas.w*radiosity.atlas.w;}
fn cardLinkStamp(tile:u32)->u32{return cardLinkProbeBase()+radiosity.atlas.y+tile;}
fn cardLinksCurrent(tile:u32)->bool {
 let stamp=links[cardLinkStamp(tile)];return stamp.x==radiosity.sampling.w&&stamp.z==${CARD_RADIOSITY_LINK_MODEL}u;
}
`;

export const CARD_RADIOSITY_LINK_TRACE_WGSL = `
${CARD_GEOMETRIC_NORMAL_WGSL}
fn cardLinkVisible(a:vec3f,na:vec3f,b:vec3f,nb:vec3f)->u32 {
 if(any((bitcast<vec3u>(a)&vec3u(0x7fffffffu))>=vec3u(0x7f800000u))||
    any((bitcast<vec3u>(b)&vec3u(0x7fffffffu))>=vec3u(0x7f800000u))||
    !cardRadiosityFinite(dot(na,na))||!cardRadiosityFinite(dot(nb,nb))||
    !(dot(na,na)>0.0)||!(dot(nb,nb)>0.0)){return 0u;}
 if(all(a==b)){return 1u;}
 let origin=worldSurfaceOrigin(a,na,frame.trace.y);let endpoint=worldSurfaceOrigin(b,nb,frame.trace.y);
 let delta=endpoint-origin;let distance=length(delta);
 if(!(distance>0.0)||!cardRadiosityFinite(distance)){return 0u;}
 let ray=Ray(origin,0.0,delta/distance,distance,vec4u(1u,0u,0u,0u));
 let hit=traceWorldVisibility(ray,frame.query.x,bitcast<f32>(frame.query.y));
 if(hit.state.x==${GlobalSdfQueryStatus.miss}u){return 1u;}
 if(hit.state.x==${GlobalSdfQueryStatus.hit}u||hit.state.x==${GlobalSdfQueryStatus.negativeStart}u){return 2u;}
 return 0u;
}
@compute @workgroup_size(64) fn visibilityCardRadiosity(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=linearId(gid,groups);let res=radiosity.atlas.w;let pixels=res*res;
 if(i>=radiosity.update.x*pixels){return;}
 let tile=pages[i/pixels];let local=vec2u(i%res,(i/res)%res);
 let pixel=vec2u(tile%radiosity.atlas.z,tile/radiosity.atlas.z)*res+local;
 let texel=pixel.y*radiosity.atlas.x+pixel.x;let surface=surfaces[texel];
 let geometric=cardGeometricNormal(textureLoad(normal,vec2i(pixel),0).zw);
 let q=vec2f(local)/f32(radiosity.sampling.y);let base=vec2u(floor(q));let f=fract(q);
 let probeAnchor=all(local%vec2u(radiosity.sampling.y)==vec2u(0u));
 let center=local/radiosity.sampling.y;
 let probe=tile*cardProbeCount()+center.y*radiosity.sampling.x+center.x;
 var visible=vec4u(0u);
 var neighbors=vec4u(0u);
 // Texel links and probe neighbors share one world trace call site.
 for(var work=0u;work<select(4u,8u,probeAnchor);work++){
  let tap=work&3u;
  var a:vec3f;
  var na:vec3f;
  var b:vec3f;
  var nb:vec3f;
  if(work<4u){
   let offset=vec2u(tap&1u,tap>>1u);
   let interpolation=select(1.0-f.x,f.x,offset.x!=0u)*select(1.0-f.y,f.y,offset.y!=0u);
   if(!(interpolation>0.0)||surface.valid==0u){continue;}
   let p=min(base+offset,vec2u(radiosity.sampling.x-1u));
   let origin=origins[tile*cardProbeCount()+p.y*radiosity.sampling.x+p.x];
   if(origin.valid==0u){continue;}
   a=origin.position;
   na=origin.normal;
   b=surface.position;
   nb=geometric;
  } else {
   let offset=array<vec2i,4>(vec2i(-1,0),vec2i(1,0),vec2i(0,-1),vec2i(0,1))[tap];
   let next=vec2i(center)+offset;
   if(any(next<vec2i(0))||any(next>=vec2i(i32(radiosity.sampling.x)))){continue;}
   let origin=origins[probe];
   let other=origins[tile*cardProbeCount()+u32(next.y)*radiosity.sampling.x+u32(next.x)];
   if(origin.valid==0u||other.valid==0u){continue;}
   a=origin.position;
   na=origin.normal;
   b=other.position;
   nb=other.normal;
  }
  let accepted=cardLinkVisible(a,na,b,nb);
  if(work<4u){visible[tap]=accepted;}else{neighbors[tap]=accepted;}
 }
 links[texel]=visible;
 if(probeAnchor){links[cardLinkProbeBase()+probe]=neighbors;}
 if(all(local==vec2u(0u))){links[cardLinkStamp(tile)]=vec4u(radiosity.sampling.w,radiosity.update.y,${CARD_RADIOSITY_LINK_MODEL}u,0u);}
}
`;
