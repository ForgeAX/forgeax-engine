import {
  CARD_GEOMETRIC_NORMAL_WGSL,
  CARD_RADIOSITY_FINITE_WGSL,
  CARD_RADIOSITY_LINK_BINDINGS_WGSL,
  CARD_RADIOSITY_LINK_LAYOUT_WGSL,
  CARD_RADIOSITY_LINK_TRACE_WGSL,
} from './card-radiosity-links';
import { GlobalSdfQueryStatus } from './global-sdf-query';
import { WorldCardSampleStatus } from './world-traversal';

/** Private CardProbeRay32 lighting/transport-estimator readiness revision.
 * Geometry reconstruction links retain their independent model3 contract.
 * Legacy availability=1 is unqualified:
 * a miss's finite observation range is not an opaque endpoint. */
export const CARD_RADIOSITY_TRANSPORT = {
  version: 4,
  hit: 2,
  miss: 3,
  inside: 4,
} as const;

/** Binding-free transport result, shared by the actual Card trace and its GPU
 * status fixture. Backfaces are known zero; unavailable transport stays distinct. */
export const CARD_RADIOSITY_RAY_TRANSPORT_WGSL = `
fn cardRadiosityRayTransport(status:u32, backface:bool, card:vec4f, environment:vec3f)->vec4f {
 if(status==${GlobalSdfQueryStatus.miss}u){return vec4f(environment,1.0);}
 if(status==${GlobalSdfQueryStatus.negativeStart}u||(status==${GlobalSdfQueryStatus.hit}u&&backface)){
  return vec4f(0,0,0,1);
 }
 if(status==${GlobalSdfQueryStatus.hit}u){
  if(card.w==${WorldCardSampleStatus.backface}.0){return vec4f(0,0,0,1);}
  if(card.w==${WorldCardSampleStatus.mapped}.0){return vec4f(max(card.xyz,vec3f(0)),1.0);}
 }
 return vec4f(0);
}
`;

/** The trace's uniform-z/azimuth hemisphere, shared with distance lookup.
 * Distances are world lengths from the unshifted Card probe, not ray t. */
export const CARD_RADIOSITY_VISIBILITY_WGSL = `
struct CardProbeVisibilitySample { ray:u32, distance:f32, valid:u32 }
struct CardProbeDistance { distance:f32, valid:u32 }
struct CardProbeVisibility { weight:f32, available:u32 }
fn cardProbeTransportKnown(tag:f32)->bool{return tag==${CARD_RADIOSITY_TRANSPORT.hit}.0||tag==${CARD_RADIOSITY_TRANSPORT.miss}.0||tag==${CARD_RADIOSITY_TRANSPORT.inside}.0;}
fn cardProbeTransportTag(status:u32,available:f32)->f32 {
 if(available!=1.0){return 0.0;}
 if(status==${GlobalSdfQueryStatus.miss}u){return ${CARD_RADIOSITY_TRANSPORT.miss}.0;}
 if(status==${GlobalSdfQueryStatus.negativeStart}u){return ${CARD_RADIOSITY_TRANSPORT.inside}.0;}
 if(status==${GlobalSdfQueryStatus.hit}u){return ${CARD_RADIOSITY_TRANSPORT.hit}.0;}return 0.0;
}
${CARD_RADIOSITY_FINITE_WGSL}
fn cardProbeBasis(n:vec3f)->mat3x3f {
 let helper=select(vec3f(0,0,1),vec3f(0,1,0),abs(n.z)>0.99);
 let tangent=normalize(cross(helper,n));return mat3x3f(tangent,cross(n,tangent),n);
}
fn cardProbeTraceDirection(n:vec3f,rayIndex:u32,count:u32)->vec3f {
 let hemi=u32(sqrt(f32(count)));let uv=(vec2f(f32(rayIndex%hemi),f32(rayIndex/hemi))+vec2f(0.5))/f32(hemi);
 let z=uv.y;let phi=uv.x*6.28318530718;let radius=sqrt(1.0-z*z);
 let basis=cardProbeBasis(n);return normalize(basis[0]*(radius*cos(phi))+basis[1]*(radius*sin(phi))+n*z);
}
fn cardRadiosityTraceDistance(status:u32,parameter:f32,maximum:f32,offset:vec3f,direction:vec3f)->CardProbeDistance {
 if(status==${GlobalSdfQueryStatus.negativeStart}u){return CardProbeDistance(0,1u);}
 var t=parameter;
 if(status==${GlobalSdfQueryStatus.miss}u){t=maximum;}
 else if(status!=${GlobalSdfQueryStatus.hit}u){return CardProbeDistance(0,0u);}
 if(!(t>=0.0)||!cardRadiosityFinite(t)){return CardProbeDistance(0,0u);}
 let endpoint=offset+direction*t;let distance=length(endpoint);
 let usable=cardRadiosityFinite(distance)&&(distance>0.0||all(endpoint==vec3f(0)));
 return CardProbeDistance(distance,select(0u,1u,usable));
}
fn cardProbeVisibilitySample(origin:vec3f,normal:vec3f,receiver:vec3f,count:u32)->CardProbeVisibilitySample {
 let empty=CardProbeVisibilitySample(0u,0,0u);let delta=receiver-origin;
 let distance=length(delta);let normalLength=length(normal);
 if(!cardRadiosityFinite(distance)||!(normalLength>0.0)||!cardRadiosityFinite(normalLength)){return empty;}
 if(distance==0.0){if(all(delta==vec3f(0))){return CardProbeVisibilitySample(0u,0,1u);}return empty;}
 let size=u32(sqrt(f32(count)));if(size==0u||size*size!=count){return empty;}
 let basis=cardProbeBasis(normal);let direction=delta/distance;
 let local=transpose(basis)*direction;var phi=0.0;
 if(any((bitcast<vec3u>(local)&vec3u(0x7fffffffu))>=vec3u(0x7f800000u))){return empty;}
 if(local.x!=0.0||local.y!=0.0){phi=atan2(local.y,local.x);}
 let uv=vec2f(fract(phi/6.28318530718+1.0),clamp(local.z,0.0,1.0));
 let cell=min(vec2u(floor(uv*f32(size))),vec2u(size-1u));
 return CardProbeVisibilitySample(cell.y*size+cell.x,distance,1u);
}
// Dimensionless UE-style relative transition. Production uses strength .5;
// strength 0/1 are diagnostic soft/closed comparisons, not source qualification.
fn cardProbeVisibilityWeight(distance:f32,hitDistance:f32,tag:f32,strength:f32)->CardProbeVisibility {
 let unknown=CardProbeVisibility(0,0u);
 if(!cardProbeTransportKnown(tag)||!(distance>=0.0)||!(hitDistance>=0.0)||!cardRadiosityFinite(distance)||!cardRadiosityFinite(hitDistance)||!(strength>=0.0&&strength<=1.0)){return unknown;}
 if(tag==${CARD_RADIOSITY_TRANSPORT.miss}.0){
  if(distance>hitDistance){return unknown;}return CardProbeVisibility(1,1u);
 }
 if(distance==0.0||hitDistance>=distance){return CardProbeVisibility(1,1u);}
 if(strength==1.0){return CardProbeVisibility(0,1u);}
 return CardProbeVisibility(clamp((hitDistance/distance-1.0)/(1.0-strength)+1.0,0.0,1.0),1u);
}
`;

const CARD_RADIOSITY_SHARED = `
struct CardRadiosityFrame { sampling:vec4u, update:vec4u, atlas:vec4u, reserved:vec4u }
struct CardProbeOrigin { position:vec3f, probe:u32, normal:vec3f, valid:u32 }
struct CardProbeRay { radianceDistance:vec4f, directionStatus:vec4f }
fn cardProbeCount()->u32{return radiosity.sampling.x*radiosity.sampling.x;}
fn cardProbeIndex(slot:u32)->u32{return pages[slot/cardProbeCount()]*cardProbeCount()+slot%cardProbeCount();}
fn cardProbePixel(probe:u32)->vec2u {
 let tile=probe/cardProbeCount();let local=probe%cardProbeCount();let res=radiosity.atlas.w;
 return vec2u(tile%radiosity.atlas.z,tile/radiosity.atlas.z)*res+
  min(vec2u(local%radiosity.sampling.x,local/radiosity.sampling.x)*radiosity.sampling.y,vec2u(res-1u));
}
fn radiosityBasis(d:vec3f)->vec4f{return vec4f(0.2820947918,0.4886025119*d.y,0.4886025119*d.z,0.4886025119*d.x);}
`;

/** Binding-free publication shared by resolve and next-bounce preparation.
 * Direct is already outgoing material radiance. A usable base does not certify
 * indirect transport; only supported finite reconstruction receives an epoch. */
export const CARD_RADIOSITY_LIGHTING_WGSL = `
struct CardRadiosityLighting { value:vec4f, history:vec4f }
fn cardLightingFiniteRgb(value:vec3f)->bool {
 return cardRadiosityFinite(value.x)&&cardRadiosityFinite(value.y)&&cardRadiosityFinite(value.z);
}
fn cardLightingFiniteSh(value:vec4f)->bool {
 return cardLightingFiniteRgb(value.xyz)&&cardRadiosityFinite(value.w);
}
fn cardLightingBaseReady(valid:u32,direct:vec4f)->bool {
 return valid!=0u&&direct.w==1.0&&cardLightingFiniteRgb(direct.xyz);
}
// Conservatively prove finite IEEE-f32 operations before evaluating them.
// Post-operation bit checks alone cannot exclude finite indeterminate results.
fn cardLightingProductSafe(a:f32,b:f32)->bool {
 if(!cardRadiosityFinite(a)||!cardRadiosityFinite(b)){return false;}
 let ax=bitcast<u32>(a)&0x7fffffffu;let bx=bitcast<u32>(b)&0x7fffffffu;
 if(ax==0u||bx==0u){return true;}
 return i32((ax>>23u)&255u)-127+i32((bx>>23u)&255u)-127<=125;
}
fn cardLightingSumSafe(a:f32,b:f32)->bool {
 if(!cardRadiosityFinite(a)||!cardRadiosityFinite(b)){return false;}
 let ax=bitcast<u32>(a)&0x7fffffffu;let bx=bitcast<u32>(b)&0x7fffffffu;
 return ax==0u||bx==0u||(ax<=0x7e800000u&&bx<=0x7e800000u);
}
fn cardLightingChannel(albedo:f32,incident:f32)->f32 {
 return albedo*max(incident,0.0);
}
fn cardRadiosityLighting(valid:u32,direct:vec4f,albedo:vec3f,incident:vec3f,supported:bool,epoch:u32)->CardRadiosityLighting {
 var out=CardRadiosityLighting(vec4f(0),vec4f(0));
 if(!cardLightingBaseReady(valid,direct)){return out;}
 out.value=direct;
 if(!supported||!cardLightingFiniteRgb(incident)){return out;}
 let incoming=max(incident,vec3f(0));
 if(!cardLightingProductSafe(albedo.x,incoming.x)||!cardLightingProductSafe(albedo.y,incoming.y)||!cardLightingProductSafe(albedo.z,incoming.z)){return out;}
 let reflected=vec3f(cardLightingChannel(albedo.x,incoming.x),cardLightingChannel(albedo.y,incoming.y),cardLightingChannel(albedo.z,incoming.z));
 if(!cardLightingFiniteRgb(reflected)){return out;}
 if(!cardLightingSumSafe(direct.x,reflected.x)||!cardLightingSumSafe(direct.y,reflected.y)||!cardLightingSumSafe(direct.z,reflected.z)){return out;}
 let value=vec3f(direct.x+reflected.x,direct.y+reflected.y,direct.z+reflected.z);
 if(!cardLightingFiniteRgb(value)){return out;}
 out.value=vec4f(value,1.0);
 out.history=vec4f(incoming,bitcast<f32>(epoch));
 return out;
}
`;

/** Same admitted world traversal and Card material/radiance owner as field rays.
 * This estimates a surface bounce; it never samples the world irradiance field. */
export function cardRadiosityKernelSources(
  worldTrace: (records: string) => string,
  shared: string,
  geometryTrace: (records: string) => string,
) {
  const common = shared.replace(/fn probeScale[\s\S]*$/, '');
  const uniforms = '@group(0) @binding(0) var<uniform> radiosity:CardRadiosityFrame;';
  const pageRead = '@group(0) @binding(1) var<storage,read> pages:array<u32>;';
  return {
    prepareCardRadiosityBounce: `${common}
${uniforms}
@group(0) @binding(1) var<storage,read> surfaces:array<CardSurface>;
@group(0) @binding(2) var<storage,read> direct:array<vec4f>;
@group(0) @binding(3) var<storage,read> indirect:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> bounce:array<vec4f>;
@group(0) @binding(5) var<storage,read> probeState:array<vec4u>;
struct CardRadiosityFrame { sampling:vec4u, update:vec4u, atlas:vec4u, reserved:vec4u }
${CARD_RADIOSITY_FINITE_WGSL}
${CARD_RADIOSITY_LIGHTING_WGSL}
@compute @workgroup_size(64) fn prepareCardRadiosityBounce(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=linearId(gid,groups);let res=radiosity.atlas.w;let tile=i/(res*res);if(tile>=radiosity.update.z){return;}
 let local=i%(res*res);let pixel=vec2u(tile%radiosity.atlas.z,tile/radiosity.atlas.z)*res+vec2u(local%res,local/res);
 let texel=pixel.y*radiosity.atlas.x+pixel.x;let surface=surfaces[texel];let history=indirect[texel];
 // A changed source starts from its known direct-light bounce. Missing surface
 // transport remains unavailable. Only prior committed, same-epoch indirect is reused.
 // Pages update all probes together. Reject older estimator history before
 // feedback; source epoch alone does not qualify a readiness-model change.
 let model=probeState[tile*radiosity.sampling.x*radiosity.sampling.x].z;
 let supported=model==${CARD_RADIOSITY_TRANSPORT.version}u&&bitcast<u32>(history.w)==radiosity.sampling.w;
 bounce[texel]=cardRadiosityLighting(surface.valid,direct[texel],surface.albedo.xyz,history.xyz,supported,radiosity.sampling.w).value;
}`,
    placeCardRadiosity: `${common}
${uniforms}${pageRead}
@group(0) @binding(2) var<storage,read> surfaces:array<CardSurface>;
@group(0) @binding(3) var<storage,read_write> origins:array<CardProbeOrigin>;
@group(0) @binding(4) var normal:texture_2d<f32>;
${CARD_RADIOSITY_SHARED}
${CARD_GEOMETRIC_NORMAL_WGSL}
@compute @workgroup_size(64) fn placeCardRadiosity(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let slot=linearId(gid,groups);if(slot>=radiosity.update.x*cardProbeCount()){return;}
 let probe=cardProbeIndex(slot);let pixel=cardProbePixel(probe);let s=surfaces[pixel.y*radiosity.atlas.x+pixel.x];
 let origin=CardProbeOrigin(s.position,probe,cardGeometricNormal(textureLoad(normal,vec2i(pixel),0).zw),s.valid);
 origins[probe]=origin;origins[radiosity.atlas.y+slot]=origin;
}`,
    traceCardRadiosity: `${worldTrace(`
@group(0) @binding(7) var<storage,read_write> rays:array<CardProbeRay>;
@group(0) @binding(8) var<uniform> radiosity:CardRadiosityFrame;
@group(0) @binding(16) var<storage,read> origins:array<CardProbeOrigin>;
`)}
struct CardRadiosityFrame { sampling:vec4u, update:vec4u, atlas:vec4u, reserved:vec4u }
struct CardProbeOrigin { position:vec3f, probe:u32, normal:vec3f, valid:u32 }
struct CardProbeRay { radianceDistance:vec4f, directionStatus:vec4f }
${CARD_RADIOSITY_VISIBILITY_WGSL}
${CARD_RADIOSITY_RAY_TRANSPORT_WGSL}
@compute @workgroup_size(64) fn traceCardRadiosity(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=linearId(gid,groups);let count=radiosity.sampling.x*radiosity.sampling.x;
 if(i>=radiosity.update.x*count*radiosity.sampling.z){return;}
 let source=origins[radiosity.atlas.y+i/radiosity.sampling.z];let rayIndex=i%radiosity.sampling.z;
 let n=source.normal;let direction=cardProbeTraceDirection(n,rayIndex,radiosity.sampling.z);
 var value=CardProbeRay(vec4f(0),vec4f(direction,0));
 if(source.valid!=0u){
  let origin=worldSurfaceOrigin(source.position,n,frame.trace.y);
  let ray=Ray(origin,0.0,direction,frame.trace.x,vec4u(1u,0u,0u,0u));
  let hit=traceWorld(ray,frame.query.x,bitcast<f32>(frame.query.y));
  let backface=hit.state.x==${GlobalSdfQueryStatus.hit}u&&worldHitBackface(hit,ray);
  var card=vec4f(0,0,0,${WorldCardSampleStatus.unmapped}.0);
  if(hit.state.x==${GlobalSdfQueryStatus.hit}u&&!backface){card=worldCardRadiance(hit,frame.trace.w,true,ray);}
  let transport=cardRadiosityRayTransport(hit.state.x,backface,card,frame.environment.xyz);
  let distance=cardRadiosityTraceDistance(hit.state.x,hit.metrics.x,frame.trace.x,origin-source.position,direction);
  value.radianceDistance=vec4f(select(vec3f(0),transport.xyz,distance.valid==1u),distance.distance);
  value.directionStatus.w=cardProbeTransportTag(hit.state.x,select(0.0,transport.w,distance.valid==1u));
 }
 rays[source.probe*radiosity.sampling.z+rayIndex]=value;
}`,
    visibilityCardRadiosity: `${geometryTrace(CARD_RADIOSITY_LINK_BINDINGS_WGSL)}
${CARD_RADIOSITY_SHARED}
${CARD_RADIOSITY_FINITE_WGSL}
${CARD_RADIOSITY_LINK_LAYOUT_WGSL}
${CARD_RADIOSITY_LINK_TRACE_WGSL}`,
    filterCardRadiosity: `${common}
${uniforms}${pageRead}
@group(0) @binding(2) var<storage,read> rays:array<CardProbeRay>;
@group(0) @binding(3) var<storage,read_write> filtered:array<CardProbeRay>;
@group(0) @binding(4) var<storage,read> origins:array<CardProbeOrigin>;
@group(0) @binding(5) var<storage,read> links:array<vec4u>;
${CARD_RADIOSITY_SHARED}
${CARD_RADIOSITY_VISIBILITY_WGSL}
${CARD_RADIOSITY_LINK_LAYOUT_WGSL}
@compute @workgroup_size(64) fn filterCardRadiosity(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=linearId(gid,groups);if(i>=radiosity.update.x*cardProbeCount()*radiosity.sampling.z){return;}
 let probe=cardProbeIndex(i/radiosity.sampling.z);let ray=i%radiosity.sampling.z;let source=rays[probe*radiosity.sampling.z+ray];
 var result=source;var sum=source.radianceDistance.xyz;var weight=1.0;
 // Only complete same-surface neighbors contribute; distance/availability retain
 // the unfiltered ray authority. Filtering never fills an unavailable direction.
 if(cardProbeTransportKnown(source.directionStatus.w)){
  let local=probe%cardProbeCount();let tile=probe/cardProbeCount();
  for(var neighbor=0u;neighbor<4u;neighbor++){
   let offset=array<vec2i,4>(vec2i(-1,0),vec2i(1,0),vec2i(0,-1),vec2i(0,1))[neighbor];
   let p=vec2i(i32(local%radiosity.sampling.x),i32(local/radiosity.sampling.x))+offset;
   if(any(p<vec2i(0))||any(p>=vec2i(i32(radiosity.sampling.x)))){continue;}
   let index=tile*cardProbeCount()+u32(p.y)*radiosity.sampling.x+u32(p.x);let other=rays[index*radiosity.sampling.z+ray];
   let origin=origins[probe];let next=origins[index];
   let separation=next.position-origin.position;let scale=max(length(separation),1e-8);
   if(!cardProbeTransportKnown(other.directionStatus.w)||next.valid==0u||dot(origin.normal,next.normal)<0.99||abs(dot(origin.normal,separation))>scale*0.01){continue;}
   if(!cardLinksCurrent(tile)||links[cardLinkProbeBase()+probe][neighbor]!=1u||
      links[cardLinkProbeBase()+index][neighbor^1u]!=1u){continue;}
   sum+=other.radianceDistance.xyz;weight+=1.0;
  }
  result.radianceDistance=vec4f(sum/weight,source.radianceDistance.w);
 }
 filtered[probe*radiosity.sampling.z+ray]=result;
}`,
    integrateCardRadiosity: `${common}
${uniforms}${pageRead}
@group(0) @binding(2) var<storage,read> filtered:array<CardProbeRay>;
@group(0) @binding(3) var<storage,read_write> sh:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> probeState:array<vec4u>;
${CARD_RADIOSITY_SHARED}
${CARD_RADIOSITY_VISIBILITY_WGSL}
@compute @workgroup_size(64) fn integrateCardRadiosity(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let slot=linearId(gid,groups);if(slot>=radiosity.update.x*cardProbeCount()){return;}let probe=cardProbeIndex(slot);
 var red=vec4f(0);var green=vec4f(0);var blue=vec4f(0);var complete=true;
 for(var ray=0u;ray<radiosity.sampling.z;ray++){
  let value=filtered[probe*radiosity.sampling.z+ray];complete=complete&&cardProbeTransportKnown(value.directionStatus.w);
  let basis=radiosityBasis(value.directionStatus.xyz)*(6.28318530718/f32(radiosity.sampling.z));
  red+=basis*value.radianceDistance.r;green+=basis*value.radianceDistance.g;blue+=basis*value.radianceDistance.b;
 }
 sh[probe*3u]=red;sh[probe*3u+1u]=green;sh[probe*3u+2u]=blue;
 probeState[probe]=vec4u(select(0u,radiosity.sampling.w,complete),radiosity.update.y,${CARD_RADIOSITY_TRANSPORT.version}u,0u);
}`,
    resolveCardRadiosity: `${common}
${uniforms}
@group(0) @binding(1) var<storage,read> surfaces:array<CardSurface>;
@group(0) @binding(2) var<storage,read> direct:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> lit:array<vec4f>;
@group(0) @binding(4) var<storage,read> sh:array<vec4f>;
@group(0) @binding(5) var<storage,read> probeState:array<vec4u>;
@group(0) @binding(6) var<storage,read> origins:array<CardProbeOrigin>;
@group(0) @binding(7) var<storage,read_write> indirectHistory:array<vec4f>;
@group(0) @binding(8) var<storage,read> links:array<vec4u>;
${CARD_RADIOSITY_SHARED.replace('fn cardProbeIndex(slot:u32)->u32{return pages[slot/cardProbeCount()]*cardProbeCount()+slot%cardProbeCount();}', '')}
${CARD_RADIOSITY_VISIBILITY_WGSL}
${CARD_RADIOSITY_LINK_LAYOUT_WGSL}
${CARD_RADIOSITY_LIGHTING_WGSL}
@compute @workgroup_size(64) fn resolveCardRadiosity(@builtin(global_invocation_id) gid:vec3u,@builtin(num_workgroups) groups:vec3u){
 let i=linearId(gid,groups);let res=radiosity.atlas.w;let tile=i/(res*res);if(tile>=radiosity.update.z){return;}
 let local=vec2u(i%res,(i/res)%res);let pixel=vec2u(tile%radiosity.atlas.z,tile/radiosity.atlas.z)*res+local;
 let texel=pixel.y*radiosity.atlas.x+pixel.x;let surface=surfaces[texel];let q=vec2f(local)/f32(radiosity.sampling.y);
 let base=vec2u(floor(q));let f=fract(q);var indirect=vec3f(0);var weight=0.0;
 for(var tap=0u;tap<4u;tap++){
  let offset=vec2u(tap&1u,tap>>1u);let p=min(base+offset,vec2u(radiosity.sampling.x-1u));
  let probe=tile*cardProbeCount()+p.y*radiosity.sampling.x+p.x;if(probeState[probe].x!=radiosity.sampling.w||probeState[probe].z!=${CARD_RADIOSITY_TRANSPORT.version}u){continue;}
  let origin=origins[probe];let delta=surface.position-origin.position;let distance=length(delta);
  if(origin.valid==0u||dot(surface.normal,origin.normal)<0.5||abs(dot(delta,origin.normal))>max(0.0001,distance*0.01)){continue;}
  let interpolation=select(1.0-f.x,f.x,offset.x!=0u)*select(1.0-f.y,f.y,offset.y!=0u);
  if(!cardLinksCurrent(tile)||links[texel][tap]!=1u){continue;}
  let w=interpolation;if(!(w>0.0)){continue;}
  if(!cardLightingFiniteSh(sh[probe*3u])||!cardLightingFiniteSh(sh[probe*3u+1u])||!cardLightingFiniteSh(sh[probe*3u+2u])){continue;}
  let transfer=radiosityBasis(surface.normal)*vec4f(1.0,0.666666667,0.666666667,0.666666667);
  indirect+=vec3f(dot(sh[probe*3u],transfer),dot(sh[probe*3u+1u],transfer),dot(sh[probe*3u+2u],transfer))*w;weight+=w;
 }
 let reconstructed=indirect/max(weight,1e-20);
 let result=cardRadiosityLighting(surface.valid,direct[texel],surface.albedo.xyz,reconstructed,weight>0.0&&cardRadiosityFinite(weight)&&cardLightingFiniteRgb(indirect),radiosity.sampling.w);
 indirectHistory[texel]=result.history;lit[texel]=result.value;
}`,
  };
}
